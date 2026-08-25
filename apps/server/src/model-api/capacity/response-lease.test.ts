import { describe, expect, it, vi } from "vitest";
import { holdCapacityLeaseForResponse } from "./response-lease.js";

const lease = {
  leaseId: "lease",
  attemptId: "attempt",
  capacityId: "capacity",
  executionTargetId: "target",
  fencingToken: 1n,
  expiresAt: new Date(Date.now() + 30_000),
};

describe("capacity response lease lifetime", () => {
  it("holds through body completion and releases exactly once", async () => {
    const store = {
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    };
    const response = holdCapacityLeaseForResponse({
      response: new Response("complete"),
      store,
      lease,
      heartbeatIntervalMs: 0,
    });
    await expect(response.text()).resolves.toBe("complete");
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it("cancels upstream and releases exactly once when downstream aborts", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const store = {
      heartbeat: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    };
    const controller = new AbortController();
    const response = holdCapacityLeaseForResponse({
      response: new Response(source),
      store,
      lease,
      signal: controller.signal,
      heartbeatIntervalMs: 0,
    });
    controller.abort("gone");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await response.body?.cancel().catch(() => undefined);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false)],
    ["rejects", vi.fn().mockRejectedValue(new Error("database unavailable"))],
  ])("cancels and errors the response when heartbeat %s", async (_label, heartbeat) => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel: cancelled,
    });
    const release = vi.fn().mockResolvedValue(true);
    const response = holdCapacityLeaseForResponse({
      response: new Response(source),
      store: { heartbeat, release },
      lease,
      heartbeatIntervalMs: 10,
    });
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await vi.advanceTimersByTimeAsync(10);
    await expect(reader.read()).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(release).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("handles a pre-aborted signal without exposing upstream chunks", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("too late"));
      },
      cancel: cancelled,
    });
    const release = vi.fn().mockResolvedValue(true);
    const controller = new AbortController();
    controller.abort("already gone");
    const response = holdCapacityLeaseForResponse({
      response: new Response(source),
      store: { heartbeat: vi.fn(), release },
      lease,
      signal: controller.signal,
      heartbeatIntervalMs: 0,
    });
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
