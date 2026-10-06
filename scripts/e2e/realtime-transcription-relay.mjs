import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";

// Live transcription (`/v1/realtime?intent=transcription`) full-stack test:
// a prebuilt WMP server and an isolated Postgres database, an OpenAI-shaped
// WebSocket client, and a protocol-faithful fake CLI that speaks the relay
// WebSocket protocol (hello identity, inventory, `stt.*` frames). The fake
// CLI stands in for the Rust relay because live sessions open only on
// recipe-managed endpoints, and running a real recipe needs the deployment
// runtime and an engine; the Rust session code is covered by the CLI's own
// tests against fake vLLM and file engines. Everything else is production:
// upgrade auth, routing over database deployment ownership, capacity
// admission, the locked send claim, credit flow, metering and rollups.

const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = requireFromDb("pg");
const requireFromServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { WebSocket } = requireFromServer("ws");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("WSMP_E2E_DATABASE_URL");
const root = resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp(join(tmpdir(), "wsmp-realtime-e2e-"));
const RELAY_SUBPROTOCOL = "ws-model-proxy.relay.v2";
const upstreamModel = "live-asr-e2e";
const endpointSlug = `inst-${randomBytes(6).toString("hex")}`;
const cliSlug = `rt-${randomBytes(4).toString("hex")}`;
const transcriptPrivacyMarker = `private live transcript ${randomUUID()}`;
const audioPrivacyMarker = `PRIVATE_LIVE_AUDIO_${randomUUID().replaceAll("-", "")}`;

// The relay protocol version this checkout speaks, read from its source so a
// version consolidation never needs this test to change.
async function relayProtocolVersion() {
  const source = await readFile(
    join(root, "packages/api/src/lib/relay-protocol-version.ts"),
    "utf8",
  );
  const versions = /RELAY_PROTOCOL_VERSIONS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  const listed = [...(versions ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert(listed.length > 0, "relay protocol versions not found");
  return listed.at(-1);
}

function lp16(bytes) {
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

/** The CLI's P-256 hello identity (apps/server/src/relay/hello-identity.ts). */
function helloIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const signingKey = createPrivateKey({
    key: privateKey.export({ type: "pkcs8", format: "der" }),
    format: "der",
    type: "pkcs8",
  });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - 65)).toString("base64url"),
    sign(nonce, slug, origin) {
      const statement = Buffer.concat([
        lp16(Buffer.from("wsmp-relay-hello-v1")),
        Buffer.from(nonce, "base64url"),
        lp16(Buffer.from(slug, "utf8")),
        lp16(Buffer.from(origin, "utf8")),
      ]);
      return sign("sha256", statement, { key: signingKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      );
    },
  };
}

function parseBinaryFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const length = buffer.readUInt32BE(0);
  return {
    metadata: JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")),
    body: buffer.subarray(4 + length),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolveWait(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() > deadline) return reject(new Error(`timed out: ${label}`));
      setTimeout(poll, 20);
    };
    void poll();
  });
}

/** An OpenAI-shaped realtime client: events in order, and the close. */
function realtimeClient(url, options) {
  const socket = new WebSocket(url, options.protocols ?? [], { headers: options.headers ?? {} });
  const events = [];
  const state = { closed: null, refused: null };
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  socket.on("close", (code, reason) => {
    state.closed = { code, reason: reason.toString() };
  });
  socket.on("unexpected-response", (_request, response) => {
    state.refused = response.statusCode;
  });
  socket.on("error", () => {});
  const send = (event) => socket.send(JSON.stringify(event));
  const next = (type) => waitFor(() => events.find((event) => event.type === type), type);
  return { socket, events, state, send, next };
}

const userId = randomUUID();
const ids = {
  pool: randomUUID(),
  config: randomUUID(),
  revision: randomUUID(),
  plan: randomUUID(),
  run: randomUUID(),
  instance: randomUUID(),
  node: randomUUID(),
};
let db;
let server;
let cli;
let heartbeat;
try {
  const serverEntry = resolve(process.env.WSMP_E2E_SERVER_ENTRY || "apps/server/dist/index.mjs");
  await access(serverEntry);
  const protocolVersion = await relayProtocolVersion();
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
  const serverPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}`;

  // Seed rows bypass the graph-write fence triggers (test fixtures only), like
  // createFixturePrismaClient (packages/db/src/test-fixture-client.ts).
  db = new pg.Pool({ connectionString: databaseUrl, max: 1, options: "-c wsmp.fences=,*," });
  await db.query(
    `INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug, "emailVerified", role, locale)
   VALUES ($1, now(), now(), $2, $3, $4, true, 'user', 'en-US')`,
    [userId, "Realtime E2E", `realtime-e2e-${userId}@invalid.test`, `e2e-${userId}`],
  );
  await db.query(
    `INSERT INTO cli_token (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
   VALUES ($1, now(), now(), $2, $3, $4, $5)`,
    [randomUUID(), userId, "Realtime E2E", cliCredential.lookupPrefix, cliCredential.digest],
  );
  const modelTokenId = randomUUID();
  await db.query(
    `INSERT INTO model_api_token (id, "createdAt", "updatedAt", "userId", name, "scopeMode", "lookupPrefix", "secretDigest")
   VALUES ($1, now(), now(), $2, $3, 'ALL_VISIBLE', $4, $5)`,
    [modelTokenId, userId, "Realtime E2E", modelCredential.lookupPrefix, modelCredential.digest],
  );

  const childBaseEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
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
  await waitFor(
    async () => {
      if (server.exitCode !== null) throw new Error(`WSMP server exited early:\n${serverLog}`);
      const response = await fetch(`${serverUrl}/v1/models`, {
        headers: { authorization: `Bearer ${modelCredential.secret}` },
        signal: AbortSignal.timeout(1_000),
      }).catch(() => null);
      return response?.ok;
    },
    "server readiness",
    30_000,
  );

  // ---- the fake CLI ----
  const identity = helloIdentity();
  const cliFrames = [];
  const sessions = new Map();
  const cliState = { registered: false, inventoryOk: 0 };
  /** What the fake engine does for the next `stt.open`. */
  const behaviour = { refuseNextOpen: null };
  cli = new WebSocket(`${wsUrl}/api/cli/ws`, [RELAY_SUBPROTOCOL], {
    headers: { authorization: `Bearer ${cliCredential.secret}` },
  });
  const cliSend = (frame) => cli.send(JSON.stringify(frame));
  const managedEndpoint = {
    slug: endpointSlug,
    deploymentInstanceId: ids.instance,
    label: "Live ASR (fake engine)",
    kind: "openai-compatible",
    status: "online",
    defaultCapabilities: {
      version: 2,
      protocol: "openai-compatible",
      audio: {
        transcriptions: {
          supported: true,
          realtime: { supported: true, adapter: "segmented", maxItemSeconds: 30 },
        },
      },
    },
    models: [{ upstreamModelId: upstreamModel }],
  };
  cli.on("message", (data, binary) => {
    if (binary) {
      const { metadata, body } = parseBinaryFrame(data);
      cliFrames.push({ type: metadata.type, seq: metadata.seq, bytes: body.length });
      const session = sessions.get(metadata.sessionId);
      assert(session, "audio for an unknown session");
      assert.equal(metadata.seq, session.nextSeq, "audio seq must increase by exactly one");
      session.nextSeq += 1;
      session.audio.push(body);
      cliSend({ type: "stt.audio.ack", sessionId: metadata.sessionId, bytes: body.length });
      return;
    }
    const frame = JSON.parse(data.toString());
    cliFrames.push(frame);
    switch (frame.type) {
      case "hello.challenge":
        cliSend({
          type: "hello",
          id: randomUUID(),
          protocolVersion,
          cli: {
            slug: cliSlug,
            hostname: "realtime-e2e",
            identityPublicKey: identity.publicKey,
            identitySignature: identity.sign(frame.nonce, cliSlug, frame.origin),
            capabilities: {
              terminalPublicKey: identity.publicKey,
              features: {
                humanTerminal: false,
                mcpCommandMode: "off",
                terminalApproval: false,
                terminalSupported: false,
                remoteMetricSources: false,
                remoteEngineAdapters: false,
                mcpFileRead: false,
                fileRootsConfigured: false,
                allowFileToolsAsRoot: false,
              },
            },
          },
          endpoints: [],
        });
        return;
      case "hello.ok":
        cliState.registered = true;
        return;
      case "inventory.ok":
        cliState.inventoryOk += 1;
        return;
      case "stt.open": {
        if (behaviour.refuseNextOpen) {
          const failure = behaviour.refuseNextOpen;
          behaviour.refuseNextOpen = null;
          cliSend({ type: "stt.error", sessionId: frame.sessionId, failure });
          return;
        }
        sessions.set(frame.sessionId, { open: frame, nextSeq: 0, audio: [], closed: null });
        cliSend({ type: "stt.opened", sessionId: frame.sessionId });
        return;
      }
      case "stt.commit": {
        const session = sessions.get(frame.sessionId);
        const words = transcriptPrivacyMarker.split(" ");
        cliSend({
          type: "stt.event",
          sessionId: frame.sessionId,
          event: { kind: "delta", itemSeq: frame.itemSeq, text: `${words[0]} ` },
        });
        cliSend({
          type: "stt.event",
          sessionId: frame.sessionId,
          event: {
            kind: "completed",
            itemSeq: frame.itemSeq,
            text: transcriptPrivacyMarker,
            engineUsage: { inputTokens: 21, outputTokens: 7 },
          },
        });
        if (session) session.committed = frame.itemSeq;
        return;
      }
      case "stt.close": {
        const session = sessions.get(frame.sessionId);
        if (session) session.closed = frame.reason;
        cliSend({ type: "stt.closed", sessionId: frame.sessionId });
        return;
      }
      default:
    }
  });
  cli.on("error", () => {});
  await waitFor(() => cliState.registered, "CLI registration");
  heartbeat = setInterval(() => {
    if (cli.readyState === WebSocket.OPEN) cliSend({ type: "heartbeat", id: randomUUID() });
  }, 10_000);

  // ---- recipe-managed deployment ownership, as the reconciler would hold it ----
  const device = await db.query(`SELECT id FROM cli_device WHERE "userId" = $1 AND slug = $2`, [
    userId,
    cliSlug,
  ]);
  const cliDeviceId = device.rows[0]?.id;
  assert(cliDeviceId, "the fake CLI did not register a device");
  // A recipe is attached to a pool (detached recipes cannot start instances).
  await db.query(
    `INSERT INTO model_pool (id, "createdAt", "updatedAt", "userId", slug, name)
     VALUES ($1, now(), now(), $2, $3, 'Live ASR recipe pool')`,
    [ids.pool, userId, `live-asr-pool-${randomBytes(4).toString("hex")}`],
  );
  await db.query(
    `INSERT INTO deployment_config (id, "userId", "poolId", slug, name)
     VALUES ($1, $2, $3, $4, 'Live ASR')`,
    [ids.config, userId, ids.pool, `live-asr-${randomBytes(4).toString("hex")}`],
  );
  await db.query(
    `INSERT INTO deployment_config_revision
       (id, "configId", revision, "editorId", "editorKind", "contentHash", spec)
     VALUES ($1, $2, 1, $3, 'USER', $4, $5)`,
    [
      ids.revision,
      ids.config,
      userId,
      "a".repeat(64),
      JSON.stringify({ variants: [{ key: "one", models: [upstreamModel] }] }),
    ],
  );
  await db.query(
    `INSERT INTO deployment_plan
       (id, "userId", "requesterId", "requesterKind", state, "expiresAt", fingerprint, contents)
     VALUES ($1, $2, $2, 'USER', 'APPLIED', now() + interval '1 hour', $3, $4)`,
    [ids.plan, userId, "b".repeat(64), JSON.stringify({ affectedNodeIds: [cliDeviceId] })],
  );
  await db.query(`INSERT INTO deployment_run (id, "planId") VALUES ($1, $2)`, [ids.run, ids.plan]);
  await db.query(
    `INSERT INTO deployment_instance
       (id, "userId", "configId", "revisionId", "runId", "variantKey", "endpointSlug",
        "startedBy", "desiredState", "observedState")
     VALUES ($1, $2, $3, $4, $5, 'one', $6, 'USER', 'RUNNING', 'RUNNING')`,
    [ids.instance, userId, ids.config, ids.revision, ids.run, endpointSlug],
  );
  await db.query(
    `INSERT INTO deployment_instance_node
       (id, "instanceId", "cliDeviceId", rank, port, resources, "claimHeld")
     VALUES ($1, $2, $3, 0, 30000, $4, true)`,
    [
      ids.node,
      ids.instance,
      cliDeviceId,
      JSON.stringify({ kind: "unified", memoryGb: 1, ramGb: 0, gpus: [] }),
    ],
  );
  cliSend({ type: "inventory.update", id: randomUUID(), endpoints: [managedEndpoint] });
  await waitFor(() => cliState.inventoryOk > 0, "managed inventory");

  const liveModel = await waitFor(async () => {
    const response = await fetch(`${serverUrl}/v1/models`, {
      headers: { authorization: `Bearer ${modelCredential.secret}` },
    });
    const listed = await response.json();
    return listed.data?.find(
      (model) =>
        model.supports_realtime_transcription === true && model.id.endsWith(`/${upstreamModel}`),
    )?.id;
  }, "the live model in /v1/models");
  const realtimeUrl = `${wsUrl}/v1/realtime?intent=transcription&model=${encodeURIComponent(liveModel)}`;
  const bearer = { authorization: `Bearer ${modelCredential.secret}` };

  // ---- upgrade refusals: no credential, a credential in the URL ----
  const anonymous = realtimeClient(realtimeUrl, {});
  await waitFor(() => anonymous.state.refused, "anonymous refusal");
  assert.equal(anonymous.state.refused, 401);
  const keyInUrl = realtimeClient(`${realtimeUrl}&api_key=${modelCredential.secret}`, {});
  await waitFor(() => keyInUrl.state.refused, "key-in-URL refusal");
  assert.equal(keyInUrl.state.refused, 400);

  // ---- session 1: bearer header, one committed item, client close ----
  const first = realtimeClient(realtimeUrl, { headers: bearer });
  await first.next("session.created");
  await waitFor(() => sessions.size === 1, "stt.open on the CLI");
  const firstSession = [...sessions.values()][0];
  assert.equal(firstSession.open.adapter, "segmented");
  assert.equal(firstSession.open.endpointSlug, endpointSlug);
  assert.equal(firstSession.open.upstreamModel, upstreamModel);
  // 0.25 s of 24 kHz s16 mono, carrying a privacy marker in the samples.
  const pcm = Buffer.alloc(12_000);
  Buffer.from(audioPrivacyMarker).copy(pcm, 64);
  for (let offset = 0; offset < pcm.length; offset += 2_400) {
    first.send({
      type: "input_audio_buffer.append",
      audio: pcm.subarray(offset, offset + 2_400).toString("base64"),
    });
  }
  first.send({ type: "input_audio_buffer.commit" });
  const committed = await first.next("input_audio_buffer.committed");
  const delta = await first.next("conversation.item.input_audio_transcription.delta");
  const completed = await first.next("conversation.item.input_audio_transcription.completed");
  await first.next("conversation.item.done");
  assert.equal(delta.item_id, committed.item_id);
  assert.equal(completed.item_id, committed.item_id);
  assert.equal(completed.transcript, transcriptPrivacyMarker);
  assert.deepEqual(completed.usage, { type: "duration", seconds: 0.25 });
  assert.deepEqual(Buffer.concat(firstSession.audio), pcm, "audio must reach the CLI intact");
  // 2 400 B appends are coalesced into 4 800 B frames; the remainder is
  // flushed ahead of the commit.
  assert.deepEqual(
    cliFrames.filter((frame) => frame.type === "stt.audio").map((frame) => frame.bytes),
    [4_800, 4_800, 2_400],
  );
  const closedAt = Date.now();
  first.socket.close(1000);
  await waitFor(() => firstSession.closed, "stt.close after the client closed", 2_000);
  assert.equal(firstSession.closed, "cancelled");
  assert(Date.now() - closedAt < 2_000);

  // ---- session 2: browser subprotocol credential, the key is never echoed ----
  const browser = realtimeClient(`${wsUrl}/v1/realtime?intent=transcription`, {
    protocols: ["realtime", `openai-insecure-api-key.${modelCredential.secret}`],
  });
  const created = await browser.next("session.created");
  assert.equal(browser.socket.protocol, "realtime");
  assert.equal(created.session.audio.input.transcription.model, null);
  browser.send({
    type: "session.update",
    session: {
      type: "transcription",
      audio: { input: { turn_detection: { type: "server_vad" } } },
    },
  });
  const vad = await browser.next("error");
  assert.equal(vad.error.code, "unsupported_parameter");
  assert.equal(vad.error.param, "session.audio.input.turn_detection");
  browser.socket.close(1000);

  // ---- session 3: a member refuses its open at capacity (no health mark) ----
  behaviour.refuseNextOpen = "rate_limited";
  const busy = realtimeClient(realtimeUrl, { headers: bearer });
  await waitFor(() => busy.state.closed, "busy close");
  assert.equal(busy.state.closed.code, 1013);
  assert.equal(busy.events.find((event) => event.type === "error")?.error.code, "server_busy");

  // ---- session 3b: Chat Test, signed in with the dashboard cookie ----
  // The same live session behind the dashboard session: attributed as HTTP
  // Chat Test (source CHAT_TEST, no token), refused cross-site and signed out.
  const dashboardSessionId = randomUUID();
  const dashboardToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO session (id, "createdAt", "updatedAt", "expiresAt", token, "userId")
     VALUES ($1, now(), now(), now() + interval '1 hour', $2, $3)`,
    [dashboardSessionId, dashboardToken, userId],
  );
  const dashboardSignature = createHmac("sha256", betterAuthSecret)
    .update(dashboardToken)
    .digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${dashboardToken}.${dashboardSignature}`)}`;
  const chatTestUrl = `${wsUrl}/api/internal/chat-test/realtime?intent=transcription&model=${encodeURIComponent(liveModel)}`;
  const crossSite = realtimeClient(chatTestUrl, {
    headers: { cookie, origin: "https://evil.example" },
  });
  await waitFor(() => crossSite.state.refused, "cross-site refusal");
  assert.equal(crossSite.state.refused, 403);
  const signedOut = realtimeClient(chatTestUrl, { headers: { origin: serverUrl } });
  await waitFor(() => signedOut.state.refused, "signed-out refusal");
  assert.equal(signedOut.state.refused, 401);
  const chatTest = realtimeClient(chatTestUrl, { headers: { cookie, origin: serverUrl } });
  await chatTest.next("session.created");
  assert.equal(chatTest.socket.protocol, "");
  await waitFor(() => sessions.size === 2, "stt.open for the Chat Test session");
  for (let offset = 0; offset < pcm.length; offset += 2_400) {
    chatTest.send({
      type: "input_audio_buffer.append",
      audio: pcm.subarray(offset, offset + 2_400).toString("base64"),
    });
  }
  chatTest.send({ type: "input_audio_buffer.commit" });
  const chatTestCompleted = await chatTest.next(
    "conversation.item.input_audio_transcription.completed",
  );
  assert.equal(chatTestCompleted.transcript, transcriptPrivacyMarker);
  chatTest.socket.close(1000);
  await waitFor(() => [...sessions.values()][1].closed, "Chat Test stt.close", 2_000);

  // ---- session 4: the CLI disconnects mid-session ----
  const doomed = realtimeClient(realtimeUrl, { headers: bearer });
  await doomed.next("session.created");
  await waitFor(() => sessions.size === 3, "third stt.open");
  doomed.send({
    type: "input_audio_buffer.append",
    audio: pcm.subarray(0, 4_800).toString("base64"),
  });
  await waitFor(
    () =>
      cliFrames.filter((frame) => frame.type === "stt.audio").length > 0 &&
      [...sessions.values()][2].audio.length > 0,
    "audio of the second session",
  );
  clearInterval(heartbeat);
  cli.terminate();
  await waitFor(() => doomed.state.closed, "client close after the CLI left");
  assert.equal(doomed.state.closed.code, 1011);
  assert.equal(
    doomed.events.find((event) => event.type === "error")?.error.code,
    "upstream_disconnected",
  );

  // ---- metering: one row per opened session, rollups with audio ----
  const rows = await waitFor(async () => {
    const result = await db.query(
      `SELECT * FROM relay_request WHERE "userId" = $1 AND operation = 'audio.realtime_transcription'
        ORDER BY "createdAt" ASC`,
      [userId],
    );
    return result.rows.length === 3 && result.rows.every((row) => row.status !== "PENDING")
      ? result.rows
      : null;
  }, "finalized live session rows");
  const [served, chatTestRow, failed] = rows;
  assert.equal(chatTestRow.source, "CHAT_TEST");
  assert.equal(chatTestRow.modelApiTokenId, null);
  assert.equal(chatTestRow.status, "SUCCEEDED");
  assert.equal(chatTestRow.audioInputMs, 250);
  assert.equal(served.status, "SUCCEEDED");
  assert.equal(served.errorClass, null);
  assert.equal(served.audioInputMs, 250);
  assert.equal(Number(served.requestBytes), 12_000);
  assert.equal(served.promptTokens, 21);
  assert.equal(served.completionTokens, 7);
  assert.equal(served.modelApiTokenId, modelTokenId);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.errorClass, "upstream_disconnected");
  assert.equal(failed.audioInputMs, 100);
  const rollup = await waitFor(async () => {
    const result = await db.query(
      `SELECT sum("audioInputMs")::bigint AS audio, sum(requests)::int AS requests
         FROM usage_rollup_minute WHERE "requesterUserId" = $1`,
      [userId],
    );
    return Number(result.rows[0]?.requests) === 3 ? result.rows[0] : null;
  }, "usage rollups");
  assert.equal(Number(rollup.audio), 600);

  // ---- privacy: no audio or transcript in logs or stored metadata ----
  const haystacks = [serverLog, JSON.stringify(rows)];
  for (const marker of [audioPrivacyMarker, transcriptPrivacyMarker]) {
    assert(
      haystacks.every((haystack) => !haystack.includes(marker)),
      `private live transcription marker leaked into logs or metadata: ${marker}`,
    );
  }
  process.stdout.write("realtime transcription relay E2E passed\n");
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (cli && cli.readyState === WebSocket.OPEN) cli.terminate();
  if (server) await waitForExit(server, "server");
  if (db) {
    // policy: bounded-delete -- generated test rows only, children first.
    await db
      .query(`DELETE FROM deployment_instance_node WHERE id = $1`, [ids.node])
      .catch(() => undefined);
    await db
      .query(`DELETE FROM deployment_instance WHERE id = $1`, [ids.instance])
      .catch(() => undefined);
    await db.query(`DELETE FROM deployment_run WHERE id = $1`, [ids.run]).catch(() => undefined);
    await db.query(`DELETE FROM deployment_plan WHERE id = $1`, [ids.plan]).catch(() => undefined);
    await db
      .query(`DELETE FROM deployment_config_revision WHERE id = $1`, [ids.revision])
      .catch(() => undefined);
    await db
      .query(`DELETE FROM deployment_config WHERE id = $1`, [ids.config])
      .catch(() => undefined);
    for (const table of ["usage_rollup_minute", "usage_rollup_hour"]) {
      await db
        .query(`DELETE FROM ${table} WHERE "ownerUserId" = $1 OR "requesterUserId" = $1`, [userId])
        .catch(() => undefined); // policy: bounded-delete -- generated test user's rollups only
    }
    await db
      .query(`DELETE FROM relay_request WHERE "userId" = $1`, [userId])
      .catch(() => undefined); // policy: bounded-delete -- generated test user's rows only
    await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined); // policy: bounded-delete -- generated test user only
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
