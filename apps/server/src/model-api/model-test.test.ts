import type { ModelTestServiceInput } from "@ws-model-proxy/api/context";
import { MCP_TOOLS } from "@ws-model-proxy/api/contracts";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("../rate-limit.js", () => ({ scaledPoints: (points: number) => points }));
vi.mock("../relay/session-manager.js", () => ({ relaySessionManager: {} }));
vi.mock("./limits.js", () => ({ modelApiConcurrencyLimiter: {} }));
vi.mock("./diagnostics.js", () => ({
  diagnosticsCapacityRuntime: vi.fn(),
  GENERIC_PROVIDER_ERROR_TYPE: "provider_error",
}));
vi.mock("./routes.js", () => ({ modelTestHandler: vi.fn() }));
vi.mock("./resolve.js", () => ({
  testTargetModelId: (runtimeId: string, model: string) => `runtime:${runtimeId}:${model}`,
}));
vi.mock("./capacity/request-scope.js", () => ({
  withCapacityRequestScope: <T>(work: () => Promise<T>) => work(),
}));

import {
  benchSummary,
  createModelTest,
  type ModelTestSend,
  percentile,
  RESPONSE_TOO_LARGE,
  type RelayRequestReadback,
  silentWav,
} from "./model-test.js";
import { reportRelayRequestCreated } from "./relay-request-observer.js";

const PERSON = {
  kind: "cookie_session" as const,
  userId: "me",
  sessionId: "sess",
  csrfVerified: true,
};
const AGENT = {
  kind: "agent_token" as const,
  userId: "me",
  agentTokenId: "tok",
  level: "FULL" as const,
};

const POOL_TARGET = {
  kind: "pool" as const,
  poolId: "pool1",
  callableId: "me/chat",
};

function input(overrides: Partial<ModelTestServiceInput> = {}): ModelTestServiceInput {
  return { userId: "me", auth: AGENT, target: POOL_TARGET, kind: "chat", ...overrides };
}

function row(overrides: Partial<RelayRequestReadback> = {}): RelayRequestReadback {
  return {
    status: "SUCCEEDED",
    selectedInstanceId: "inst1",
    selectedNodeId: "node1",
    selectedVersionId: "ver1",
    selectedProviderModelId: null,
    startedAt: new Date(0),
    firstClientByteAt: new Date(5),
    queueWaitMs: 3,
    promptTokens: 7,
    completionTokens: 2,
    rejection: null,
    errorClass: null,
    ...overrides,
  };
}

function sse(...chunks: unknown[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"];
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

function chatAnswer(text: string): Response {
  return sse(
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: text } }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
  );
}

/** A clock that only moves when the test (or a fake send) moves it. */
function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("bench statistics", () => {
  it("takes nearest-rank percentiles over known values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([null, null], 95)).toBeNull();
    expect(percentile([30, 10, 20], 50)).toBe(20);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile([5], 95)).toBe(5);
  });

  it("summarizes only the rows that succeeded", () => {
    const base = {
      servedBy: { instanceId: null, nodeId: null, versionId: null, providerModelId: null },
      queueWaitMs: null,
      promptTokens: null,
      completionTokens: null,
      errorClass: null,
      rejection: null,
      excerpt: null,
    };
    const summary = benchSummary([
      { ...base, outcome: "ok", ttftMs: 10, latencyMs: 100 },
      { ...base, outcome: "ok", ttftMs: 30, latencyMs: 300 },
      { ...base, outcome: "ok", ttftMs: 20, latencyMs: 200 },
      { ...base, outcome: "refused", ttftMs: null, latencyMs: null, rejection: "over_capacity" },
      { ...base, outcome: "error", ttftMs: 1, latencyMs: 1, errorClass: "transport" },
    ]);
    expect(summary).toEqual({
      p50: { ttftMs: 20, latencyMs: 200 },
      p95: { ttftMs: 30, latencyMs: 300 },
    });
  });
});

describe("runModelTest", () => {
  it("sends one chat test, reads what served it and keeps the excerpt only in the result", async () => {
    const time = clock();
    const sent: Request[] = [];
    const send: ModelTestSend = async ({ request, kind }) => {
      expect(kind).toBe("chat");
      sent.push(request);
      reportRelayRequestCreated("req1");
      time.advance(25);
      return chatAnswer("pong");
    };
    const readRelayRequest = vi.fn(async () => row());
    const run = createModelTest({ send, readRelayRequest, now: time.now });
    const output = await run(input({ prompt: "say pong", maxTokens: 8 }));
    expect(readRelayRequest).toHaveBeenCalledWith("req1");
    expect(output.bench).toBeUndefined();
    expect(output.result).toEqual({
      outcome: "ok",
      servedBy: { instanceId: "inst1", nodeId: "node1", versionId: "ver1", providerModelId: null },
      ttftMs: 25,
      latencyMs: 25,
      queueWaitMs: 3,
      promptTokens: 7,
      completionTokens: 2,
      errorClass: null,
      rejection: null,
      excerpt: "pong",
    });
    const body = (await sent[0]?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "me/chat", stream: true, max_tokens: 8 });
    expect(body.messages).toEqual([{ role: "user", content: "say pong" }]);
  });

  it("reports a refusal from the request's row", async () => {
    const send: ModelTestSend = async () => {
      reportRelayRequestCreated("req1");
      return new Response(
        JSON.stringify({
          error: { message: "busy", type: "rate_limit_error", code: "rate_limited" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    };
    const run = createModelTest({
      send,
      readRelayRequest: async () =>
        row({ status: "FAILED", selectedInstanceId: null, rejection: "capacity_wait_expired" }),
    });
    const { result } = await run(input());
    expect(result).toMatchObject({
      outcome: "refused",
      rejection: "capacity_wait_expired",
      errorClass: null,
      excerpt: null,
    });
  });
  it("matches each bench row to its own request when the sends finish out of order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let count = 0;
    const time = clock();
    const repeat = 7;
    const send: ModelTestSend = async () => {
      count += 1;
      const n = count;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      reportRelayRequestCreated(`req${n}`);
      // Later requests finish first, so completions interleave with starts.
      await new Promise((resolve) => setTimeout(resolve, (repeat - n) * 2));
      time.advance(10);
      inFlight -= 1;
      return chatAnswer(`answer ${n}`);
    };
    const readRelayRequest = vi.fn(async (id: string) =>
      row({ selectedInstanceId: `inst-${id}`, queueWaitMs: Number(id.slice(3)) }),
    );
    const run = createModelTest({ send, readRelayRequest, now: time.now });
    const output = await run(input({ bench: { repeat, concurrency: 3 } }));
    expect(count).toBe(repeat);
    expect(maxInFlight).toBe(3);
    const rows = output.bench?.rows ?? [];
    expect(rows).toHaveLength(repeat);
    rows.forEach((entry, index) => {
      expect(entry.outcome).toBe("ok");
      expect(entry.servedBy.instanceId).toBe(`inst-req${index + 1}`);
      expect(entry.queueWaitMs).toBe(index + 1);
    });
    // Only the first row (the result) carries the excerpt, and it is the first request's.
    expect(output.result.excerpt).toBe("answer 1");
    expect(rows.slice(1).every((entry) => entry.excerpt === null)).toBe(true);
    expect(output.bench?.p50.latencyMs).not.toBeNull();
    expect(output.bench?.p95.ttftMs).not.toBeNull();
  });

  it("cancels the rest of a bench once the caller aborts", async () => {
    const controller = new AbortController();
    let count = 0;
    const send: ModelTestSend = async () => {
      count += 1;
      if (count === 2) controller.abort();
      return chatAnswer("pong");
    };
    const run = createModelTest({ send, readRelayRequest: async () => null });
    const output = await run(
      input({ bench: { repeat: 5, concurrency: 1 }, signal: controller.signal }),
    );
    expect(count).toBe(2);
    expect(output.bench?.rows.map((entry) => entry.outcome)).toEqual([
      "ok",
      "ok",
      "refused",
      "refused",
      "refused",
    ]);
    expect(output.bench?.rows[4]?.rejection).toBe("cancelled");
  });

  it("fails a test whose response passes the size cap, and cancels the rest", async () => {
    let cancelled = false;
    const megabyte = new Uint8Array(1024 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(megabyte);
      },
      cancel() {
        cancelled = true;
      },
    });
    const send: ModelTestSend = async () => {
      reportRelayRequestCreated("req1");
      return new Response(body, { headers: { "content-type": "application/json" } });
    };
    const run = createModelTest({ send, readRelayRequest: async () => row() });
    const { result } = await run(input({ kind: "embeddings" }));
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({
      outcome: "error",
      errorClass: RESPONSE_TOO_LARGE,
      latencyMs: null,
      excerpt: null,
    });
  });

  it("fails a chat test whose stream ends in an error event", async () => {
    const send: ModelTestSend = async () => {
      reportRelayRequestCreated("req1");
      return sse(
        { choices: [{ delta: { content: "half an ans" } }] },
        { error: { message: "engine crashed: secret detail", type: "server_error" } },
      );
    };
    const run = createModelTest({ send, readRelayRequest: async () => row() });
    const { result } = await run(input());
    expect(result).toMatchObject({ outcome: "error", errorClass: "server_error", excerpt: null });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });
  it("limits a person's benches but leaves agent tokens to the MCP limit", async () => {
    const send: ModelTestSend = async () => chatAnswer("pong");
    const benchLimiter = new RateLimiterMemory({ points: 1, duration: 60 });
    const run = createModelTest({ send, readRelayRequest: async () => null, benchLimiter });
    const bench = { repeat: 1, concurrency: 1 };
    await run(input({ auth: PERSON, bench }));
    await expect(run(input({ auth: PERSON, bench }))).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    // Tokens were counted by MCP before the procedure ran; not counted twice.
    await expect(run(input({ auth: AGENT, bench }))).resolves.toBeDefined();
    await expect(run(input({ auth: AGENT, bench }))).resolves.toBeDefined();
  });

  it("relies on MCP counting every bench per token (tokens reach models.test only via MCP)", () => {
    // If this changes, count token benches in consumePersonBench instead.
    const tool = MCP_TOOLS.find((entry) => entry.name === "model_test");
    expect(tool?.procedures).toEqual(["models.test"]);
    expect(tool?.rateLimit).toEqual({ perMinute: 2, key: "bench", onlyWhen: "bench" });
  });

  it("transcribes the built-in silent WAV, pinned to the chosen instance", async () => {
    const sent: Request[] = [];
    const send: ModelTestSend = async ({ request, kind }) => {
      expect(kind).toBe("transcription");
      sent.push(request);
      reportRelayRequestCreated("req1");
      return Response.json({ text: "" });
    };
    const run = createModelTest({ send, readRelayRequest: async () => row() });
    const { result } = await run(
      input({
        kind: "transcription",
        target: {
          kind: "runtime",
          runtimeId: "rt1",
          runtimeModelId: "rm1",
          model: "whisper",
          instanceId: "inst1",
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "ok", excerpt: "", ttftMs: 5 });
    const request = sent[0];
    expect(request?.url).toBe("http://model-test.internal/v1/audio/transcriptions");
    expect(request?.headers.get("x-wsmp-instance")).toBe("inst1");
    const form = await request?.formData();
    expect(form?.get("model")).toBe("runtime:rt1:whisper");
    const file = form?.get("file");
    expect(file).toBeInstanceOf(Blob);
    const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    expect(bytes).toEqual(silentWav());
  });
});

describe("silentWav", () => {
  it("is a half-second 16 kHz mono 16-bit PCM WAV of zeros", () => {
    const wav = silentWav();
    const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
    const view = new DataView(wav.buffer);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 12)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(16_000);
    expect(wav.byteLength).toBe(44 + 16_000);
    expect(wav.slice(44).every((byte) => byte === 0)).toBe(true);
  });
});
