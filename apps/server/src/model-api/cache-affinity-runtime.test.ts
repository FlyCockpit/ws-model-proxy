import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cache-affinity.js", () => ({ sweepExpiredAffinity: vi.fn() }));

import { startCacheAffinityCleanup } from "./cache-affinity-runtime.js";

describe("cache affinity cleanup lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("sweeps immediately, drains bounded batches, and stops cleanly", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(4).mockResolvedValue(0);
    const stop = startCacheAffinityCleanup({ intervalMs: 100, sweep });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sweep).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it.each([1000, 1500, 2000])(
    "keeps draining when a batch removes %i rows (records plus nodes)",
    async (removed) => {
      const sweep = vi.fn().mockResolvedValueOnce(removed).mockResolvedValue(0);
      const stop = startCacheAffinityCleanup({ intervalMs: 60_000, sweep });
      await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
      stop();
    },
  );
});
