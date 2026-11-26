import { useSyncExternalStore } from "react";

/** Tailwind `md` in px at the browser-default 16px font size (the keyboard heuristic's fallback width). */
export const MOBILE_BREAKPOINT_PX = 768;
/**
 * Tailwind `md` exactly (48rem): a rem media query follows the user's default font size, as the
 * `md:` styles do, so JS and CSS flip at the same width when that default is larger than 16px.
 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 48rem)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return !useMediaQuery(DESKTOP_MEDIA_QUERY);
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_MEDIA_QUERY);
}
