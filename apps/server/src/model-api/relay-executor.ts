import {
  RELAY_BINARY_CHUNK_MAX_BYTES,
  type RelayFailure,
  type RelayServerControlMessage,
} from "../relay/protocol.js";
import type {
  ActiveRelayResponseHandlers,
  CountContextResultMessage,
  RelaySessionManager,
} from "../relay/session-manager.js";
import { isCapacityLeaseLost } from "./capacity/lease-loss.js";
import type { ModelApiFailure } from "./openai-errors.js";
import type { RelayBodySource } from "./request-body-source.js";
import { ResponseUsageRecorder, type ResponseUsageSample } from "./response-usage-sample.js";
import { upstreamErrorExcerpt } from "./upstream-error-excerpt.js";

type RelayUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

type RelayMetrics = {
  completionTokens: number;
  tokenizer: "cl100k_base";
};

// The websocket relay protocol currently has request-side credits but no
// response-side acknowledgement. Bound the Fetch response queue and cancel a
// relay whose caller is not consuming it instead of retaining arbitrary
// upstream output in the server heap. This is generic for every relay family.
export const RELAY_RESPONSE_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

export type RelayAttemptTerminal = {
  ok: boolean;
  /**
   * Wire failures plus the server-only `capacity_lease_lost`: the dispatch
   * was aborted because its capacity lease was lost (never a client cancel).
   */
  failure: ModelApiFailure | null;
  httpStatusCode: number | null;
  upstreamStatusCode: number | null;
  usage: RelayUsage | null;
  metrics: RelayMetrics | null;
  responseBytes: number;
  /** Actual request-body bytes emitted to the CLI websocket for this attempt. */
  requestBytes: number;
  /**
   * Bounded prefix/tail windows of the upstream response body, retained for
   * every attempt so the server parses provider usage once at finalization.
   * Absent for synthesized terminals that never received a response.
   */
  usageSample?: ResponseUsageSample | null;
  /** A bounded, redacted excerpt of an upstream error answer (HTTP >= 400); null otherwise. */
  upstreamErrorExcerpt?: string | null;
};

type RelayAttemptStarted = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
};

export type RelayAttempt = {
  requestId: string;
  started: Promise<RelayAttemptStarted>;
  terminal: Promise<RelayAttemptTerminal>;
  cancel(reason: RelayFailure): void;
};

type RelayManager = Pick<
  RelaySessionManager,
  | "registerRelayResponseHandlers"
  | "sendRelayRequest"
  | "cancelRelayRequest"
  | "completeRelayRequest"
>;

/** Exactly one request body; a bodiless request (a GET) sends an empty `body`. */
type RelayAttemptBody =
  | { body: Uint8Array; bodySource?: undefined }
  | { body?: undefined; bodySource: RelayBodySource };

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

/**
 * A promise settled from outside. It is marked handled at creation: a rejection nobody awaits
 * (a caller that never reached `await`, or one that stopped listening) must not become an
 * unhandled rejection, which ends the whole process. Callers that await it still see it.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function splitBodyChunks(body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < body.byteLength; offset += RELAY_BINARY_CHUNK_MAX_BYTES) {
    chunks.push(body.subarray(offset, offset + RELAY_BINARY_CHUNK_MAX_BYTES));
  }
  return chunks;
}

const SAFE_NATIVE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "openai-processing-ms",
  "request-id",
  "retry-after",
  "vary",
  "x-request-id",
]);

function isSafeNativeResponseHeader(name: string): boolean {
  if (SAFE_NATIVE_RESPONSE_HEADERS.has(name)) return true;
  return (
    name.startsWith("x-ratelimit-") ||
    name.startsWith("ratelimit-") ||
    name.startsWith("anthropic-ratelimit-")
  );
}

export function sanitizeNativeResponseHeaders(
  headers: Record<string, string> | readonly (readonly [string, string])[],
): Headers {
  const output = new Headers();
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [name, value] of entries) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;
    // Explicit allowlisting keeps credentials, cookies, redirect locations,
    // provider account metadata and private/internal routing headers out even
    // when a provider invents a new spelling. Content-Length is intentionally
    // excluded because relay framing/decompression can change body length.
    if (!isSafeNativeResponseHeader(normalized)) continue;
    output.append(normalized, value);
  }
  return output;
}

/**
 * Terminal facts for a dispatch aborted by `signal`. A lost capacity lease is a
 * server-side failure (503, failover-eligible before commit); anything else is
 * a client cancellation (499). Classified on `signal.reason`, never on
 * `signal.aborted` alone.
 */
export function abortedRelayFailure(signal: AbortSignal | undefined): {
  failure: Extract<ModelApiFailure, "cancelled" | "capacity_lease_lost">;
  httpStatusCode: number;
} {
  return isCapacityLeaseLost(signal?.reason)
    ? { failure: "capacity_lease_lost", httpStatusCode: 503 }
    : { failure: "cancelled", httpStatusCode: 499 };
}

function failureForHttpStatus(status: number): RelayFailure | null {
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "upstream_4xx";
  return null;
}

/**
 * The lifecycle of one relay attempt. `dispatching` until the node's response headers arrive,
 * `streaming` (with the upstream status those headers carried) while body frames flow, and
 * `settled` once a terminal is known. Settled is final: every later frame is ignored.
 */
export type RelayAttemptState =
  | { phase: "dispatching" }
  | { phase: "streaming"; status: number }
  | { phase: "settled"; upstreamStatusCode: number | null };

/**
 * Why an attempt settled, as far as its response body is concerned.
 * - `completed`: the node reported `relay.complete`; the body is whole.
 * - `caller_cancelled`: the caller (cancel(), or a non-lease abort) walked away from the body.
 * - `consumer_cancelled`: the body stream itself was cancelled or already errored.
 * - `interrupted`: anything else (timeout, relay.error, node cancel, disconnect, lost lease,
 *   protocol violation) — the body, if any, is truncated.
 */
export type RelayAttemptSettleCause =
  | "completed"
  | "caller_cancelled"
  | "consumer_cancelled"
  | "interrupted";

/**
 * How the response body ends when an attempt settles from `from`.
 * Before headers nobody holds the body: `started` rejects. After headers, the body ends cleanly
 * only when it is whole or its reader walked away; a truncated body errors, so a client never
 * mistakes it for a complete response (clean EOF).
 */
export function relayBodyEnd(
  from: Exclude<RelayAttemptState, { phase: "settled" }>,
  cause: RelayAttemptSettleCause,
): "reject_started" | "close" | "error" | "none" {
  if (from.phase === "dispatching") return "reject_started";
  switch (cause) {
    case "completed":
    case "caller_cancelled":
      return "close";
    case "consumer_cancelled":
      return "none";
    case "interrupted":
      return "error";
  }
}

function upstreamStatusOf(state: RelayAttemptState): number | null {
  if (state.phase === "streaming") return state.status;
  if (state.phase === "settled") return state.upstreamStatusCode;
  return null;
}

export function startRelayAttempt({
  requestId = crypto.randomUUID(),
  manager,
  nodeId,
  handle,
  family,
  method,
  path,
  headers,
  body,
  bodySource,
  timeoutMs,
  abortSignal,
  onResponseBodyChunk,
  countFirst,
  countCeiling,
  onCountResult,
}: RelayAttemptBody & {
  /** Caller-supplied only when durable telemetry must exist before dispatch. */
  requestId?: string;
  manager: RelayManager;
  /** The head node the request is relayed to. */
  nodeId: string;
  /** The instance handle the node routes by. */
  handle: string;
  family: Extract<RelayServerControlMessage, { type: "relay.request" }>["family"];
  method: "GET" | "POST" | "DELETE";
  path: string;
  headers: Headers;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onResponseBodyChunk?: (chunk: Uint8Array) => void;
  countFirst?: boolean;
  countCeiling?: number;
  onCountResult?: (message: CountContextResultMessage) => void;
}): RelayAttempt {
  // Checked before anything is armed: a throw after the timeout or abort listener exist would
  // leave them settling an attempt its caller never received.
  if ((body === undefined) === (bodySource === undefined)) {
    throw new Error("A relay attempt requires exactly one request body representation.");
  }
  const started = deferred<RelayAttemptStarted>();
  const terminal = deferred<RelayAttemptTerminal>();

  // G1: synchronous entry check. An ALREADY-aborted signal must start NO
  // work — no handler registration, no relay dispatch, no abort listener
  // (registering one on an aborted signal never fires, leaking it), no
  // timeout. The attempt settles immediately as cancelled; callers that
  // await `started` observe the rejection through their own catch paths.
  if (abortSignal?.aborted) {
    const aborted = abortedRelayFailure(abortSignal);
    started.reject(new Error(aborted.failure));
    terminal.resolve({
      ok: false,
      ...aborted,
      upstreamStatusCode: null,
      usage: null,
      metrics: null,
      responseBytes: 0,
      requestBytes: 0,
    });
    return {
      requestId,
      started: started.promise,
      terminal: terminal.promise,
      cancel() {
        // Nothing was dispatched; nothing to cancel.
      },
    };
  }

  // One explicit state per attempt. Every handler reads it and every transition goes through
  // `finish` (to settled) or `onHeaders` (dispatching -> streaming), so a frame that arrives
  // in the wrong phase is a visible protocol violation instead of a silent overwrite.
  let state: RelayAttemptState = { phase: "dispatching" };
  let responseBytes = 0;
  let requestBytes = 0;
  const usageRecorder = new ResponseUsageRecorder();

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  // A truncated body errors only once the reader has drained what was already delivered:
  // `controller.error` would otherwise discard queued output the node did send.
  let errorAfterDrain: Error | null = null;
  const responseBody = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
      },
      pull(controller) {
        if (errorAfterDrain && controller.desiredSize === RELAY_RESPONSE_QUEUE_MAX_BYTES) {
          controller.error(errorAfterDrain);
        }
      },
      cancel() {
        finish(
          {
            ok: false,
            failure: "cancelled",
            httpStatusCode: 499,
            upstreamStatusCode: upstreamStatusOf(state),
            usage: null,
            metrics: null,
          },
          "consumer_cancelled",
        );
        manager.cancelRelayRequest({ nodeId, requestId, reason: "cancelled" });
      },
    },
    {
      highWaterMark: RELAY_RESPONSE_QUEUE_MAX_BYTES,
      size: (chunk) => chunk.byteLength,
    },
  );
  // `start` runs synchronously inside the constructor.
  if (!streamController) throw new Error("relay response stream did not start");
  const responseController = streamController;

  const timeout = setTimeout(() => {
    manager.cancelRelayRequest({ nodeId, requestId, reason: "timeout" });
    finish(
      {
        ok: false,
        failure: "timeout",
        httpStatusCode: 504,
        upstreamStatusCode: upstreamStatusOf(state),
        usage: null,
        metrics: null,
      },
      "interrupted",
    );
  }, timeoutMs);

  const abort = () => {
    // The wire protocol has no lease-loss reason: the CLI only needs to stop.
    manager.cancelRelayRequest({ nodeId, requestId, reason: "cancelled" });
    const aborted = abortedRelayFailure(abortSignal);
    finish(
      {
        ok: false,
        ...aborted,
        upstreamStatusCode: upstreamStatusOf(state),
        usage: null,
        metrics: null,
      },
      // A lost lease is a server failure; any other abort is the caller walking away.
      aborted.failure === "capacity_lease_lost" ? "interrupted" : "caller_cancelled",
    );
  };
  abortSignal?.addEventListener("abort", abort, { once: true });

  /** A node frame that is not legal in the current phase: stop the node and fail the attempt. */
  function protocolViolation() {
    manager.cancelRelayRequest({ nodeId, requestId, reason: "protocol_error" });
    finish(
      {
        ok: false,
        failure: "protocol_error",
        httpStatusCode: null,
        upstreamStatusCode: upstreamStatusOf(state),
        usage: null,
        metrics: null,
      },
      "interrupted",
    );
  }

  function finish(
    result: Omit<RelayAttemptTerminal, "responseBytes" | "requestBytes">,
    cause: RelayAttemptSettleCause,
  ) {
    if (state.phase === "settled") return;
    const from = state;
    state = { phase: "settled", upstreamStatusCode: result.upstreamStatusCode };
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abort);
    manager.completeRelayRequest(requestId);
    const end = relayBodyEnd(from, cause);
    if (end === "reject_started") started.reject(new Error(result.failure ?? "unknown"));
    if (end === "close") responseController.close();
    else if (end === "reject_started")
      responseController.error(new Error(result.failure ?? "unknown"));
    else if (end === "error") {
      const error = new Error(result.failure ?? "unknown");
      if (responseController.desiredSize === RELAY_RESPONSE_QUEUE_MAX_BYTES) {
        responseController.error(error);
      } else errorAfterDrain = error;
    }
    const usageSample = responseBytes > 0 ? usageRecorder.sample() : null;
    terminal.resolve({
      ...result,
      responseBytes,
      requestBytes,
      usageSample,
      upstreamErrorExcerpt:
        result.upstreamStatusCode !== null && result.upstreamStatusCode >= 400
          ? upstreamErrorExcerpt(usageSample)
          : null,
    });
  }

  const handlers: ActiveRelayResponseHandlers = {
    onRequestBodySent(byteLength) {
      if (state.phase !== "settled") requestBytes += byteLength;
    },
    onCountResult(message) {
      if (state.phase !== "settled") onCountResult?.(message);
    },
    onHeaders(message) {
      if (state.phase === "settled") return;
      // Headers arrive exactly once; a second set would silently change the status the
      // attempt is classified by after the caller already committed to the first.
      if (state.phase === "streaming") return protocolViolation();
      state = { phase: "streaming", status: message.status };
      const responseHeaders = sanitizeNativeResponseHeaders(message.headers);
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/json; charset=utf-8");
      }
      started.resolve({
        status: message.status,
        headers: responseHeaders,
        body: responseBody,
      });
    },
    onBody(chunk) {
      if (state.phase === "settled") return;
      // Body bytes have no response to belong to until headers arrive.
      if (state.phase === "dispatching") return protocolViolation();
      const bodyChunk = new Uint8Array(chunk);
      const available = responseController.desiredSize;
      if (available !== null && bodyChunk.byteLength > available) {
        manager.cancelRelayRequest({ nodeId, requestId, reason: "cancelled" });
        // Headers may already have committed a 2xx response. Error the body so
        // a slow caller observes truncation instead of receiving a clean EOF.
        responseController.error(new Error("relay response buffer limit exceeded"));
        finish(
          {
            ok: false,
            failure: "cancelled",
            httpStatusCode: 499,
            upstreamStatusCode: state.status,
            usage: null,
            metrics: null,
          },
          "consumer_cancelled",
        );
        return;
      }
      responseBytes += bodyChunk.byteLength;
      usageRecorder.push(bodyChunk);
      onResponseBodyChunk?.(bodyChunk);
      responseController.enqueue(bodyChunk);
    },
    onComplete(message) {
      if (state.phase === "settled") return;
      const status = upstreamStatusOf(state);
      const failure = status === null ? "protocol_error" : failureForHttpStatus(status);
      finish(
        {
          ok: failure === null,
          failure,
          httpStatusCode: status,
          upstreamStatusCode: status,
          usage: message.usage ?? null,
          metrics: message.metrics ?? null,
        },
        "completed",
      );
    },
    onError(message) {
      if (state.phase === "settled") return;
      finish(
        {
          ok: false,
          failure: message.failure,
          httpStatusCode: null,
          upstreamStatusCode: message.upstreamStatusCode ?? upstreamStatusOf(state),
          usage: null,
          metrics: null,
        },
        "interrupted",
      );
    },
    onCancelled() {
      finish(
        {
          ok: false,
          failure: "cancelled",
          httpStatusCode: 499,
          upstreamStatusCode: upstreamStatusOf(state),
          usage: null,
          metrics: null,
        },
        "interrupted",
      );
    },
  };

  manager.registerRelayResponseHandlers({ nodeId, requestId, handlers });
  try {
    manager.sendRelayRequest({
      nodeId,
      handle,
      requestId,
      family,
      method,
      path,
      headers,
      bodyChunks: body ? splitBodyChunks(body) : undefined,
      bodySource,
      timeoutMs,
      countFirst,
      countCeiling,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const failure: RelayFailure = message.includes("disconnected") ? "disconnected" : "transport";
    finish(
      {
        ok: false,
        failure,
        httpStatusCode: null,
        upstreamStatusCode: upstreamStatusOf(state),
        usage: null,
        metrics: null,
      },
      "interrupted",
    );
  }

  return {
    requestId,
    started: started.promise,
    terminal: terminal.promise,
    cancel(reason) {
      // A settled attempt is over on the node too: a second cancel frame would be noise.
      if (state.phase === "settled") return;
      manager.cancelRelayRequest({ nodeId, requestId, reason });
      finish(
        {
          ok: false,
          failure: reason,
          httpStatusCode: null,
          upstreamStatusCode: upstreamStatusOf(state),
          usage: null,
          metrics: null,
        },
        "caller_cancelled",
      );
    },
  };
}
