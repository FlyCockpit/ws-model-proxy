/**
 * Gesture state for the Utilities key row and the terminal's text size, kept free of the DOM so
 * it can be tested with fake timers: modifier latches, the swipe pad, hold-Ctrl/Alt and pinch.
 */

/** A latched modifier: off, for the next key only, or locked until tapped again. */
export type ModifierLatch = "off" | "once" | "lock";

/** Two taps this close lock the modifier. */
export const MODIFIER_DOUBLE_TAP_MS = 400;

/** The latch after a tap at `now` (`lastTapAt`: when the latch turned `once`). */
export function tapModifierLatch(
  latch: ModifierLatch,
  lastTapAt: number,
  now: number,
): ModifierLatch {
  if (latch === "off") return "once";
  if (latch === "once") return now - lastTapAt < MODIFIER_DOUBLE_TAP_MS ? "lock" : "off";
  return "off";
}

/** The latch after a key used it: `once` ends, `lock` stays. */
export function consumeModifierLatch(latch: ModifierLatch): ModifierLatch {
  return latch === "once" ? "off" : latch;
}

export type SwipeArrow = "Up" | "Down" | "Left" | "Right";

/** One arrow per this many px of swipe. */
export const SWIPE_STEP_PX = 20;
/** A swipe picks its axis once it has moved this far. */
export const SWIPE_AXIS_SLOP_PX = 10;

/**
 * The swipe pad: a drag sends one arrow key per `SWIPE_STEP_PX` along the axis it started on.
 * The axis is fixed for the drag, so a slightly diagonal swipe never mixes in the other arrows.
 */
export class SwipePad {
  private x0 = 0;
  private y0 = 0;
  private axis: "x" | "y" | null = null;
  private active = false;

  start(x: number, y: number): void {
    this.x0 = x;
    this.y0 = y;
    this.axis = null;
    this.active = true;
  }

  /** The arrows a move to (x, y) sends, in order (several after a fast move). */
  move(x: number, y: number): SwipeArrow[] {
    if (!this.active) return [];
    const dx = x - this.x0;
    const dy = y - this.y0;
    if (!this.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_AXIS_SLOP_PX) return [];
      this.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    }
    const arrows: SwipeArrow[] = [];
    let d = this.axis === "x" ? dx : dy;
    while (Math.abs(d) >= SWIPE_STEP_PX) {
      const sign = Math.sign(d);
      if (this.axis === "x") {
        arrows.push(sign > 0 ? "Right" : "Left");
        this.x0 += sign * SWIPE_STEP_PX;
      } else {
        arrows.push(sign > 0 ? "Down" : "Up");
        this.y0 += sign * SWIPE_STEP_PX;
      }
      d -= sign * SWIPE_STEP_PX;
    }
    return arrows;
  }

  end(): void {
    this.active = false;
    this.axis = null;
  }

  get dragging(): boolean {
    return this.active;
  }
}

/** Holding Ctrl or Alt this long opens the letter grid. */
export const HOLD_MODIFIER_MS = 400;

export type HoldModifierResult =
  /** Released before the hold time: latch the modifier for the next key. */
  | { kind: "tap" }
  /** Released over a grid key: send that key with the modifier. */
  | { kind: "send"; key: string }
  /** Released with the grid open but off every key, or cancelled: nothing. */
  | { kind: "none" };

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Hold Ctrl/Alt: a press held `HOLD_MODIFIER_MS` opens the grid (`onOpen`), sliding over it
 * picks a key (`hover`), and lifting sends it. A shorter press is a tap.
 */
export class HoldModifierGesture {
  private timer: unknown = null;
  private open = false;
  private pressed = false;
  private hovered: string | null = null;

  constructor(
    private readonly onOpen: () => void,
    private readonly timers: Timers = defaultTimers,
  ) {}

  press(): void {
    this.reset();
    this.pressed = true;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (!this.pressed) return;
      this.open = true;
      this.onOpen();
    }, HOLD_MODIFIER_MS);
  }

  /** The grid key under the finger now, or null. Ignored until the grid is open. */
  hover(key: string | null): void {
    if (this.open) this.hovered = key;
  }

  release(): HoldModifierResult {
    if (!this.pressed) return { kind: "none" };
    const result: HoldModifierResult = !this.open
      ? { kind: "tap" }
      : this.hovered !== null
        ? { kind: "send", key: this.hovered }
        : { kind: "none" };
    this.reset();
    return result;
  }

  cancel(): void {
    this.reset();
  }

  get gridOpen(): boolean {
    return this.open;
  }

  get hoveredKey(): string | null {
    return this.hovered;
  }

  private reset(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.open = false;
    this.pressed = false;
    this.hovered = null;
  }
}

/** The terminal text size range, in whole px. */
export const TERMINAL_FONT_MIN = 9;
export const TERMINAL_FONT_MAX = 20;
export const TERMINAL_FONT_DEFAULT = 13;

export function clampTerminalFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/**
 * Two-finger pinch to a text size: whole px, damped with a square root so a full spread is
 * about ±5 px rather than doubling the text.
 */
export class PinchFontGesture {
  private readonly startDistance: number;

  constructor(
    distance: number,
    private readonly startSize: number,
  ) {
    this.startDistance = Math.max(1, distance);
  }

  sizeAt(distance: number): number {
    const ratio = Math.sqrt(Math.max(0, distance) / this.startDistance);
    return clampTerminalFontSize(this.startSize * ratio);
  }
}

/** Where the hold grid goes: fixed, right above the key row, in the room the viewport has. */
export type HoldGridLayout = {
  left: number;
  width: number;
  /** Distance from the layout viewport's bottom (CSS `bottom` of a fixed box). */
  bottom: number;
  columns: number;
  /** Row height in px: 44 when there is room, less (never under 24) when the keyboard is up. */
  cellHeight: number;
  /** Short rows drop the hints under the keys. */
  hints: boolean;
  /** Very short room drops the title line too. */
  title: boolean;
};

/** Gap between grid cells, and the grid's title, padding and border, in px. */
const GRID_GAP = 4;
/** Title line, padding and border. Without the title: padding and border only. */
const GRID_CHROME = 40;
const GRID_CHROME_COMPACT = 20;
/** Space kept between the grid and the top of the visible page. */
const GRID_MARGIN = 8;
const GRID_MIN_CELL = 24;
const GRID_CELL = 44;

/**
 * The hold grid's layout for a key row at `row` (client px), with the visible part of the page
 * from `visibleTop` and a layout viewport `viewportHeight` tall. Columns keep every key 44px wide
 * and rows shrink when the room above the row (a phone with its keyboard up) is short. Where even
 * 24px rows do not fit, the title goes and then the grid takes more, narrower columns: every key
 * stays on screen (a slide target, highlighted under the finger, not a tap target).
 */
export function holdGridLayout(input: {
  row: { left: number; top: number; width: number };
  visibleTop: number;
  viewportHeight: number;
  keys: number;
}): HoldGridLayout {
  const inner = input.row.width - 18;
  const room = input.row.top - input.visibleTop - GRID_MARGIN - GRID_GAP;
  const height = (rows: number, cell: number, chrome: number) =>
    chrome + rows * cell + GRID_GAP * (rows - 1);
  let columns = Math.min(7, Math.max(4, Math.floor((inner + GRID_GAP) / (GRID_CELL + GRID_GAP))));
  let title = true;
  const fits = () =>
    height(
      Math.ceil(input.keys / columns),
      GRID_MIN_CELL,
      title ? GRID_CHROME : GRID_CHROME_COMPACT,
    ) <= room;
  if (!fits()) title = false;
  while (!fits() && columns < input.keys) columns += 1;
  const rows = Math.ceil(input.keys / columns);
  const chrome = title ? GRID_CHROME : GRID_CHROME_COMPACT;
  const cellHeight = Math.max(
    GRID_MIN_CELL,
    Math.min(GRID_CELL, Math.floor((room - chrome - GRID_GAP * (rows - 1)) / rows)),
  );
  return {
    left: input.row.left,
    width: input.row.width,
    bottom: input.viewportHeight - input.row.top + GRID_GAP,
    columns,
    cellHeight,
    hints: cellHeight >= 40,
    title,
  };
}
