import { describe, expect, it } from "vitest";

import {
  dropTarget,
  type ReorderEvent,
  type ReorderState,
  reduceReorder,
  reorderActive,
  reorderDrag,
} from "./pointer-reorder-state";

/** Three 100px-wide items in a row: 0-100, 100-200, 200-300. */
const rects = [
  { right: 100, bottom: 40 },
  { right: 200, bottom: 40 },
  { right: 300, bottom: 40 },
];
const measure = () => rects;
const IDLE: ReorderState = { phase: "idle" };

const down = (index: number, x: number, immediate = false): ReorderEvent => ({
  type: "down",
  pointerId: 1,
  index,
  x,
  y: 10,
  immediate,
  measure,
});
const move = (x: number, touch = false, pointerId = 1): ReorderEvent => ({
  type: "move",
  pointerId,
  x,
  y: 10,
  touch,
  measure,
});

function run(events: ReorderEvent[], state: ReorderState = IDLE) {
  let current = state;
  const moves: { from: number; to: number }[] = [];
  const swallowed: boolean[] = [];
  for (const event of events) {
    const transition = reduceReorder(current, event, "x");
    current = transition.state;
    if (transition.move) moves.push(transition.move);
    if (event.type === "click") swallowed.push(transition.swallowClick === true);
  }
  return { state: current, moves, swallowed };
}

describe("dropTarget", () => {
  it("is the first item whose far edge is past the point, or the last", () => {
    expect(dropTarget(rects, "x", 50, 1)).toBe(0);
    expect(dropTarget(rects, "x", 150, 0)).toBe(1);
    expect(dropTarget(rects, "x", 900, 0)).toBe(2);
    expect(dropTarget([], "x", 50, 1)).toBe(1);
  });
});

describe("reduceReorder", () => {
  it("drags a mouse press past the threshold and moves on release, swallowing its click", () => {
    const pressed = run([down(0, 50)]).state;
    expect(pressed.phase).toBe("pressing");
    expect(reorderDrag(pressed)).toBeNull();
    const dragging = run([move(60), move(250)], pressed).state;
    expect(reorderDrag(dragging)).toEqual({ from: 0, to: 2 });
    const { state, moves, swallowed } = run(
      [{ type: "up", pointerId: 1 }, { type: "click" }, { type: "click" }],
      dragging,
    );
    expect(moves).toEqual([{ from: 0, to: 2 }]);
    // Only the click that ends the drag.
    expect(swallowed).toEqual([true, false]);
    expect(state).toEqual(IDLE);
  });

  it("treats a press that barely moves as a click", () => {
    const { state, moves, swallowed } = run([
      down(1, 150),
      move(152),
      { type: "up", pointerId: 1 },
      { type: "click" },
    ]);
    expect(moves).toEqual([]);
    expect(swallowed).toEqual([false]);
    expect(state).toEqual(IDLE);
  });

  it("moves nothing for a drag dropped where it started, but still swallows its click", () => {
    const { moves, swallowed } = run([
      down(0, 50),
      move(80),
      { type: "up", pointerId: 1 },
      { type: "click" },
    ]);
    expect(moves).toEqual([]);
    expect(swallowed).toEqual([true]);
  });

  it("starts a touch drag only after its long press; a swipe before it is a scroll", () => {
    const pressed = run([down(2, 250)]).state;
    // The swipe.
    expect(run([move(150, true)], pressed).state).toEqual(IDLE);
    // A small drift keeps the press.
    expect(run([move(255, true)], pressed).state).toBe(pressed);
    const dragging = run([{ type: "longPress", press: pressed, measure }], pressed).state;
    expect(reorderDrag(dragging)).toEqual({ from: 2, to: 2 });
    const { moves } = run([move(20, true), { type: "up", pointerId: 1 }], dragging);
    expect(moves).toEqual([{ from: 2, to: 0 }]);
  });

  it("ignores a long press of a press that is over", () => {
    const old = run([down(0, 50)]).state;
    const current = run([down(1, 150)], old).state;
    expect(run([{ type: "longPress", press: old, measure }], current).state).toBe(current);
  });

  it("starts an immediate (handle) touch drag at once", () => {
    expect(reorderDrag(run([down(1, 150, true)]).state)).toEqual({ from: 1, to: 1 });
  });

  it("ignores another pointer's moves and releases", () => {
    const pressed = run([down(0, 50)]).state;
    expect(run([move(250, false, 2), { type: "up", pointerId: 2 }], pressed).state).toBe(pressed);
  });

  it("drops nothing when the gesture is cancelled", () => {
    const { state, moves } = run([
      down(0, 50),
      move(250),
      { type: "cancel" },
      { type: "up", pointerId: 1 },
    ]);
    expect(moves).toEqual([]);
    expect(state).toEqual(IDLE);
  });

  it("keeps a press, but ends a drag, when pointer capture is lost", () => {
    const pressed = run([down(0, 50)]).state;
    expect(run([{ type: "lostCapture" }], pressed).state).toBe(pressed);
    expect(run([move(250), { type: "lostCapture" }], pressed).state).toEqual(IDLE);
  });

  it("keeps waiting for a drag's click through its capture loss", () => {
    const { swallowed } = run([
      down(0, 50),
      move(250),
      { type: "up", pointerId: 1 },
      { type: "lostCapture" },
      { type: "cancel" },
      { type: "click" },
    ]);
    expect(swallowed).toEqual([true]);
  });

  it("does not swallow the next press's click when a drag's click never came", () => {
    const { swallowed } = run([
      down(0, 50),
      move(250),
      { type: "up", pointerId: 1 },
      down(1, 150),
      { type: "up", pointerId: 1 },
      { type: "click" },
    ]);
    expect(swallowed).toEqual([false]);
  });

  it("is active (no context menu) only while pressing or dragging", () => {
    expect(reorderActive(IDLE)).toBe(false);
    expect(reorderActive({ phase: "dropped" })).toBe(false);
    const pressed = run([down(0, 50)]).state;
    expect(reorderActive(pressed)).toBe(true);
    expect(reorderActive(run([move(250)], pressed).state)).toBe(true);
  });
});
