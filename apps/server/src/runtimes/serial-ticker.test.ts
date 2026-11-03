import { describe, expect, it, vi } from "vitest";
import { SerialTicker } from "./serial-ticker";

/** A tick the test finishes by hand, recording how many run at once. */
function harness() {
  let live = 0;
  let maxLive = 0;
  const finish: Array<(error?: unknown) => void> = [];
  const work = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        finish.push((error?: unknown) => {
          live -= 1;
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const onError = vi.fn();
  const ticker = new SerialTicker(work, onError);
  /** Finishes the oldest running tick and lets its continuation run. */
  const end = async (error?: unknown) => {
    const next = finish.shift();
    if (!next) throw new Error("no tick is running");
    next(error);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { ticker, work, onError, end, maxLive: () => maxLive };
}

describe("SerialTicker", () => {
  it("idle → running → idle", async () => {
    const h = harness();
    expect(h.ticker.state).toBe("idle");
    h.ticker.wake();
    expect(h.ticker.state).toBe("running");
    await h.end();
    expect(h.ticker.state).toBe("idle");
    expect(h.work).toHaveBeenCalledTimes(1);
  });

  it("wakes during a tick coalesce into one rerun after it", async () => {
    const h = harness();
    h.ticker.wake();
    h.ticker.wake();
    h.ticker.wake();
    expect(h.ticker.state).toBe("running_with_rerun");
    expect(h.work).toHaveBeenCalledTimes(1);
    await h.end();
    expect(h.ticker.state).toBe("running");
    expect(h.work).toHaveBeenCalledTimes(2);
    await h.end();
    expect(h.ticker.state).toBe("idle");
    expect(h.maxLive()).toBe(1);
  });

  it("runOnce during a tick waits for the next one and never overlaps (the old race)", async () => {
    const h = harness();
    h.ticker.wake();
    let settled = false;
    const once = h.ticker.runOnce().then(() => {
      settled = true;
    });
    // A wake between the current tick's end and runOnce's tick used to start a second tick
    // beside it.
    h.ticker.wake();
    await h.end();
    expect(settled).toBe(false);
    expect(h.work).toHaveBeenCalledTimes(2);
    h.ticker.wake();
    await h.end();
    await once;
    expect(settled).toBe(true);
    await h.end();
    expect(h.maxLive()).toBe(1);
    expect(h.ticker.state).toBe("idle");
  });

  it("runOnce from idle runs a tick and settles with it; its failure rejects it", async () => {
    const h = harness();
    const once = h.ticker.runOnce();
    expect(h.ticker.state).toBe("running");
    const failure = new Error("tick failed");
    const rejected = expect(once).rejects.toBe(failure);
    await h.end(failure);
    await rejected;
    expect(h.onError).toHaveBeenCalledWith(failure);
    expect(h.ticker.state).toBe("idle");
  });

  it("a failed tick from wake is reported and the ticker goes on", async () => {
    const h = harness();
    h.ticker.wake();
    await h.end(new Error("boom"));
    expect(h.onError).toHaveBeenCalledTimes(1);
    h.ticker.wake();
    expect(h.ticker.state).toBe("running");
    await h.end();
  });

  it("stop waits for the tick in progress, drops the rerun, and ignores later wakes", async () => {
    const h = harness();
    h.ticker.wake();
    h.ticker.wake();
    let stopped = false;
    const stop = h.ticker.stop().then(() => {
      stopped = true;
    });
    expect(h.ticker.state).toBe("stopped");
    await Promise.resolve();
    expect(stopped).toBe(false);
    await h.end();
    await stop;
    expect(stopped).toBe(true);
    h.ticker.wake();
    expect(h.work).toHaveBeenCalledTimes(1);
    expect(h.ticker.state).toBe("stopped");
  });

  it("runOnce still runs one tick once stopped (tests, probes), after the one in progress", async () => {
    const h = harness();
    h.ticker.wake();
    const stop = h.ticker.stop();
    const once = h.ticker.runOnce();
    await h.end();
    expect(h.work).toHaveBeenCalledTimes(2);
    await h.end();
    await once;
    await stop;
    expect(h.ticker.state).toBe("stopped");
    expect(h.maxLive()).toBe(1);
  });
});
