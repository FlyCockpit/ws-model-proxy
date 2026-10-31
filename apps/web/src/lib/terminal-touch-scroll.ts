import type { Terminal } from "@xterm/xterm";

import { claimTouchMouse, type TouchGrant } from "@/lib/terminal-touch-mouse";

/**
 * Touch scrolling for the browser terminal. xterm 6 has no touch handling of its own, so a swipe
 * is turned into the wheel: one synthetic line-mode wheel event per line, handed to xterm's own
 * wheel listeners. A mouse app (tmux `mouse on`) gets wheel reports, the alternate screen gets
 * arrow keys, exactly as for a desktop wheel; the normal buffer scrolls its scrollback. A swipe is
 * never a click: it sends no click report and opens no copy window. What it sends is the person's
 * own input, as a key is (`isTouchScrollWheel`): unlike the desktop wheel's, it takes the writer
 * when someone else has it.
 */

/** A touch that moves less than this is a tap, not a scroll. */
export const TOUCH_SCROLL_SLOP_PX = 10;
/** Release velocity is measured over this much of the end of the drag. */
const VELOCITY_WINDOW_MS = 100;
/** Slower than this at release (px/ms), the scroll stops with the finger. */
const MOMENTUM_MIN_START = 0.3;
/** Momentum stops below this speed (px/ms). */
const MOMENTUM_MIN_SPEED = 0.05;
/** Momentum slows by e every this many ms (iOS-like). */
const MOMENTUM_TIME_CONSTANT_MS = 325;
/** Momentum never runs longer than this after the finger lifts. */
const MOMENTUM_MAX_MS = 3_000;
/**
 * A momentum frame this late means the page was suspended or stalled: the scroll stops there
 * instead of catching up with a burst of lines the person never saw coming.
 */
const MOMENTUM_MAX_FRAME_GAP_MS = 200;
/** The line height used when the screen cannot be measured. */
const FALLBACK_LINE_HEIGHT_PX = 16;
/**
 * A tap's own mouse events (the browser's compatibility mousedown, click and so on) come this soon
 * after its touchend; WebKit's click can be about 350 ms late.
 */
const TAP_MOUSE_WINDOW_MS = 1_000;

export type TouchPoint = { x: number; y: number };

/** Whole lines from a running pixel distance; the remainder carries to the next step. */
class LineAccumulator {
  private pixels = 0;

  /** `delta`: pixels the content should move toward newer output. Returns whole lines. */
  add(delta: number, lineHeight: number): number {
    this.pixels += delta;
    const lines = Math.trunc(this.pixels / lineHeight);
    this.pixels -= lines * lineHeight;
    return lines;
  }
}

/**
 * One finger's drag. It stays a tap until it moves past the slop, then locks to an axis:
 * vertical scrolls, horizontal is left alone for the rest of the gesture.
 */
export class TouchScrollGesture {
  private state: "pending" | "vertical" | "horizontal" = "pending";
  private lastY: number;
  private readonly lines = new LineAccumulator();
  private samples: { y: number; t: number }[];

  constructor(
    readonly start: TouchPoint,
    startMs: number,
  ) {
    this.lastY = start.y;
    this.samples = [{ y: start.y, t: startMs }];
  }

  /** Whether the gesture became a vertical scroll (it is not a tap). */
  get scrolling(): boolean {
    return this.state === "vertical";
  }

  /** Whether the gesture moved past the slop on either axis (it is not a tap). */
  get moved(): boolean {
    return this.state !== "pending";
  }

  /** Whether `point` is within the slop of where the finger went down. */
  withinSlop(point: TouchPoint): boolean {
    return Math.hypot(point.x - this.start.x, point.y - this.start.y) <= TOUCH_SCROLL_SLOP_PX;
  }

  /**
   * The finger moved. Returns the whole lines to scroll now: positive toward newer output (the
   * finger moved up, a wheel scrolled down), negative toward older.
   */
  move(point: TouchPoint, nowMs: number, lineHeight: number): number {
    if (this.state === "horizontal") return 0;
    if (this.state === "pending") {
      if (this.withinSlop(point)) return 0;
      const dx = point.x - this.start.x;
      const dy = point.y - this.start.y;
      this.state = Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
      if (this.state === "horizontal") return 0;
    }
    // Counted from where the finger went down, so the distance is all the person's.
    const delta = this.lastY - point.y;
    this.lastY = point.y;
    this.samples.push({ y: point.y, t: nowMs });
    this.samples = this.samples.filter((sample) => nowMs - sample.t <= VELOCITY_WINDOW_MS);
    return this.lines.add(delta, lineHeight);
  }

  /**
   * The finger lifted: the momentum to continue with, or null when the scroll stops here (a tap,
   * a horizontal drag, or a slow release).
   */
  end(nowMs: number): TouchScrollMomentum | null {
    if (this.state !== "vertical") return null;
    const recent = this.samples.filter((sample) => nowMs - sample.t <= VELOCITY_WINDOW_MS);
    const first = recent[0];
    if (!first || nowMs <= first.t) return null;
    // Measured up to the release, not the last move: a finger that paused before lifting has
    // slowed down, and the pause counts. Toward newer output is positive, as for move().
    const velocity = (first.y - this.lastY) / (nowMs - first.t);
    if (Math.abs(velocity) < MOMENTUM_MIN_START) return null;
    return new TouchScrollMomentum(velocity, nowMs, this.lines);
  }
}

/**
 * The scroll continuing after a fast release, slowing down until it stops. It ends for good
 * when it slows down enough, at `MOMENTUM_MAX_MS` after the release, or at a frame that comes
 * more than `MOMENTUM_MAX_FRAME_GAP_MS` after the one before (checked before any line is
 * produced, so a late frame scrolls nothing).
 */
export class TouchScrollMomentum {
  private lastMs: number;
  private expired = false;

  constructor(
    private velocity: number,
    private readonly startMs: number,
    private readonly lines = new LineAccumulator(),
  ) {
    this.lastMs = startMs;
  }

  get done(): boolean {
    return this.expired || Math.abs(this.velocity) < MOMENTUM_MIN_SPEED;
  }

  /** Advance to `nowMs`; returns the whole lines to scroll for it (sign as in move()). */
  step(nowMs: number, lineHeight: number, maxLines: number): number {
    if (this.done) return 0;
    const dtMs = nowMs - this.lastMs;
    if (nowMs - this.startMs > MOMENTUM_MAX_MS || dtMs > MOMENTUM_MAX_FRAME_GAP_MS) {
      this.expired = true;
      return 0;
    }
    if (dtMs <= 0) return 0;
    this.lastMs = nowMs;
    const decay = Math.exp(-dtMs / MOMENTUM_TIME_CONSTANT_MS);
    // Distance covered while the speed decays from v to v*decay.
    const distance = this.velocity * MOMENTUM_TIME_CONSTANT_MS * (1 - decay);
    this.velocity *= decay;
    const lines = this.lines.add(distance, lineHeight);
    return Math.max(-maxLines, Math.min(maxLines, lines));
  }
}

/** The height of one terminal row in CSS pixels. */
function lineHeightOf(term: Terminal): number {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const height = screen ? screen.getBoundingClientRect().height : 0;
  return height > 0 && term.rows > 0 ? height / term.rows : FALLBACK_LINE_HEIGHT_PX;
}

/** The wheel events a touch scroll makes (not a desktop wheel's). */
const touchWheels = new WeakSet<Event>();

/**
 * Whether `event` is one of the wheel events a touch scroll made. What xterm sends for it is the
 * person's own input, as a key's is; a desktop wheel's only scrolls (writer-only).
 */
export function isTouchScrollWheel(event: Event): boolean {
  return touchWheels.has(event);
}

/**
 * Scroll `lines` (positive toward newer output) the way the desktop wheel does at `at`: each line
 * is one line-mode wheel event on xterm's element, where its wheel listeners are. xterm cancels
 * the events it turns into input (a wheel report in a mouse app, an arrow key on the alternate
 * screen). One it leaves alone is a wheel over the normal buffer, which scrolls the scrollback.
 * (The event goes to xterm's element, not to the screen inside it: the scrollbar widget there
 * reads a constructed event's legacy wheel delta and would move about a pixel.)
 */
export function scrollTerminalLines(term: Terminal, lines: number, at: TouchPoint): void {
  const element = term.element;
  if (!element || lines === 0) return;
  // Reports carry the position: keep it on the screen, as a real pointer over it would be.
  const screen = element.querySelector(".xterm-screen")?.getBoundingClientRect();
  const clientX = screen ? clamp(at.x, screen.left + 1, screen.right - 1) : at.x;
  const clientY = screen ? clamp(at.y, screen.top + 1, screen.bottom - 1) : at.y;
  const direction = Math.sign(lines);
  let unhandled = 0;
  for (let index = 0; index < Math.abs(lines); index += 1) {
    const wheel = new WheelEvent("wheel", {
      deltaY: direction,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX,
      clientY,
      bubbles: false,
      cancelable: true,
    });
    touchWheels.add(wheel);
    if (element.dispatchEvent(wheel)) unhandled += direction;
  }
  if (unhandled !== 0) term.scrollLines(unhandled);
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

export type TouchScrollWiring = {
  /**
   * End the current interaction. The touch in progress is void for the rest of its life: it
   * scrolls no more, it is not a tap, and each of its releases is cancelled (no compatibility
   * click); a coasting scroll stops, and nothing already scheduled scrolls after this. The last
   * tap's grant ends too: no mouse event of a touch acts here for it any more, except the release
   * of a press xterm already took from it, so the app gets the release of the press it got. Called
   * whenever touch stops being the pane's (hidden, Select text, following) and whenever its attach
   * changes (a reset, a retire, a new attach). The next touch starts afresh.
   */
  cancel: () => void;
  dispose: () => void;
  /**
   * Whether `event`, the event being dispatched, is a touch's release that xterm answers with the
   * release of an earlier touch press here whose own release never reached it (see
   * `claimTouchMouse`): what xterm sends for it must not go out.
   */
  foreignRelease: (event: Event | undefined) => boolean;
};

/**
 * One touch, from the touchstart that put its finger down until no finger is left. Everything the
 * touch may do is decided from this record: an interaction ending or a second finger anywhere on
 * the page sets `void`, and nothing else carries its authority.
 */
type LiveTouch = {
  /** The `Touch.identifier` of its finger, to find that finger's lift in a touchend. */
  identifier: number;
  gesture: TouchScrollGesture;
  /** It may scroll the pane: enabled when it started, and since. */
  owned: boolean;
  /**
   * The pane took it (it moved past the slop while the pane's, or it stopped a coasting scroll):
   * its moves are cancelled, so its release is cancelled too.
   */
  claimed: boolean;
  /**
   * Ended by `cancel()` (the interaction changed under it) or by a second finger: it scrolls no
   * more, is no tap, and every one of its releases is cancelled.
   */
  void: boolean;
  /** No finger of it is down any more. */
  ended: boolean;
};

/**
 * What a finger lifting in the pane does, decided for every lift before anything else:
 * - `tap`: the touch's only finger, it stayed under the slop up to and including where it lifted
 *   (the touchend's own coordinates for that finger, not only the moves before it), did not stop a
 *   coasting scroll, and its interaction did not end. The click it makes stays (it focuses and
 *   opens the keyboard) and it opens the copy window. How long the finger stayed down does not
 *   matter: a long still press is a tap too (a deliberate gesture on the pane, as a short one is).
 * - `native`: a drag the browser had (the pane was not taking touch when it started). Left alone,
 *   and it opens nothing.
 * - `cancel`: anything else, also a finger that lifts while another is still down, one that lifts
 *   past the slop when no move (or only moves under it) came before, and a touchend that does not
 *   carry the touch's own finger (no position to check: no tap). Its release is cancelled: no
 *   compatibility mousedown or click (no click report, no writer claim, no focus).
 */
type Release = "tap" | "native" | "cancel";

/**
 * Turn one-finger vertical swipes in `container` into wheel scrolling of `term`. `enabled` is
 * read at each touch, move and momentum frame: while it is false, touch is left to the browser.
 * A touch and its momentum belong to one interaction: `cancel()`, a new touch, a second finger,
 * the document going hidden, or `dispose()` ends it, and a frame queued before that does nothing
 * when it runs. `onTap` runs when a touch lifts as a tap (in its touchend, once every finger it
 * had is known); pointer events of a touch decide nothing. The mouse events a touch makes act in
 * `container` only after that touch's tap here (a long press's context menu: while it is down, or
 * after its tap); the document's owner (`claimTouchMouse`) holds back any other before xterm, a
 * listener on `container` or xterm's document listeners see it.
 */
export function wireTouchScroll(
  term: Terminal,
  container: HTMLElement,
  options: {
    enabled: () => boolean;
    onTap?: () => void;
    now?: () => number;
    requestFrame?: (callback: (time: number) => void) => number;
    cancelFrame?: (handle: number) => void;
  },
): TouchScrollWiring {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const doc = container.ownerDocument;
  let touch: LiveTouch | null = null;
  let frame: number | null = null;
  /** The interaction; bumped by every cancel. A frame from an earlier one does nothing. */
  let epoch = 0;
  /**
   * This pane's last `tap` decision, while that touch is still the latest one on the page. Only
   * then may a touch's mouse events act here. Any new touchstart on the page, and `cancel()`, end it.
   * A new object per tap: the document's owner holds a press xterm took from this tap to this
   * identity, so once it ends, no later tap can stand in for it.
   */
  let tap: { at: number } | null = null;

  const cancel = () => {
    epoch += 1;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    tap = null;
    if (touch) touch.void = true;
  };

  const runMomentum = (momentum: TouchScrollMomentum, at: TouchPoint) => {
    const started = epoch;
    const tick = () => {
      if (started !== epoch) return;
      frame = null;
      if (!options.enabled() || !term.element) return;
      const lines = momentum.step(now(), lineHeightOf(term), Math.max(1, term.rows));
      scrollTerminalLines(term, lines, at);
      if (!momentum.done && started === epoch) frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
  };

  /** The decision for one finger lifting (touchend) or the browser taking the touch (touchcancel). */
  const releaseOf = (event: TouchEvent): Release => {
    const live = touch;
    // A finger of a touch this wiring did not see start, or saw end: not this interaction's.
    // (A touch that outlived this pane's element gets no touchend here at all; its mouse events
    // find no grant here and are held back by the document's owner instead.)
    if (!live || live.ended) return "cancel";
    // A finger is still down (of this touch, or one that went down outside the pane), or the
    // browser took the touch: more than a one-finger tap, for the rest of the touch.
    if (event.touches.length > 0 || event.type === "touchcancel") live.void = true;
    if (live.void || live.claimed) return "cancel";
    if (live.gesture.moved) return "native";
    // Where the finger lifted decides too: the browser may deliver no move for it at all (or only
    // one under the slop, the rest coalesced into the touchend), so a tap is checked against the
    // touchend's own coordinates for this touch's finger, matched by identifier. A finger that
    // lifts past the slop is no tap; a touchend that does not carry this finger is none either.
    const lifted = Array.from(event.changedTouches).find(
      (point) => point.identifier === live.identifier,
    );
    if (!lifted || !live.gesture.withinSlop({ x: lifted.clientX, y: lifted.clientY }))
      return "cancel";
    return "tap";
  };
  /** Every lift: decided first, whichever finger it is; then, at the last finger, the touch ends. */
  const onRelease = (event: TouchEvent) => {
    const release = releaseOf(event);
    if (release === "cancel") {
      if (event.cancelable) event.preventDefault();
    } else if (release === "tap") {
      // Its mouse events (the click that focuses and opens the keyboard) may act, and only its.
      // A long still press gets here as well: it is a tap, with the same click and copy window.
      tap = { at: now() };
      options.onTap?.();
    }
    const live = touch;
    if (!live || live.ended || event.touches.length > 0) return;
    live.ended = true;
    // A scroll the pane had, released fast, coasts on.
    if (live.void || !live.claimed || !live.owned || !options.enabled()) return;
    const momentum = live.gesture.end(now());
    if (momentum) runMomentum(momentum, live.gesture.start);
  };
  // Every finger on the page, also one that goes down outside the pane (none of its events come
  // to the pane): a second finger makes the pane's touch no tap and no scroll, whatever lifts first.
  // A new touch anywhere also ends the last tap's turn: mouse events after this are not that tap's.
  const onAnyTouchStart = (event: TouchEvent) => {
    tap = null;
    if (touch && !touch.ended && event.touches.length > 1) touch.void = true;
  };
  /**
   * What lets a mouse event a touch made act here: this pane decided that touch was a tap (or, for
   * a long press's context menu, the touch is still down and this pane's); null otherwise. A finger
   * that went down on a pane that was then replaced (a remount, a closed tab showing the one under
   * it) gets no touchend anywhere, and the browser hit-tests its click onto the new terminal: that
   * click has no tap here, so it focuses nothing, sends no click report and claims no writer.
   *
   * The long press's context menu is admitted on purpose (owner decision) before any tap is
   * decided: the engine fires it while the finger is still down, and xterm's context-menu handler
   * only moves its textarea under the finger and focuses it. That sends no user input (no
   * keystroke, no mouse-button report), claims no writer and opens no copy window (only `onTap`,
   * at a tap's release, opens that). Focusing can make xterm emit a focus report (`ESC [ I`) when
   * the program enabled them (DECSET 1004): that is a `reply`, sent only from the writer.
   */
  const grant = (event: MouseEvent): TouchGrant | null => {
    if (tap !== null && now() - tap.at <= TAP_MOUSE_WINDOW_MS) return tap;
    if (event.type !== "contextmenu") return null;
    // A live long press: focus only (see above), never a tap's click or copy window.
    return touch !== null && !touch.ended && !touch.void ? touch : null;
  };

  const onTouchStart = (event: TouchEvent) => {
    const live = touch && !touch.ended ? touch : null;
    const coasting = frame !== null;
    // A new touch, or another finger of this one: the interaction so far ends here.
    cancel();
    const first = event.touches[0];
    // Another finger joined (pinch zoom): the touch is void for the rest of its life, and the
    // browser has the gesture. (One finger down means any earlier touch is over, seen or not.)
    if (live && event.touches.length !== 1) return;
    if (!first) {
      touch = null;
      return;
    }
    const owned = options.enabled();
    // Disabled, the finger is still followed to tell a tap from a drag, but scrolls nothing.
    touch = {
      identifier: first.identifier,
      gesture: new TouchScrollGesture({ x: first.clientX, y: first.clientY }, now()),
      owned,
      // Stopping a coasting scroll is a stop, as a native scroll's is, not a tap.
      claimed: coasting && owned,
      // Two fingers at once (one may have started outside the pane): never this pane's scroll.
      void: event.touches.length !== 1,
      ended: false,
    };
  };
  const onTouchMove = (event: TouchEvent) => {
    const live = touch;
    if (!live || live.ended) return;
    // A second finger, even one that went down outside the pane (its touchstart never came
    // here): the touch is void for the rest of its life, also once back to one finger.
    if (event.touches.length !== 1) live.void = true;
    const point = event.touches[0];
    if (!point) return;
    if (live.void) {
      // A drag the pane took stays out of the page; a pinch stays the browser's.
      if (live.claimed && event.touches.length === 1 && event.cancelable) event.preventDefault();
      return;
    }
    const lines = live.gesture.move(
      { x: point.clientX, y: point.clientY },
      now(),
      lineHeightOf(term),
    );
    if (live.owned && !options.enabled()) live.owned = false;
    // Under the slop it may still be a tap: cancelling a move there could cancel the tap's click
    // (and the keyboard it opens). touch-action on the pane keeps the browser from panning.
    if (!live.gesture.moved || !(live.owned || live.claimed)) return;
    // Past the slop the drag is the pane's: the browser pans nothing on either axis, even once
    // the drag has been cancelled (it started as the pane's, and stays out of the page).
    if (event.cancelable) event.preventDefault();
    live.claimed = true;
    if (live.owned && live.gesture.scrolling) scrollTerminalLines(term, lines, live.gesture.start);
  };
  // A hidden page runs no frames: a scroll queued now would arrive in a burst on return.
  const onVisibilityChange = () => {
    if (doc.visibilityState === "hidden") cancel();
  };

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onRelease, { passive: false });
  // Never cancelable: the browser already took the touch.
  container.addEventListener("touchcancel", onRelease, { passive: true });
  doc.addEventListener("touchstart", onAnyTouchStart, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", onVisibilityChange);
  const touchMouse = claimTouchMouse(container, { grant });
  return {
    cancel,
    foreignRelease: touchMouse.foreignRelease,
    dispose: () => {
      cancel();
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onRelease);
      container.removeEventListener("touchcancel", onRelease);
      doc.removeEventListener("touchstart", onAnyTouchStart, { capture: true });
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      touchMouse.release();
    },
  };
}
