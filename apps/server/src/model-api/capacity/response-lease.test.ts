import { afterEach, describe, expect, it, vi } from "vitest";
import { CapacityLeaseLostError } from "./lease-loss.js";
import { holdCapacityLeaseForResponse } from "./response-lease.js";

afterEach(() => vi.useRealTimers());

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

  it("retries release after a transient database disconnect", async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValue(true);
    const response = holdCapacityLeaseForResponse({
      response: new Response("complete"),
      store: { heartbeat: vi.fn().mockResolvedValue(true), release },
      lease,
      heartbeatIntervalMs: 0,
    });

    await expect(response.text()).resolves.toBe("complete");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["returns false", vi.fn().mockResolvedValue(false), 10],
    // A thrown heartbeat is retried inside the acknowledged TTL; only when no
    // retry fits (here after the 1 s, 2 s, 4 s, ... backoff) is the lease lost.
    ["keeps rejecting", vi.fn().mockRejectedValue(new Error("database unavailable")), 28_000],
  ])(
    "cancels and errors the response when heartbeat %s",
    async (_label, heartbeat, lossAfterMs) => {
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
      await vi.advanceTimersByTimeAsync(lossAfterMs);
      await expect(reader.read()).rejects.toThrow(CapacityLeaseLostError);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(release).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    },
  );

  it("refuses the hand-off when the lease was already lost before any byte", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const release = vi.fn().mockResolvedValue(true);
    const controller = new AbortController();
    const lost = new CapacityLeaseLostError("ownership_lost");
    controller.abort(lost);
    expect(() =>
      holdCapacityLeaseForResponse({
        response: new Response(source),
        store: { heartbeat: vi.fn(), release },
        lease,
        signal: controller.signal,
        heartbeatIntervalMs: 0,
      }),
    ).toThrow(lost);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
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
    expect(() =>
      holdCapacityLeaseForResponse({
        response: new Response(source),
        store: { heartbeat: vi.fn(), release },
        lease,
        signal: controller.signal,
        heartbeatIntervalMs: 0,
      }),
    ).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("contains cancel and release cleanup rejections without exposing messages", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = new ReadableStream<Uint8Array>({
      cancel: vi.fn().mockRejectedValue(new Error("secret upstream detail")),
    });
    const response = holdCapacityLeaseForResponse({
      response: new Response(source),
      store: {
        heartbeat: vi.fn(),
        release: vi.fn().mockRejectedValue(new Error("secret database detail")),
      },
      lease,
      heartbeatIntervalMs: 0,
    });
    await expect(response.body!.cancel("done")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });
});
