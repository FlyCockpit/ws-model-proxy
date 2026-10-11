import { describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../relay/session-manager.js";
import { CapacityLeaseLostError } from "./capacity/lease-loss.js";
import {
  RELAY_RESPONSE_QUEUE_MAX_BYTES,
  sanitizeNativeResponseHeaders,
  startRelayAttempt,
} from "./relay-executor.js";

describe("native response header sanitizer", () => {
  it("preserves protocol metadata while removing framing, cookies, and auth challenges", () => {
    const headers = sanitizeNativeResponseHeaders({
      "Content-Type": "text/event-stream",
      "Request-Id": "req_123",
      "retry-after": "2",
      "content-length": "999",
      "Set-Cookie": "secret=1",
      "Set-Cookie2": "legacy-secret=1",
      "WWW-Authenticate": "Bearer realm=provider",
      "Proxy-Authenticate": "Basic realm=provider",
      "x-api-key": "provider-secret",
      "x-provider-account-id": "acct_private",
      "x-internal-endpoint": "http://10.0.0.1",
      location: "https://credential.example/",
      "x-unknown-provider-secret": "secret",
      Connection: "keep-alive",
    });
    expect(headers.get("content-type")).toBe("text/event-stream");
    expect(headers.get("request-id")).toBe("req_123");
    expect(headers.get("retry-after")).toBe("2");
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("set-cookie2")).toBeNull();
    expect(headers.get("www-authenticate")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("proxy-authenticate")).toBeNull();
    expect(headers.get("location")).toBeNull();
    expect(headers.get("x-provider-account-id")).toBeNull();
    expect(headers.get("x-unknown-provider-secret")).toBeNull();
  });

  it("preserves ordered duplicate safe headers without trusting stale lengths", () => {
    const headers = sanitizeNativeResponseHeaders([
      ["warning", "private warning"],
      ["x-request-id", "first"],
      ["x-request-id", "second"],
      ["content-length", "1"],
      ["content-type", "application/json"],
    ]);
    expect(headers.get("warning")).toBeNull();
    expect(headers.get("x-request-id")).toBe("first, second");
    expect(headers.get("content-length")).toBeNull();
  });
});

function harness(abortSignal?: AbortSignal) {
  let handlers: ActiveRelayResponseHandlers | undefined;
  const manager = {
    registerRelayResponseHandlers: vi.fn((input: { handlers: ActiveRelayResponseHandlers }) => {
      handlers = input.handlers;
    }),
    sendRelayRequest: vi.fn(),
    cancelRelayRequest: vi.fn(),
    completeRelayRequest: vi.fn(),
  };
  const attempt = startRelayAttempt({
    manager,
    nodeId: "cli-1",
    handle: "neutral-upstream",
    family: "audio",
    method: "POST",
    path: "/v1/audio/transcriptions",
    headers: new Headers(),
    body: new Uint8Array([1]),
    timeoutMs: 30_000,
    abortSignal,
  });
  if (!handlers) throw new Error("relay handlers were not registered");
  return { manager, attempt, handlers };
}

describe("relay response backpressure", () => {
  it("reports only request bytes actually emitted before an early cancellation", async () => {
    let registered: ActiveRelayResponseHandlers | undefined;
    const manager = {
      registerRelayResponseHandlers: vi.fn(
        (input: { handlers: ActiveRelayResponseHandlers }) => (registered = input.handlers),
      ),
      sendRelayRequest: vi.fn(() => registered?.onRequestBodySent?.(2)),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
    };
    const attempt = startRelayAttempt({
      manager,
      nodeId: "cli-1",
      handle: "neutral-upstream",
      family: "audio",
      method: "POST",
      path: "/v1/audio/transcriptions",
      headers: new Headers(),
      body: new Uint8Array([1, 2, 3, 4]),
      timeoutMs: 30_000,
    });

    void attempt.started.catch(() => undefined);
    attempt.cancel("cancelled");
    await expect(attempt.terminal).resolves.toMatchObject({
      failure: "cancelled",
      requestBytes: 2,
    });
  });

  it("cancels a relay when a slow caller fills the bounded response queue", async () => {
    const { manager, attempt, handlers } = harness();
    handlers.onHeaders({
      type: "relay.response.headers",
      requestId: attempt.requestId,
      status: 200,
      headers: [["content-type", "text/event-stream"]],
    });
    const { body } = await attempt.started;
    const chunk = new Uint8Array(1024 * 1024);
    for (let sent = 0; sent < RELAY_RESPONSE_QUEUE_MAX_BYTES; sent += chunk.byteLength) {
      handlers.onBody(chunk, {
        type: "relay.response.body",
        requestId: attempt.requestId,
        chunkId: String(sent / chunk.byteLength),
      });
    }
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
    handlers.onBody(new Uint8Array([1]), {
      type: "relay.response.body",
      requestId: attempt.requestId,
      chunkId: "overflow",
    });
    await expect(attempt.terminal).resolves.toMatchObject({ ok: false, failure: "cancelled" });
    await expect(body.getReader().read()).rejects.toThrow("buffer limit");
    expect(manager.cancelRelayRequest).toHaveBeenCalledWith({
      nodeId: "cli-1",
      requestId: attempt.requestId,
      reason: "cancelled",
    });
  });

  it("allows an actively reading caller to drain more than the queue cap", async () => {
    const { manager, attempt, handlers } = harness();
    handlers.onHeaders({
      type: "relay.response.headers",
      requestId: attempt.requestId,
      status: 200,
      headers: [],
    });
    const { body } = await attempt.started;
    const reader = body.getReader();
    const chunk = new Uint8Array(1024 * 1024);
    for (let index = 0; index < 12; index++) {
      handlers.onBody(chunk, {
        type: "relay.response.body",
        requestId: attempt.requestId,
        chunkId: String(index),
      });
      const read = await reader.read();
      expect(read.value?.byteLength).toBe(chunk.byteLength);
    }
    handlers.onComplete({ type: "relay.complete", requestId: attempt.requestId });
    await expect(attempt.terminal).resolves.toMatchObject({ ok: true, upstreamErrorExcerpt: null });
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
  });

  it("keeps a redacted excerpt of an upstream 4xx answer on the terminal", async () => {
    const { attempt, handlers } = harness();
    handlers.onHeaders({
      type: "relay.response.headers",
      requestId: attempt.requestId,
      status: 400,
      headers: [["content-type", "application/json"]],
    });
    handlers.onBody(new TextEncoder().encode('{"detail":"messages must be a list"}'), {
      type: "relay.response.body",
      requestId: attempt.requestId,
      chunkId: "0",
    });
    handlers.onComplete({ type: "relay.complete", requestId: attempt.requestId });
    await expect(attempt.terminal).resolves.toMatchObject({
      ok: false,
      failure: "upstream_4xx",
      upstreamStatusCode: 400,
      upstreamErrorExcerpt: "messages must be a list",
    });
  });
});

describe("G1 — an ALREADY-aborted signal starts nothing (synchronous entry check)", () => {
  it("startRelayAttempt is a no-op: no registration, no dispatch, no listener, settled cancelled", async () => {
    const manager = {
      registerRelayResponseHandlers: vi.fn(),
      sendRelayRequest: vi.fn(),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
    };
    const controller = new AbortController();
    controller.abort();
    const attempt = startRelayAttempt({
      manager,
      nodeId: "cli-1",
      handle: "neutral-upstream",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new Uint8Array([1]),
      timeoutMs: 30_000,
      abortSignal: controller.signal,
    });
    expect(manager.registerRelayResponseHandlers).not.toHaveBeenCalled();
    expect(manager.sendRelayRequest).not.toHaveBeenCalled();
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
    expect(manager.completeRelayRequest).not.toHaveBeenCalled();
    await expect(attempt.started).rejects.toThrow("cancelled");
    await expect(attempt.terminal).resolves.toMatchObject({
      ok: false,
      failure: "cancelled",
      httpStatusCode: 499,
      responseBytes: 0,
      requestBytes: 0,
    });
    // cancel() on the no-op attempt does not reach the manager either.
    attempt.cancel("cancelled");
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
  });
});

// F2-CAP-3: a lost capacity lease aborts the dispatch with a typed reason. It
// is classified on signal.reason as a server failure, never a client cancel.
describe("capacity lease loss is not a client cancellation", () => {
  it("settles an in-flight attempt as capacity_lease_lost (503) and stops the CLI", async () => {
    const lease = new AbortController();
    const { manager, attempt } = harness(lease.signal);
    const started = expect(attempt.started).rejects.toThrow("capacity_lease_lost");
    lease.abort(new CapacityLeaseLostError("ownership_lost"));
    await started;
    await expect(attempt.terminal).resolves.toMatchObject({
      ok: false,
      failure: "capacity_lease_lost",
      httpStatusCode: 503,
    });
    // The wire protocol has no lease-loss reason; the CLI is told to stop.
    expect(manager.cancelRelayRequest).toHaveBeenCalledWith({
      nodeId: "cli-1",
      requestId: attempt.requestId,
      reason: "cancelled",
    });
  });

  it("errors a committed body instead of ending it cleanly", async () => {
    const lease = new AbortController();
    const { attempt, handlers } = harness(lease.signal);
    handlers.onHeaders({
      type: "relay.response.headers",
      requestId: attempt.requestId,
      status: 200,
      headers: [["content-type", "text/event-stream"]],
    });
    const { body } = await attempt.started;
    lease.abort(new CapacityLeaseLostError("heartbeat_timeout"));
    await expect(body.getReader().read()).rejects.toThrow("capacity_lease_lost");
    await expect(attempt.terminal).resolves.toMatchObject({ failure: "capacity_lease_lost" });
  });

  it("keeps a plain abort a 499 cancellation", async () => {
    const client = new AbortController();
    const { attempt } = harness(client.signal);
    void attempt.started.catch(() => undefined);
    client.abort();
    await expect(attempt.terminal).resolves.toMatchObject({
      failure: "cancelled",
      httpStatusCode: 499,
    });
  });

  it("classifies an already-lost lease at entry without dispatching", async () => {
    const manager = {
      registerRelayResponseHandlers: vi.fn(),
      sendRelayRequest: vi.fn(),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
    };
    const lease = new AbortController();
    lease.abort(new CapacityLeaseLostError("ownership_lost"));
    const attempt = startRelayAttempt({
      manager,
      nodeId: "cli-1",
      handle: "neutral-upstream",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new Uint8Array([1]),
      timeoutMs: 30_000,
      abortSignal: lease.signal,
    });
    await expect(attempt.started).rejects.toThrow("capacity_lease_lost");
    await expect(attempt.terminal).resolves.toMatchObject({
      failure: "capacity_lease_lost",
      httpStatusCode: 503,
    });
    expect(manager.sendRelayRequest).not.toHaveBeenCalled();
  });
});

// Production crash: the timeout settled an attempt nobody was awaiting, and the unobserved
// `started` rejection ended the whole process.
describe("an unobserved attempt failure never becomes an unhandled rejection", () => {
  async function unhandledDuring(run: () => void): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      run();
      // Node reports unhandled rejections once the microtask queue has drained.
      for (let turn = 0; turn < 3; turn += 1) await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it("times out with no listener on `started` without an unhandled rejection", async () => {
    let attempt: ReturnType<typeof startRelayAttempt> | undefined;
    const seen = await unhandledDuring(() => {
      attempt = harness().attempt;
      vi.advanceTimersByTime(30_000);
    });
    expect(seen).toEqual([]);
    // A caller that does await it still sees the failure.
    await expect(attempt?.started).rejects.toThrow("timeout");
    await expect(attempt?.terminal).resolves.toMatchObject({ ok: false, failure: "timeout" });
  });

  it("refuses an attempt without a body before arming its timeout or abort listener", async () => {
    const manager = {
      registerRelayResponseHandlers: vi.fn(),
      sendRelayRequest: vi.fn(),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
    };
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const seen = await unhandledDuring(() => {
      expect(() =>
        // @ts-expect-error -- the runtime guard behind the type: exactly one body is required.
        startRelayAttempt({
          manager,
          nodeId: "cli-1",
          handle: "neutral-upstream",
          family: "generic",
          method: "GET",
          path: "/openapi.json",
          headers: new Headers(),
          timeoutMs: 10_000,
          abortSignal: controller.signal,
        }),
      ).toThrow("exactly one request body");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
    });
    expect(seen).toEqual([]);
    expect(addListener).not.toHaveBeenCalled();
    expect(manager.registerRelayResponseHandlers).not.toHaveBeenCalled();
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
    expect(manager.completeRelayRequest).not.toHaveBeenCalled();
  });
});
