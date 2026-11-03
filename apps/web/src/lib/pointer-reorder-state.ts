/**
 * The gesture of `usePointerReorder`, as a pure state machine: a press that may become a drag, the
 * drag, and the click that ends a drag (swallowed).
 */

/** How far a mouse or pen moves before a press becomes a drag (px). */
export const DRAG_THRESHOLD_PX = 5;
/** How far a finger may drift during the long press before it counts as a scroll (px). */
export const TOUCH_SLOP_PX = 8;

export type ReorderDrag = { from: number; to: number };

/** An item's box along the reorder axis. */
export type ReorderRect = Pick<DOMRectReadOnly, "right" | "bottom">;

export type ReorderState =
  /** No press. */
  | { readonly phase: "idle" }
  /**
   * A press that is not a drag yet: a mouse or pen moving past the threshold, or a touch held for
   * the long press (`longPress`), makes it one.
   */
  | {
      readonly phase: "pressing";
      readonly pointerId: number;
      readonly from: number;
      readonly startX: number;
      readonly startY: number;
    }
  /** Dragging item `from`; it drops at `to`. `rects`: item boxes at its start, in list order. */
  | {
      readonly phase: "dragging";
      readonly pointerId: number;
      readonly from: number;
      readonly to: number;
      readonly rects: readonly ReorderRect[];
    }
  /** A drag just ended on its release: the click that follows it is swallowed. */
  | { readonly phase: "dropped" };

type Measure = () => readonly ReorderRect[];

export type ReorderEvent =
  | {
      readonly type: "down";
      readonly pointerId: number;
      readonly index: number;
      readonly x: number;
      readonly y: number;
      /** A touch with no long press (a drag handle): the drag starts at once. */
      readonly immediate: boolean;
      readonly measure: Measure;
    }
  /** The long press of `press` passed (a timer started at its `down`). */
  | { readonly type: "longPress"; readonly press: ReorderState; readonly measure: Measure }
  | {
      readonly type: "move";
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly touch: boolean;
      readonly measure: Measure;
    }
  | { readonly type: "up"; readonly pointerId: number }
  | { readonly type: "cancel" }
  | { readonly type: "lostCapture" }
  | { readonly type: "click" };

export type ReorderTransition = {
  readonly state: ReorderState;
  /** A drag dropped somewhere else: move the item. */
  readonly move?: ReorderDrag;
  /** Swallow this click (it ends a drag). */
  readonly swallowClick?: boolean;
};

const IDLE: ReorderState = { phase: "idle" };

/** What the list shows: the dragged item and its drop place while dragging, else null. */
export function reorderDrag(state: ReorderState): ReorderDrag | null {
  return state.phase === "dragging" ? { from: state.from, to: state.to } : null;
}

/** A press or drag is under way (a long press opens no context menu then). */
export function reorderActive(state: ReorderState): boolean {
  return state.phase === "pressing" || state.phase === "dragging";
}

/** The first item whose far edge is past `point`; past the last, the last. */
export function dropTarget(
  rects: readonly ReorderRect[],
  axis: "x" | "y",
  point: number,
  from: number,
): number {
  for (const [index, rect] of rects.entries()) {
    const end = axis === "x" ? rect.right : rect.bottom;
    if (point < end || index === rects.length - 1) return index;
  }
  return from;
}

type Dragging = Extract<ReorderState, { phase: "dragging" }>;

function begin(press: { pointerId: number; from: number }, measure: Measure): Dragging {
  return {
    phase: "dragging",
    pointerId: press.pointerId,
    from: press.from,
    to: press.from,
    rects: measure(),
  };
}

export function reduceReorder(
  state: ReorderState,
  event: ReorderEvent,
  axis: "x" | "y",
): ReorderTransition {
  switch (event.type) {
    case "down": {
      // A press that never got its release (it ended outside the page) gives way, and a drag's
      // click that never came is not waited for any more.
      const press = { pointerId: event.pointerId, from: event.index };
      if (event.immediate) return { state: begin(press, event.measure) };
      return {
        state: { phase: "pressing", ...press, startX: event.x, startY: event.y },
      };
    }
    case "longPress":
      return {
        state:
          state === event.press && state.phase === "pressing" ? begin(state, event.measure) : state,
      };
    case "move": {
      if (state.phase !== "pressing" && state.phase !== "dragging") return { state };
      if (state.pointerId !== event.pointerId) return { state };
      let dragging: Dragging;
      if (state.phase === "pressing") {
        const distance = Math.hypot(event.x - state.startX, event.y - state.startY);
        // Moving before the long press ends is a scroll, not a drag.
        if (event.touch) return { state: distance > TOUCH_SLOP_PX ? IDLE : state };
        if (distance < DRAG_THRESHOLD_PX) return { state };
        dragging = begin(state, event.measure);
      } else dragging = state;
      const to = dropTarget(dragging.rects, axis, axis === "x" ? event.x : event.y, dragging.from);
      return { state: to === dragging.to ? dragging : { ...dragging, to } };
    }
    case "up": {
      if (state.phase === "pressing" && state.pointerId === event.pointerId) return { state: IDLE };
      if (state.phase !== "dragging" || state.pointerId !== event.pointerId) return { state };
      return {
        state: { phase: "dropped" },
        move: state.to !== state.from ? { from: state.from, to: state.to } : undefined,
      };
    }
    case "cancel":
      return { state: reorderActive(state) ? IDLE : state };
    case "lostCapture":
      // A press keeps going without capture (a touch's long press may lose it); a drag ends.
      return { state: state.phase === "dragging" ? IDLE : state };
    case "click":
      return state.phase === "dropped" ? { state: IDLE, swallowClick: true } : { state };
  }
}
