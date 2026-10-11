/**
 * `models.test` (MCP `model_test`): one test request, or a bench of them, as the caller through
 * the production admission and routing path (`modelTestHandler` in routes.ts, the Test page's
 * targets and capacity runtime), tagged source `AGENT_TEST` so it counts in metrics.
 *
 * What served each request, its queue wait, refusal and error class are read back from the
 * request's own `RelayRequest` row. Prompts and answers are never stored: the answer excerpt
 * exists only in the returned result.
 *
 * Bench limits: MCP already counts bench calls per agent token (`model_test` `rateLimit` in
 * contracts/mcp-tools.ts) before the procedure runs, and tokens reach this procedure only
 * through MCP, so token calls are not counted again here. A person's bench (cookie session on
 * `/rpc`) gets the same budget per user here. The procedure has already refused `:external`
 * targets, benches on shared pools and benches over the prompt-token cap.
 */

import { ORPCError } from "@orpc/server";
import type {
  ModelTestKind,
  ModelTestServiceInput,
  ModelTestServiceOutput,
  ModelTestServiceTarget,
} from "@ws-model-proxy/api/context";
import { TEST_INSTANCE_HEADER } from "@ws-model-proxy/api/contracts";
import prisma from "@ws-model-proxy/db";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { scaledPoints } from "../rate-limit.js";
import { relaySessionManager } from "../relay/session-manager.js";
import { withCapacityRequestScope } from "./capacity/request-scope.js";
import { diagnosticsCapacityRuntime, GENERIC_PROVIDER_ERROR_TYPE } from "./diagnostics.js";
import { modelApiConcurrencyLimiter } from "./limits.js";
import { observeRelayRequests } from "./relay-request-observer.js";
import { testTargetModelId } from "./resolve.js";
import { modelTestHandler } from "./routes.js";

type ModelTestRow = ModelTestServiceOutput["result"];
type Percentiles = { ttftMs: number | null; latencyMs: number | null };

/**
 * A chat test's default output budget: room for a reasoning model's thinking before its answer
 * (GLM spent 64 tokens on reasoning alone).
 */
export const MODEL_TEST_DEFAULT_MAX_TOKENS = 256;
/** The excerpt of an answer that was reasoning only (no content within the budget). */
export const REASONING_ONLY_PREFIX = "[reasoning only] ";
/** Longest answer or transcript excerpt a result carries. */
export const MODEL_TEST_EXCERPT_CHARS = 280;
/** Most response bytes read from one test (the rest is cancelled). */
const MODEL_TEST_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** How long the read-back waits for the request's row to settle after the response ended. */
const ROW_SETTLE_WAIT_MS = 3_000;
const ROW_SETTLE_POLL_MS = 100;
/** A person's bench budget per user (MCP counts agent tokens: 2 per minute). */
export const MODEL_TEST_BENCH_PER_MINUTE = 2;

const DEFAULT_CHAT_PROMPT = "Reply with the single word pong.";
const DEFAULT_EMBEDDINGS_INPUT = "pong";

// ── silent WAV ──

const SILENT_WAV_SAMPLE_RATE = 16_000;
const SILENT_WAV_SECONDS = 0.5;

/** A built-in ~0.5 s mono 16-bit 16 kHz silent WAV, so transcription tests need no upload. */
export function silentWav(): Uint8Array<ArrayBuffer> {
  const samples = Math.round(SILENT_WAV_SAMPLE_RATE * SILENT_WAV_SECONDS);
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes; // samples stay zero: silence
}

// ── statistics ──

/** Nearest-rank percentile of the known values; null when there are none. */
export function percentile(values: ReadonlyArray<number | null>, p: number): number | null {
  const known = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (known.length === 0) return null;
  const rank = Math.min(known.length, Math.max(1, Math.ceil((p / 100) * known.length)));
  return known[rank - 1] ?? null;
}

/** p50/p95 of TTFT and latency over the bench rows that succeeded. */
export function benchSummary(rows: ReadonlyArray<ModelTestRow>): {
  p50: Percentiles;
  p95: Percentiles;
} {
  const ok = rows.filter((row) => row.outcome === "ok");
  const ttft = ok.map((row) => row.ttftMs);
  const latency = ok.map((row) => row.latencyMs);
  return {
    p50: { ttftMs: percentile(ttft, 50), latencyMs: percentile(latency, 50) },
    p95: { ttftMs: percentile(ttft, 95), latencyMs: percentile(latency, 95) },
  };
}

// ── one request ──

export type ModelTestSend = (input: {
  request: Request;
  userId: string;
  kind: ModelTestKind;
}) => Promise<Response>;

export type RelayRequestReadback = {
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  selectedInstanceId: string | null;
  selectedNodeId: string | null;
  selectedVersionId: string | null;
  selectedProviderModelId: string | null;
  startedAt: Date;
  firstClientByteAt: Date | null;
  queueWaitMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  rejection: string | null;
  errorClass: string | null;
  upstreamErrorExcerpt: string | null;
};

export type ModelTestDependencies = {
  /** Sends one prepared request through the production path (default `modelTestHandler`). */
  send?: ModelTestSend;
  /** Reads the request's row (default Prisma). */
  readRelayRequest?: (id: string) => Promise<RelayRequestReadback | null>;
  /** A person's bench budget (default 2 per minute per user). */
  benchLimiter?: Pick<RateLimiterMemory, "consume">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSend({ request, userId, kind }: Parameters<ModelTestSend>[0]): Promise<Response> {
  return modelTestHandler({
    request,
    userId,
    kind,
    manager: relaySessionManager,
    limiter: modelApiConcurrencyLimiter,
    capacityRuntime: diagnosticsCapacityRuntime(),
  });
}

const RELAY_REQUEST_SELECT = {
  status: true,
  selectedInstanceId: true,
  selectedNodeId: true,
  selectedVersionId: true,
  selectedProviderModelId: true,
  startedAt: true,
  firstClientByteAt: true,
  queueWaitMs: true,
  promptTokens: true,
  completionTokens: true,
  rejection: true,
  errorClass: true,
  upstreamErrorExcerpt: true,
} as const;

function defaultReadRelayRequest(id: string): Promise<RelayRequestReadback | null> {
  return prisma.relayRequest.findUnique({ where: { id }, select: RELAY_REQUEST_SELECT });
}

/** The model name the production path resolves for this target. */
function modelName(target: ModelTestServiceTarget): string {
  return target.kind === "pool"
    ? target.callableId
    : testTargetModelId(target.runtimeId, target.model);
}

/** Roughly `tokens` tokens of filler (one short word is one token in common tokenizers). */
function fillerPrompt(tokens: number): string {
  return "a ".repeat(tokens).trimEnd();
}

function buildRequest(input: ModelTestServiceInput, signal: AbortSignal | undefined): Request {
  const headers = new Headers();
  if (input.target.kind === "runtime" && input.target.instanceId) {
    headers.set(TEST_INSTANCE_HEADER, input.target.instanceId);
  }
  const model = modelName(input.target);
  const promptTokens = input.bench?.promptTokens;
  const filler = promptTokens === undefined ? null : fillerPrompt(promptTokens);
  if (input.kind === "transcription") {
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    form.set("file", new Blob([silentWav()], { type: "audio/wav" }), "silence.wav");
    return new Request("http://model-test.internal/v1/audio/transcriptions", {
      method: "POST",
      headers,
      body: form,
      ...(signal ? { signal } : {}),
    });
  }
  headers.set("content-type", "application/json");
  const body =
    input.kind === "embeddings"
      ? {
          model,
          input: filler
            ? `${filler}\n\n${input.prompt ?? DEFAULT_EMBEDDINGS_INPUT}`
            : (input.prompt ?? DEFAULT_EMBEDDINGS_INPUT),
        }
      : {
          model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: input.maxTokens ?? MODEL_TEST_DEFAULT_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: filler
                ? `${filler}\n\n${input.prompt ?? DEFAULT_CHAT_PROMPT}`
                : (input.prompt ?? DEFAULT_CHAT_PROMPT),
            },
          ],
        };
  return new Request(
    `http://model-test.internal/v1/${input.kind === "embeddings" ? "embeddings" : "chat/completions"}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );
}

type ReadOutcome = {
  /** The body was a valid answer for this kind. */
  valid: boolean;
  firstTokenAt: number | null;
  excerpt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** A stable error code or type from an error body (never its message). */
  errorCode: string | null;
};

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function errorCodeOf(parsed: unknown): string | null {
  const error = record(record(parsed)?.error);
  if (!error) return null;
  for (const key of ["code", "type"] as const) {
    const value = error[key];
    if (typeof value === "string" && STABLE_CODE.test(value)) return value;
  }
  return error.type === undefined ? null : GENERIC_PROVIDER_ERROR_TYPE;
}

function clip(text: string): string {
  return text.length > MODEL_TEST_EXCERPT_CHARS ? text.slice(0, MODEL_TEST_EXCERPT_CHARS) : text;
}

/** The answer's excerpt, or its reasoning marked as such when it has no content. */
function answerExcerpt(answer: string, reasoning: string): string {
  if (answer.trim() !== "" || reasoning.trim() === "") return clip(answer);
  return clip(`${REASONING_ONLY_PREFIX}${reasoning.trim()}`);
}

function reasoningText(source: Record<string, unknown> | null): string {
  if (!source) return "";
  for (const key of ["reasoning_content", "reasoning"] as const) {
    const value = source[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** The stable error code of a response cut off at `MODEL_TEST_MAX_RESPONSE_BYTES`. */
export const RESPONSE_TOO_LARGE = "response_too_large";

/**
 * Reads a body chunk by chunk, calling `onChunk` with each decoded piece. Past the cap the rest
 * is cancelled and the answer is `true` (truncated).
 */
async function readText(
  body: ReadableStream<Uint8Array> | null,
  onChunk: (text: string) => void,
): Promise<boolean> {
  if (!body) return false;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MODEL_TEST_MAX_RESPONSE_BYTES) {
        await reader.cancel("model_test_response_too_large").catch(() => undefined);
        return true;
      }
      onChunk(decoder.decode(value, { stream: true }));
    }
    onChunk(decoder.decode());
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function readJsonBody(response: Response): Promise<{ parsed: unknown; truncated: boolean }> {
  let text = "";
  const truncated = await readText(response.body, (chunk) => {
    text += chunk;
  });
  if (truncated) return { parsed: null, truncated };
  try {
    return { parsed: JSON.parse(text), truncated };
  } catch {
    return { parsed: null, truncated };
  }
}

/** A streamed chat answer: TTFT at the first content (or reasoning) delta, usage at the end. */
async function readChatStream(response: Response, now: () => number): Promise<ReadOutcome> {
  const outcome: ReadOutcome = {
    valid: false,
    firstTokenAt: null,
    excerpt: null,
    promptTokens: null,
    completionTokens: null,
    errorCode: null,
  };
  let pending = "";
  let answer = "";
  let reasoningSoFar = "";
  const onLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const chunk = record(parsed);
    if (!chunk) return;
    if (chunk.error !== undefined) {
      outcome.errorCode = errorCodeOf(chunk);
      return;
    }
    const usage = record(chunk.usage);
    if (usage) {
      outcome.promptTokens = intOrNull(usage.prompt_tokens);
      outcome.completionTokens = intOrNull(usage.completion_tokens);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = record(record(choices[0])?.delta);
    if (!delta) return;
    outcome.valid = true;
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning = reasoningText(delta);
    if ((content !== "" || reasoning !== "") && outcome.firstTokenAt === null) {
      outcome.firstTokenAt = now();
    }
    if (content !== "" && answer.length < MODEL_TEST_EXCERPT_CHARS) answer += content;
    if (reasoning !== "" && reasoningSoFar.length < MODEL_TEST_EXCERPT_CHARS)
      reasoningSoFar += reasoning;
  };
  const truncated = await readText(response.body, (text) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.trimEnd());
  });
  if (truncated) {
    outcome.errorCode = RESPONSE_TOO_LARGE;
  } else if (pending !== "") {
    onLine(pending.trimEnd());
  }
  // An error event (or the cap) ends the answer as failed, whatever streamed before it.
  if (outcome.errorCode !== null) outcome.valid = false;
  outcome.excerpt = outcome.valid ? answerExcerpt(answer, reasoningSoFar) : null;
  return outcome;
}

async function readAnswer(
  kind: ModelTestKind,
  response: Response,
  now: () => number,
): Promise<ReadOutcome> {
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (kind === "chat" && response.ok && streamed) return readChatStream(response, now);
  const { parsed, truncated } = await readJsonBody(response);
  const body = record(parsed);
  const usage = record(body?.usage);
  const base = {
    firstTokenAt: null,
    promptTokens: intOrNull(usage?.prompt_tokens),
    completionTokens: intOrNull(usage?.completion_tokens),
    errorCode: truncated ? RESPONSE_TOO_LARGE : response.ok ? null : errorCodeOf(parsed),
  };
  if (!response.ok || !body) return { ...base, valid: false, excerpt: null };
  if (kind === "embeddings") {
    const data = Array.isArray(body.data) ? body.data : [];
    const vector = record(data[0])?.embedding;
    return { ...base, valid: Array.isArray(vector) && vector.length > 0, excerpt: null };
  }
  if (kind === "transcription") {
    const text = body.text;
    return {
      ...base,
      valid: typeof text === "string",
      excerpt: typeof text === "string" ? clip(text) : null,
    };
  }
  // A chat answer that came back as one JSON body.
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = record(record(choices[0])?.message);
  const content = typeof message?.content === "string" ? message.content : "";
  const reasoning = reasoningText(message);
  return {
    ...base,
    valid: choices.length > 0,
    excerpt: content !== "" || reasoning !== "" ? answerExcerpt(content, reasoning) : null,
  };
}

async function settledRow(
  id: string | null,
  deps: Required<Pick<ModelTestDependencies, "readRelayRequest" | "now" | "sleep">>,
): Promise<RelayRequestReadback | null> {
  if (id === null) return null;
  const deadline = deps.now() + ROW_SETTLE_WAIT_MS;
  let row = await deps.readRelayRequest(id);
  while (row?.status === "PENDING" && deps.now() < deadline) {
    await deps.sleep(ROW_SETTLE_POLL_MS);
    row = await deps.readRelayRequest(id);
  }
  return row;
}

/** One test request; never throws for a failed or refused request (that is a result row). */
async function runOne(
  input: ModelTestServiceInput,
  options: { withExcerpt: boolean },
  deps: Required<Omit<ModelTestDependencies, "benchLimiter">>,
): Promise<ModelTestRow> {
  let relayRequestId: string | null = null;
  const startedAt = deps.now();
  let sent: { status: number; read: ReadOutcome; finishedAt: number } | null = null;
  try {
    sent = await withCapacityRequestScope(() =>
      observeRelayRequests(
        (id) => {
          relayRequestId ??= id;
        },
        async () => {
          const response = await deps.send({
            request: buildRequest(input, input.signal),
            userId: input.userId,
            kind: input.kind,
          });
          // The whole body is read (or cancelled) inside the scope, so no capacity lease outlives it.
          const read = await readAnswer(input.kind, response, deps.now);
          return { status: response.status, read, finishedAt: deps.now() };
        },
      ),
    );
  } catch (error) {
    console.error(
      `model test request failed (${error instanceof Error ? error.constructor.name : typeof error})`,
    );
  }
  const row = await settledRow(relayRequestId, deps).catch(() => null);
  const status = sent?.status ?? null;
  const read = sent?.read ?? null;
  const finishedAt = sent?.finishedAt ?? deps.now();
  const ok = status !== null && status >= 200 && status < 300 && read?.valid === true;
  const fallbackCode = read?.errorCode ?? (status === null ? "transport" : `http_${status}`);
  const refused = !ok && (row?.rejection != null || (relayRequestId === null && status !== null));
  const rowTtft =
    row?.firstClientByteAt != null
      ? Math.max(0, row.firstClientByteAt.getTime() - row.startedAt.getTime())
      : null;
  return {
    outcome: ok ? "ok" : refused ? "refused" : "error",
    servedBy: {
      instanceId: row?.selectedInstanceId ?? null,
      nodeId: row?.selectedNodeId ?? null,
      versionId: row?.selectedVersionId ?? null,
      providerModelId: row?.selectedProviderModelId ?? null,
    },
    ttftMs:
      read?.firstTokenAt != null
        ? Math.max(0, read.firstTokenAt - startedAt)
        : ok && input.kind !== "chat"
          ? rowTtft
          : null,
    latencyMs: ok ? Math.max(0, finishedAt - startedAt) : null,
    queueWaitMs: row?.queueWaitMs ?? null,
    promptTokens: row?.promptTokens ?? read?.promptTokens ?? null,
    completionTokens: row?.completionTokens ?? read?.completionTokens ?? null,
    errorClass: ok || refused ? null : (row?.errorClass ?? fallbackCode),
    upstreamError: ok ? null : (row?.upstreamErrorExcerpt ?? null),
    rejection: refused ? (row?.rejection ?? fallbackCode) : null,
    excerpt: ok && options.withExcerpt ? (read?.excerpt ?? null) : null,
  };
}

function refusedRow(rejection: string): ModelTestRow {
  return {
    outcome: "refused",
    servedBy: { instanceId: null, nodeId: null, versionId: null, providerModelId: null },
    ttftMs: null,
    latencyMs: null,
    queueWaitMs: null,
    promptTokens: null,
    completionTokens: null,
    errorClass: null,
    upstreamError: null,
    rejection,
    excerpt: null,
  };
}

let defaultBenchLimiter: RateLimiterMemory | undefined;

function personBenchLimiter(): RateLimiterMemory {
  defaultBenchLimiter ??= new RateLimiterMemory({
    points: scaledPoints(MODEL_TEST_BENCH_PER_MINUTE),
    duration: 60,
  });
  return defaultBenchLimiter;
}

async function consumePersonBench(
  input: ModelTestServiceInput,
  limiter: Pick<RateLimiterMemory, "consume">,
): Promise<void> {
  // Tokens were counted by MCP (contracts/mcp-tools.ts) before the procedure ran.
  if (input.auth.kind !== "cookie_session") return;
  try {
    await limiter.consume(`model-test-bench:${input.userId}`);
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: `Too many benches this minute; try again in ${Math.ceil(rejection.msBeforeNext / 1000)} s.`,
        data: { reason: "rate_limited", subjectId: null },
      });
    }
    throw rejection;
  }
}

/** The `services.modelTest` hook (see the module docblock). */
export function createModelTest(dependencies: ModelTestDependencies = {}) {
  const deps = {
    send: dependencies.send ?? defaultSend,
    readRelayRequest: dependencies.readRelayRequest ?? defaultReadRelayRequest,
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  return async function runModelTest(
    input: ModelTestServiceInput,
  ): Promise<ModelTestServiceOutput> {
    const bench = input.bench;
    if (!bench) return { result: await runOne(input, { withExcerpt: true }, deps) };
    await consumePersonBench(input, dependencies.benchLimiter ?? personBenchLimiter());
    const rows: ModelTestRow[] = new Array(bench.repeat);
    let next = 0;
    const worker = async () => {
      while (next < bench.repeat) {
        const index = next;
        next += 1;
        if (input.signal?.aborted) {
          rows[index] = refusedRow("cancelled");
          continue;
        }
        // Only the first row carries an excerpt; the rest stay compact.
        rows[index] = await runOne(input, { withExcerpt: index === 0 }, deps);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(bench.concurrency, bench.repeat) }, () => worker()),
    );
    const [first] = rows;
    return {
      result: first ?? refusedRow("cancelled"),
      bench: { rows, ...benchSummary(rows) },
    };
  };
}

export const runModelTest = createModelTest();
