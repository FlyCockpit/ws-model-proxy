import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/** Reveal only the horizontal part of a tab strip; never move the page scroller. */
export function useActiveTabScroll() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Path changes trigger this after the active link's DOM props have committed.
    if (!pathname) return;
    const scroller = ref.current;
    const active = scroller?.querySelector<HTMLElement>('[data-status="active"]');
    if (!scroller || !active || scroller.clientWidth === 0) return;
    const left = scroller.getBoundingClientRect().left + scroller.clientLeft;
    const right = left + scroller.clientWidth;
    const tab = active.getBoundingClientRect();
    if (tab.left < left) scroller.scrollLeft += tab.left - left;
    else if (tab.right > right) scroller.scrollLeft += tab.right - right;
  }, [pathname]);
  return ref;
}
