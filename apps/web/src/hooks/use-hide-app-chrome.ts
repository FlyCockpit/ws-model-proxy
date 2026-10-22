import { useEffect } from "react";

import { useAppChrome } from "@/stores/app-chrome";

/**
 * Hide the app's chrome (Header, BottomNav, sidebar, page padding) while `active`, so the calling
 * page has the whole viewport. Leaving the page, or `active` turning false, shows it again. The
 * page keeps its place in the tree, so nothing in it remounts.
 */
export function useHideAppChrome(active: boolean) {
  const setHidden = useAppChrome((state) => state.setHidden);
  useEffect(() => {
    if (!active) return;
    setHidden(true);
    return () => setHidden(false);
  }, [active, setHidden]);
}
