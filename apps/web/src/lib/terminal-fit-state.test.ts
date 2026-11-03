import { describe, expect, it } from "vitest";

import {
  type FitEvent,
  type FitState,
  INITIAL_FIT_STATE,
  isFitHeld,
  pendingFit,
  reduceFit,
} from "./terminal-fit-state";

/** Apply `events` in order; returns the final state and whether each one laid out. */
function run(events: FitEvent[], state: FitState = INITIAL_FIT_STATE) {
  const layouts: boolean[] = [];
  let current = state;
  for (const event of events) {
    const transition = reduceFit(current, event);
    current = transition.state;
    layouts.push(transition.layout);
  }
  return { state: current, layouts };
}

const applied = (following = false): FitEvent => ({ type: "sizeApplied", following });

describe("reduceFit", () => {
  it("starts with nothing queued or waiting", () => {
    expect(isFitHeld(INITIAL_FIT_STATE)).toBe(false);
    expect(pendingFit(INITIAL_FIT_STATE)).toBeNull();
  });

  it("holds a writer's layout while PTY sizes are queued, and lays out at the last one", () => {
    const { state, layouts } = run([
      { type: "sizeQueued" },
      { type: "sizeQueued" },
      { type: "layoutHeld" },
      applied(),
      applied(),
    ]);
    expect(layouts).toEqual([false, false, false, false, true]);
    expect(state.pending).toEqual({ kind: "none" });
    expect(state.queuedSizes).toBe(0);
  });

  it("does not lay out for a held layout when following by the time the queue drains", () => {
    const { layouts, state } = run([{ type: "sizeQueued" }, { type: "layoutHeld" }, applied(true)]);
    expect(layouts.at(-1)).toBe(false);
    expect(state.pending).toEqual({ kind: "none" });
  });

  it("marks no layout due when nothing holds it", () => {
    const { state } = run([{ type: "layoutHeld" }]);
    expect(state.pending).toEqual({ kind: "none" });
  });

  it("runs a takeover's fit when its barrier passes with nothing queued", () => {
    const { state, layouts } = run([{ type: "takeover" }, { type: "barrierPassed", fit: 1 }]);
    expect(layouts).toEqual([false, true]);
    expect(state.pending).toEqual({ kind: "none" });
    expect(isFitHeld(state)).toBe(false);
  });

  it("holds every layout while a takeover's fit waits for its barrier", () => {
    const { state } = run([{ type: "takeover" }]);
    expect(isFitHeld(state)).toBe(true);
    // A held layout does not replace the takeover's fit.
    expect(run([{ type: "layoutHeld" }], state).state.pending).toEqual({ kind: "barrier", fit: 1 });
  });

  it("leaves a fit whose barrier passed to the last PTY size still queued", () => {
    const { state, layouts } = run([
      { type: "sizeQueued" },
      { type: "takeover" },
      { type: "sizeQueued" },
      { type: "barrierPassed", fit: 1 },
    ]);
    expect(layouts).toEqual([false, false, false, false]);
    expect(state.pending).toEqual({ kind: "fit", fit: 1 });
    const after = run([applied(), applied()], state);
    expect(after.layouts).toEqual([false, true]);
    expect(after.state.pending).toEqual({ kind: "none" });
  });

  it("a queued size draining before the barrier does not run the takeover's fit", () => {
    const { state, layouts } = run([{ type: "sizeQueued" }, { type: "takeover" }, applied()]);
    expect(layouts.at(-1)).toBe(false);
    expect(state.pending).toEqual({ kind: "barrier", fit: 1 });
  });

  it("drops a layout held before a takeover: the takeover's fit lays out instead", () => {
    const { state } = run([{ type: "sizeQueued" }, { type: "layoutHeld" }, { type: "takeover" }]);
    expect(state.pending).toEqual({ kind: "barrier", fit: 1 });
    const after = run(
      [applied(), { type: "barrierPassed", fit: 1 }, { type: "sizeQueued" }, applied()],
      state,
    );
    // Only the barrier lays out; the later size has nothing due.
    expect(after.layouts).toEqual([false, true, false, false]);
  });

  it("ignores an older takeover's barrier once a newer one waits", () => {
    const { state, layouts } = run([
      { type: "takeover" },
      { type: "followed" },
      { type: "takeover" },
      { type: "barrierPassed", fit: 1 },
    ]);
    expect(layouts).toEqual([false, true, false, false]);
    expect(state.pending).toEqual({ kind: "barrier", fit: 2 });
    expect(run([{ type: "barrierPassed", fit: 2 }], state).layouts).toEqual([true]);
  });

  it("cancels a waiting fit when following again, and lays out", () => {
    for (const setup of [
      [{ type: "takeover" }] as FitEvent[],
      [
        { type: "sizeQueued" },
        { type: "takeover" },
        { type: "barrierPassed", fit: 1 },
      ] as FitEvent[],
      [{ type: "sizeQueued" }, { type: "layoutHeld" }] as FitEvent[],
    ]) {
      const { state } = run([...setup, { type: "followed" }]);
      expect(state.pending).toEqual({ kind: "none" });
      expect(reduceFit(run(setup).state, { type: "followed" }).layout).toBe(true);
      // The queue still drains without laying out.
      expect(run([applied()], state).layouts).toEqual([false]);
    }
  });

  it("starts a new xterm with an empty queue and nothing waiting, keeping fit numbers unique", () => {
    const { state } = run([
      { type: "sizeQueued" },
      { type: "takeover" },
      { type: "opened" },
      { type: "takeover" },
    ]);
    expect(state.queuedSizes).toBe(0);
    expect(state.pending).toEqual({ kind: "barrier", fit: 2 });
  });

  it("never counts the queue below zero", () => {
    expect(run([applied()]).state.queuedSizes).toBe(0);
  });
});
