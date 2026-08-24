import { describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../relay/session-manager.js";
import { RELAY_RESPONSE_QUEUE_MAX_BYTES, startRelayAttempt } from "./relay-executor.js";

function harness() {
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
    cliDeviceId: "cli-1",
    endpointSlug: "neutral-upstream",
    family: "audio",
    method: "POST",
    path: "/v1/audio/transcriptions",
    headers: new Headers(),
    body: new Uint8Array([1]),
    timeoutMs: 30_000,
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
      cliDeviceId: "cli-1",
      endpointSlug: "neutral-upstream",
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
      headers: { "content-type": "text/event-stream" },
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
      cliDeviceId: "cli-1",
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
      headers: {},
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
    await expect(attempt.terminal).resolves.toMatchObject({ ok: true });
    expect(manager.cancelRelayRequest).not.toHaveBeenCalled();
  });
});
