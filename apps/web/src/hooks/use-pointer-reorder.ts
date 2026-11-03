import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";

import {
  type ReorderDrag,
  type ReorderEvent,
  type ReorderState,
  reduceReorder,
  reorderActive,
  reorderDrag,
} from "@/lib/pointer-reorder-state";

export type { ReorderDrag } from "@/lib/pointer-reorder-state";

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
  /** The gesture (see pointer-reorder-state.ts); `drag` is what it shows. */
  const gesture = useRef<ReorderState>({ phase: "idle" });
  /** A touch's long press, while its press is the gesture. */
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elements = useRef(new Map<number, HTMLElement>());

  /** Item boxes now, in list order (the list does not move during a drag). */
  const measure = () =>
    [...elements.current.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, element]) => element.getBoundingClientRect());

  /** Run `event` through the gesture; returns whether to swallow it (a drag's click). */
  const dispatch = (event: ReorderEvent): boolean => {
    const previous = gesture.current;
    const transition = reduceReorder(previous, event, axis);
    const next = transition.state;
    gesture.current = next;
    if (next !== previous) {
      // The press the long press was for is over (or became a drag).
      if (previous.phase === "pressing" && longPress.current) {
        clearTimeout(longPress.current);
        longPress.current = null;
      }
      const before = reorderDrag(previous);
      const after = reorderDrag(next);
      if (before?.from !== after?.from || before?.to !== after?.to) setDrag(after);
    }
    if (transition.move) onMove(transition.move.from, transition.move.to);
    return transition.swallowClick === true;
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
      if (gesture.current.phase === "dragging") event.preventDefault();
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
      const touch = event.pointerType === "touch";
      dispatch({
        type: "down",
        pointerId: event.pointerId,
        index,
        x: event.clientX,
        y: event.clientY,
        immediate: touch && touchDelayMs <= 0,
        measure,
      });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const press = gesture.current;
      if (touch && press.phase === "pressing") {
        longPress.current = setTimeout(() => {
          longPress.current = null;
          dispatch({ type: "longPress", press, measure });
        }, touchDelayMs);
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      dispatch({
        type: "move",
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        touch: event.pointerType === "touch",
        measure,
      });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      dispatch({ type: "up", pointerId: event.pointerId });
    },
    onPointerCancel: () => {
      dispatch({ type: "cancel" });
    },
    onLostPointerCapture: () => {
      dispatch({ type: "lostCapture" });
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!dispatch({ type: "click" })) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      // A long press on touch opens no menu while it may become a drag.
      if (reorderActive(gesture.current)) event.preventDefault();
    },
  });

  return { drag, itemRef, handleProps };
}
