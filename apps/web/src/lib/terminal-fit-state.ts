/**
 * When the browser terminal may fit xterm to its own box, as a pure state machine (`useXterm`
 * holds one `FitState` in a ref and runs every change through `reduceFit`).
 *
 * xterm parses writes asynchronously, so two things can hold xterm's size back after the box was
 * measured:
 * - PTY size events written into xterm's output queue but not yet reached by its parser
 *   (`queuedSizes`). While any is queued the size is left to them, so output written before a size
 *   change still renders at the old size.
 * - A takeover's fit (leaving follow mode) waits for the output queued before it to be parsed
 *   (its barrier); until it runs, no other layout may refit xterm, since that output must render
 *   at the size it was written for. Each takeover's fit has its own number, so an older barrier's
 *   callback can neither run nor cancel a newer one.
 */

/** What is waiting to lay xterm out once the queue lets it. */
export type FitPending =
  /** Nothing: a writer's layout fits xterm right away when no PTY size is queued. */
  | { readonly kind: "none" }
  /**
   * A writer's layout found PTY sizes still queued and left xterm's size to them: the last of them
   * lays out again, so xterm ends at the size its box was measured at. Only while sizes are queued.
   */
  | { readonly kind: "layout" }
  /** A takeover's fit waits for its barrier (the output queued before it) to be parsed. */
  | { readonly kind: "barrier"; readonly fit: number }
  /**
   * A takeover's barrier passed while PTY sizes were still queued: the last of them runs the fit.
   * Only while sizes are queued.
   */
  | { readonly kind: "fit"; readonly fit: number };

export type FitState = {
  /** PTY size events written into xterm's output queue whose callback has not run yet. */
  readonly queuedSizes: number;
  readonly pending: FitPending;
  /** The number of the newest takeover fit (never reused while the hook lives). */
  readonly lastFit: number;
};

export type FitEvent =
  /** A new xterm opened: nothing of the old one's queue or fit applies to it. */
  | { readonly type: "opened" }
  /** Taking over (leaving follow mode): a new fit waits for the output queued before it. */
  | { readonly type: "takeover" }
  /** Following (again, or at a new PTY size), or no xterm to take over: no fit waits any more. */
  | { readonly type: "followed" }
  /** The barrier of takeover fit `fit` was reached by xterm's parser. */
  | { readonly type: "barrierPassed"; readonly fit: number }
  /** A PTY size event was written into xterm's output queue. */
  | { readonly type: "sizeQueued" }
  /** xterm's parser reached a queued PTY size (already applied). `following`: at that moment. */
  | { readonly type: "sizeApplied"; readonly following: boolean }
  /** A writer's layout measured the box but left xterm's size alone (`isFitHeld`). */
  | { readonly type: "layoutHeld" };

export type FitTransition = {
  readonly state: FitState;
  /** Lay out now (the hook's `layout()`). */
  readonly layout: boolean;
};

export const INITIAL_FIT_STATE: FitState = {
  queuedSizes: 0,
  pending: { kind: "none" },
  lastFit: 0,
};

const NONE: FitPending = { kind: "none" };

/** Whether a writer's layout must leave xterm's size alone (it still reports the measured size). */
export function isFitHeld(state: FitState): boolean {
  return state.pending.kind === "barrier" || state.pending.kind === "fit" || state.queuedSizes > 0;
}

/** The takeover fit waiting (for its barrier or for the queued sizes), or null. */
export function pendingFit(state: FitState): number | null {
  const { pending } = state;
  return pending.kind === "barrier" || pending.kind === "fit" ? pending.fit : null;
}

export function reduceFit(state: FitState, event: FitEvent): FitTransition {
  switch (event.type) {
    case "opened":
      return { state: { ...state, queuedSizes: 0, pending: NONE }, layout: false };
    case "takeover": {
      // The fit lays out once its barrier passes, which also covers a writer's layout the queue
      // held back before it.
      const fit = state.lastFit + 1;
      return {
        state: { ...state, pending: { kind: "barrier", fit }, lastFit: fit },
        layout: false,
      };
    }
    case "followed":
      return { state: { ...state, pending: NONE }, layout: true };
    case "barrierPassed": {
      if (pendingFit(state) !== event.fit) return { state, layout: false };
      // PTY sizes queued before the barrier still apply first; the last one runs the fit.
      if (state.queuedSizes > 0)
        return { state: { ...state, pending: { kind: "fit", fit: event.fit } }, layout: false };
      return { state: { ...state, pending: NONE }, layout: true };
    }
    case "sizeQueued":
      return { state: { ...state, queuedSizes: state.queuedSizes + 1 }, layout: false };
    case "sizeApplied": {
      const queuedSizes = Math.max(0, state.queuedSizes - 1);
      const kind = state.pending.kind;
      // The last queued size runs a takeover fit whose barrier already passed, or a writer's
      // layout these sizes held back (a takeover's fit still waiting for its barrier runs then).
      if (queuedSizes > 0 || (kind !== "fit" && kind !== "layout"))
        return { state: { ...state, queuedSizes }, layout: false };
      return { state: { ...state, queuedSizes, pending: NONE }, layout: !event.following };
    }
    case "layoutHeld":
      // A takeover's fit lays out once its barrier passes; otherwise the last queued size does.
      if (state.pending.kind !== "none" || state.queuedSizes === 0) return { state, layout: false };
      return { state: { ...state, pending: { kind: "layout" } }, layout: false };
  }
}
