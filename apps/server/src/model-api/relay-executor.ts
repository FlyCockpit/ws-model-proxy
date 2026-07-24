import {
  RELAY_BINARY_CHUNK_MAX_BYTES,
  type RelayFailure,
  type RelayServerControlMessage,
} from "../relay/protocol.js";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";

type RelayUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type RelayAttemptTerminal = {
  ok: boolean;
  failure: RelayFailure | null;
  httpStatusCode: number | null;
  upstreamStatusCode: number | null;
  usage: RelayUsage | null;
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

function sanitizeRelayResponseHeaders(headers: Record<string, string>): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) continue;
    if (
      normalized === "connection" ||
      normalized === "content-length" ||
      normalized === "set-cookie" ||
      normalized === "transfer-encoding" ||
      normalized === "upgrade" ||
      normalized.startsWith("sec-")
    ) {
      continue;
    }
    output.set(normalized, value);
  }
  return output;
}

function failureForHttpStatus(status: number): RelayFailure | null {
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "upstream_4xx";
  return null;
}

export function startRelayAttempt({
  manager,
  cliDeviceId,
  family,
  method,
  path,
  headers,
  body,
  timeoutMs,
  abortSignal,
  onResponseBodyChunk,
}: {
  manager: RelayManager;
  cliDeviceId: string;
  family: Extract<RelayServerControlMessage, { type: "relay.request" }>["family"];
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onResponseBodyChunk?: (chunk: Uint8Array) => void;
}): RelayAttempt {
  const requestId = crypto.randomUUID();
  const started = deferred<RelayAttemptStarted>();
  const terminal = deferred<RelayAttemptTerminal>();
  let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let upstreamStatusCode: number | null = null;
  let terminalSettled = false;
  let headersResolved = false;
  let responseStreamCancelled = false;

  const responseBody = new ReadableStream<Uint8Array>({
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
      });
      manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "cancelled" });
    },
  });

  const timeout = setTimeout(() => {
    manager.cancelRelayRequest({ cliDeviceId, requestId, reason: "timeout" });
    finish({
      ok: false,
      failure: "timeout",
      httpStatusCode: 504,
      upstreamStatusCode,
      usage: null,
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
    });
  };
  abortSignal?.addEventListener("abort", abort, { once: true });

  function finish(result: RelayAttemptTerminal) {
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
    terminal.resolve(result);
  }

  const handlers: ActiveRelayResponseHandlers = {
    onHeaders(message) {
      headersResolved = true;
      upstreamStatusCode = message.status;
      const responseHeaders = sanitizeRelayResponseHeaders(message.headers);
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
      });
    },
    onCancelled() {
      finish({
        ok: false,
        failure: "cancelled",
        httpStatusCode: 499,
        upstreamStatusCode,
        usage: null,
      });
    },
  };

  manager.registerRelayResponseHandlers({ cliDeviceId, requestId, handlers });
  try {
    manager.sendRelayRequest({
      cliDeviceId,
      requestId,
      family,
      method,
      path,
      headers,
      bodyChunks: splitBodyChunks(body),
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
      });
    },
  };
}
