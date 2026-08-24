import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `pg` is an existing @ws-model-proxy/db dependency. Resolve it from that
// workspace without adding a duplicate root dependency solely for this test.
const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = requireFromDb("pg");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("WSMP_E2E_DATABASE_URL");
const cliSlug = process.env.WSMP_E2E_CLI_SLUG?.trim() || "transcription-e2e";
const root = resolve(import.meta.dirname, "../..");
// Allocate every test-owned filesystem resource before bootstrapping external
// processes or database rows so all child paths (including the server spool)
// are isolated from the repository and the developer environment.
const scratch = await mkdtemp(join(tmpdir(), "wsmp-transcription-e2e-"));
let db;
let server;
let upstream;
let relay;
let waitForExit;
const userId = randomUUID();
try {
  const cliBinary = resolve(process.env.WSMP_E2E_CLI_BINARY || "apps/cli/target/debug/wsmp");
  const serverEntry = resolve(process.env.WSMP_E2E_SERVER_ENTRY || "apps/server/dist/index.mjs");
  await access(cliBinary);
  await access(serverEntry);
  const betterAuthSecret = randomBytes(48).toString("base64url");
  const credential = (prefix, purpose) => {
    const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
    const key = createHmac("sha256", betterAuthSecret)
      .update(`ws-model-proxy:${purpose}:v1`)
      .digest();
    return {
      secret,
      lookupPrefix: secret.slice(0, prefix.length + 12),
      digest: createHmac("sha256", key).update(secret).digest("base64url"),
    };
  };
  const cliCredential = credential("wsmp_cli_", "cli-token");
  const modelCredential = credential("wsmp_model_", "model-api-token");
  const upstreamModel = "deterministic-asr";
  const failingUpstreamModel = "retryable-asr";
  const audioPrivacyMarker = `PRIVATE_AUDIO_${randomUUID()}`;
  const filenamePrivacyMarker = `private-${randomUUID()}.wav`;
  const transcriptPrivacyMarker = `private transcript ${randomUUID()}`;
  const sentinel = Buffer.from(`RIFF\u0000${audioPrivacyMarker}\u0000WAVE`, "binary");
  const spoolRoot = join(scratch, "spool");
  let failedPoolAttempts = 0;
  let successfulUpstreamAttempts = 0;
  const readDirectory = async (path) =>
    readdir(path, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  const waitForCleanSpool = async (label) => {
    const deadline = Date.now() + 2_000;
    let lastSnapshot = "spool base has not been created";
    while (Date.now() < deadline) {
      const baseEntries = await readDirectory(spoolRoot);
      if (!baseEntries || baseEntries.length === 0) {
        lastSnapshot = "spool base contains no process instance directory";
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      const instanceEntries = baseEntries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("instance-"),
      );
      const unexpectedBaseEntries = baseEntries.filter(
        (entry) => !entry.isDirectory() || !entry.name.startsWith("instance-"),
      );
      if (instanceEntries.length !== 1 || unexpectedBaseEntries.length !== 0) {
        lastSnapshot = `spool base entries: ${baseEntries.map((entry) => entry.name).join(", ")}`;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      const uploadEntries = await readDirectory(join(spoolRoot, instanceEntries[0].name));
      if (uploadEntries?.length === 0) return;
      lastSnapshot = `process spool entries: ${(uploadEntries ?? [])
        .map((entry) => entry.name)
        .join(", ")}`;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.fail(`${label} did not clean its upload spool: ${lastSnapshot}`);
  };
  let upstreamAssertion;
  let resolveAbortedUpstream;
  const abortedUpstream = new Promise((resolveAbort) => {
    resolveAbortedUpstream = resolveAbort;
  });

  const portProbe = createServer();
  await new Promise((resolveListen, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolveListen);
  });
  const portAddress = portProbe.address();
  assert(portAddress && typeof portAddress === "object");
  const serverPort = portAddress.port;
  await new Promise((resolveClose) => portProbe.close(resolveClose));
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const cliTokenId = randomUUID();
  const modelTokenId = randomUUID();
  await db.query(
    `INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug, "emailVerified", role, locale)
   VALUES ($1, now(), now(), $2, $3, $4, true, 'user', 'en-US')`,
    [userId, "Transcription E2E", `transcription-e2e-${userId}@invalid.test`, `e2e-${userId}`],
  );
  await db.query(
    `INSERT INTO cli_token (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
   VALUES ($1, now(), now(), $2, $3, $4, $5)`,
    [cliTokenId, userId, "Transcription E2E", cliCredential.lookupPrefix, cliCredential.digest],
  );
  await db.query(
    `INSERT INTO model_api_token (id, "createdAt", "updatedAt", "userId", name, "scopeMode", "lookupPrefix", "secretDigest")
   VALUES ($1, now(), now(), $2, $3, 'ALL_VISIBLE', $4, $5)`,
    [
      modelTokenId,
      userId,
      "Transcription E2E",
      modelCredential.lookupPrefix,
      modelCredential.digest,
    ],
  );

  const childBaseEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  waitForExit = async (child, label) => {
    if (child.exitCode !== null) return;
    const signal = (name) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    const exited = new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
    signal("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 3_000)),
    ]);
    if (!graceful) {
      signal("SIGKILL");
      await exited;
    }
    assert(child.signalCode || child.exitCode !== null, `${label} did not exit`);
  };

  server = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...childBaseEnv,
      WSMP_DISABLE_DOTENV: "1",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      SERVER_PORT: String(serverPort),
      BETTER_AUTH_SECRET: betterAuthSecret,
      BETTER_AUTH_URL: serverUrl,
      SIGNUP_ENABLED: "false",
      MODEL_API_TRANSCRIPTION_SPOOL_DIR: spoolRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    serverLog += chunk;
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    serverLog += chunk;
  });

  upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [upstreamModel, failingUpstreamModel].map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert(body.includes(sentinel), "upstream did not receive the audio bytes intact");
      assert.match(body.toString("latin1"), /name="language"\r\n\r\nfr\r\n/);
      const wire = body.toString("latin1");
      const requestedModel = /name="model"\r\n\r\n([^\r]+)\r\n/.exec(wire)?.[1];
      assert(
        requestedModel === upstreamModel || requestedModel === failingUpstreamModel,
        `unexpected upstream model ${requestedModel}`,
      );
      if (requestedModel === failingUpstreamModel) {
        failedPoolAttempts += 1;
        response.setHeader("content-type", "application/json");
        response.writeHead(503).end(JSON.stringify({ error: "retryable upstream failure" }));
        return;
      }
      successfulUpstreamAttempts += 1;
      if (/name="prompt"\r\n\r\nabort\r\n/.test(wire)) {
        response.setHeader("content-type", "text/event-stream");
        response.write('data: {"delta":"first"}\n\n');
        const interval = setInterval(() => {
          response.write('data: {"delta":"more"}\n\n');
        }, 25);
        response.once("close", () => {
          clearInterval(interval);
          resolveAbortedUpstream();
        });
        return;
      }
      if (/name="stream"\r\n\r\ntrue\r\n/.test(wire)) {
        response.setHeader("content-type", "text/event-stream");
        response.write('data: {"delta":"first"}\n\n');
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        response.end('data: {"delta":"second"}\n\ndata: [DONE]\n\n');
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: transcriptPrivacyMarker, language: "fr" }));
    } catch (error) {
      upstreamAssertion = error;
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise((resolveListen, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const address = upstream.address();
  assert(address && typeof address === "object");

  const configPath = join(scratch, "config.json");
  const stateDir = join(scratch, "state");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      serverUrl,
      cliSlug,
      cliLabel: "Transcription E2E",
      cliTokenEnv: "WSMP_E2E_CLI_TOKEN",
      endpoints: [
        {
          slug: "mock-asr",
          label: "Deterministic mock ASR",
          kind: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          enabled: true,
          defaultCapabilities: {
            version: 2,
            protocol: "openai-compatible",
            audio: {
              transcriptions: { supported: true, streaming: true, languages: ["fr"] },
            },
          },
          headers: [],
          models: [{ upstreamModelId: upstreamModel }, { upstreamModelId: failingUpstreamModel }],
        },
      ],
      mediaTrustedOrigins: [],
    }),
    { mode: 0o600 },
  );

  relay = spawn(cliBinary, ["connect"], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...childBaseEnv,
      WSMP_CONFIG: configPath,
      WSMP_STATE_DIR: stateDir,
      WSMP_E2E_CLI_TOKEN: cliCredential.secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.setEncoding("utf8");
  relay.stdout.on("data", (chunk) => {
    relayLog += chunk;
  });
  relay.stderr.setEncoding("utf8");
  relay.stderr.on("data", (chunk) => {
    relayLog += chunk;
  });

  const deadline = Date.now() + 30_000;
  let listed = false;
  let publishedModel;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`Rust relay exited early:\n${relayLog}`);
    if (server.exitCode !== null) throw new Error(`WSMP server exited early:\n${serverLog}`);
    const response = await fetch(`${serverUrl}/v1/models`, {
      headers: { authorization: `Bearer ${modelCredential.secret}` },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    if (response?.ok) {
      const models = await response.json();
      const candidates = models.data?.filter(
        (model) => model.supports_audio_transcription === true,
      );
      assert((candidates?.length ?? 0) <= 2, "E2E user unexpectedly published audio models");
      publishedModel = candidates?.find((model) => model.id.endsWith(`/${upstreamModel}`))?.id;
      listed = typeof publishedModel === "string";
      if (listed) break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert(listed, `published model did not appear within 30s; relay log:\n${relayLog}`);

  const form = new FormData();
  form.append("model", publishedModel);
  form.append("language", "fr");
  form.append("file", new Blob([sentinel], { type: "audio/wav" }), filenamePrivacyMarker);
  const response = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${modelCredential.secret}` },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), { text: transcriptPrivacyMarker, language: "fr" });
  await waitForCleanSpool("successful direct request");

  const discovered = await db.query(
    `SELECT id, "upstreamModelId" FROM discovered_model
     WHERE "userId" = $1 AND "upstreamModelId" = ANY($2::text[])`,
    [userId, [upstreamModel, failingUpstreamModel]],
  );
  const discoveredByModel = new Map(discovered.rows.map((row) => [row.upstreamModelId, row.id]));
  assert(discoveredByModel.has(upstreamModel), "successful pool member was not discovered");
  assert(discoveredByModel.has(failingUpstreamModel), "failing pool member was not discovered");
  const poolId = randomUUID();
  const poolSlug = `failover-${randomUUID()}`;
  await db.query(
    `INSERT INTO model_pool
       (id, "createdAt", "updatedAt", "userId", slug, name, "optimisticBasicTranscription")
     VALUES ($1, now(), now(), $2, $3, $4, false)`,
    [poolId, userId, poolSlug, "Transcription failover E2E"],
  );
  await db.query(
    `INSERT INTO pool_member
       (id, "createdAt", "updatedAt", "poolId", "discoveredModelId", weight)
     VALUES
       ($1, now(), now(), $3, $4, 100),
       ($2, now(), now(), $3, $5, 1)`,
    [
      `a-fail-${randomUUID()}`,
      `z-success-${randomUUID()}`,
      poolId,
      discoveredByModel.get(failingUpstreamModel),
      discoveredByModel.get(upstreamModel),
    ],
  );
  const poolModel = `e2e-${userId}/${poolSlug}`;
  const poolForm = new FormData();
  poolForm.append("model", poolModel);
  poolForm.append("language", "fr");
  poolForm.append("file", new Blob([sentinel], { type: "audio/wav" }), filenamePrivacyMarker);
  const poolResponse = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${modelCredential.secret}` },
    body: poolForm,
    signal: AbortSignal.timeout(10_000),
  });
  const poolText = await poolResponse.text();
  assert.equal(poolResponse.status, 200, poolText);
  assert.deepEqual(JSON.parse(poolText), { text: transcriptPrivacyMarker, language: "fr" });
  assert.equal(failedPoolAttempts, 1, "pool did not try the retryable member exactly once");
  assert.equal(
    successfulUpstreamAttempts,
    2,
    "pool did not replay the upload to the successful member exactly once",
  );
  await waitForCleanSpool("successful pool failover request");

  const streamingForm = new FormData();
  streamingForm.append("model", publishedModel);
  streamingForm.append("language", "fr");
  streamingForm.append("stream", "true");
  streamingForm.append("file", new Blob([sentinel], { type: "audio/wav" }), "stream.wav");
  const streamingResponse = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${modelCredential.secret}` },
    body: streamingForm,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(streamingResponse.status, 200);
  assert.match(streamingResponse.headers.get("content-type") || "", /text\/event-stream/);
  const streamReader = streamingResponse.body.getReader();
  const firstChunkStartedAt = Date.now();
  const firstChunk = await streamReader.read();
  assert.equal(firstChunk.done, false);
  assert.match(Buffer.from(firstChunk.value).toString(), /first/);
  assert(
    Date.now() - firstChunkStartedAt < 200,
    "SSE first chunk was buffered until the upstream response completed",
  );
  const remainingChunks = [];
  while (true) {
    const chunk = await streamReader.read();
    if (chunk.done) break;
    remainingChunks.push(Buffer.from(chunk.value));
  }
  assert.match(Buffer.concat(remainingChunks).toString(), /second/);
  await waitForCleanSpool("successful streaming request");

  const callerAbort = new AbortController();
  const abortForm = new FormData();
  abortForm.append("model", publishedModel);
  abortForm.append("language", "fr");
  abortForm.append("stream", "true");
  abortForm.append("prompt", "abort");
  abortForm.append("file", new Blob([sentinel], { type: "audio/wav" }), "abort.wav");
  const abortResponse = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${modelCredential.secret}` },
    body: abortForm,
    signal: callerAbort.signal,
  });
  const abortReader = abortResponse.body.getReader();
  await abortReader.read();
  callerAbort.abort();
  await assert.rejects(abortReader.read(), /abort/i);
  await Promise.race([
    abortedUpstream,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("caller abort did not close the upstream response")),
        2_000,
      ),
    ),
  ]);
  await waitForCleanSpool("aborted streaming request");

  let relayRows = [];
  const metadataDeadline = Date.now() + 2_000;
  while (Date.now() < metadataDeadline) {
    const result = await db.query(
      `SELECT * FROM relay_request WHERE "userId" = $1 ORDER BY "createdAt" ASC`,
      [userId],
    );
    relayRows = result.rows;
    if (relayRows.length === 4 && relayRows.every((row) => row.status !== "PENDING")) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(relayRows.length, 4, "expected metadata for every transcription request");
  assert(
    relayRows.every((row) => row.operation === "audio.transcriptions"),
    "metadata must identify only the protocol operation",
  );
  assert(
    relayRows.every((row) => Number(row.requestBytes) > sentinel.byteLength),
    "metadata must count rebuilt multipart request bytes",
  );
  assert(
    relayRows.every((row) => row.responseBytes !== null && Number(row.responseBytes) >= 0),
    "metadata must count response bytes without retaining response content",
  );
  const poolRelayRow = relayRows.find((row) => row.requestedModelPoolId === poolId);
  assert(poolRelayRow, "pool relay metadata was not persisted");
  assert.equal(poolRelayRow.attemptCount, 2);
  assert.equal(poolRelayRow.selectedDiscoveredModelId, discoveredByModel.get(upstreamModel));
  const smallestDirectRequestBytes = Math.min(
    ...relayRows
      .filter((row) => row.requestedModelPoolId === null)
      .map((row) => Number(row.requestBytes)),
  );
  assert(
    Number(poolRelayRow.requestBytes) > smallestDirectRequestBytes + sentinel.byteLength,
    "pool request byte count must accumulate both replay attempts",
  );
  assert(Number(poolRelayRow.responseBytes) > 0, "pool response byte count was not persisted");

  const privacyHaystacks = [serverLog, relayLog, JSON.stringify(relayRows)];
  for (const marker of [audioPrivacyMarker, filenamePrivacyMarker, transcriptPrivacyMarker]) {
    assert(
      privacyHaystacks.every((haystack) => !haystack.includes(marker)),
      `private transcription marker leaked into logs or RelayRequest metadata: ${marker}`,
    );
  }
  if (upstreamAssertion) throw upstreamAssertion;
  process.stdout.write("transcription relay E2E passed\n");
} finally {
  if (relay) await waitForExit(relay, "relay");
  if (server) await waitForExit(server, "server");
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
  if (db) {
    await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined);
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
