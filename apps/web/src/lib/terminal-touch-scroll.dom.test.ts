// @vitest-environment jsdom

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scrollTerminalLines,
  TOUCH_SCROLL_SLOP_PX,
  TouchScrollGesture,
  TouchScrollMomentum,
  wireTouchScroll,
} from "./terminal-touch-scroll";

/** 20 rows of 18 px, as xterm lays out 13 px text at line height 1.2 (probe: 18 px). */
const LINE = 18;

describe("TouchScrollGesture", () => {
  it("is a tap until the finger moves past the slop", () => {
    const gesture = new TouchScrollGesture({ x: 100, y: 100 }, 0);
    expect(gesture.move({ x: 100, y: 100 - TOUCH_SCROLL_SLOP_PX }, 10, LINE)).toBe(0);
    expect(gesture.moved).toBe(false);
    expect(gesture.scrolling).toBe(false);
    expect(gesture.end(20)).toBeNull();
  });

  it("scrolls whole lines toward newer output when the finger moves up, counted from touchdown", () => {
    const gesture = new TouchScrollGesture({ x: 100, y: 300 }, 0);
    // 11 px: past the slop, under a line.
    expect(gesture.move({ x: 100, y: 289 }, 10, LINE)).toBe(0);
    expect(gesture.scrolling).toBe(true);
    // 37 px in all: two lines (the slop's distance counts).
    expect(gesture.move({ x: 100, y: 263 }, 20, LINE)).toBe(2);
    // 100 px in all: five lines, the remainder carried.
    expect(gesture.move({ x: 100, y: 200 }, 30, LINE)).toBe(3);
  });

  it("scrolls toward older output when the finger moves down", () => {
    const gesture = new TouchScrollGesture({ x: 100, y: 100 }, 0);
    expect(gesture.move({ x: 100, y: 100 + 4 * LINE }, 10, LINE)).toBe(-4);
    // Back up by one line.
    expect(gesture.move({ x: 100, y: 100 + 3 * LINE }, 20, LINE)).toBe(1);
  });

  it("ignores a drag that starts sideways for the rest of the gesture", () => {
    const gesture = new TouchScrollGesture({ x: 100, y: 100 }, 0);
    expect(gesture.move({ x: 130, y: 105 }, 10, LINE)).toBe(0);
    expect(gesture.moved).toBe(true);
    expect(gesture.scrolling).toBe(false);
    expect(gesture.move({ x: 130, y: 300 }, 20, LINE)).toBe(0);
    expect(gesture.end(30)).toBeNull();
  });

  it("keeps going after a fast release, and stops with a slow or held one", () => {
    const fast = new TouchScrollGesture({ x: 0, y: 400 }, 0);
    for (let step = 1; step <= 5; step += 1)
      fast.move({ x: 0, y: 400 - step * 20 }, step * 8, LINE);
    expect(fast.end(40)).toBeInstanceOf(TouchScrollMomentum);

    const held = new TouchScrollGesture({ x: 0, y: 400 }, 0);
    for (let step = 1; step <= 5; step += 1)
      held.move({ x: 0, y: 400 - step * 20 }, step * 8, LINE);
    // Held still for 150 ms before lifting: no velocity left.
    expect(held.end(190)).toBeNull();
  });

  it("counts a pause before lifting, even one inside the velocity window", () => {
    // 100 px in 80 ms, then 8 px more, then held still for 91 ms: 8 px in the last 99 ms.
    const paused = new TouchScrollGesture({ x: 0, y: 400 }, 0);
    paused.move({ x: 0, y: 300 }, 80, LINE);
    paused.move({ x: 0, y: 292 }, 88, LINE);
    expect(paused.end(179)).toBeNull();
  });

  it("keeps a genuinely fast release's speed", () => {
    const fast = new TouchScrollGesture({ x: 0, y: 400 }, 0);
    for (let step = 1; step <= 6; step += 1)
      fast.move({ x: 0, y: 400 - step * 30 }, step * 16, LINE);
    // Lifted 4 ms after the last move: about 180 px over 100 ms.
    const momentum = fast.end(100);
    expect(momentum).toBeInstanceOf(TouchScrollMomentum);
    let lines = 0;
    for (let time = 116; momentum && !momentum.done; time += 16)
      lines += momentum.step(time, LINE, 100);
    // About 1.8 px/ms * 325 ms, in 18 px lines.
    expect(lines).toBeGreaterThan(25);
  });
});

describe("TouchScrollMomentum", () => {
  it("scrolls in the release direction, slows down, and stops", () => {
    const momentum = new TouchScrollMomentum(2, 0);
    const steps: number[] = [];
    for (let frame = 1; frame < 400 && !momentum.done; frame += 1)
      steps.push(momentum.step(frame * 16, LINE, 100));
    expect(momentum.done).toBe(true);
    expect(steps.every((lines) => lines >= 0)).toBe(true);
    const total = steps.reduce((sum, lines) => sum + lines, 0);
    // v * tau = 650 px at most: about 36 lines.
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThanOrEqual(Math.ceil(650 / LINE));
    expect(new TouchScrollMomentum(-2, 0).step(16, LINE, 100)).toBeLessThanOrEqual(0);
  });

  it("never scrolls more than the cap in one frame", () => {
    expect(new TouchScrollMomentum(50, 0).step(100, LINE, 3)).toBe(3);
  });

  it("scrolls nothing at a frame after its deadline, and stops for good", () => {
    const momentum = new TouchScrollMomentum(2, 0);
    expect(momentum.step(16, LINE, 100)).toBeGreaterThanOrEqual(0);
    // The page was suspended: the next frame comes 30 s later.
    expect(momentum.step(30_000, LINE, 100)).toBe(0);
    expect(momentum.done).toBe(true);
    expect(momentum.step(30_016, LINE, 100)).toBe(0);
  });

  it("stops at a frame that comes too long after the one before, without catching up", () => {
    const momentum = new TouchScrollMomentum(2, 0);
    momentum.step(16, LINE, 100);
    // Within the 3 s, but half a second without a frame (a stalled page): no burst.
    expect(momentum.step(516, LINE, 100)).toBe(0);
    expect(momentum.done).toBe(true);
  });

  it("stops at its deadline even while frames keep coming", () => {
    // 1000 px/ms decays under the stop speed only after about 3.2 s.
    const momentum = new TouchScrollMomentum(1_000, 0);
    let after = 0;
    for (let time = 16; time < 5_000; time += 16) {
      const lines = momentum.step(time, LINE, 100);
      if (time > 3_000) after += Math.abs(lines);
    }
    expect(momentum.done).toBe(true);
    expect(after).toBe(0);
  });
});

type Wheel = {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  bubbles: boolean;
};

/** A stand-in for xterm: its element records the wheel events it gets, as xterm's listeners do. */
function fakeTerminal(consume: boolean) {
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => new DOMRect(10, 20, 600, 20 * LINE);
  element.appendChild(screen);
  const wheels: Wheel[] = [];
  const scrolled: number[] = [];
  element.addEventListener("wheel", (event) => {
    wheels.push({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      bubbles: event.bubbles,
    });
    // xterm cancels a wheel it turns into a report or an arrow key.
    if (consume) event.preventDefault();
  });
  const term = {
    element,
    rows: 20,
    scrollLines: (amount: number) => scrolled.push(amount),
  };
  return { term: term as unknown as Terminal, element, wheels, scrolled };
}

describe("scrollTerminalLines", () => {
  it("sends one line-mode wheel event per line to xterm's element, at a point on the screen", () => {
    const { term, wheels, scrolled } = fakeTerminal(true);
    scrollTerminalLines(term, 3, { x: 0, y: 1000 });
    expect(wheels).toEqual(
      Array.from({ length: 3 }, () => ({
        deltaY: 1,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: 11,
        clientY: 20 + 20 * LINE - 1,
        bubbles: false,
      })),
    );
    expect(scrolled).toEqual([]);
    scrollTerminalLines(term, -2, { x: 50, y: 60 });
    expect(wheels.slice(3).map((wheel) => [wheel.deltaY, wheel.clientX, wheel.clientY])).toEqual([
      [-1, 50, 60],
      [-1, 50, 60],
    ]);
  });

  it("scrolls the scrollback when xterm leaves the wheel alone (the normal buffer)", () => {
    const { term, wheels, scrolled } = fakeTerminal(false);
    scrollTerminalLines(term, -4, { x: 50, y: 60 });
    expect(wheels).toHaveLength(4);
    expect(scrolled).toEqual([-4]);
  });
});

type FakeTouch = { identifier: number; clientX: number; clientY: number };
/** The fingers down, as the last touch event reported them (their identifiers stay theirs). */
let fingersDown: FakeTouch[] = [];
let nextFinger = 0;

/**
 * A touch event with the given fingers down (jsdom has no Touch constructor). Its changedTouches
 * are the fingers it puts down, moves or lifts; a lifted finger is where it was last unless
 * `liftedAt` says where it lifted (a touchend's own final position, with no move to it before).
 */
function touchEvent(
  type: string,
  points: { x: number; y: number }[],
  liftedAt?: { x: number; y: number }[],
) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  // One finger down again: every earlier finger lifted (seen or not).
  if (type === "touchstart" && points.length <= fingersDown.length) fingersDown = [];
  const byOrder = (point: { x: number; y: number }, index: number): FakeTouch => ({
    identifier: fingersDown[index]?.identifier ?? nextFinger++,
    clientX: point.x,
    clientY: point.y,
  });
  let touches: FakeTouch[];
  let changed: FakeTouch[];
  if (type === "touchend" || type === "touchcancel") {
    // The fingers still down are the ones where they were; the others lift.
    touches = points.map(
      (point, index) =>
        fingersDown.find((finger) => finger.clientX === point.x && finger.clientY === point.y) ??
        byOrder(point, index),
    );
    changed = fingersDown
      .filter((finger) => !touches.includes(finger))
      .map((finger, index) => {
        const at = liftedAt?.[index];
        return at ? { ...finger, clientX: at.x, clientY: at.y } : finger;
      });
  } else {
    touches = points.map(byOrder);
    changed = type === "touchstart" ? touches.slice(fingersDown.length) : touches;
  }
  fingersDown = touches;
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changed });
  return event;
}

/** The page goes hidden (headless engines cannot hide it for real). */
function hidePage() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
  } finally {
    // Back to jsdom's own (the prototype getter).
    Reflect.deleteProperty(document, "visibilityState");
  }
}

describe("wireTouchScroll", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  function setup(
    options: { consume?: boolean; enabled?: () => boolean; cancelFrameWorks?: boolean } = {},
  ) {
    const fake = fakeTerminal(options.consume ?? true);
    const container = document.createElement("div");
    container.appendChild(fake.element);
    // In the page, as the pane is: a finger outside it is seen through the document.
    document.body.appendChild(container);
    disposers.push(() => container.remove());
    let clock = 0;
    const frames: ((time: number) => void)[] = [];
    let tapCount = 0;
    /** How many releases were taps (each opens the copy window). */
    const taps = () => tapCount;
    const wiring = wireTouchScroll(fake.term, container, {
      enabled: options.enabled ?? (() => true),
      onTap: () => {
        tapCount += 1;
      },
      now: () => clock,
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: (handle) => {
        // Off: a frame the browser already took off its queue still runs.
        if (options.cancelFrameWorks !== false) frames[handle - 1] = () => undefined;
      },
    });
    disposers.push(wiring.dispose);
    const at = (ms: number) => {
      clock = ms;
    };
    /** Run queued animation frames 16 ms apart until none are left (or a cap). */
    let nextFrame = 0;
    const runFrames = () => {
      for (; nextFrame < frames.length && nextFrame < 1000; nextFrame += 1) {
        clock += 16;
        frames[nextFrame]?.(clock);
      }
    };
    return { ...fake, container, wiring, at, frames, runFrames, taps };
  }

  /** A slow drag from y0 to y1 at x=100, ending after holding still (no momentum). */
  function drag(container: HTMLElement, at: (ms: number) => void, y0: number, y1: number) {
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: y0 }]));
    const moves: Event[] = [];
    for (let step = 1; step <= 10; step += 1) {
      at(step * 16);
      const move = touchEvent("touchmove", [{ x: 100, y: y0 + ((y1 - y0) * step) / 10 }]);
      container.dispatchEvent(move);
      moves.push(move);
    }
    at(500);
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    return { moves, end };
  }

  it("turns a vertical swipe into wheel events, and keeps it from being a tap", () => {
    const { container, wheels, taps, at } = setup();
    const { moves, end } = drag(container, at, 300, 300 - 5 * LINE);
    expect(wheels.map((wheel) => wheel.deltaY)).toEqual([1, 1, 1, 1, 1]);
    // The position is where the finger went down.
    expect(new Set(wheels.map((wheel) => wheel.clientY))).toEqual(new Set([300]));
    // Past the slop the browser pans nothing, and the release makes no click.
    expect(moves.filter((move) => move.defaultPrevented).length).toBeGreaterThan(0);
    expect(end.defaultPrevented).toBe(true);
    expect(taps()).toBe(0);
  });

  it("leaves a tap alone, even one that wobbles under the slop", () => {
    const { container, wheels, taps, at } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
    at(30);
    const move = touchEvent("touchmove", [{ x: 104, y: 105 }]);
    container.dispatchEvent(move);
    at(80);
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    expect(wheels).toEqual([]);
    // Cancelling either would cancel the tap's click, and the keyboard it opens.
    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(taps()).toBe(1);
  });

  // Round 10 (F-FA-1): the moves before a lift may be coalesced into its touchend, so the touchend's
  // own position for the touch's finger decides too.
  describe("where the finger lifts decides whether it was a tap", () => {
    const starts = {
      "with no move before it": [],
      "after a move under the slop": [{ x: 104, y: 98 }],
    } as Record<string, { x: number; y: number }[]>;
    it.each(Object.keys(starts))(
      "a lift past the slop is no tap and its release is cancelled (%s)",
      (name) => {
        for (const enabled of [true, false]) {
          const { container, wheels, taps, at } = setup({ enabled: () => enabled });
          at(0);
          container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
          for (const point of starts[name] ?? []) {
            at(16);
            container.dispatchEvent(touchEvent("touchmove", [point]));
          }
          at(32);
          const end = touchEvent("touchend", [], [{ x: 100, y: 100 + TOUCH_SCROLL_SLOP_PX + 1 }]);
          container.dispatchEvent(end);
          expect(end.defaultPrevented).toBe(true);
          expect(taps()).toBe(0);
          expect(wheels).toEqual([]);
        }
      },
    );

    it("a lift at the slop boundary (exactly 10 px away) is still a tap", () => {
      const { container, taps, at } = setup();
      at(0);
      container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
      at(32);
      const end = touchEvent("touchend", [], [{ x: 106, y: 108 }]);
      container.dispatchEvent(end);
      expect(end.defaultPrevented).toBe(false);
      expect(taps()).toBe(1);
    });

    it("a touchend that does not carry the touch's finger is no tap (fails closed)", () => {
      for (const changed of [[], [{ identifier: -1, clientX: 100, clientY: 100 }]]) {
        const { container, taps } = setup();
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
        const end = new Event("touchend", { cancelable: true, bubbles: true });
        Object.defineProperty(end, "touches", { value: [] });
        Object.defineProperty(end, "changedTouches", { value: changed });
        container.dispatchEvent(end);
        expect(end.defaultPrevented).toBe(true);
        expect(taps()).toBe(0);
      }
    });
  });

  // Owner decision (round 10): how long a still finger stays down does not matter.
  it("takes a long still press as a tap (intended)", () => {
    const { container, taps, at } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
    at(1_200);
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(false);
    expect(taps()).toBe(1);
  });

  it("does not scroll on a sideways drag, and does not take it as a tap", () => {
    const { container, wheels, taps, at } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 100 }]));
    at(16);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 160, y: 110 }]));
    at(32);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 200, y: 300 }]));
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    expect(wheels).toEqual([]);
    expect(end.defaultPrevented).toBe(true);
    expect(taps()).toBe(0);
  });

  it("leaves touch to the browser while disabled (following, Select text, hidden)", () => {
    const { container, wheels, taps, at } = setup({ enabled: () => false });
    const { moves, end } = drag(container, at, 300, 100);
    expect(wheels).toEqual([]);
    expect(moves.some((move) => move.defaultPrevented)).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    // Still not a tap: a drag the browser did not cancel opens no copy window either.
    expect(taps()).toBe(0);
  });

  it("stops scrolling mid-gesture once disabled", () => {
    let enabled = true;
    const { container, wheels, at } = setup({ enabled: () => enabled });
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
    at(16);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 2 * LINE }]));
    expect(wheels).toHaveLength(2);
    enabled = false;
    at(32);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 6 * LINE }]));
    container.dispatchEvent(touchEvent("touchend", []));
    expect(wheels).toHaveLength(2);
  });

  it("gives a second finger (pinch zoom) to the browser, and makes no tap or click of it", () => {
    const { container, wheels, taps, at } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
    container.dispatchEvent(
      touchEvent("touchstart", [
        { x: 100, y: 300 },
        { x: 200, y: 300 },
      ]),
    );
    at(16);
    const move = touchEvent("touchmove", [
      { x: 100, y: 200 },
      { x: 200, y: 400 },
    ]);
    container.dispatchEvent(move);
    expect(wheels).toEqual([]);
    expect(move.defaultPrevented).toBe(false);
    // Each finger's release is cancelled: the first while the other is still down, and the last.
    const first = touchEvent("touchend", [{ x: 200, y: 400 }]);
    container.dispatchEvent(first);
    const last = touchEvent("touchend", []);
    container.dispatchEvent(last);
    expect([first.defaultPrevented, last.defaultPrevented]).toEqual([true, true]);
    expect(taps()).toBe(0);
  });

  it("keeps scrolling after a flick until it slows down, and a new touch stops it", () => {
    const { container, wheels, at, runFrames, frames } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    const duringDrag = wheels.length;
    expect(duringDrag).toBe(Math.trunc(100 / LINE));
    container.dispatchEvent(touchEvent("touchend", []));
    expect(frames).toHaveLength(1);
    runFrames();
    expect(wheels.length).toBeGreaterThan(duringDrag + 3);
    expect(wheels.every((wheel) => wheel.deltaY === 1)).toBe(true);

    // A flick, then a touch right away: the momentum ends there.
    const before = wheels.length;
    at(10_000);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(10_000 + step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    container.dispatchEvent(touchEvent("touchend", []));
    const afterDrag = wheels.length;
    expect(afterDrag).toBe(before + Math.trunc(100 / LINE));
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    runFrames();
    expect(wheels.length).toBe(afterDrag);
  });

  it("takes a touch that stops a coasting scroll as a stop, not a tap", () => {
    const { container, wheels, taps, at, frames } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    container.dispatchEvent(touchEvent("touchend", []));
    expect(frames).toHaveLength(1);
    const coasted = wheels.length;
    at(60);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    // No click (report, writer claim) and no copy window for it.
    expect(end.defaultPrevented).toBe(true);
    expect(taps()).toBe(0);
    expect(wheels.length).toBe(coasted);
    // The next plain tap is a tap again.
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    const tap = touchEvent("touchend", []);
    container.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
    expect(taps()).toBe(1);
  });

  it("stops the momentum once disabled", () => {
    let enabled = true;
    const { container, wheels, at, runFrames } = setup({ enabled: () => enabled });
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    container.dispatchEvent(touchEvent("touchend", []));
    const afterDrag = wheels.length;
    enabled = false;
    runFrames();
    expect(wheels.length).toBe(afterDrag);
  });

  /** A flick up of 100 px in 40 ms, lifted at once: momentum is queued. */
  function flick(container: HTMLElement, at: (ms: number) => void, startMs = 0) {
    at(startMs);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(startMs + step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    container.dispatchEvent(touchEvent("touchend", []));
  }

  it("cancel ends a coasting scroll for good, even a frame already queued; a new flick works", () => {
    const { container, wheels, wiring, at, frames, runFrames } = setup({
      cancelFrameWorks: false,
    });
    flick(container, at);
    const afterDrag = wheels.length;
    expect(frames).toHaveLength(1);
    wiring.cancel();
    runFrames();
    expect(wheels.length).toBe(afterDrag);
    expect(frames).toHaveLength(1);
    // The next interaction scrolls and coasts as usual.
    flick(container, at, 10_000);
    const afterSecond = wheels.length;
    expect(afterSecond).toBe(afterDrag + Math.trunc(100 / LINE));
    runFrames();
    expect(wheels.length).toBeGreaterThan(afterSecond + 3);
  });

  it("cancel mid-drag: it scrolls no more and starts no momentum, and is still not a tap", () => {
    const { container, wheels, wiring, taps, at, frames } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 3; step += 1) {
      at(step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    const before = wheels.length;
    expect(before).toBe(3);
    wiring.cancel();
    at(32);
    const move = touchEvent("touchmove", [{ x: 100, y: 300 }]);
    container.dispatchEvent(move);
    const end = touchEvent("touchend", []);
    container.dispatchEvent(end);
    expect(wheels.length).toBe(before);
    expect(frames).toHaveLength(0);
    // The drag stays out of the page and makes no click.
    expect(move.defaultPrevented).toBe(true);
    expect(end.defaultPrevented).toBe(true);
    expect(taps()).toBe(0);
  });

  it("a drag cancelled while the finger is down stays cancelled once enabled again", () => {
    let enabled = true;
    const { container, wheels, wiring, at, frames } = setup({ enabled: () => enabled });
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    at(8);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 }]));
    // Disabled and enabled again (hidden and shown) while the finger is down.
    enabled = false;
    wiring.cancel();
    enabled = true;
    const before = wheels.length;
    at(16);
    container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 200 }]));
    container.dispatchEvent(touchEvent("touchend", []));
    expect(wheels.length).toBe(before);
    expect(frames).toHaveLength(0);
  });

  it("a momentum frame that runs long after the deadline scrolls nothing", () => {
    const { container, wheels, at, frames } = setup();
    flick(container, at);
    const afterDrag = wheels.length;
    expect(frames).toHaveLength(1);
    // The page was suspended: the queued frame runs 30 s later.
    at(30_000);
    frames[0]?.(30_000);
    expect(wheels.length).toBe(afterDrag);
    expect(frames).toHaveLength(1);
  });

  it("stops coasting when the page is hidden", () => {
    const { container, wheels, at, runFrames } = setup({ cancelFrameWorks: false });
    flick(container, at);
    const afterDrag = wheels.length;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      // Back to jsdom's own (the prototype getter).
      Reflect.deleteProperty(document, "visibilityState");
    }
    runFrames();
    expect(wheels.length).toBe(afterDrag);
  });

  it("keeps coasting while the page stays visible", () => {
    const { container, wheels, at, runFrames } = setup();
    flick(container, at);
    const afterDrag = wheels.length;
    document.dispatchEvent(new Event("visibilitychange"));
    runFrames();
    expect(wheels.length).toBeGreaterThan(afterDrag + 3);
  });

  describe("a touch belongs to the interaction it started in", () => {
    type Setup = ReturnType<typeof setup>;
    /** Bring a touch to a state; the finger stays down unless the state says otherwise. */
    const states: Record<string, (s: Setup, enable: (value: boolean) => void) => void> = {
      "a pending tap": ({ container, at }) => {
        at(0);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
        at(30);
        container.dispatchEvent(touchEvent("touchmove", [{ x: 104, y: 303 }]));
      },
      "a scrolling drag": ({ container, at }) => {
        at(0);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
        at(16);
        container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 3 * LINE }]));
      },
      "a drag that started disabled (following)": ({ container, at }, enable) => {
        enable(false);
        at(0);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
        at(16);
        container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 3 * LINE }]));
        enable(true);
      },
      "a touch that caught a coasting scroll": ({ container, at }) => {
        flick(container, at);
        at(60);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      },
      "a touch with a second finger from outside": ({ container, at }) => {
        at(0);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
        at(16);
        container.dispatchEvent(
          touchEvent("touchmove", [
            { x: 100, y: 300 },
            { x: 300, y: 500 },
          ]),
        );
      },
    };
    const ends: Record<string, (s: Setup) => void> = {
      "cancel (reset, retire, attach, disabled)": ({ wiring }) => wiring.cancel(),
      "the page going hidden": () => hidePage(),
    };
    const cases = Object.keys(states).flatMap((state) =>
      Object.keys(ends).map((end) => [state, end] as const),
    );

    /** A fresh one-finger tap taps and is left alone, and a fresh swipe scrolls 4 lines. */
    function expectFresh(s: Setup) {
      const taps = s.taps();
      const wheels = s.wheels.length;
      s.at(1_000);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      const tap = touchEvent("touchend", []);
      s.container.dispatchEvent(tap);
      expect(tap.defaultPrevented).toBe(false);
      expect(s.taps()).toBe(taps + 1);
      drag(s.container, s.at, 300, 300 - 4 * LINE);
      expect(s.wheels.length).toBe(wheels + 4);
      expect(s.taps()).toBe(taps + 1);
    }

    it.each(cases)("%s, then %s: void until it lifts; the next touch is fresh", (state, end) => {
      let enabled = true;
      const s = setup({ enabled: () => enabled, cancelFrameWorks: false });
      states[state]?.(s, (value) => {
        enabled = value;
      });
      ends[end]?.(s);
      const before = s.wheels.length;
      const frames = s.frames.length;
      const taps = s.taps();
      s.at(100);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 100 }]));
      s.at(108);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 40 }]));
      const release = touchEvent("touchend", []);
      s.container.dispatchEvent(release);
      // Its release makes no compatibility click (no click report, no writer, no focus), opens no
      // copy window, and it scrolls nothing more, now or as momentum.
      expect(release.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(taps);
      s.runFrames();
      expect(s.wheels.length).toBe(before);
      expect(s.frames.length).toBe(frames);
      expectFresh(s);
    });

    /**
     * Every lift of a touch with two fingers, the second from inside or outside the pane, lifted in
     * either order. `pane` lifts a pane finger (its touchend comes to the pane); `outside` lifts the
     * outside finger (its touchend goes where it started). Returns the pane's release events.
     */
    const lifts: Record<string, (s: Setup, outside: HTMLElement) => Event[]> = {
      "a second finger inside, the first lifting first": ({ container }) => {
        container.dispatchEvent(
          touchEvent("touchstart", [
            { x: 100, y: 300 },
            { x: 200, y: 300 },
          ]),
        );
        const first = touchEvent("touchend", [{ x: 200, y: 300 }]);
        container.dispatchEvent(first);
        const last = touchEvent("touchend", []);
        container.dispatchEvent(last);
        return [first, last];
      },
      "a second finger outside, the pane finger lifting first (the last lift is outside)": (
        { container },
        outside,
      ) => {
        outside.dispatchEvent(
          touchEvent("touchstart", [
            { x: 100, y: 300 },
            { x: 390, y: 600 },
          ]),
        );
        const pane = touchEvent("touchend", [{ x: 390, y: 600 }]);
        container.dispatchEvent(pane);
        outside.dispatchEvent(touchEvent("touchend", []));
        return [pane];
      },
      "a second finger outside, lifting first": ({ container }, outside) => {
        outside.dispatchEvent(
          touchEvent("touchstart", [
            { x: 100, y: 300 },
            { x: 390, y: 600 },
          ]),
        );
        outside.dispatchEvent(touchEvent("touchend", [{ x: 100, y: 300 }]));
        const pane = touchEvent("touchend", []);
        container.dispatchEvent(pane);
        return [pane];
      },
    };
    /** Touch states at the moment the second finger lands. */
    const holds: Record<string, (s: Setup, enable: (value: boolean) => void) => void> = {
      "a pending tap": (s) => states["a pending tap"]?.(s, () => undefined),
      "a claimed drag": (s) => states["a scrolling drag"]?.(s, () => undefined),
      "a pending tap that started disabled (following)": ({ container, at }, enable) => {
        enable(false);
        at(0);
        container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      },
      "an already void tap (a reset while down)": (s) => {
        states["a pending tap"]?.(s, () => undefined);
        s.wiring.cancel();
      },
    };
    const multi = Object.keys(holds).flatMap((hold) =>
      Object.keys(lifts).map((lift) => [hold, lift] as const),
    );

    it.each(multi)(
      "%s with %s: every pane release is cancelled, none taps, and the next tap is fresh",
      (hold, lift) => {
        let enabled = true;
        const s = setup({ enabled: () => enabled, cancelFrameWorks: false });
        const outside = document.body.appendChild(document.createElement("div"));
        try {
          holds[hold]?.(s, (value) => {
            enabled = value;
          });
          const before = s.wheels.length;
          const frames = s.frames.length;
          const releases = lifts[lift]?.(s, outside) ?? [];
          expect(releases.length).toBeGreaterThan(0);
          expect(releases.map((release) => release.defaultPrevented)).toEqual(
            releases.map(() => true),
          );
          expect(s.taps()).toBe(0);
          s.runFrames();
          expect(s.wheels.length).toBe(before);
          expect(s.frames.length).toBe(frames);
          enabled = true;
          expectFresh(s);
        } finally {
          outside.remove();
        }
      },
    );

    it("a finger lifting while another is down after a reset is cancelled before anything else", () => {
      // R3 A-PARTIAL-VOID: void first, then a second finger, then the partial lift.
      const s = setup();
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      s.wiring.cancel();
      const outside = document.body.appendChild(document.createElement("div"));
      outside.dispatchEvent(
        touchEvent("touchstart", [
          { x: 100, y: 300 },
          { x: 390, y: 600 },
        ]),
      );
      const partial = touchEvent("touchend", [{ x: 390, y: 600 }]);
      s.container.dispatchEvent(partial);
      outside.remove();
      expect(partial.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(0);
    });

    it("a lift with a finger left is no tap, even when that finger's touchstart was never seen", () => {
      // The other finger went down in another document (an iframe on the page): neither the pane
      // nor this document saw it start; only the lift's remaining fingers say so.
      const s = setup();
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      const other = document.implementation.createHTMLDocument("frame").body;
      other.dispatchEvent(
        touchEvent("touchstart", [
          { x: 100, y: 300 },
          { x: 390, y: 600 },
        ]),
      );
      const partial = touchEvent("touchend", [{ x: 390, y: 600 }]);
      s.container.dispatchEvent(partial);
      expect(partial.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(0);
    });

    it("a pending tap with nothing ending its interaction is still a tap", () => {
      const s = setup();
      states["a pending tap"]?.(s, () => undefined);
      const release = touchEvent("touchend", []);
      s.container.dispatchEvent(release);
      expect(release.defaultPrevented).toBe(false);
      expect(s.taps()).toBe(1);
    });

    it("a follower's tap (disabled at the start) is still a tap", () => {
      const s = setup({ enabled: () => false });
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      const release = touchEvent("touchend", []);
      s.container.dispatchEvent(release);
      expect(release.defaultPrevented).toBe(false);
      expect(s.taps()).toBe(1);
    });

    it("a one-finger touch outside that has lifted leaves the next pane tap a tap", () => {
      const s = setup();
      const outside = document.body.appendChild(document.createElement("div"));
      outside.dispatchEvent(touchEvent("touchstart", [{ x: 390, y: 600 }]));
      outside.dispatchEvent(touchEvent("touchend", []));
      outside.remove();
      expectFresh(s);
    });

    it("a release whose touch was never seen, or already ended, is cancelled and no tap", () => {
      // A tap, then a release with no touchstart (no record of this interaction): it cannot borrow
      // the earlier tap's verdict.
      const s = setup();
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      s.container.dispatchEvent(touchEvent("touchend", []));
      expect(s.taps()).toBe(1);
      const stray = touchEvent("touchend", []);
      s.container.dispatchEvent(stray);
      expect(stray.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(1);
      const unseen = touchEvent("touchend", []);
      setup().container.dispatchEvent(unseen);
      expect(unseen.defaultPrevented).toBe(true);
    });

    it("a pending tap that outlives dispose makes no tap", () => {
      const s = setup();
      states["a pending tap"]?.(s, () => undefined);
      s.wiring.dispose();
      s.container.dispatchEvent(touchEvent("touchend", []));
      expect(s.taps()).toBe(0);
    });

    it("a second finger from outside stops the scroll for good, also once back to one finger", () => {
      const s = setup();
      s.at(0);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      s.at(16);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 2 * LINE }]));
      expect(s.wheels).toHaveLength(2);
      // The second finger went down outside the pane: only the moves say so.
      s.at(32);
      const pinch = touchEvent("touchmove", [
        { x: 100, y: 300 - 4 * LINE },
        { x: 390, y: 500 },
      ]);
      s.container.dispatchEvent(pinch);
      // The second finger lifts (its touchend goes to where it started, outside); the first goes
      // on alone, fast.
      document.body.dispatchEvent(touchEvent("touchend", [{ x: 100, y: 300 - 4 * LINE }]));
      s.at(40);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 8 * LINE }]));
      s.at(48);
      const release = touchEvent("touchend", []);
      s.container.dispatchEvent(release);
      s.runFrames();
      expect(s.wheels).toHaveLength(2);
      // The pinch stays the browser's.
      expect(pinch.defaultPrevented).toBe(false);
      expect(release.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(0);
      // A fresh swipe scrolls again.
      drag(s.container, s.at, 300, 300 - 3 * LINE);
      expect(s.wheels).toHaveLength(5);
    });

    it("a second finger from outside, seen only by the document, stops the scroll for good", () => {
      const s = setup();
      s.at(0);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      s.at(16);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 2 * LINE }]));
      const outside = document.body.appendChild(document.createElement("div"));
      outside.dispatchEvent(
        touchEvent("touchstart", [
          { x: 100, y: 300 - 2 * LINE },
          { x: 390, y: 600 },
        ]),
      );
      outside.dispatchEvent(touchEvent("touchend", [{ x: 100, y: 300 - 2 * LINE }]));
      outside.remove();
      s.at(24);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 8 * LINE }]));
      s.container.dispatchEvent(touchEvent("touchend", []));
      s.runFrames();
      expect(s.wheels).toHaveLength(2);
      expect(s.taps()).toBe(0);
    });

    it("a touch that starts with two fingers down (one from outside) never scrolls", () => {
      const s = setup();
      s.at(0);
      s.container.dispatchEvent(
        touchEvent("touchstart", [
          { x: 100, y: 300 },
          { x: 390, y: 500 },
        ]),
      );
      s.at(16);
      s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 300 - 4 * LINE }]));
      const release = touchEvent("touchend", []);
      s.container.dispatchEvent(release);
      expect(s.wheels).toHaveLength(0);
      expect(release.defaultPrevented).toBe(true);
      expect(s.taps()).toBe(0);
    });

    it("the browser taking the touch (touchcancel) leaves no tap and no momentum", () => {
      const s = setup();
      s.at(0);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
      for (let step = 1; step <= 5; step += 1) {
        s.at(step * 8);
        s.container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
      }
      s.container.dispatchEvent(touchEvent("touchcancel", []));
      expect(s.frames).toHaveLength(0);
      expect(s.taps()).toBe(0);
      // A pending tap the browser takes is no tap either.
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
      s.container.dispatchEvent(touchEvent("touchcancel", []));
      expect(s.taps()).toBe(0);
      expectFresh(s);
    });
  });

  // R4-P-1: a finger resting on a pane that is replaced (a remount, a closed tab) gets no touchend
  // anywhere, and its compatibility mouse events land on the new terminal.
  describe("a touch's mouse events act only after this pane's own tap", () => {
    type Setup = ReturnType<typeof setup>;
    const ACTING = ["mousemove", "mousedown", "mouseup", "click", "dblclick"] as const;
    /**
     * A mouse event as Chromium makes it: `sourceCapabilities.firesTouchEvents` says whether a touch
     * made it; `null` leaves it out, as WebKit and Firefox do.
     */
    function mouse(type: string, byTouch: boolean | null) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      if (byTouch !== null)
        Object.defineProperty(event, "sourceCapabilities", {
          value: { firesTouchEvents: byTouch },
        });
      return event;
    }
    /**
     * What reaches xterm's element and a capture listener added to the container after the wiring
     * (as useXterm's `armClick` is): the types each saw, and whether each event was cancelled.
     */
    function observe(s: Setup) {
      const reached: string[] = [];
      const later: string[] = [];
      const record = (into: string[]) => (event: Event) => into.push(event.type);
      for (const type of [...ACTING, "contextmenu"]) {
        s.element.addEventListener(type, record(reached));
        s.container.addEventListener(type, record(later), true);
      }
      const send = (type: string, byTouch: boolean | null) => {
        const event = mouse(type, byTouch);
        s.element.dispatchEvent(event);
        return event;
      };
      /** Send every acting type; returns whether each reached xterm and was left uncancelled. */
      const all = (byTouch: boolean | null) =>
        ACTING.map((type) => {
          reached.length = 0;
          later.length = 0;
          const event = send(type, byTouch);
          return reached.includes(type) && later.includes(type) && !event.defaultPrevented;
        });
      return { reached, later, send, all };
    }
    const tap = (s: Setup, ms: number) => {
      s.at(ms);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      const end = touchEvent("touchend", []);
      s.container.dispatchEvent(end);
      return end;
    };
    const NONE = ACTING.map(() => false);
    const EVERY = ACTING.map(() => true);

    it("stops a touch's mouse events in a pane that saw no tap of it (it replaced the one touched)", () => {
      const s = setup();
      const o = observe(s);
      expect(o.all(true)).toEqual(NONE);
      for (const type of ACTING) expect(o.send(type, true).defaultPrevented).toBe(true);
      expect(o.reached).toEqual([]);
      expect(o.later).toEqual([]);
    });

    it("lets a tap's own mouse events through, until the next touch or a second later", () => {
      const s = setup();
      const o = observe(s);
      expect(tap(s, 0).defaultPrevented).toBe(false);
      expect(s.taps()).toBe(1);
      s.at(40);
      expect(o.all(true)).toEqual(EVERY);
      // A double tap: the second tap's events are its own.
      expect(tap(s, 200).defaultPrevented).toBe(false);
      s.at(1_200);
      expect(o.all(true)).toEqual(EVERY);
      s.at(1_201);
      expect(o.all(true)).toEqual(NONE);
    });

    it("ends the tap's turn at any new touch on the page, and at cancel", () => {
      const s = setup();
      const o = observe(s);
      const outside = document.body.appendChild(document.createElement("div"));
      try {
        tap(s, 0);
        // A finger goes down elsewhere (and stays: its pane may be replaced under it).
        outside.dispatchEvent(touchEvent("touchstart", [{ x: 300, y: 600 }]));
        expect(o.all(true)).toEqual(NONE);
        outside.dispatchEvent(touchEvent("touchend", []));
        tap(s, 100);
        s.wiring.cancel();
        expect(o.all(true)).toEqual(NONE);
        // A touch in the pane that is not a tap (a swipe) gives none either.
        tap(s, 200);
        drag(s.container, s.at, 300, 300 - 3 * LINE);
        expect(o.all(true)).toEqual(NONE);
      } finally {
        outside.remove();
      }
    });

    it.each([
      ["a swipe", (s: Setup) => drag(s.container, s.at, 300, 300 - 3 * LINE)],
      [
        "a touch with a second finger",
        (s: Setup) => {
          s.container.dispatchEvent(
            touchEvent("touchstart", [
              { x: 100, y: 300 },
              { x: 200, y: 300 },
            ]),
          );
          s.container.dispatchEvent(touchEvent("touchend", [{ x: 200, y: 300 }]));
          s.container.dispatchEvent(touchEvent("touchend", []));
        },
      ],
      [
        "a tap cancelled while down",
        (s: Setup) => {
          s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
          s.wiring.cancel();
          s.container.dispatchEvent(touchEvent("touchend", []));
        },
      ],
      [
        "a release whose touch was never seen",
        (s: Setup) => s.container.dispatchEvent(touchEvent("touchend", [])),
      ],
    ])("gives %s's mouse events nothing", (_name, act) => {
      const s = setup();
      const o = observe(s);
      act(s);
      expect(s.taps()).toBe(0);
      expect(o.all(true)).toEqual(NONE);
    });

    it("lets a follower's tap (touch disabled) click as before, and nothing after its drag", () => {
      const s = setup({ enabled: () => false });
      const o = observe(s);
      expect(tap(s, 0).defaultPrevented).toBe(false);
      expect(o.all(true)).toEqual(EVERY);
      drag(s.container, s.at, 300, 300 - 3 * LINE);
      expect(o.all(true)).toEqual(NONE);
    });

    it("never stops a mouse's or a pen's events", () => {
      const s = setup();
      const o = observe(s);
      expect(o.all(false)).toEqual(EVERY);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      s.wiring.cancel();
      expect(o.all(false)).toEqual(EVERY);
      expect(o.send("contextmenu", false).defaultPrevented).toBe(false);
    });

    it("without sourceCapabilities, judges a mouse event by its own data only (a plain one is a mouse's)", () => {
      const s = setup();
      const o = observe(s);
      s.element.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
      );
      s.element.dispatchEvent(
        new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }),
      );
      // WebKit and Firefox: a plain mouse event says nothing of a touch, so it is a mouse's. No
      // pointer event before it is read (round 7: no inference from another event).
      expect(o.all(null)).toEqual(EVERY);
      // A PointerEvent click or context menu names its pointer: a touch's has no grant here.
      for (const type of ["click", "contextmenu"]) {
        const event = new PointerEvent(type, {
          pointerType: "touch",
          bubbles: true,
          cancelable: true,
        });
        s.element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      // After the pane's own tap, it acts.
      tap(s, 0);
      const own = new PointerEvent("click", {
        pointerType: "touch",
        bubbles: true,
        cancelable: true,
      });
      s.element.dispatchEvent(own);
      expect(own.defaultPrevented).toBe(false);
    });

    it("takes a Chromium event with no capabilities (made by a script) as no touch's", () => {
      const s = setup();
      const o = observe(s);
      s.element.dispatchEvent(
        new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }),
      );
      for (const type of ACTING) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "sourceCapabilities", { value: null });
        s.element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(o.reached).toEqual([...ACTING]);
    });

    it("lets a context menu through after this pane's own tap (an engine may fire it after the lift)", () => {
      const s = setup();
      const o = observe(s);
      tap(s, 0);
      expect(o.send("contextmenu", true).defaultPrevented).toBe(false);
      expect(o.reached).toContain("contextmenu");
      // Not after a later touch anywhere, nor for a release that was no tap.
      document.body.dispatchEvent(touchEvent("touchstart", [{ x: 1, y: 1 }]));
      expect(o.send("contextmenu", true).defaultPrevented).toBe(true);
      document.body.dispatchEvent(touchEvent("touchend", []));
      drag(s.container, s.at, 300, 300 - 3 * LINE);
      expect(o.send("contextmenu", true).defaultPrevented).toBe(true);
    });

    // Owner decision (round 10): intended. The engine fires a long press's context menu while the
    // finger is down, before any tap is decided; xterm only focuses (no user input, no copy window;
    // a program that enabled focus reports still gets xterm's focus report, as a reply).
    it("lets a live long press's context menu through (focus only, intended) only while its touch is down here", () => {
      const s = setup();
      const o = observe(s);
      expect(o.send("contextmenu", true).defaultPrevented).toBe(true);
      s.container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 300 }]));
      const held = o.send("contextmenu", true);
      expect(held.defaultPrevented).toBe(false);
      expect(o.reached).toContain("contextmenu");
      // It is no tap: no copy window opens for it.
      expect(s.taps()).toBe(0);
      o.reached.length = 0;
      s.wiring.cancel();
      expect(o.send("contextmenu", true).defaultPrevented).toBe(true);
      s.container.dispatchEvent(touchEvent("touchend", []));
      expect(o.send("contextmenu", true).defaultPrevented).toBe(true);
      expect(o.reached).toEqual([]);
    });

    it("removes every listener it added when disposed", () => {
      type Entry = [string, string, unknown, boolean];
      const added: Entry[] = [];
      const removed: Entry[] = [];
      const entry = (
        target: EventTarget,
        type: string,
        listener: unknown,
        options?: boolean | AddEventListenerOptions | EventListenerOptions,
      ): Entry => [
        target === document ? "document" : "pane",
        type,
        listener,
        typeof options === "boolean" ? options : Boolean(options?.capture),
      ];
      const add = vi.spyOn(EventTarget.prototype, "addEventListener");
      const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
      try {
        const s = setup();
        for (const [index, args] of add.mock.calls.entries()) {
          const target = add.mock.contexts[index] as EventTarget;
          if (target === document || target === s.container) added.push(entry(target, ...args));
        }
        s.wiring.dispose();
        for (const [index, args] of remove.mock.calls.entries())
          removed.push(entry(remove.mock.contexts[index] as EventTarget, ...args));
        // The pane's own, and (as the only pane on the page) the document owner's.
        expect(added.map(([target, type]) => `${target}:${type}`).sort()).toEqual(
          [
            "document:touchstart",
            "document:visibilitychange",
            "pane:touchstart",
            "pane:touchmove",
            "pane:touchend",
            "pane:touchcancel",
            ...[...ACTING, "auxclick", "contextmenu"].map((type) => `document:${type}`),
            "document:mouseup",
            // Round 9: the owner's, where a new touch ends the last tap's press.
            "document:touchstart",
          ].sort(),
        );
        for (const one of added) expect(removed).toContainEqual(one);
        // Gone: a touch's mouse event is no longer stopped.
        const event = mouse("mousedown", true);
        s.element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    });
  });

  it("stops listening and scrolling when disposed", () => {
    const { container, wheels, wiring, at, runFrames } = setup();
    at(0);
    container.dispatchEvent(touchEvent("touchstart", [{ x: 100, y: 400 }]));
    for (let step = 1; step <= 5; step += 1) {
      at(step * 8);
      container.dispatchEvent(touchEvent("touchmove", [{ x: 100, y: 400 - step * 20 }]));
    }
    container.dispatchEvent(touchEvent("touchend", []));
    const afterDrag = wheels.length;
    wiring.dispose();
    runFrames();
    drag(container, at, 300, 100);
    expect(wheels.length).toBe(afterDrag);
  });
});
