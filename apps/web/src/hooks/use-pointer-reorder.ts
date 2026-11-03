import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";

/** How far a mouse or pen moves before a press becomes a drag (px). */
const DRAG_THRESHOLD_PX = 5;
/** How far a finger may drift during the long press before it counts as a scroll (px). */
const TOUCH_SLOP_PX = 8;

export type ReorderDrag = { from: number; to: number };

type Gesture = {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  /** The press became a drag. */
  started: boolean;
  /** Item boxes at the start, in list order (the list does not move during a drag). */
  rects: DOMRect[];
  timer: ReturnType<typeof setTimeout> | null;
  to: number;
};

/**
 * Drag-to-reorder for a short list with Pointer Events (mouse, pen and touch), no library.
 * The list stays put while dragging: the dragged item and the drop place are marked
 * (`drag.from`, `drag.to`) and the move is made on release, through `onMove`. A mouse or pen
 * drag starts after a few pixels; a touch drag starts after a long press (`touchDelayMs`), so
 * a quick swipe still scrolls. Set `touchDelayMs` to 0 for a drag handle that never scrolls
 * (give it `touch-action: none`). The click that ends a drag is swallowed. Keyboard moves are
 * the caller's (call `onMove` from a key handler). Each item takes `itemRef(index)` on the
 * element that is measured and `handleProps(index)` where a drag starts (often the same one).
 */
export function usePointerReorder({
  axis,
  onMove,
  touchDelayMs = 350,
}: {
  axis: "x" | "y";
  onMove: (from: number, to: number) => void;
  touchDelayMs?: number;
}) {
  const [drag, setDrag] = useState<ReorderDrag | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const elements = useRef(new Map<number, HTMLElement>());
  const swallowClick = useRef(false);

  const clear = () => {
    const current = gesture.current;
    if (current?.timer) clearTimeout(current.timer);
    gesture.current = null;
    setDrag(null);
  };

  const begin = (current: Gesture) => {
    current.started = true;
    current.rects = [...elements.current.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, element]) => element.getBoundingClientRect());
    setDrag({ from: current.from, to: current.from });
  };

  const targetAt = (current: Gesture, x: number, y: number) => {
    const point = axis === "x" ? x : y;
    const { rects } = current;
    for (const [index, rect] of rects.entries()) {
      const end = axis === "x" ? rect.right : rect.bottom;
      // The first item whose far edge is past the pointer; past the last, the last.
      if (point < end || index === rects.length - 1) return index;
    }
    return current.from;
  };

  /** The item's element, measured for the drop place (the whole row or tab). */
  const itemRef = (index: number) => (element: HTMLElement | null) => {
    if (!element) {
      elements.current.delete(index);
      return;
    }
    elements.current.set(index, element);
    // A touch drag must not scroll the page or the strip. React's touch listeners are
    // passive, so this one is added here (non-passive) and only cancels once dragging.
    const blockScroll = (event: TouchEvent) => {
      if (gesture.current?.started) event.preventDefault();
    };
    element.addEventListener("touchmove", blockScroll, { passive: false });
    return () => {
      element.removeEventListener("touchmove", blockScroll);
      if (elements.current.get(index) === element) elements.current.delete(index);
    };
  };

  /** Where a drag starts: the item itself, or a handle inside it. */
  const handleProps = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // A press that never got its release (it ended outside the page) gives way.
      if (gesture.current) clear();
      const current: Gesture = {
        pointerId: event.pointerId,
        from: index,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        rects: [],
        timer: null,
        to: index,
      };
      gesture.current = current;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (event.pointerType === "touch" && touchDelayMs > 0) {
        current.timer = setTimeout(() => {
          current.timer = null;
          if (gesture.current === current) begin(current);
        }, touchDelayMs);
      } else if (event.pointerType === "touch") {
        begin(current);
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (!current.started) {
        if (event.pointerType === "touch") {
          // Moving before the long press ends is a scroll, not a drag.
          if (distance > TOUCH_SLOP_PX) clear();
          return;
        }
        if (distance < DRAG_THRESHOLD_PX) return;
        begin(current);
      }
      const to = targetAt(current, event.clientX, event.clientY);
      if (to !== current.to) {
        current.to = to;
        setDrag({ from: current.from, to });
      }
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.started) {
        swallowClick.current = true;
        if (current.to !== current.from) onMove(current.from, current.to);
      }
      clear();
    },
    onPointerCancel: () => clear(),
    onLostPointerCapture: () => {
      if (gesture.current && !gesture.current.started) return;
      clear();
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      // A long press on touch opens no menu while it may become a drag.
      if (gesture.current) event.preventDefault();
    },
  });

  return { drag, itemRef, handleProps };
}
