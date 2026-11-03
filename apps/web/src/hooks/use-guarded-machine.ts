import { useCallback, useRef, useState } from "react";

/**
 * Drives a pure `transition(state, event)` machine from event handlers.
 *
 * `send` applies the event to the CURRENT state synchronously (a ref, not the
 * render-time closure) and reports whether it was accepted, i.e. whether the
 * transition returned a different state object. Two Enter presses in the same
 * tick therefore see each other: the second `verifyStarted` is rejected and
 * no second request goes out. `nextAttempt` hands out the monotonically
 * increasing ids the machines use to drop stale async completions.
 */
export function useGuardedMachine<S, E>(initial: S, transition: (state: S, event: E) => S) {
  const [state, setState] = useState(initial);
  const stateRef = useRef(initial);
  const attemptRef = useRef(0);

  const send = useCallback(
    (event: E): boolean => {
      const next = transition(stateRef.current, event);
      if (Object.is(next, stateRef.current)) return false;
      stateRef.current = next;
      setState(next);
      return true;
    },
    [transition],
  );

  const nextAttempt = useCallback(() => {
    attemptRef.current += 1;
    return attemptRef.current;
  }, []);

  /** The latest state, including transitions not yet rendered. */
  const current = useCallback(() => stateRef.current, []);

  return { state, send, nextAttempt, current };
}
