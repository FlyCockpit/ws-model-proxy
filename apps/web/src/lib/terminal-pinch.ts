import { PinchFontGesture } from "@/lib/terminal-key-gestures";

function fingerDistance(touches: TouchList): number {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * Two-finger pinch on the terminal changes its text size in whole px (`change`, at each new
 * size). One finger stays the touch scroll's and xterm's (scroll, tap, select): only a second
 * finger starts a pinch, and the touch scroll drops its touch then. The page never zooms here:
 * the pane's `touch-action` leaves the browser no pinch, and iOS gesture events are cancelled.
 */
export function wirePinchFont(
  element: HTMLElement,
  options: {
    enabled: () => boolean;
    current: () => number;
    change: (size: number) => void;
  },
): () => void {
  let pinch: { gesture: PinchFontGesture; last: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 2 && options.enabled()) {
      const size = options.current();
      pinch = { gesture: new PinchFontGesture(fingerDistance(event.touches), size), last: size };
    } else if (event.touches.length !== 2) pinch = null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!pinch || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const size = pinch.gesture.sizeAt(fingerDistance(event.touches));
    if (size === pinch.last) return;
    pinch.last = size;
    options.change(size);
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) pinch = null;
  };
  const cancelGesture = (event: Event) => event.preventDefault();
  element.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  element.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  element.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
  // iOS Safari: its own pinch events would zoom the page.
  for (const type of ["gesturestart", "gesturechange", "gestureend"])
    element.addEventListener(type, cancelGesture, { passive: false });
  return () => {
    element.removeEventListener("touchstart", onTouchStart, { capture: true });
    element.removeEventListener("touchmove", onTouchMove, { capture: true });
    element.removeEventListener("touchend", onTouchEnd, { capture: true });
    element.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    for (const type of ["gesturestart", "gesturechange", "gestureend"])
      element.removeEventListener(type, cancelGesture);
  };
}
