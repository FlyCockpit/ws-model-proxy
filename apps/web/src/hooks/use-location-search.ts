import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};

/**
 * The page's raw `location.search` as the browser has it (not the router's re-serialized search),
 * or null while server rendering, so server and client render the same first branch.
 */
export function useLocationSearch(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => null,
  );
}
