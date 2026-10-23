import { useLayoutEffect } from "react";

import { useAppChrome } from "@/stores/app-chrome";

/**
 * Hide the app's chrome (Header, BottomNav, sidebar, page padding) while `active`, so the calling
 * page has the whole viewport. Leaving the page, or `active` turning false, shows it again. The
 * page keeps its place in the tree, so nothing in it remounts.
 *
 * A layout effect, so the chrome follows the page's visibility: when a pending navigation's
 * Suspense fallback hides the page, React runs layout cleanups (not passive ones), and the chrome
 * comes back with the fallback instead of staying hidden with no Restore button on screen.
 */
export function useHideAppChrome(active: boolean) {
  const setHidden = useAppChrome((state) => state.setHidden);
  useLayoutEffect(() => {
    if (!active) return;
    setHidden(true);
    return () => setHidden(false);
  }, [active, setHidden]);
}
