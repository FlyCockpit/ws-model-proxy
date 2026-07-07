import { useCallback, useEffect, useRef, useState } from "react";

type ScrollMode = "following" | "paused";

type AnchorSnapshot = {
  id: string;
  top: number;
};

type ScrollIntent = "follow" | "pause";
type ScrollBoundaryDecision = "scroll-container" | "chain-parent";

type ScrollBoundaryMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  deltaY: number;
};

const LIVE_EDGE_PX = 32;
const TURN_CONTEXT_PX = 96;
const TURN_SCROLL_ATTEMPTS = 8;

export function getScrollBoundaryDecision({
  scrollTop,
  scrollHeight,
  clientHeight,
  deltaY,
}: ScrollBoundaryMetrics): ScrollBoundaryDecision {
  if (deltaY === 0) return "scroll-container";

  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const boundedScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
  if (deltaY < 0) return boundedScrollTop <= 0 ? "chain-parent" : "scroll-container";
  return boundedScrollTop >= maxScrollTop ? "chain-parent" : "scroll-container";
}

function isAtLiveEdge(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= LIVE_EDGE_PX;
}

function anchorElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-scroll-anchor]"));
}

function anchorId(element: HTMLElement) {
  return element.dataset.scrollAnchor ?? null;
}

function firstVisibleAnchor(container: HTMLElement): AnchorSnapshot | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const element of anchorElements(container)) {
    const rect = element.getBoundingClientRect();
    const id = anchorId(element);
    if (id && rect.bottom > containerTop) {
      return { id, top: rect.top };
    }
  }
  return null;
}

function scrollToLiveEdge(element: HTMLElement) {
  element.scrollTop = element.scrollHeight;
}

export function useChatScrollEngine() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const liveEdgeRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<AnchorSnapshot | null>(null);
  const modeRef = useRef<ScrollMode>("paused");
  const touchYRef = useRef<number | null>(null);
  const [mode, setMode] = useState<ScrollMode>("paused");
  const [hasOutOfViewUpdates, setHasOutOfViewUpdates] = useState(false);

  const setScrollIntent = useCallback((intent: ScrollIntent) => {
    const nextMode: ScrollMode = intent === "follow" ? "following" : "paused";
    modeRef.current = nextMode;
    setMode(nextMode);
    if (intent === "pause") {
      const container = scrollRef.current;
      anchorRef.current = container ? firstVisibleAnchor(container) : null;
      return;
    }
    const container = scrollRef.current;
    if (container) scrollToLiveEdge(container);
    setHasOutOfViewUpdates(false);
  }, []);

  const markUserIntent = useCallback(() => {
    const container = scrollRef.current;
    modeRef.current = "paused";
    setMode("paused");
    anchorRef.current = container ? firstVisibleAnchor(container) : null;
    setHasOutOfViewUpdates(container ? !isAtLiveEdge(container) : false);
  }, []);

  const jumpToLatest = useCallback(() => {
    setScrollIntent("follow");
  }, [setScrollIntent]);

  const markContentChanged = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    if (modeRef.current === "following") {
      scrollToLiveEdge(container);
      setHasOutOfViewUpdates(false);
      return;
    }

    const anchor = anchorRef.current;
    if (anchor) {
      const element = container.querySelector<HTMLElement>(`[data-scroll-anchor="${anchor.id}"]`);
      if (element) {
        const delta = element.getBoundingClientRect().top - anchor.top;
        if (delta !== 0) container.scrollTop += delta;
      }
      anchorRef.current = firstVisibleAnchor(container);
    } else {
      anchorRef.current = firstVisibleAnchor(container);
    }

    if (!isAtLiveEdge(container)) setHasOutOfViewUpdates(true);
  }, []);

  const positionTurnNearTop = useCallback(
    (turnId: string) => {
      setScrollIntent("follow");
      let attempts = 0;

      const position = () => {
        const container = scrollRef.current;
        if (!container) return;
        const element = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
        if (!element) {
          attempts += 1;
          if (attempts < TURN_SCROLL_ATTEMPTS) requestAnimationFrame(position);
          return;
        }
        const elementTop =
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;
        container.scrollTop = Math.max(0, elementTop - TURN_CONTEXT_PX);
        anchorRef.current = firstVisibleAnchor(container);
      };

      requestAnimationFrame(position);
    },
    [setScrollIntent],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (isAtLiveEdge(container)) {
        setHasOutOfViewUpdates(false);
        return;
      }
      modeRef.current = "paused";
      setMode("paused");
      setHasOutOfViewUpdates(true);
      anchorRef.current = firstVisibleAnchor(container);
    };

    const handleIntent = (deltaY = 0) => {
      const boundaryDecision = getScrollBoundaryDecision({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        deltaY,
      });
      if (deltaY !== 0) {
        container.style.overscrollBehaviorY =
          boundaryDecision === "chain-parent" ? "auto" : "contain";
      }
      modeRef.current = "paused";
      setMode("paused");
      if (!isAtLiveEdge(container)) setHasOutOfViewUpdates(true);
      anchorRef.current = firstVisibleAnchor(container);
    };

    const handleWheel = (event: WheelEvent) => {
      handleIntent(event.deltaY);
    };

    const handleTouchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches.item(0)?.clientY ?? null;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const currentY = event.touches.item(0)?.clientY ?? null;
      const previousY = touchYRef.current;
      handleIntent(previousY !== null && currentY !== null ? previousY - currentY : 0);
      touchYRef.current = currentY;
    };

    const handleTouchEnd = () => {
      touchYRef.current = null;
      container.style.overscrollBehaviorY = "auto";
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === " "
      ) {
        handleIntent();
      }
    };

    const handleClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a, button, input, textarea")) {
        handleIntent();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && container.contains(event.target)) {
        handleIntent();
      }
    };

    const handleSelectionChange = () => {
      const selection = document.getSelection();
      if (
        selection?.anchorNode &&
        !selection.isCollapsed &&
        container.contains(selection.anchorNode)
      ) {
        handleIntent();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);
    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("click", handleClick);
    container.addEventListener("focusin", handleFocusIn);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      container.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("click", handleClick);
      container.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("selectionchange", handleSelectionChange);
      container.style.overscrollBehaviorY = "";
    };
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(markContentChanged);
    observer.observe(content);
    for (const element of anchorElements(content)) observer.observe(element);

    const mutationObserver = new MutationObserver(() => {
      for (const element of anchorElements(content)) observer.observe(element);
      markContentChanged();
    });
    mutationObserver.observe(content, { childList: true, subtree: true, characterData: true });

    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [markContentChanged]);

  return {
    contentRef,
    hasOutOfViewUpdates,
    jumpToLatest,
    liveEdgeRef,
    markContentChanged,
    markUserIntent,
    mode,
    positionTurnNearTop,
    scrollRef,
  };
}
