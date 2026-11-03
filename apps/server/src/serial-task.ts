/**
 * A single-flight background task: at most one pass runs at a time, a trigger that lands during
 * a pass either asks for exactly one more pass (`overlap: "rerun"`) or is dropped
 * (`overlap: "drop"`), an optional minimum gap between pass starts defers a trigger behind a
 * timer, an optional interval triggers it periodically, and an optional follow-up delay arms the
 * next pass when one ends. Once stopped, triggers never run it again.
 *
 * The phases are explicit so callers never re-derive them from loose flags:
 *
 *   idle ──trigger──▶ running ──trigger (rerun)──▶ running_rerun
 *    ▲  └─(minIntervalMs)─▶ scheduled ──timer──▶ running        │
 *    └──────────── pass ends, no rerun ◀──────────────────────────┘ (runs again)
 *   any ──stop──▶ stopped (terminal: triggers are no-ops; the current pass may finish)
 *
 * `runOnce()` (tests, operational probes) is the one way to run a pass once stopped: it always
 * gets a pass that starts after it was called, never beside another one.
 */

export type SerialTaskPhase = "idle" | "scheduled" | "running" | "running_rerun" | "stopped";

type Timer = ReturnType<typeof setTimeout>;

/** The one-shot timers a task schedules passes with (injectable for tests). */
export type SerialTaskTimers = {
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
};

export type SerialTaskOptions = {
  /** One pass. Errors are reported through `onError` and never stop the task. */
  run: () => Promise<unknown>;
  onError: (error: unknown) => void;
  /** What a trigger during a pass does. Default `"rerun"`. */
  overlap?: "rerun" | "drop";
  /**
   * Minimum gap between two pass starts. When set (even to 0), every pass starts from a timer
   * (with no delay when the gap has already elapsed), so a trigger never runs synchronously.
   */
  minIntervalMs?: number;
  /** When set, `start()` triggers the task every `intervalMs` (and once right away). */
  intervalMs?: number;
  /**
   * Asked when a pass ends with no rerun due: the next pass starts after that many ms (`null`:
   * none). The task is `idle` meanwhile, and a trigger runs it sooner.
   */
  nextPassMs?: () => number | null;
  /** Clock for `minIntervalMs`. */
  now?: () => number;
  /** One-shot timers for `minIntervalMs` and `nextPassMs` (`intervalMs` uses `setInterval`). */
  timers?: SerialTaskTimers;
};

export type SerialTask = {
  readonly phase: SerialTaskPhase;
  /**
   * Requests a pass. Resolves when the task next goes idle or stops (so it covers the rerun this
   * trigger asked for); resolves at once when stopped.
   */
  trigger(): Promise<void>;
  /**
   * Runs one pass that starts after this call (right after the current one, never beside it),
   * whatever `overlap` says and even once stopped, and settles with it: it rejects with that
   * pass's error (which `onError` also gets).
   */
  runOnce(): Promise<void>;
  /** Starts the interval (if configured) and triggers once. A no-op when started or stopped. */
  start(): void;
  /**
   * Stops for good: clears every timer, drops a pending pass, and resolves once no pass runs
   * (including passes `runOnce()` asked for).
   */
  stop(): Promise<void>;
};

type State =
  | { phase: "idle"; next: Timer | null }
  | { phase: "scheduled"; timer: Timer }
  | { phase: "running" }
  | { phase: "running_rerun" }
  | { phase: "stopped" };

/** A `runOnce()` caller: settled by the first pass numbered above `after`. */
type Probe = { after: number; resolve: () => void; reject: (error: unknown) => void };

const globalTimers: SerialTaskTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function createSerialTask(options: SerialTaskOptions): SerialTask {
  const overlap = options.overlap ?? "rerun";
  const minIntervalMs = options.minIntervalMs;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? globalTimers;
  let state: State = { phase: "idle", next: null };
  let lastStartMs: number | null = null;
  let started = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  /** Whether a pass runs (in any phase, `stopped` included). */
  let inPass = false;
  /** How many passes have started. */
  let passes = 0;
  const probes: Probe[] = [];
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

  function setTimer(callback: () => void, ms: number): Timer {
    const timer = timers.setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  }

  function schedule(): void {
    const gapMs = minIntervalMs ?? 0;
    const waitMs = lastStartMs === null ? 0 : Math.max(0, lastStartMs + gapMs - now());
    const timer = setTimer(() => {
      if (state.phase !== "scheduled" || state.timer !== timer) return;
      void loop();
    }, waitMs);
    state = { phase: "scheduled", timer };
  }

  function armNext(): Timer | null {
    const ms = options.nextPassMs?.() ?? null;
    if (ms === null) return null;
    const timer = setTimer(() => {
      if (state.phase !== "idle" || state.next !== timer) return;
      state = { phase: "idle", next: null };
      void trigger();
    }, ms);
    return timer;
  }

  function settleProbes(pass: number, failure: { error: unknown } | null): void {
    for (let index = probes.length - 1; index >= 0; index--) {
      const probe = probes[index];
      if (!probe || probe.after >= pass) continue;
      probes.splice(index, 1);
      if (failure) probe.reject(failure.error);
      else probe.resolve();
    }
  }

  async function loop(): Promise<void> {
    for (;;) {
      if (state.phase !== "stopped") state = { phase: "running" };
      inPass = true;
      const pass = ++passes;
      lastStartMs = now();
      let failure: { error: unknown } | null = null;
      try {
        await options.run();
      } catch (error) {
        options.onError(error);
        failure = { error };
      }
      inPass = false;
      settleProbes(pass, failure);
      // `stop()` may have run during the pass (TypeScript cannot see that through the await).
      const after = state as State;
      // A `runOnce()` made during this pass waits for the next one, stopped or not.
      if (after.phase === "stopped") {
        if (probes.length > 0) continue;
      } else if (after.phase === "running_rerun" || probes.length > 0) {
        if (minIntervalMs !== undefined) {
          schedule();
          return;
        }
        continue;
      } else {
        state = { phase: "idle", next: armNext() };
      }
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
        if (state.next) timers.clearTimeout(state.next);
        state = { phase: "idle", next: null };
        const done = openBusy();
        if (minIntervalMs !== undefined) schedule();
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
    runOnce() {
      const done = new Promise<void>((resolve, reject) => {
        probes.push({ after: passes, resolve, reject });
      });
      // A pass in flight (or scheduled) runs the probe's pass after it; otherwise start one.
      if (state.phase === "idle") void trigger();
      else if (state.phase === "stopped" && !inPass) {
        openBusy();
        void loop();
      }
      return done;
    },
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
      const wasScheduled = state.phase === "scheduled";
      if (state.phase === "scheduled") timers.clearTimeout(state.timer);
      if (state.phase === "idle" && state.next) timers.clearTimeout(state.next);
      state = { phase: "stopped" };
      const pending = busy?.done ?? Promise.resolve();
      if (inPass) {
        // The pass in flight settles the busy period when it ends.
      } else if (wasScheduled && probes.length > 0) {
        // The dropped pass was a `runOnce()`'s: it runs now instead.
        void loop();
      } else {
        closeBusy();
      }
      return pending;
    },
  };
}
