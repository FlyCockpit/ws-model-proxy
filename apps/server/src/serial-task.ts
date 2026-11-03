/**
 * A single-flight background task: at most one pass runs at a time, a trigger that lands during
 * a pass either asks for exactly one more pass (`overlap: "rerun"`) or is dropped
 * (`overlap: "drop"`), an optional minimum gap between pass starts defers a trigger behind a
 * timer, and an optional interval triggers it periodically. Once stopped it never runs again.
 *
 * The phases are explicit so callers never re-derive them from loose flags:
 *
 *   idle ──trigger──▶ running ──trigger (rerun)──▶ running_rerun
 *    ▲  └─(minIntervalMs)─▶ scheduled ──timer──▶ running        │
 *    └──────────── pass ends, no rerun ◀──────────────────────────┘ (runs again)
 *   any ──stop──▶ stopped (terminal: triggers are no-ops; the current pass may finish)
 */

export type SerialTaskPhase = "idle" | "scheduled" | "running" | "running_rerun" | "stopped";

export type SerialTaskOptions = {
  /** One pass. Errors are reported through `onError` and never stop the task. */
  run: () => Promise<unknown>;
  onError: (error: unknown) => void;
  /** What a trigger during a pass does. Default `"rerun"`. */
  overlap?: "rerun" | "drop";
  /**
   * Minimum gap between two pass starts. When set (> 0), every pass starts from a timer (with
   * no delay when the gap has already elapsed), so a trigger never runs synchronously.
   */
  minIntervalMs?: number;
  /** When set, `start()` triggers the task every `intervalMs` (and once right away). */
  intervalMs?: number;
  /** Clock for `minIntervalMs`. */
  now?: () => number;
};

export type SerialTask = {
  readonly phase: SerialTaskPhase;
  /**
   * Requests a pass. Resolves when the task next goes idle or stops (so it covers the rerun this
   * trigger asked for); resolves at once when stopped.
   */
  trigger(): Promise<void>;
  /** Starts the interval (if configured) and triggers once. A no-op when started or stopped. */
  start(): void;
  /** Stops for good: clears every timer, drops a pending pass, and awaits the current one. */
  stop(): Promise<void>;
};

type Timer = ReturnType<typeof setTimeout>;

type State =
  | { phase: "idle" }
  | { phase: "scheduled"; timer: Timer }
  | { phase: "running" }
  | { phase: "running_rerun" }
  | { phase: "stopped" };

export function createSerialTask(options: SerialTaskOptions): SerialTask {
  const overlap = options.overlap ?? "rerun";
  const minIntervalMs = options.minIntervalMs ?? 0;
  const now = options.now ?? Date.now;
  let state: State = { phase: "idle" };
  let lastStartMs: number | null = null;
  let started = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  /** Settles when the current busy period (scheduled or running) ends. */
  let busy: { done: Promise<void>; settle: () => void } | null = null;

  function openBusy(): Promise<void> {
    if (busy) return busy.done;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    busy = { done, settle };
    return done;
  }

  function closeBusy(): void {
    const current = busy;
    busy = null;
    current?.settle();
  }

  function schedule(): void {
    const waitMs = lastStartMs === null ? 0 : Math.max(0, lastStartMs + minIntervalMs - now());
    const timer = setTimeout(() => {
      if (state.phase !== "scheduled" || state.timer !== timer) return;
      void loop();
    }, waitMs);
    timer.unref?.();
    state = { phase: "scheduled", timer };
  }

  async function loop(): Promise<void> {
    for (;;) {
      state = { phase: "running" };
      lastStartMs = now();
      try {
        await options.run();
      } catch (error) {
        options.onError(error);
      }
      // `stop()` may have run during the pass (TypeScript cannot see that through the await).
      const after = state as State;
      if (after.phase === "running_rerun") {
        if (minIntervalMs > 0) {
          schedule();
          return;
        }
        continue;
      }
      if (after.phase === "running") state = { phase: "idle" };
      closeBusy();
      return;
    }
  }

  function trigger(): Promise<void> {
    switch (state.phase) {
      case "stopped":
        return Promise.resolve();
      case "scheduled":
      case "running_rerun":
        return openBusy();
      case "running":
        if (overlap === "rerun") state = { phase: "running_rerun" };
        return openBusy();
      case "idle": {
        const done = openBusy();
        if (minIntervalMs > 0) schedule();
        else void loop();
        return done;
      }
    }
  }

  return {
    get phase() {
      return state.phase;
    },
    trigger,
    start() {
      if (state.phase === "stopped" || started) return;
      started = true;
      if (options.intervalMs !== undefined) {
        interval = setInterval(() => void trigger(), options.intervalMs);
        interval.unref?.();
      }
      void trigger();
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
      const wasRunning = state.phase === "running" || state.phase === "running_rerun";
      if (state.phase === "scheduled") clearTimeout(state.timer);
      state = { phase: "stopped" };
      const pending = busy?.done ?? Promise.resolve();
      // A pass in flight settles the busy period when it ends; nothing else will.
      if (!wasRunning) closeBusy();
      return pending;
    },
  };
}
