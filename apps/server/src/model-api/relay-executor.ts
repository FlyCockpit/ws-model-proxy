import {
  RELAY_BINARY_CHUNK_MAX_BYTES,
  type RelayFailure,
  type RelayServerControlMessage,
} from "../relay/protocol.js";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";
import type { RelayBodySource } from "./request-body-source.js";

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
  failure: RelayFailure | null;
  httpStatusCode: number | null;
  upstreamStatusCode: number | null;
  usage: RelayUsage | null;
  metrics: RelayMetrics | null;
  responseBytes: number;
  /** Actual request-body bytes emitted to the CLI websocket for this attempt. */
  requestBytes: number;
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
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

function failureForHttpStatus(status: number): RelayFailure | null {
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "upstream_4xx";
  return null;
}

export function startRelayAttempt({
  requestId = crypto.randomUUID(),
  manager,
  cliDeviceId,
  endpointSlug,
  family,
  method,
  path,
  headers,
  body,
  bodySource,
  timeoutMs,
  abortSignal,
  onResponseBodyChunk,
}: {
  /** Caller-supplied only when durable telemetry must exist before dispatch. */
  requestId?: string;
  manager: RelayManager;
  cliDeviceId: string;
  endpointSlug: string;
  family: Extract<RelayServerControlMessage, { type: "relay.request" }>["family"];
  method: string;
  path: string;
  headers: Headers;
  body?: Uint8Array;
  bodySource?: RelayBodySource;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onResponseBodyChunk?: (chunk: Uint8Array) => void;
}): RelayAttempt {
  const started = deferred<RelayAttemptStarted>();
  const terminal = deferred<RelayAttemptTerminal>();
  let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let upstreamStatusCode: number | null = null;
  let terminalSettled = false;
  let headersResolved = false;
  let responseStreamCancelled = false;
  let responseBytes = 0;
  let requestBytes = 0;

  const responseBody = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        responseController = controller;
      },
      cancel() {
        responseStreamCancelled = true;
        finish({
          ok: false,
          failure: "cancelled",
          httpStatusCode: 499,
          upstreamStatusCode,
          usage: null,
          metrics: null,
        });
        manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "cancelled" });
      },
    },
    {
      highWaterMark: RELAY_RESPONSE_QUEUE_MAX_BYTES,
      size: (chunk) => chunk.byteLength,
    },
  );

  const timeout = setTimeout(() => {
    manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "timeout" });
    finish({
      ok: false,
      failure: "timeout",
      httpStatusCode: 504,
      upstreamStatusCode,
      usage: null,
      metrics: null,
    });
  }, timeoutMs);

  const abort = () => {
    manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "cancelled" });
    finish({
      ok: false,
      failure: "cancelled",
      httpStatusCode: 499,
      upstreamStatusCode,
      usage: null,
      metrics: null,
    });
  };
  abortSignal?.addEventListener("abort", abort, { once: true });

  function finish(result: Omit<RelayAttemptTerminal, "responseBytes" | "requestBytes">) {
    if (terminalSettled) return;
    terminalSettled = true;
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abort);
    manager.completeRelayRequest(requestId);
    if ((result.ok || headersResolved) && !responseStreamCancelled) {
      responseController?.close();
    } else {
      started.reject(new Error(result.failure ?? "unknown"));
      responseController?.error(new Error(result.failure ?? "unknown"));
    }
    terminal.resolve({ ...result, responseBytes, requestBytes });
  }

  const handlers: ActiveRelayResponseHandlers = {
    onRequestBodySent(byteLength) {
      if (!terminalSettled) requestBytes += byteLength;
    },
    onHeaders(message) {
      headersResolved = true;
      upstreamStatusCode = message.status;
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
      if (terminalSettled) return;
      const bodyChunk = new Uint8Array(chunk);
      const available = responseController?.desiredSize;
      if (available !== null && available !== undefined && bodyChunk.byteLength > available) {
        manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "cancelled" });
        // Headers may already have committed a 2xx response. Error the body so
        // a slow caller observes truncation instead of receiving a clean EOF.
        responseStreamCancelled = true;
        responseController?.error(new Error("relay response buffer limit exceeded"));
        finish({
          ok: false,
          failure: "cancelled",
          httpStatusCode: 499,
          upstreamStatusCode,
          usage: null,
          metrics: null,
        });
        return;
      }
      responseBytes += bodyChunk.byteLength;
      onResponseBodyChunk?.(bodyChunk);
      responseController?.enqueue(bodyChunk);
    },
    onComplete(message) {
      const failure =
        upstreamStatusCode === null ? "protocol_error" : failureForHttpStatus(upstreamStatusCode);
      finish({
        ok: failure === null,
        failure,
        httpStatusCode: upstreamStatusCode,
        upstreamStatusCode,
        usage: message.usage ?? null,
        metrics: message.metrics ?? null,
      });
    },
    onError(message) {
      upstreamStatusCode = message.upstreamStatusCode ?? upstreamStatusCode;
      finish({
        ok: false,
        failure: message.failure,
        httpStatusCode: null,
        upstreamStatusCode,
        usage: null,
        metrics: null,
      });
    },
    onCancelled() {
      finish({
        ok: false,
        failure: "cancelled",
        httpStatusCode: 499,
        upstreamStatusCode,
        usage: null,
        metrics: null,
      });
    },
  };

  if ((body === undefined) === (bodySource === undefined)) {
    throw new Error("A relay attempt requires exactly one request body representation.");
  }

  manager.registerRelayResponseHandlers({ cliDeviceId, requestId, handlers });
  try {
    manager.sendRelayRequest({
      cliDeviceId,
      endpointSlug,
      requestId,
      family,
      method,
      path,
      headers,
      bodyChunks: body ? splitBodyChunks(body) : undefined,
      bodySource,
      timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const failure: RelayFailure = message.includes("disconnected") ? "disconnected" : "transport";
    finish({
      ok: false,
      failure,
      httpStatusCode: null,
      upstreamStatusCode,
      usage: null,
      metrics: null,
    });
  }

  return {
    requestId,
    started: started.promise,
    terminal: terminal.promise,
    cancel(reason) {
      manager.cancelRelayRequest({ cliDeviceId, requestId, reason });
      finish({
        ok: false,
        failure: reason,
        httpStatusCode: null,
        upstreamStatusCode,
        usage: null,
        metrics: null,
      });
    },
  };
}
