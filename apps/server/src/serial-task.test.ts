import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerialTask } from "./serial-task.js";

/** Passes the test finishes by hand, recording how many run at once. */
function harness(options: { overlap?: "rerun" | "drop" } = {}) {
  let live = 0;
  let maxLive = 0;
  const finish: Array<(error?: unknown) => void> = [];
  const run = vi.fn(
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
  const task = createSerialTask({ run, onError, ...options });
  /** Finishes the oldest running pass and lets its continuation run. */
  const end = async (error?: unknown) => {
    const next = finish.shift();
    if (!next) throw new Error("no pass is running");
    next(error);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { task, run, onError, end, maxLive: () => maxLive };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSerialTask", () => {
  afterEach(() => vi.useRealTimers());

  it("runs one pass at a time and coalesces triggers during a pass into one rerun", async () => {
    const gates: Array<() => void> = [];
    const run = vi.fn(() => {
      const gate = deferred();
      gates.push(gate.resolve);
      return gate.promise;
    });
    const task = createSerialTask({ run, onError: vi.fn() });
    expect(task.phase).toBe("idle");
    const first = task.trigger();
    expect(task.phase).toBe("running");
    const second = task.trigger();
    void task.trigger();
    expect(task.phase).toBe("running_rerun");
    expect(run).toHaveBeenCalledTimes(1);
    gates[0]?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(task.phase).toBe("running");
    gates[1]?.();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(task.phase).toBe("idle");
  });

  it("drops triggers during a pass with overlap: drop", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const task = createSerialTask({ run, onError: vi.fn(), overlap: "drop" });
    const done = task.trigger();
    void task.trigger();
    expect(task.phase).toBe("running");
    gate.resolve();
    await done;
    expect(run).toHaveBeenCalledTimes(1);
    expect(task.phase).toBe("idle");
  });

  it("reports errors and keeps working", async () => {
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const task = createSerialTask({ run, onError });
    await task.trigger();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    await task.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never runs after stop, and stop awaits the pass in flight", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const task = createSerialTask({ run, onError: vi.fn() });
    void task.trigger();
    void task.trigger(); // a rerun request that stop must drop
    let stopped = false;
    const stopping = task.stop().then(() => {
      stopped = true;
    });
    expect(task.phase).toBe("stopped");
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    await task.trigger();
    task.start();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("spaces pass starts by minIntervalMs, always starting from a timer", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({
      run,
      onError: vi.fn(),
      minIntervalMs: 1_000,
      now: () => nowMs,
    });
    void task.trigger();
    expect(task.phase).toBe("scheduled");
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(task.phase).toBe("idle");

    nowMs = 200;
    void task.trigger();
    void task.trigger();
    await vi.advanceTimersByTimeAsync(700);
    expect(run).toHaveBeenCalledTimes(1);
    nowMs = 1_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("schedules a rerun behind the minimum gap", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const gate = deferred();
    const run = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(undefined);
    const task = createSerialTask({
      run,
      onError: vi.fn(),
      minIntervalMs: 1_000,
      now: () => nowMs,
    });
    void task.trigger();
    await vi.advanceTimersByTimeAsync(0);
    void task.trigger();
    expect(task.phase).toBe("running_rerun");
    nowMs = 300;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(task.phase).toBe("scheduled");
    nowMs = 1_000;
    await vi.advanceTimersByTimeAsync(700);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stop cancels a scheduled pass and settles its waiters", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({ run, onError: vi.fn(), minIntervalMs: 1_000 });
    const waiting = task.trigger();
    await task.stop();
    await waiting;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("start triggers at once and then every interval, once", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({ run, onError: vi.fn(), intervalMs: 100 });
    task.start();
    task.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(3);
    await task.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("runOnce during a pass waits for the next one and never overlaps it", async () => {
    const h = harness();
    void h.task.trigger();
    let settled = false;
    const once = h.task.runOnce().then(() => {
      settled = true;
    });
    // A wake between the current pass's end and runOnce's pass once started a second pass
    // beside it (the old lifecycle race).
    void h.task.trigger();
    await h.end();
    expect(settled).toBe(false);
    expect(h.run).toHaveBeenCalledTimes(2);
    void h.task.trigger();
    await h.end();
    await once;
    expect(settled).toBe(true);
    await h.end();
    expect(h.maxLive()).toBe(1);
    expect(h.task.phase).toBe("idle");
  });

  it("runOnce gets its own pass even with overlap: drop", async () => {
    const h = harness({ overlap: "drop" });
    void h.task.trigger();
    const once = h.task.runOnce();
    await h.end();
    expect(h.run).toHaveBeenCalledTimes(2);
    await h.end();
    await once;
    expect(h.task.phase).toBe("idle");
  });

  it("runOnce from idle runs a pass and settles with it; its failure rejects it", async () => {
    const h = harness();
    const once = h.task.runOnce();
    expect(h.task.phase).toBe("running");
    const failure = new Error("pass failed");
    const rejected = expect(once).rejects.toBe(failure);
    await h.end(failure);
    await rejected;
    expect(h.onError).toHaveBeenCalledWith(failure);
    expect(h.task.phase).toBe("idle");
  });

  it("runOnce still runs one pass once stopped, after the one in progress", async () => {
    const h = harness();
    void h.task.trigger();
    const stop = h.task.stop();
    const once = h.task.runOnce();
    await h.end();
    expect(h.run).toHaveBeenCalledTimes(2);
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await h.end();
    await once;
    await stop;
    expect(h.task.phase).toBe("stopped");
    expect(h.maxLive()).toBe(1);
    // Triggers stay no-ops.
    await h.task.trigger();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("stop runs a runOnce's pass that was only scheduled", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({ run, onError: vi.fn(), minIntervalMs: 1_000 });
    const once = task.runOnce();
    expect(task.phase).toBe("scheduled");
    await task.stop();
    await once;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("minIntervalMs: 0 starts every pass from a timer without spacing", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({ run, onError: vi.fn(), minIntervalMs: 0 });
    void task.trigger();
    expect(task.phase).toBe("scheduled");
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    const second = task.trigger();
    expect(task.phase).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("nextPassMs arms the next pass when one ends, and a trigger runs it sooner", async () => {
    const pending: Array<{ callback: () => void; ms: number }> = [];
    const timers = {
      setTimeout: (callback: () => void, ms: number) => {
        pending.push({ callback, ms });
        return setTimeout(() => undefined, 0);
      },
      clearTimeout: vi.fn(),
    };
    let next: number | null = 500;
    const run = vi.fn(async () => undefined);
    const task = createSerialTask({ run, onError: vi.fn(), nextPassMs: () => next, timers });
    await task.trigger();
    expect(task.phase).toBe("idle");
    expect(pending.map((timer) => timer.ms)).toEqual([500]);
    // The poll fires: one more pass, which arms the next poll.
    pending[0]?.callback();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(run).toHaveBeenCalledTimes(2);
    // A trigger while a poll is due cancels it and runs now.
    await task.trigger();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(3);
    pending[1]?.callback(); // the cancelled poll is a no-op
    expect(run).toHaveBeenCalledTimes(3);
    // null: no next pass (the trigger cancelled the poll pass 3 armed).
    next = null;
    await task.trigger();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(3);
    // stop clears a due poll.
    next = 500;
    await task.trigger();
    expect(pending).toHaveLength(4);
    await task.stop();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(3);
    pending[3]?.callback();
    expect(run).toHaveBeenCalledTimes(5);
  });
});
