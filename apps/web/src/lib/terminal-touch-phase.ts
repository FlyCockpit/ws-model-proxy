/**
 * What one touch on the browser terminal may still do, as a pure state machine
 * (`wireTouchScroll` keeps one `TouchPhase` per live touch). A touch goes from its touchstart
 * until no finger of it is left (`ended`); everything it may do is decided from its phase.
 *
 * - `native`: the browser's (touch was not the pane's when it started, or stopped being the pane's
 *   before the pane took it). Followed only to tell a tap from a drag; it scrolls nothing.
 * - `owned`: the pane's, still under the slop: it may become the pane's scroll, or be a tap.
 * - `claimed`: the pane took it (it moved past the slop while the pane's, or it stopped a coasting
 *   scroll): its moves are cancelled, it scrolls, and its release is cancelled too.
 * - `disowned`: the pane took it, then touch stopped being the pane's: it stays out of the page
 *   (moves and release cancelled) but scrolls no more and never coasts.
 * - `void`: ended by `cancel()` (the interaction changed under it) or by a second finger: it scrolls
 *   no more, is no tap, and every one of its releases is cancelled. `claimed`: the pane had taken
 *   it, so its one-finger moves stay out of the page.
 * - `ended`: no finger of it is down any more. Nothing of it acts here again.
 */
export type TouchPhase =
  | { readonly kind: "native" }
  | { readonly kind: "owned" }
  | { readonly kind: "claimed" }
  | { readonly kind: "disowned" }
  | { readonly kind: "void"; readonly claimed: boolean }
  | { readonly kind: "ended" };

/** What a finger lifting does (see `wireTouchScroll`'s `Release`). */
export type TouchRelease = "tap" | "native" | "cancel";

const NATIVE: TouchPhase = { kind: "native" };
const OWNED: TouchPhase = { kind: "owned" };
const CLAIMED: TouchPhase = { kind: "claimed" };
const DISOWNED: TouchPhase = { kind: "disowned" };
const ENDED: TouchPhase = { kind: "ended" };

/** Whether the pane has taken the touch (its moves past the slop and its release are cancelled). */
export function touchTaken(phase: TouchPhase): boolean {
  return (
    phase.kind === "claimed" ||
    phase.kind === "disowned" ||
    (phase.kind === "void" && phase.claimed)
  );
}

/** A finger of it is still down: it is this interaction's touch. */
export function touchLive(phase: TouchPhase): boolean {
  return phase.kind !== "ended";
}

/**
 * The touch's first phase. `enabled`: touch is the pane's now. `coasting`: it stops a coasting
 * scroll (a stop, as a native scroll's is, not a tap). `fingers`: fingers down on the page.
 */
export function startTouchPhase(start: {
  enabled: boolean;
  coasting: boolean;
  fingers: number;
}): TouchPhase {
  const claimed = start.coasting && start.enabled;
  // Two fingers at once (one may have started outside the pane): never this pane's scroll.
  if (start.fingers !== 1) return { kind: "void", claimed };
  if (!start.enabled) return NATIVE;
  return claimed ? CLAIMED : OWNED;
}

/** The interaction ended under the touch, or a second finger came: it is void from now on. */
export function voidTouchPhase(phase: TouchPhase): TouchPhase {
  if (phase.kind === "void" || phase.kind === "ended") return phase;
  return { kind: "void", claimed: touchTaken(phase) };
}

/**
 * A one-finger move of a touch that is neither void nor ended. `enabled`: touch is the pane's now.
 * `pastSlop`: the gesture has moved past the slop (on either axis).
 */
export function moveTouchPhase(
  phase: TouchPhase,
  move: { enabled: boolean; pastSlop: boolean },
): TouchPhase {
  switch (phase.kind) {
    case "owned":
      if (!move.enabled) return NATIVE;
      // Past the slop the drag is the pane's, on either axis.
      return move.pastSlop ? CLAIMED : OWNED;
    case "claimed":
      return move.enabled ? CLAIMED : DISOWNED;
    default:
      return phase;
  }
}

/**
 * A finger lifted (touchend) or the browser took the touch (touchcancel): what the lift does, and
 * the phase after it. `fingersLeft`: fingers still down on the page. `moved`: the gesture moved
 * past the slop. `liftedWithinSlop`: the event carries this touch's finger, and it lifted within
 * the slop of where it went down. `coasts`: the touch was the pane's scroll up to its last finger,
 * so a fast release may coast on (the caller checks `enabled` and the release speed).
 */
export function releaseTouchPhase(
  phase: TouchPhase,
  lift: { fingersLeft: number; cancelled: boolean; moved: boolean; liftedWithinSlop: boolean },
): { phase: TouchPhase; release: TouchRelease; coasts: boolean } {
  // A touch this wiring saw end: not this interaction's.
  if (phase.kind === "ended") return { phase, release: "cancel", coasts: false };
  // A finger is still down, or the browser took the touch: more than a one-finger tap.
  const decided = lift.fingersLeft > 0 || lift.cancelled ? voidTouchPhase(phase) : phase;
  const release: TouchRelease =
    decided.kind === "void" || touchTaken(decided)
      ? "cancel"
      : lift.moved
        ? "native"
        : lift.liftedWithinSlop
          ? "tap"
          : "cancel";
  if (lift.fingersLeft > 0) return { phase: decided, release, coasts: false };
  return { phase: ENDED, release, coasts: decided.kind === "claimed" };
}
