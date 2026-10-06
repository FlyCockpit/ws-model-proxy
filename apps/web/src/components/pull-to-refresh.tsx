import { Loader2 } from "lucide-react";
import { useCallback, useRef } from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}

const THRESHOLD = 80;
const MAX_PULL = 128;

type GestureState =
  | { kind: "idle" }
  | { kind: "pulling"; identifier: number; startY: number; distance: number }
  | { kind: "refreshing" };

function nearestVerticalScroller(start: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export default function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  const gesture = useRef<GestureState>({ kind: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);

  function updateIndicator(distance: number) {
    const indicator = indicatorRef.current;
    const icon = iconRef.current;
    if (!indicator || !icon) return;
    const progress = Math.min(distance / THRESHOLD, 1);
    indicator.style.height = distance > 0 ? `${distance}px` : "0";
    Object.assign(icon.style, {
      opacity: String(progress),
      transform: `rotate(${progress * 360}deg)`,
    });
  }

  const cancelPull = useCallback(() => {
    // Touch cleanup never owns the indicator of an unresolved refresh.
    if (gesture.current.kind !== "pulling") return;
    gesture.current = { kind: "idle" };
    if (indicatorRef.current) indicatorRef.current.style.transitionDuration = "200ms";
    updateIndicator(0);
  }, []);

  function containsTarget(target: EventTarget) {
    return target instanceof Node && containerRef.current?.contains(target);
  }

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (gesture.current.kind === "refreshing") return;
      cancelPull();
      const container = containerRef.current;
      if (!container || e.touches.length !== 1) return;
      let node: HTMLElement | null =
        e.target instanceof HTMLElement
          ? e.target
          : e.target instanceof Node
            ? e.target.parentElement
            : null;
      // React portal events bubble through the logical component tree, but
      // overlays outside this page must never start its refresh gesture.
      if (!node || !container.contains(node)) return;
      while (node && node !== container) {
        const overflowY = getComputedStyle(node).overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight &&
          node.scrollTop > 0
        ) {
          return;
        }
        node = node.parentElement;
      }
      const scroller = nearestVerticalScroller(container);
      if (scroller && scroller.scrollTop > 0) return;
      const touch = e.touches[0];
      gesture.current = {
        kind: "pulling",
        identifier: touch.identifier,
        startY: touch.clientY,
        distance: 0,
      };
      if (indicatorRef.current) {
        indicatorRef.current.style.transitionDuration = "0ms";
      }
    },
    [cancelPull],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const current = gesture.current;
      if (current.kind !== "pulling" || !containsTarget(e.target)) return;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || touch.identifier !== current.identifier) {
        cancelPull();
        return;
      }
      const delta = touch.clientY - current.startY;
      if (delta < 0) {
        cancelPull();
        return;
      }
      current.distance = Math.min(delta * 0.5, MAX_PULL);
      updateIndicator(current.distance);
    },
    [cancelPull],
  );

  const handleTouchEnd = useCallback(
    async (e: React.TouchEvent) => {
      const current = gesture.current;
      if (current.kind !== "pulling" || !containsTarget(e.target)) return;
      if (!Array.from(e.changedTouches).some((touch) => touch.identifier === current.identifier)) {
        return;
      }
      cancelPull();
      if (e.touches.length === 0 && current.distance >= THRESHOLD) {
        // Transfer ownership before invoking the callback, including synchronous re-entry.
        const pending: GestureState = { kind: "refreshing" };
        gesture.current = pending;
        updateIndicator(THRESHOLD / 2);
        if (iconRef.current) {
          iconRef.current.style.animation = "spin 0.8s linear infinite";
        }
        try {
          await onRefresh();
        } finally {
          gesture.current = { kind: "idle" };
          updateIndicator(0);
          if (iconRef.current) {
            iconRef.current.style.animation = "none";
          }
        }
      }
    },
    [cancelPull, onRefresh],
  );

  const handleTouchCancel = useCallback(
    (e: React.TouchEvent) => {
      const current = gesture.current;
      if (
        current.kind === "pulling" &&
        Array.from(e.changedTouches).some((touch) => touch.identifier === current.identifier)
      ) {
        cancelPull();
      }
    },
    [cancelPull],
  );

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        ref={indicatorRef}
        className="flex items-center justify-center overflow-hidden transition-[height] duration-200"
        style={{ height: 0 }}
      >
        <Loader2 ref={iconRef} className="size-5 text-muted-foreground" style={{ opacity: 0 }} />
      </div>
      {children}
    </div>
  );
}
