import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerialTask } from "./serial-task.js";

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
});
