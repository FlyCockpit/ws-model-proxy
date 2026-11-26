import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampTerminalFontSize,
  consumeModifierLatch,
  HOLD_MODIFIER_MS,
  HoldModifierGesture,
  holdGridLayout,
  PinchFontGesture,
  SwipePad,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  tapModifierLatch,
} from "./terminal-key-gestures";

describe("modifier latch", () => {
  it("taps to once, double-taps to lock, and taps off", () => {
    expect(tapModifierLatch("off", 0, 1000)).toBe("once");
    expect(tapModifierLatch("once", 1000, 1200)).toBe("lock");
    expect(tapModifierLatch("once", 1000, 1600)).toBe("off");
    expect(tapModifierLatch("lock", 0, 5000)).toBe("off");
  });

  it("ends a one-key latch after use and keeps a lock", () => {
    expect(consumeModifierLatch("once")).toBe("off");
    expect(consumeModifierLatch("lock")).toBe("lock");
    expect(consumeModifierLatch("off")).toBe("off");
  });
});

describe("SwipePad", () => {
  it("sends nothing until the swipe passes the axis slop and a full step", () => {
    const pad = new SwipePad();
    pad.start(100, 100);
    expect(pad.move(105, 102)).toEqual([]);
    expect(pad.move(115, 100)).toEqual([]);
    expect(pad.move(120, 100)).toEqual(["Right"]);
    expect(pad.move(139, 100)).toEqual([]);
    expect(pad.move(140, 100)).toEqual(["Right"]);
  });

  it("sends one arrow per 20 px, several after a fast move", () => {
    const pad = new SwipePad();
    pad.start(0, 0);
    expect(pad.move(-65, 3)).toEqual(["Left", "Left", "Left"]);
    expect(pad.move(-40, 3)).toEqual(["Right"]);
  });

  it("keeps the axis it started on", () => {
    const pad = new SwipePad();
    pad.start(0, 0);
    expect(pad.move(0, -25)).toEqual(["Up"]);
    // Sideways drift on a vertical swipe sends no Left/Right.
    expect(pad.move(60, -25)).toEqual([]);
    expect(pad.move(60, 20)).toEqual(["Down", "Down"]);
  });

  it("does nothing outside a drag", () => {
    const pad = new SwipePad();
    expect(pad.move(100, 0)).toEqual([]);
    pad.start(0, 0);
    pad.end();
    expect(pad.move(100, 0)).toEqual([]);
    expect(pad.dragging).toBe(false);
  });
});

describe("HoldModifierGesture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a tap when released before the hold time", () => {
    const onOpen = vi.fn();
    const gesture = new HoldModifierGesture(onOpen);
    gesture.press();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS - 1);
    expect(gesture.release()).toEqual({ kind: "tap" });
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the grid after the hold time and sends the key released over", () => {
    const onOpen = vi.fn();
    const gesture = new HoldModifierGesture(onOpen);
    gesture.press();
    gesture.hover("c");
    expect(gesture.hoveredKey).toBeNull();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(gesture.gridOpen).toBe(true);
    gesture.hover("c");
    gesture.hover("r");
    expect(gesture.release()).toEqual({ kind: "send", key: "r" });
    expect(gesture.gridOpen).toBe(false);
  });

  it("sends nothing when released off the grid or cancelled", () => {
    const gesture = new HoldModifierGesture(() => {});
    gesture.press();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS);
    gesture.hover("c");
    gesture.hover(null);
    expect(gesture.release()).toEqual({ kind: "none" });

    const onOpen = vi.fn();
    const cancelled = new HoldModifierGesture(onOpen);
    cancelled.press();
    cancelled.cancel();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS * 2);
    expect(onOpen).not.toHaveBeenCalled();
    expect(cancelled.release()).toEqual({ kind: "none" });
  });

  it("starts over on a new press", () => {
    const onOpen = vi.fn();
    const gesture = new HoldModifierGesture(onOpen);
    gesture.press();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS - 100);
    gesture.press();
    vi.advanceTimersByTime(HOLD_MODIFIER_MS - 100);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("PinchFontGesture", () => {
  it("changes the size in whole px, damped, within the range", () => {
    const pinch = new PinchFontGesture(100, 13);
    expect(pinch.sizeAt(100)).toBe(13);
    // Twice the spread: +5 px; four times: +7 (damped); half: -5.
    expect(pinch.sizeAt(200)).toBe(18);
    expect(pinch.sizeAt(400)).toBe(20);
    expect(pinch.sizeAt(50)).toBe(8);
    expect(pinch.sizeAt(25)).toBe(6);
    expect(pinch.sizeAt(1000)).toBe(TERMINAL_FONT_MAX);
    expect(pinch.sizeAt(0)).toBe(TERMINAL_FONT_MIN);
  });

  it("reaches 1 px and grows back from it", () => {
    expect(TERMINAL_FONT_MIN).toBe(1);
    expect(new PinchFontGesture(400, 4).sizeAt(25)).toBe(1);
    const fromOne = new PinchFontGesture(100, 1);
    expect(fromOne.sizeAt(50)).toBe(1);
    expect(fromOne.sizeAt(100)).toBe(1);
    expect(fromOne.sizeAt(200)).toBe(6);
    expect(fromOne.sizeAt(800)).toBe(10);
  });

  it("clamps and rounds sizes", () => {
    expect(clampTerminalFontSize(3)).toBe(3);
    expect(clampTerminalFontSize(1)).toBe(1);
    expect(clampTerminalFontSize(0.4)).toBe(TERMINAL_FONT_MIN);
    expect(clampTerminalFontSize(-5)).toBe(TERMINAL_FONT_MIN);
    expect(clampTerminalFontSize(14.6)).toBe(15);
    expect(clampTerminalFontSize(99)).toBe(TERMINAL_FONT_MAX);
  });
});

describe("holdGridLayout", () => {
  const keys = 33;

  it("keeps 44px keys and fits columns to the row", () => {
    const wide = holdGridLayout({
      row: { left: 16, top: 780, width: 420 },
      visibleTop: 0,
      viewportHeight: 844,
      keys,
    });
    expect(wide).toMatchObject({ columns: 7, cellHeight: 44, hints: true, left: 16, width: 420 });
    expect(wide.bottom).toBe(844 - 780 + 4);
    expect(
      holdGridLayout({
        row: { left: 0, top: 780, width: 324 },
        visibleTop: 0,
        viewportHeight: 844,
        keys,
      }).columns,
    ).toBe(6);
    expect(
      holdGridLayout({
        row: { left: 0, top: 700, width: 254 },
        visibleTop: 0,
        viewportHeight: 760,
        keys,
      }).columns,
    ).toBe(5);
  });

  it("shrinks the rows to the room above the row, never cutting keys off", () => {
    // A 320px phone with its keyboard up: about 300px above the row.
    const short = holdGridLayout({
      row: { left: 0, top: 300, width: 254 },
      visibleTop: 0,
      viewportHeight: 568,
      keys,
    });
    const rows = Math.ceil(keys / short.columns);
    expect(short.cellHeight).toBeLessThan(44);
    expect(short.hints).toBe(false);
    // The whole grid fits between the top of the visible page and the row.
    expect(40 + rows * short.cellHeight + 4 * (rows - 1) + 8).toBeLessThanOrEqual(300);
  });

  it("keeps every key on screen in very little room: no title, then more columns", () => {
    for (const top of [240, 200, 150, 110]) {
      const layout = holdGridLayout({
        row: { left: 0, top, width: 254 },
        visibleTop: 0,
        viewportHeight: 400,
        keys,
      });
      const rows = Math.ceil(keys / layout.columns);
      const height = (layout.title ? 40 : 20) + rows * layout.cellHeight + 4 * (rows - 1);
      // The grid's top (row top - gap - height) stays at or below the visible top's margin.
      expect(top - 4 - height).toBeGreaterThanOrEqual(8);
      expect(layout.cellHeight).toBeGreaterThanOrEqual(24);
    }
    expect(
      holdGridLayout({
        row: { left: 0, top: 200, width: 254 },
        visibleTop: 0,
        viewportHeight: 400,
        keys,
      }),
    ).toMatchObject({ title: false });
  });

  it("grows the cells with the root font size so the hints still fit", () => {
    // 4K (the viewport scale's 150 %): a 24px root.
    const scaled = holdGridLayout({
      row: { left: 0, top: 1900, width: 900 },
      visibleTop: 0,
      viewportHeight: 2160,
      keys,
      rootPx: 24,
    });
    expect(scaled).toMatchObject({ cellHeight: 66, hints: true, title: true, columns: 7 });
    expect(scaled.bottom).toBe(2160 - 1900 + 6);
    // Room for 44px rows but not 60px ones at a 24px root: the hints go.
    const tight = holdGridLayout({
      row: { left: 0, top: 380, width: 420 },
      visibleTop: 0,
      viewportHeight: 844,
      keys,
      rootPx: 24,
    });
    expect(tight.cellHeight).toBeLessThan(60);
    expect(tight.hints).toBe(false);
    // A smaller root never shrinks the 44px touch rows.
    expect(
      holdGridLayout({
        row: { left: 0, top: 780, width: 420 },
        visibleTop: 0,
        viewportHeight: 844,
        keys,
        rootPx: 12,
      }),
    ).toMatchObject({ cellHeight: 44, hints: true });
  });

  it("keeps a large default font's grid on screen: narrow columns, then smaller measures", () => {
    // A 32px default font on a short screen: 24px-at-16px rows do not fit at the root's scale.
    const top = 158;
    const layout = holdGridLayout({
      row: { left: 0, top, width: 262 },
      visibleTop: 0,
      viewportHeight: 600,
      keys,
      rootPx: 32,
    });
    const rows = Math.ceil(keys / layout.columns);
    const inner = 262 - 2 * layout.padding - 2;
    // No overlapping keys: every column is wider than its monospace key (~0.6em).
    expect((inner - layout.gap * (layout.columns - 1)) / layout.columns).toBeGreaterThan(
      0.6 * layout.fontSize,
    );
    expect(layout.fontSize).toBeGreaterThanOrEqual(12);
    // The whole grid (padding, rows, gaps, border) sits below the visible top's margin.
    const height = 2 * layout.padding + 2 + rows * layout.cellHeight + layout.gap * (rows - 1);
    expect(top - layout.gap - height).toBeGreaterThanOrEqual(8);
    expect(layout).toMatchObject({ title: false, hints: false });
    expect(layout.gap).toBeLessThan(8);
    // With room, the same root keeps its full measures.
    expect(
      holdGridLayout({
        row: { left: 0, top: 1200, width: 900 },
        visibleTop: 0,
        viewportHeight: 1600,
        keys,
        rootPx: 32,
      }),
    ).toMatchObject({ gap: 8, padding: 16, fontSize: 28, cellHeight: 88, title: true });
    // Even less room (100px above the row): 16px measures with 14px keys, every key still fits.
    for (const roomTop of [100, 158]) {
      const tight = holdGridLayout({
        row: { left: 0, top: roomTop, width: 262 },
        visibleTop: 0,
        viewportHeight: 600,
        keys,
        rootPx: 32,
      });
      const tightRows = Math.ceil(keys / tight.columns);
      const tightInner = 262 - 2 * tight.padding - 2;
      const column = (tightInner - tight.gap * (tight.columns - 1)) / tight.columns;
      expect(column).toBeGreaterThan(0.6 * tight.fontSize);
      expect(tight.cellHeight).toBeGreaterThanOrEqual(1.25 * tight.fontSize);
      const tightHeight =
        2 * tight.padding + 2 + tightRows * tight.cellHeight + tight.gap * (tightRows - 1);
      expect(roomTop - tight.gap - tightHeight).toBeGreaterThanOrEqual(8);
    }
  });

  it("measures from the visible top when the page is scrolled under the keyboard", () => {
    const shifted = holdGridLayout({
      row: { left: 0, top: 600, width: 324 },
      visibleTop: 300,
      viewportHeight: 844,
      keys,
    });
    const roomy = holdGridLayout({
      row: { left: 0, top: 300, width: 324 },
      visibleTop: 0,
      viewportHeight: 844,
      keys,
    });
    expect(shifted.cellHeight).toBe(roomy.cellHeight);
  });
});
