import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";
import { startCloudflareLikeProxy } from "./lib/cloudflare-like-proxy.mjs";
import {
  eventually,
  pg,
  requiredEnv,
  rpcClient,
  signUp,
  startNode,
  startServer,
  waitForReadyRuntime,
} from "./lib/stack.mjs";

// The server behind a Cloudflare-like proxy (100 MB request bodies, 524 after 100 s without an
// origin byte), at Cloudflare's real timings and the server's default settings: slow
// non-streaming and streaming chat answers survive through the commit keepalive, pool failover
// still works after the commit, a failure after it arrives in the body, opting out reproduces
// the 524, and transcription uploads under the default caps fit through the edge while an
// oversized one gets the server's JSON 413 (with the admin attachment policy raised). Takes about 2.5 minutes.

const databaseUrl = requiredEnv("WSMP_E2E_DATABASE_URL");
const IDLE_MS = 100_000;
const SLOW_MS = 130_000;
const FAIL_AFTER_MS = 40_000;
const MiB = 1024 * 1024;
const scratch = await mkdtemp(join(tmpdir(), "wsmp-cloudflare-e2e-"));
let db;
let server;
let upstream;
let relay;
let proxy;
let userId;
let failureLogs;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

try {
  const slowModel = "slow-llm";
  const failingModel = "failing-llm";
  const asrModel = "mock-asr";
  let transcriptionBytes = 0;
  /** Upstream models tried for the failover scenario's request, in order. */
  const failoverAttempts = [];

  upstream = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: [slowModel, failingModel, asrModel].map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/audio/transcriptions") {
      for await (const chunk of request) transcriptionBytes += chunk.byteLength;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "ok" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const content = body.messages?.[0]?.content ?? "";
    const delay = Number(/delay:(\d+)/.exec(content)?.[1] ?? 0);
    if (content.includes("failover")) failoverAttempts.push(body.model);
    let closed = false;
    response.once("close", () => {
      closed = true;
    });
    if (body.model === failingModel) {
      await sleep(FAIL_AFTER_MS);
      if (closed) return;
      response.setHeader("content-type", "application/json");
      response.writeHead(503).end(JSON.stringify({ error: { message: "engine overloaded" } }));
      return;
    }
    if (body.stream) {
      // Headers at once, then a long silent prefill before the first token.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      await sleep(delay);
      if (closed) return;
      const chunk = (content) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: 1,
          model: slowModel,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`;
      response.write(chunk("slow "));
      response.end(`${chunk("stream")}data: [DONE]\n\n`);
      return;
    }
    if (content.includes("early-headers")) {
      // Headers at once, then a silent body: some engines answer like this.
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
    } else response.setHeader("content-type", "application/json");
    await sleep(delay);
    if (closed) return;
    response.end(
      JSON.stringify({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: 1,
        model: slowModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "slow answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  });
  await new Promise((resolveListen, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolveListen);
  });
  const upstreamPort = upstream.address().port;

  // Server defaults for the keepalive and the transcription caps; only the proxy hop is set.
  server = await startServer({
    databaseUrl,
    extraEnv: {
      TRUST_PROXY_HOPS: "1",
      MODEL_API_TRANSCRIPTION_SPOOL_DIR: join(scratch, "spool"),
    },
  });
  const serverUrl = server.url;
  failureLogs = () => `server:\n${server.log.text}`;
  const person = await signUp(serverUrl, "cloudflare-e2e");
  userId = person.userId;
  const client = await rpcClient(serverUrl, person.cookie);
  const node = await startNode({
    client,
    serverUrl,
    scratch: join(scratch, "node"),
    slug: "cloudflare-e2e",
  });
  relay = node.child;
  failureLogs = () => `server:\n${server.log.text}\nwsmp:\n${node.log.text}`;
  const logs = failureLogs;

  const runtime = async (slug, modelType, models) => {
    const created = await client.runtimes.create({
      slug,
      name: slug,
      kind: "ALWAYS_ON",
      nodeId: node.nodeId,
      spec: {
        api: "openai",
        engine: "other",
        modelType,
        models,
        address: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
      },
    });
    return waitForReadyRuntime(client, created.runtime.id, logs);
  };
  const llm = await runtime("mock-llm", "llm", [{ id: slowModel }, { id: failingModel }]);
  const asr = await runtime("mock-asr", "transcription", [{ id: asrModel, transcription: {} }]);
  const served = (ready, id) => ready.servedModels.find((model) => model.upstreamModelId === id);

  const pool = async (slug, type, members) =>
    client.pools.create({
      slug,
      name: slug,
      type,
      members: members.map((member) => ({ runtimeModelId: member.id })),
    });
  const slowPool = await pool("slow", "LLM", [served(llm, slowModel)]);
  const failingPool = await pool("failing", "LLM", [served(llm, failingModel)]);
  const failoverPool = await pool("failover", "LLM", [
    served(llm, failingModel),
    served(llm, slowModel),
  ]);
  const failing = failoverPool.members.find((member) => member.upstreamModelId === failingModel);
  const healthy = failoverPool.members.find((member) => member.upstreamModelId === slowModel);
  await client.pools.update({
    poolId: failoverPool.id,
    members: {
      set: [
        { memberId: failing.id, weight: 100 },
        { memberId: healthy.id, weight: 1 },
      ],
    },
  });
  const asrPool = await pool("asr", "TRANSCRIPTION", [served(asr, asrModel)]);
  const { secret: apiKey } = await client.access.apiKeys.create({
    name: "Cloudflare E2E",
    scope: "ALL_POOLS",
    poolIds: [],
    expiresAt: null,
  });
  const model = (created) => created.callableIds[0];
  await eventually(`pools were not listed by /v1/models\n${logs()}`, async () => {
    const response = await fetch(`${serverUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    if (!response?.ok) return false;
    const ids = new Set(((await response.json().catch(() => null))?.data ?? []).map((m) => m.id));
    return [slowPool, failingPool, failoverPool, asrPool].every((p) => ids.has(model(p)));
  });

  proxy = await startCloudflareLikeProxy({ target: serverUrl, idleMs: IDLE_MS });
  const chat = (pooled, { delay, stream = false, headers = {}, tag = "" }) =>
    fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: model(pooled),
        stream,
        messages: [{ role: "user", content: `delay:${delay} ${tag}` }],
      }),
      signal: AbortSignal.timeout(5 * 60_000),
    });

  const scenarios = {
    async nonStreaming() {
      const response = await chat(slowPool, { delay: SLOW_MS });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("x-wsmp-keepalive"), "1");
      assert.match(text, /^\n+\{/, "the committed body starts with JSON-safe whitespace");
      assert.equal(JSON.parse(text).choices[0].message.content, "slow answer");
    },
    async earlyHeadersSlowJson() {
      const response = await chat(slowPool, { delay: SLOW_MS, tag: "early-headers" });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /^\n+\{/, "the slow body is preceded by JSON-safe whitespace");
      assert.equal(JSON.parse(text).choices[0].message.content, "slow answer");
    },
    async streaming() {
      const response = await chat(slowPool, { delay: SLOW_MS, stream: true });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /^(: keepalive\n\n)+data: /, "silent prefill kept alive by comments");
      assert.match(text, /"slow "[\s\S]*"stream"[\s\S]*data: \[DONE\]/);
    },
    async failoverAfterCommit() {
      const response = await chat(failoverPool, { delay: 5_000, tag: "failover" });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("x-wsmp-keepalive"), "1");
      assert.equal(JSON.parse(text).choices[0].message.content, "slow answer");
      // The failing member answered 503 only after the commit (40 s > 30 s); the pool then
      // retried the healthy member.
      assert.deepEqual(failoverAttempts, [failingModel, slowModel]);
    },
    async failureAfterCommit() {
      const response = await chat(failingPool, { delay: 0 });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("x-wsmp-keepalive"), "1");
      const error = JSON.parse(text).error;
      assert(error?.message, `expected an in-body error, got ${text}`);
      assert(error.status >= 500, `expected a 5xx error.status, got ${text}`);
    },
    async optOutReproduces524() {
      const response = await chat(slowPool, {
        delay: SLOW_MS,
        headers: { "x-wsmp-keepalive": "off" },
      });
      await response.text();
      assert.equal(response.status, 524, "without the keepalive the edge times the request out");
    },
  };
  const startedAt = Date.now();
  const outcomes = await Promise.allSettled(
    Object.entries(scenarios).map(async ([name, run]) => {
      try {
        await run();
      } catch (error) {
        throw new Error(`${name}: ${error.message}`);
      }
    }),
  );
  const failed = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(failed.length, 0, failed.map((outcome) => outcome.reason.message).join("\n"));
  assert(Date.now() - startedAt > IDLE_MS, "the slow scenarios outlasted the edge idle timeout");
  assert.equal(proxy.stats.timeouts524, 1, "only the opted-out request hit a 524");
  assert.equal(proxy.stats.cutAfterHeaders, 0);

  // Transcription uploads at the default deployment caps (90 MiB file, 91 MiB request). The
  // admin attachment policy (25 MiB by default) narrows them; raise it to the maximum so the
  // deployment caps decide. The harness's person is the instance's first user, hence admin.
  await client.adminSettings.update({ mediaAttachmentMaxBytes: 2 ** 31 - 1 });
  const upload = (bytes) => {
    const form = new FormData();
    form.append("model", model(asrPool));
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "a.wav");
    return fetch(`${proxy.url}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  };
  const fits = await upload(89 * MiB);
  assert.equal(fits.status, 200, await fits.clone().text());
  assert.deepEqual(await fits.json(), { text: "ok" });
  assert(transcriptionBytes > 89 * MiB, "the upload reached the runtime");
  const overServer = await upload(92 * MiB);
  assert.equal(overServer.status, 413);
  const overServerBody = await overServer.json();
  assert.equal(overServerBody.error.code, "request_too_large");
  assert.match(overServerBody.error.message, /up to 95420416 bytes .* up to 94371840 bytes/);
  const overEdge = await upload(101_000_000);
  assert.equal(overEdge.status, 413);
  assert.match(await overEdge.text(), /<html>/, "the edge's own 413 for a body over 100 MB");

  process.stdout.write("cloudflare limits E2E passed\n");
} catch (error) {
  if (process.env.WSMP_E2E_VERBOSE && failureLogs) process.stderr.write(failureLogs());
  throw error;
} finally {
  if (proxy) await proxy.close();
  if (relay) await waitForExit(relay, "wsmp");
  if (server) await waitForExit(server.child, "server");
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
  if (userId) {
    db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined); // policy: bounded-delete -- generated test user only
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
