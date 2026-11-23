import { pipeline, Readable, type Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from "node:zlib";
import { env } from "@ws-model-proxy/env/server";
import {
  CanonicalStreamRenderer,
  type ProtocolSurface,
  renderProtocolError,
} from "./protocols/index.js";

/**
 * Commit keepalive: keep a slow model API request from looking dead to an idle
 * timeout in front of the server (Cloudflare answers 524 after ~100 s without
 * a response byte; nginx's proxy_read_timeout defaults to 60 s).
 *
 * A request can be silent for minutes before its first response byte: it can
 * wait in capacity admission, fail over between pool members, and a
 * non-streaming upstream (vLLM, llama.cpp) sends nothing until generation ends.
 * Once a request is prepared (its body read and validated), this waits
 * `MODEL_API_KEEPALIVE_AFTER_MS` (0 turns it off). A response ready by then is
 * returned unchanged, with its real status and headers. Otherwise the server
 * commits `200` with the caller's content type and sends a keepalive every
 * {@link KEEPALIVE_INTERVAL_MS}: a newline for a JSON answer (JSON parsers skip
 * leading whitespace) or an SSE comment line for a stream (SSE decoders skip
 * comments). The real answer follows. A failure after the commit is written in
 * the body in the caller's protocol: the protocol's error JSON with
 * `error.status` set to the status it would have had, or the protocol's stream
 * error event. A committed response carries `x-wsmp-keepalive: 1`.
 *
 * The keepalive wraps the routed handler from the outside, so its bytes never
 * reach `responseWithFirstClientByte`: the routing commit point (no failover
 * after the first real byte) is unchanged. A caller can opt out per request
 * with `x-wsmp-keepalive: off` and get real status codes at any latency.
 *
 * An answer whose headers arrived before the deadline can still go silent:
 * streams then get an SSE comment after every {@link KEEPALIVE_INTERVAL_MS} of
 * silence, written only between events (a long prefill before the first
 * token), and JSON gets whitespace until its first byte. JSON that already
 * started is never touched: whitespace inside a string would change it.
 */

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_HEADER = "x-wsmp-keepalive";

/** What a route answers in, fixed when the route is registered. */
export type KeepaliveRoute = {
  /** The error JSON shape of the route. */
  protocol: "openai" | "anthropic";
  /** The stream protocol for `stream: true`; null keeps no stream alive. */
  streamSurface: ProtocolSurface | null;
  /** Multipart transcription: only JSON response formats are kept alive. */
  transcription?: boolean;
};

/** The commit keepalive shape of each model API route. */
export const OPENAI_CHAT_KEEPALIVE: KeepaliveRoute = {
  protocol: "openai",
  streamSurface: "openai-chat",
};
export const OPENAI_RESPONSES_KEEPALIVE: KeepaliveRoute = {
  protocol: "openai",
  streamSurface: "openai-responses",
};
export const ANTHROPIC_MESSAGES_KEEPALIVE: KeepaliveRoute = {
  protocol: "anthropic",
  streamSurface: "anthropic-messages",
};
export const OPENAI_JSON_KEEPALIVE: KeepaliveRoute = { protocol: "openai", streamSurface: null };
export const ANTHROPIC_JSON_KEEPALIVE: KeepaliveRoute = {
  protocol: "anthropic",
  streamSurface: null,
};
export const TRANSCRIPTION_KEEPALIVE: KeepaliveRoute = {
  protocol: "openai",
  streamSurface: null,
  transcription: true,
};

/** Facts about one prepared request, reported by the handler. */
type PreparedRequestFacts = {
  stream: boolean;
  transcriptionProfile?: { stream: boolean; responseFormat?: string };
};

type KeepaliveMode =
  | { kind: "json"; protocol: "openai" | "anthropic" }
  | { kind: "sse"; surface: ProtocolSurface };

/** JSON transcription formats; `text`, `srt` and `vtt` answers must stay byte-exact. */
const JSON_TRANSCRIPTION_FORMATS = new Set(["json", "verbose_json", "diarized_json"]);

function keepaliveMode(route: KeepaliveRoute, facts: PreparedRequestFacts): KeepaliveMode | null {
  if (route.transcription) {
    const profile = facts.transcriptionProfile;
    if (!profile || profile.stream) return null;
    if (
      profile.responseFormat !== undefined &&
      !JSON_TRANSCRIPTION_FORMATS.has(profile.responseFormat)
    )
      return null;
    return { kind: "json", protocol: route.protocol };
  }
  if (facts.stream)
    return route.streamSurface ? { kind: "sse", surface: route.streamSurface } : null;
  return { kind: "json", protocol: route.protocol };
}

/**
 * The handler's side of the keepalive. `prepared` starts the clock once the
 * request is read and validated, so a slow upload is never answered with a
 * committed 200 while the client is still sending it.
 */
export class CommitKeepalive {
  #onPrepared: ((facts: PreparedRequestFacts) => void) | undefined;

  constructor(onPrepared?: (facts: PreparedRequestFacts) => void) {
    this.#onPrepared = onPrepared;
  }

  prepared(facts: PreparedRequestFacts): void {
    const onPrepared = this.#onPrepared;
    this.#onPrepared = undefined;
    onPrepared?.(facts);
  }
}

const encoder = new TextEncoder();
const JSON_KEEPALIVE = encoder.encode("\n");
const SSE_KEEPALIVE = encoder.encode(": keepalive\n\n");

type CommitKeepaliveOptions = {
  afterMs?: number;
  intervalMs?: number;
};

/**
 * Run `handler` under the commit keepalive for `route`. See the module comment.
 */
export function withCommitKeepalive(
  request: Request,
  route: KeepaliveRoute,
  handler: (keepalive: CommitKeepalive) => Promise<Response>,
  options: CommitKeepaliveOptions = {},
): Promise<Response> {
  const afterMs = options.afterMs ?? env.MODEL_API_KEEPALIVE_AFTER_MS;
  const intervalMs = options.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  if (!(afterMs > 0) || request.headers.get(KEEPALIVE_HEADER)?.trim().toLowerCase() === "off")
    return handler(new CommitKeepalive());

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let mode: KeepaliveMode | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keepalive = new CommitKeepalive((facts) => {
      if (settled) return;
      mode = keepaliveMode(route, facts);
      if (!mode) return;
      const committedMode = mode;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(committedResponse(committedMode, inner, intervalMs));
      }, afterMs);
    });
    const inner = Promise.resolve().then(() => handler(keepalive));
    inner.then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(mode ? withEarlyAnswerKeepalive(response, mode, intervalMs) : response);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One source of body chunks for {@link keepaliveStream}. */
type ChunkSource = {
  next(): Promise<IteratorResult<Uint8Array>>;
  cancel(reason: unknown): Promise<void>;
};

const TICK = Symbol("keepalive-tick");

/**
 * A pull stream that forwards `source` and, whenever `intervalMs` passes with
 * no chunk and `keepaliveAllowed()` holds, writes `keepalive` instead. A read
 * in flight survives the tick and is awaited again on the next pull, so
 * backpressure and ordering are those of the source.
 */
function keepaliveStream({
  source,
  keepalive,
  keepaliveAllowed,
  onChunk,
  intervalMs,
  initial,
}: {
  source: ChunkSource;
  keepalive: Uint8Array;
  keepaliveAllowed: () => boolean;
  onChunk?: (chunk: Uint8Array) => void;
  intervalMs: number;
  initial?: Uint8Array;
}): ReadableStream<Uint8Array> {
  let pending: Promise<IteratorResult<Uint8Array>> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial) controller.enqueue(initial);
    },
    async pull(controller) {
      while (true) {
        pending ??= source.next();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof TICK>((resolveTick) => {
          timer = setTimeout(() => resolveTick(TICK), intervalMs);
        });
        let winner: IteratorResult<Uint8Array> | typeof TICK;
        try {
          winner = await Promise.race([pending, tick]);
        } finally {
          clearTimeout(timer);
        }
        if (winner === TICK) {
          if (!keepaliveAllowed()) continue;
          controller.enqueue(keepalive);
          return;
        }
        pending = null;
        if (winner.done) {
          controller.close();
          return;
        }
        if (winner.value.byteLength === 0) continue;
        onChunk?.(winner.value);
        controller.enqueue(winner.value);
        return;
      }
    },
    async cancel(reason) {
      await source.cancel(reason);
    },
  });
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * `source` without a leading UTF-8 BOM. A decoder honours a BOM only as the
 * very first bytes; after a keepalive it would become part of the first field
 * name (SSE) or a parse error (JSON).
 */
function withoutLeadingBom(source: ChunkSource): ChunkSource {
  let checked = false;
  let held = new Uint8Array(0);
  return {
    async next() {
      while (!checked) {
        const result = await source.next();
        if (result.done) {
          checked = true;
          if (held.byteLength > 0) return { done: false, value: held };
          return result;
        }
        const joined = new Uint8Array(held.byteLength + result.value.byteLength);
        joined.set(held);
        joined.set(result.value, held.byteLength);
        held = joined;
        const prefix = Math.min(held.byteLength, UTF8_BOM.length);
        if (UTF8_BOM.slice(0, prefix).some((byte, at) => held[at] !== byte)) {
          checked = true;
          return { done: false, value: held };
        }
        if (held.byteLength >= UTF8_BOM.length) {
          checked = true;
          return { done: false, value: held.subarray(UTF8_BOM.length) };
        }
      }
      return source.next();
    },
    cancel: (reason) => source.cancel(reason),
  };
}

function bodySource(body: ReadableStream<Uint8Array> | null): ChunkSource {
  if (!body) {
    return {
      next: async () => ({ done: true, value: undefined }),
      cancel: async () => undefined,
    };
  }
  const reader = body.getReader();
  return {
    next: () => reader.read(),
    cancel: (reason) => reader.cancel(reason),
  };
}

/**
 * Whether `text` ends with a blank line, i.e. two line terminators in a row.
 * SSE terminators are CRLF, LF or CR, and may be mixed: `\n\r\n` and `\r\r`
 * end an event, `x\r\n` does not (CRLF is one terminator).
 */
export function endsWithSseBlankLine(text: string): boolean {
  let end = text.length;
  let terminators = 0;
  while (terminators < 2 && end > 0) {
    if (text[end - 1] === "\n" && text[end - 2] === "\r") end -= 2;
    else if (text[end - 1] === "\n" || text[end - 1] === "\r") end -= 1;
    else break;
    terminators += 1;
  }
  return terminators >= 2;
}

/** Tracks whether the bytes written so far end between two SSE events. */
function sseBoundaryTracker() {
  // Terminators are ASCII, so the last few bytes decide it, whatever chunks
  // the stream was split into.
  let tail = "";
  let started = false;
  return {
    observe(chunk: Uint8Array) {
      started = true;
      tail = (tail + new TextDecoder().decode(chunk.subarray(-8))).slice(-8);
    },
    atBoundary(): boolean {
      return !started || endsWithSseBlankLine(tail);
    },
  };
}

/**
 * The body as plain bytes. Provider answers passed through natively keep their
 * `Content-Encoding` (public-overflow.ts), and plaintext keepalive bytes cannot
 * be mixed into a compressed body, so a kept-alive answer is decoded (the edge
 * compresses again). Null for an encoding this cannot decode.
 */
function decodedBody(response: Response): ReadableStream<Uint8Array> | null {
  const encodings = (response.headers.get("content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding.length > 0 && encoding !== "identity");
  if (!response.body || encodings.length === 0) return response.body;
  const decoders: Transform[] = [];
  // Applied in order, so undone in reverse.
  for (const encoding of encodings.reverse()) {
    if (encoding === "gzip" || encoding === "x-gzip") decoders.push(createGunzip());
    else if (encoding === "deflate") decoders.push(createInflate());
    else if (encoding === "br") decoders.push(createBrotliDecompress());
    else if (encoding === "zstd") decoders.push(createZstdDecompress());
    else return null;
  }
  // pipeline() destroys every stage when any one ends early, so cancelling the
  // decoded body (or a decode error) cancels the original body too.
  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const finished = new Promise<void>((resolveFinished) => {
    pipeline([source, ...decoders], () => resolveFinished());
  });
  const reader = (
    Readable.toWeb(decoders[decoders.length - 1] as Transform) as ReadableStream<Uint8Array>
  ).getReader();
  // Every way out (end, a decode error, cancel) waits until every stage, the
  // original body included, has torn down, so whoever holds this stream (the
  // capacity scope) sees it end only after the body's own release.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        await finished;
        throw error;
      }
      if (chunk.done) {
        await finished;
        controller.close();
      } else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finished;
      }
    },
  });
}

/** Headers of a decoded body: no encoding, no length, nothing an intermediary may buffer. */
function plainStreamHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("x-accel-buffering", "no");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-cache, no-transform");
  return headers;
}

function isEventStream(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") === true
  );
}

function isJson(response: Response): boolean {
  const type = response.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

/**
 * An answer whose headers came before the deadline can still go silent: a
 * stream during a long prefill, or a JSON answer whose engine sent its headers
 * first. Streams get comments in silent gaps between events; JSON gets
 * whitespace only until its first byte.
 */
function withEarlyAnswerKeepalive(
  response: Response,
  mode: KeepaliveMode,
  intervalMs: number,
): Response {
  if (!response.ok || !response.body) return response;
  if (mode.kind === "sse" ? !isEventStream(response) : !isJson(response)) return response;
  const decoded = decodedBody(response);
  if (!decoded) return response;
  const boundary = sseBoundaryTracker();
  let started = false;
  const body = keepaliveStream({
    source: withoutLeadingBom(bodySource(decoded)),
    keepalive: mode.kind === "sse" ? SSE_KEEPALIVE : JSON_KEEPALIVE,
    keepaliveAllowed: () => (mode.kind === "sse" ? boundary.atBoundary() : !started),
    onChunk: (chunk) => {
      started = true;
      boundary.observe(chunk);
    },
    intervalMs,
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: plainStreamHeaders(response),
  });
}

const ERROR_BODY_LIMIT_BYTES = 64 * 1024;

async function readBoundedText(response: Response, signal?: AbortSignal): Promise<string> {
  const body = decodedBody(response);
  if (!body) {
    await response.body?.cancel().catch(() => undefined);
    return "";
  }
  const reader = body.getReader();
  // One cancel, awaited by both paths: a second cancel on the then-closed
  // reader would resolve at once, before the body's own teardown finished.
  let cancelling: Promise<void> | null = null;
  const cancelOnce = (reason?: unknown): Promise<void> => {
    if (!cancelling) cancelling = reader.cancel(reason).catch(() => undefined);
    return cancelling;
  };
  const stop = () => void cancelOnce(signal?.reason);
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    await cancelOnce();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_LIMIT_BYTES));
}

type ExtractedError = { body: Record<string, unknown> | null; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error a failed handler response carries, in whatever protocol it was rendered. */
function extractError(text: string, status: number): ExtractedError {
  const fallbackMessage = `The request failed with HTTP status ${status}.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: null, code: "upstream_error", message: fallbackMessage };
  }
  if (!isRecord(parsed) || !isRecord(parsed.error))
    return { body: null, code: "upstream_error", message: fallbackMessage };
  const error = parsed.error;
  const message = typeof error.message === "string" ? error.message : fallbackMessage;
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof error.type === "string"
        ? error.type
        : "upstream_error";
  return { body: parsed, code, message };
}

function jsonErrorBytes(
  protocol: "openai" | "anthropic",
  status: number,
  extracted: ExtractedError,
): Uint8Array {
  const body =
    extracted.body ??
    renderProtocolError(protocol === "anthropic" ? "anthropic-messages" : "openai-chat", {
      code: extracted.code,
      message: extracted.message,
      upstreamStatus: status,
    });
  const error = body.error;
  const withStatus = isRecord(error) ? { ...body, error: { ...error, status } } : body;
  return encoder.encode(JSON.stringify(withStatus));
}

function sseErrorBytes(surface: ProtocolSurface, status: number, extracted: ExtractedError) {
  return new CanonicalStreamRenderer(surface).push({
    type: "error",
    error: { code: extracted.code, message: extracted.message, upstreamStatus: status },
  });
}

/** The body of a committed 200: keepalives until the handler answers, then its answer. */
function committedResponse(
  mode: KeepaliveMode,
  inner: Promise<Response>,
  intervalMs: number,
): Response {
  let cancelled: { reason: unknown } | null = null;
  /** Stops reading a failed answer's error body when the client leaves. */
  const extraction = new AbortController();
  let answer: ChunkSource | null = null;
  let answerStarted = false;
  const boundary = sseBoundaryTracker();

  const settle = async (): Promise<ChunkSource> => {
    let response: Response;
    try {
      response = await inner;
    } catch (error) {
      // Name only, like app.onError (unhandled-error-log.ts): messages and
      // stacks can carry SQL parameters or credentials.
      const name = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
      console.error(`[model-api] request failed after the keepalive commit: ${name}`);
      return queuedSource(
        renderFailure(mode, 500, {
          body: null,
          code: "internal_error",
          message: "The request failed.",
        }),
      );
    }
    if (cancelled) {
      await response.body?.cancel(cancelled.reason).catch(() => undefined);
      return queuedSource([]);
    }
    const failed = !response.ok || (mode.kind === "sse" && !isEventStream(response));
    if (!failed) {
      const decoded = decodedBody(response);
      if (decoded) return withoutLeadingBom(bodySource(decoded));
      await response.body?.cancel().catch(() => undefined);
      return queuedSource(
        renderFailure(mode, 502, {
          body: null,
          code: "unsupported_content_encoding",
          message: "The upstream answer used a content encoding the server cannot decode.",
        }),
      );
    }
    const status = response.ok ? 502 : response.status;
    // A truncated or undecodable error body still ends in the protocol's error.
    const text = await readBoundedText(response, extraction.signal).catch(() => "");
    if (cancelled) return queuedSource([]);
    const extracted = extractError(text, status);
    return queuedSource(renderFailure(mode, status, extracted));
  };
  let settling: Promise<ChunkSource> | null = null;

  // Settling starts on the first read, or on cancel so a late answer's body is
  // still released.
  const settled = (): Promise<ChunkSource> => {
    if (!settling) settling = settle();
    return settling;
  };
  const source: ChunkSource = {
    async next() {
      if (!answer) answer = await settled();
      return answer.next();
    },
    async cancel(reason) {
      cancelled = { reason };
      extraction.abort(reason);
      // Resolves once the handler has answered (it sees the request's abort
      // signal) and its answer's body is cancelled, so the request's capacity
      // scope closes after the answer's own release, as without the keepalive.
      // The server does not await a body's cancel, so this never holds it.
      await (await settled()).cancel(reason);
    },
  };

  const body = keepaliveStream({
    source,
    keepalive: mode.kind === "json" ? JSON_KEEPALIVE : SSE_KEEPALIVE,
    keepaliveAllowed: () => (mode.kind === "json" ? !answerStarted : boundary.atBoundary()),
    onChunk: (chunk) => {
      answerStarted = true;
      boundary.observe(chunk);
    },
    intervalMs,
    initial: mode.kind === "json" ? JSON_KEEPALIVE : SSE_KEEPALIVE,
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type":
        mode.kind === "json"
          ? "application/json; charset=utf-8"
          : "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      [KEEPALIVE_HEADER]: "1",
    },
  });
}

function renderFailure(
  mode: KeepaliveMode,
  status: number,
  extracted: ExtractedError,
): Uint8Array[] {
  return mode.kind === "json"
    ? [jsonErrorBytes(mode.protocol, status, extracted)]
    : sseErrorBytes(mode.surface, status, extracted);
}

function queuedSource(chunks: Uint8Array[]): ChunkSource {
  const remaining = [...chunks];
  return {
    next: async () => {
      const value = remaining.shift();
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    },
    cancel: async () => {
      remaining.length = 0;
    },
  };
}
