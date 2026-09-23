import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A ref that holds the value from the latest committed render. Callbacks and
 * effects read `.current` to see current props without re-subscribing.
 *
 * The ref is written in a layout effect, not during render, so an abandoned
 * render never leaks its value. Layout effects run before passive effects and
 * before the browser paints, so effects and event handlers see the new value.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
