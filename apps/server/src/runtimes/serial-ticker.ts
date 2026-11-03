/**
 * One tick at a time, as an explicit state machine:
 *
 * - `idle`: nothing runs. `wake()` or `runOnce()` starts a tick (`running`).
 * - `running`: a tick runs. Another request does not start a second one: it asks for one more
 *   after it (`running_with_rerun`).
 * - `running_with_rerun`: a tick runs and one more follows it (requests coalesce into it).
 * - `stopped`: `stop()` was called. `wake()` does nothing; the tick in progress finishes, and
 *   `stop()` resolves once no tick runs. `runOnce()` (tests, operational probes) still runs a
 *   tick, after the one in progress, never beside it.
 *
 * `runOnce()` resolves (or rejects) with the first tick that started after it was called, so a
 * caller always observes a tick that saw its writes.
 */
export type SerialTickerState = "idle" | "running" | "running_with_rerun" | "stopped";

type Waiter = { tick: number; resolve: () => void; reject: (error: unknown) => void };

export class SerialTicker {
  private mode: SerialTickerState = "idle";
  private current: Promise<void> | null = null;
  /** How many ticks have started. */
  private started = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly work: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get state(): SerialTickerState {
    return this.mode;
  }

  /** Runs a tick now, or right after the current one (requests made meanwhile coalesce). */
  wake(): void {
    if (this.mode === "idle") this.launch();
    else if (this.mode === "running") this.mode = "running_with_rerun";
  }

  /** Runs one tick that starts after this call, and settles with it. */
  runOnce(): Promise<void> {
    const tick = this.started + 1;
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.push({ tick, resolve, reject });
    });
    if (this.current === null) this.launch();
    else if (this.mode === "running") this.mode = "running_with_rerun";
    return done;
  }

  /** No tick starts on `wake()` any more; resolves once the tick in progress (if any) ended. */
  async stop(): Promise<void> {
    this.mode = "stopped";
    while (this.current) await this.current;
  }

  private launch(): void {
    if (this.mode !== "stopped") this.mode = "running";
    const tick = ++this.started;
    this.current = this.work().then(
      () => this.settle(tick, null),
      (error: unknown) => {
        this.onError(error);
        this.settle(tick, { error });
      },
    );
  }

  private settle(tick: number, failure: { error: unknown } | null): void {
    this.current = null;
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index];
      if (!waiter || waiter.tick > tick) continue;
      this.waiters.splice(index, 1);
      if (failure) waiter.reject(failure.error);
      else waiter.resolve();
    }
    const rerun = this.mode === "running_with_rerun";
    // A runOnce made while this tick ran waits for the next one, stopped or not.
    if (rerun || this.waiters.length > 0) this.launch();
    else if (this.mode === "running") this.mode = "idle";
  }
}
