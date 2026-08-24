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
});
