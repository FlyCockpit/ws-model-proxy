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

/**
 * The terminal text size range, in whole px. 1 px is unreadable on purpose: it shows a whole
 * wide screen at once. The pane's cols x rows stay within what the CLI accepts
 * (`boundTerminalSize`).
 */
export const TERMINAL_FONT_MIN = 1;
export const TERMINAL_FONT_MAX = 20;
export const TERMINAL_FONT_DEFAULT = 13;

export function clampTerminalFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** Text size change for doubling (or halving) the distance between the fingers, in px. */
export const PINCH_PX_PER_DOUBLING = 5;

/**
 * Two-finger pinch to a text size: whole px, the same number of px at every size (so a pinch
 * works from 1 px as from 20), damped: doubling the spread adds 5 px, four times adds 7, and
 * pinching in takes off as much as spreading out adds.
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
    const doublings = Math.log2(Math.max(1, distance) / this.startDistance);
    const change = Math.sign(doublings) * Math.sqrt(Math.abs(doublings)) * PINCH_PX_PER_DOUBLING;
    return clampTerminalFontSize(this.startSize + change);
  }
}

/** Where the hold grid goes: fixed, right above the key row, in the room the viewport has. */
export type HoldGridLayout = {
  left: number;
  width: number;
  /** Distance from the layout viewport's bottom (CSS `bottom` of a fixed box). */
  bottom: number;
  columns: number;
  /** Row height in px: 44 (at a 16px root) when there is room, less (never under 24) when the keyboard is up. */
  cellHeight: number;
  /** Gap between cells, the grid's padding and the keys' font size, in px (the grid draws them from here). */
  gap: number;
  padding: number;
  fontSize: number;
  /** Short rows drop the hints under the keys. */
  hints: boolean;
  /** Very short room drops the title line too. */
  title: boolean;
};

/**
 * The grid's measures in px at the browser-default 16px root; they scale with the root font size
 * (the viewport scale and the user's default font size), as the grid's text does.
 * Gap between grid cells:
 */
const GRID_GAP = 4;
const GRID_PADDING = 8;
/** Title line, padding and border. Without the title: padding and border only. */
const GRID_CHROME = 40;
const GRID_CHROME_COMPACT = 20;
/** Padding and border across the grid's width. */
const GRID_INSET = 18;
/** Space kept between the grid and the top of the visible page. */
const GRID_MARGIN = 8;
const GRID_MIN_CELL = 24;
/** The narrowest column: still a slide target with room for its one-character key (~0.6em wide). */
const GRID_MIN_COLUMN = 10;
/** The keys' font size (`text-sm`); in a fallback with smaller measures it shrinks with them. */
const GRID_FONT = 14;
const GRID_CELL = 44;
/** The shortest row that still shows a hint under its key. */
const GRID_HINT_CELL = 40;
const ROOT_FONT_PX = 16;
/** Step by which a grid that does not fit at its root's scale tries smaller measures. */
const GRID_SCALE_STEP = 0.25;

/**
 * The hold grid's layout for a key row at `row` (client px), with the visible part of the page
 * from `visibleTop` and a layout viewport `viewportHeight` tall, at a root font size of `rootPx`
 * (default 16). Columns keep every key 44px wide (at 16px) and rows shrink when the room above the
 * row (a phone with its keyboard up) is short. Where even 24px rows do not fit, the title goes and
 * then the grid takes more, narrower columns, never so many that the gaps outgrow the row. Where
 * that is still too tall (a large default font on a short screen), its measures and key text step
 * down toward the 16px ones (14px keys, never under 12px) until it fits: every key stays on screen (a slide target, highlighted under the
 * finger, not a tap target). Only a room too short even for that lets it reach above the top.
 */
export function holdGridLayout(input: {
  row: { left: number; top: number; width: number };
  visibleTop: number;
  viewportHeight: number;
  keys: number;
  rootPx?: number;
}): HoldGridLayout {
  const rootScale = Math.max(1, (input.rootPx ?? ROOT_FONT_PX) / ROOT_FONT_PX);
  const at = (scale: number, titleAllowed: boolean) => {
    const gap = GRID_GAP * scale;
    const cell = GRID_CELL * scale;
    const minCell = GRID_MIN_CELL * scale;
    const inner = input.row.width - GRID_INSET * scale;
    const room = input.row.top - input.visibleTop - GRID_MARGIN - gap;
    const height = (rows: number, size: number, chrome: number) =>
      chrome + rows * size + gap * (rows - 1);
    // Past this many columns the gaps alone outgrow the row and the keys overlap.
    const widest = Math.max(1, Math.floor((inner + gap) / (GRID_MIN_COLUMN * scale + gap)));
    let columns = Math.min(widest, 7, Math.max(4, Math.floor((inner + gap) / (cell + gap))));
    let title = titleAllowed;
    const chromeOf = () => (title ? GRID_CHROME : GRID_CHROME_COMPACT) * scale;
    const fits = () => height(Math.ceil(input.keys / columns), minCell, chromeOf()) <= room;
    if (!fits()) title = false;
    while (!fits() && columns < Math.min(input.keys, widest)) columns += 1;
    const rows = Math.ceil(input.keys / columns);
    const cellHeight = Math.max(
      Math.floor(minCell),
      Math.min(Math.floor(cell), Math.floor((room - chromeOf() - gap * (rows - 1)) / rows)),
    );
    const layout: HoldGridLayout = {
      left: input.row.left,
      width: input.row.width,
      bottom: input.viewportHeight - input.row.top + gap,
      columns,
      cellHeight,
      gap,
      padding: GRID_PADDING * scale,
      fontSize: GRID_FONT * scale,
      // The hint text stays at the root's size: smaller measures than the root's drop it.
      hints: scale === rootScale && cellHeight >= GRID_HINT_CELL * scale,
      title,
    };
    return { layout, fits: fits() };
  };
  let tried = at(rootScale, true);
  // Smaller measures than the root's: the title and hints (rem text) no longer match them, so they go.
  for (let scale = rootScale - GRID_SCALE_STEP; !tried.fits && scale > 1; scale -= GRID_SCALE_STEP)
    tried = at(scale, false);
  if (!tried.fits && rootScale > 1) tried = at(1, false);
  return tried.layout;
}
