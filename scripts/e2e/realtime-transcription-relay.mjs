import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";
import {
  eventually,
  pg,
  requiredEnv,
  root,
  rpcClient,
  signUp,
  startNode,
  startServer,
  waitForReadyRuntime,
} from "./lib/stack.mjs";

// Live transcription (`/v1/realtime?intent=transcription`) full stack: a prebuilt WMP server on
// an isolated Postgres database, a real `wsmp` node, and a mock speech-to-text server as an
// always-on runtime whose served model declares a `segmented` live profile. `wsmp` collects
// each committed turn and posts it to the mock's `/v1/audio/transcriptions` as a WAV file.
// Setup uses the browser's own paths (sign-up, oRPC, enrollment code, `wsmp login`). The
// relay wire itself (audio frames, credits, seq) is covered by the server's stt tests and
// `wsmp`'s own tests against fake engines.

const requireFromServer = createRequire(join(root, "apps/server/package.json"));
const { WebSocket } = requireFromServer("ws");

const databaseUrl = requiredEnv("WSMP_E2E_DATABASE_URL");
const scratch = await mkdtemp(join(tmpdir(), "wsmp-realtime-e2e-"));
const upstreamModel = "live-asr-e2e";
const nodeSlug = `rt-${randomUUID().slice(0, 8)}`;
const transcriptPrivacyMarker = `private live transcript ${randomUUID()}`;
const audioPrivacyMarker = `PRIVATE_LIVE_AUDIO_${randomUUID().replaceAll("-", "")}`;

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
  const next = (type) =>
    waitFor(() => events.find((event) => event.type === type), type).catch((error) => {
      throw new Error(`${error.message}; events: ${JSON.stringify(events).slice(0, 2_000)}`);
    });
  return { socket, events, state, send, next };
}

/** One committed turn: 0.25 s of 24 kHz s16 mono in 2 400 B appends, carrying a marker. */
function sendTurn(client, pcm) {
  for (let offset = 0; offset < pcm.length; offset += 2_400) {
    client.send({
      type: "input_audio_buffer.append",
      audio: pcm.subarray(offset, offset + 2_400).toString("base64"),
    });
  }
  client.send({ type: "input_audio_buffer.commit" });
}

let db;
let server;
let upstream;
let relay;
let userId;
let failureLogs;
try {
  // ---- the mock speech-to-text server ----
  const uploads = [];
  upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ object: "list", data: [{ id: upstreamModel, object: "model" }] }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const wire = Buffer.concat(chunks).toString("latin1");
    uploads.push({
      model: /name="model"\r\n\r\n([^\r]+)\r\n/.exec(wire)?.[1],
      wav: wire.includes("RIFF") && wire.includes("WAVE"),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: transcriptPrivacyMarker }));
  });
  await new Promise((resolveListen, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const upstreamPort = upstream.address().port;

  // ---- server, person, node, runtime, pool and API key ----
  server = await startServer({ databaseUrl });
  const serverUrl = server.url;
  const wsUrl = serverUrl.replace("http", "ws");
  failureLogs = () => `server:\n${server.log.text}`;
  const person = await signUp(serverUrl, "realtime-e2e");
  userId = person.userId;
  const client = await rpcClient(serverUrl, person.cookie);
  const node = await startNode({
    client,
    serverUrl,
    scratch: join(scratch, "node"),
    slug: nodeSlug,
  });
  relay = node.child;
  failureLogs = () => `server:\n${server.log.text}\nwsmp:\n${node.log.text}`;
  const logs = failureLogs;
  db = new pg.Pool({ connectionString: databaseUrl, max: 1 });

  const runtime = await client.runtimes.create({
    slug: "live-asr",
    name: "Live ASR (mock)",
    kind: "ALWAYS_ON",
    nodeId: node.nodeId,
    spec: {
      api: "openai",
      engine: "other",
      modelType: "transcription",
      models: [
        {
          id: upstreamModel,
          transcription: { realtime: { adapter: "segmented", maxItemSeconds: 30, maxSessions: 1 } },
        },
      ],
      address: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
    },
  });
  const ready = await waitForReadyRuntime(client, runtime.runtime.id, logs);
  const servedModel = ready.servedModels.find((model) => model.upstreamModelId === upstreamModel);
  assert(servedModel, "the served model is missing");
  const pool = await client.pools.create({
    slug: "live-asr",
    name: "Live ASR",
    type: "TRANSCRIPTION",
    members: [{ runtimeModelId: servedModel.id }],
  });
  const { key: apiKeyView, secret: apiKey } = await client.access.apiKeys.create({
    name: "Realtime E2E",
    scope: "ALL_POOLS",
    poolIds: [],
    expiresAt: null,
  });

  const liveModel = pool.callableIds[0];
  await eventually(`${liveModel} was not advertised as live\n${logs()}`, async () => {
    const response = await fetch(`${serverUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    const listed = response?.ok ? await response.json().catch(() => null) : null;
    return listed?.data?.some(
      (model) => model.id === liveModel && model.supports_realtime_transcription === true,
    );
  });
  const realtimeUrl = `${wsUrl}/v1/realtime?intent=transcription&model=${encodeURIComponent(liveModel)}`;
  const bearer = { authorization: `Bearer ${apiKey}` };
  const pcm = Buffer.alloc(12_000);
  Buffer.from(audioPrivacyMarker).copy(pcm, 64);

  // ---- upgrade refusals: no credential, a credential in the URL ----
  const anonymous = realtimeClient(realtimeUrl, {});
  await waitFor(() => anonymous.state.refused, "anonymous refusal");
  assert.equal(anonymous.state.refused, 401);
  const keyInUrl = realtimeClient(`${realtimeUrl}&api_key=${apiKey}`, {});
  await waitFor(() => keyInUrl.state.refused, "key-in-URL refusal");
  assert.equal(keyInUrl.state.refused, 400);

  // ---- session 1: bearer header, one committed turn ----
  const first = realtimeClient(realtimeUrl, { headers: bearer });
  await first.next("session.created");
  sendTurn(first, pcm);
  const committed = await first.next("input_audio_buffer.committed");
  const completed = await first.next("conversation.item.input_audio_transcription.completed");
  await first.next("conversation.item.done");
  assert.equal(completed.item_id, committed.item_id);
  assert.equal(completed.transcript, transcriptPrivacyMarker);
  assert.deepEqual(completed.usage, { type: "duration", seconds: 0.25 });
  assert.deepEqual(uploads, [{ model: upstreamModel, wav: true }], "one WAV upload per turn");

  // ---- session 2 while session 1 is open: the instance serves at most 1 (maxSessions) ----
  // The engine session opens on the node with the first audio, so the refusal comes then.
  const busy = realtimeClient(realtimeUrl, { headers: bearer });
  await busy.next("session.created");
  sendTurn(busy, pcm);
  await waitFor(() => busy.state.closed, `busy close; events: ${JSON.stringify(busy.events)}`);
  assert.equal(busy.state.closed.code, 1013);
  assert.equal(busy.events.find((event) => event.type === "error")?.error.code, "server_busy");
  first.socket.close(1000);
  await waitFor(() => first.state.closed, "session 1 close");

  // ---- session 3: browser subprotocol credential, the key is never echoed ----
  const browser = realtimeClient(`${wsUrl}/v1/realtime?intent=transcription`, {
    protocols: ["realtime", `openai-insecure-api-key.${apiKey}`],
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
  await waitFor(() => browser.state.closed, "session 3 close");

  // ---- session 4: the Test page, signed in with the browser session ----
  const testUrl = `${wsUrl}/api/internal/chat-test/realtime?intent=transcription&model=${encodeURIComponent(liveModel)}`;
  const crossSite = realtimeClient(testUrl, {
    headers: { cookie: person.cookie, origin: "https://evil.example" },
  });
  await waitFor(() => crossSite.state.refused, "cross-site refusal");
  assert.equal(crossSite.state.refused, 403);
  const signedOut = realtimeClient(testUrl, { headers: { origin: serverUrl } });
  await waitFor(() => signedOut.state.refused, "signed-out refusal");
  assert.equal(signedOut.state.refused, 401);
  // The instance takes one session (maxSessions): the node frees session 1's slot once its
  // close arrives there, so a turn may meet the busy refusal first; try again until it lands.
  let testPage;
  const testCompleted = await eventually(
    "the Test page session got no transcript",
    async () => {
      testPage = realtimeClient(testUrl, { headers: { cookie: person.cookie, origin: serverUrl } });
      await testPage.next("session.created");
      assert.equal(testPage.socket.protocol, "");
      sendTurn(testPage, pcm);
      await waitFor(
        () =>
          testPage.state.closed ||
          testPage.events.find(
            (event) => event.type === "conversation.item.input_audio_transcription.completed",
          ),
        "Test page turn outcome",
        20_000,
      );
      return testPage.events.find(
        (event) => event.type === "conversation.item.input_audio_transcription.completed",
      );
    },
    { timeoutMs: 60_000, intervalMs: 1_000 },
  );
  assert.equal(testCompleted.transcript, transcriptPrivacyMarker);
  testPage.socket.close(1000);
  await waitFor(() => testPage.state.closed, "session 4 close");

  // ---- session 5: the node goes away mid-session ----
  const doomed = await eventually("the instance took no new session", async () => {
    // The instance frees its one session slot once session 4's close reaches the node.
    const attempt = realtimeClient(realtimeUrl, { headers: bearer });
    await waitFor(() => attempt.state.closed || attempt.events.length > 0, "open outcome");
    if (attempt.events.some((event) => event.type === "session.created")) return attempt;
    return null;
  });
  doomed.send({
    type: "input_audio_buffer.append",
    audio: pcm.subarray(0, 4_800).toString("base64"),
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  process.kill(-relay.pid, "SIGKILL");
  await waitFor(() => doomed.state.closed, "client close after the node left", 20_000);
  assert.equal(doomed.state.closed.code, 1011);
  assert.equal(
    doomed.events.find((event) => event.type === "error")?.error.code,
    "upstream_disconnected",
  );

  // ---- metering: one row per opened session, rollups with audio ----
  const rows = await waitFor(
    async () => {
      const result = await db.query(
        `SELECT * FROM relay_request WHERE "userId" = $1 AND operation = 'audio.realtime_transcription'
          ORDER BY "createdAt" ASC`,
        [userId],
      );
      const finished = result.rows.filter((row) => row.status !== "PENDING");
      return finished.length === result.rows.length && result.rows.length >= 3 ? result.rows : null;
    },
    "finalized live session rows",
    20_000,
  );
  // A refused open (session 2) may or may not leave a row; the three opened sessions do.
  const served = rows.find((row) => row.source === "API_KEY" && row.status === "SUCCEEDED");
  const testRow = rows.find((row) => row.source === "TEST");
  const failed = rows.at(-1);
  assert(served, "the first API-key session was not recorded");
  assert.equal(served.source, "API_KEY");
  assert.equal(served.apiKeyId, apiKeyView.id);
  assert.equal(served.poolId, pool.id);
  assert.equal(served.status, "SUCCEEDED");
  assert.equal(served.errorClass, null);
  assert.equal(served.audioInputMs, 250);
  assert.equal(Number(served.requestBytes), 12_000);
  assert(testRow, "the Test page session was not recorded");
  assert.equal(testRow.apiKeyId, null);
  assert.equal(testRow.status, "SUCCEEDED");
  assert.equal(testRow.audioInputMs, 250);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.errorClass, "upstream_disconnected");
  const rollup = await waitFor(async () => {
    const result = await db.query(
      `SELECT sum("audioInputMs")::bigint AS audio, sum(requests)::int AS requests
         FROM usage_rollup_minute WHERE "requesterUserId" = $1`,
      [userId],
    );
    return Number(result.rows[0]?.requests) === rows.length ? result.rows[0] : null;
  }, "usage rollups");
  assert(Number(rollup.audio) >= 500, `rollup audio ${rollup.audio}`);

  // ---- privacy: no audio or transcript in logs or stored metadata ----
  const haystacks = [server.log.text, node.log.text, JSON.stringify(rows)];
  for (const marker of [audioPrivacyMarker, transcriptPrivacyMarker]) {
    assert(
      haystacks.every((haystack) => !haystack.includes(marker)),
      `private live transcription marker leaked into logs or metadata: ${marker}`,
    );
  }
  process.stdout.write("realtime transcription relay E2E passed\n");
} catch (error) {
  if (process.env.WSMP_E2E_VERBOSE && failureLogs) process.stderr.write(failureLogs());
  throw error;
} finally {
  if (relay) await waitForExit(relay, "wsmp");
  if (server) await waitForExit(server.child, "server");
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
  if (db) {
    if (userId) await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined); // policy: bounded-delete -- generated test user only
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
