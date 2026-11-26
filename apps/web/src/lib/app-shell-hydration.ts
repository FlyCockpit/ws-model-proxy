/**
 * Whether the server-rendered app shell has hydrated, so a route guard may
 * change the router's state.
 *
 * The root route is `ssr: false`: the server sends its pending state,
 * `ShellSkeleton` (header, sidebar column and bottom nav shaped by the URL,
 * `shellPartsOf`). The router wraps that in a Suspense boundary and React
 * hydrates it in a later, low-priority pass, so the router can run the guards
 * (`Transitioner`'s mount effect) while the skeleton is still server HTML.
 * The router's stores give React the current state as the "server snapshot",
 * so a redirect that lands in that window makes React hydrate the skeleton for
 * the new URL against the old URL's HTML: React error #418 on a signed-out
 * cold load of /en-US/nodes (sidebar → none on /login), or a signed-in one of
 * /en-US/signup. `resolveRouteSession` waits here (in parallel with its
 * probe), so every guard decides only after the shell hydrated (docs/ui.md
 * § Guards wait for the shell to hydrate).
 */

/** On the shell skeleton's root element, in the server HTML and after. */
export const APP_SHELL_ATTRIBUTE = "data-app-shell";

/**
 * A guard waits at most this long. The frame reports in its first effect, so
 * this only matters if that ever stops happening: a late redirect (and a
 * recoverable mismatch) instead of a page stuck on its skeleton.
 */
export const APP_SHELL_HYDRATION_TIMEOUT_MS = 5000;

let hydrated = false;
let waiters: (() => void)[] = [];

/** Called by the shell skeleton's and the root component's mount effects: the markup is React's now. */
export function markAppShellHydrated(): void {
  hydrated = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/**
 * Resolves once no server-rendered app shell is waiting to hydrate: at once
 * on the server, after the first hydration, and when the document holds no
 * app shell (a client navigation from a public page).
 */
export function appShellHydrated(): Promise<void> {
  if (hydrated || typeof document === "undefined") return Promise.resolve();
  if (!document.querySelector(`[${APP_SHELL_ATTRIBUTE}]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(release, APP_SHELL_HYDRATION_TIMEOUT_MS);
    function release() {
      clearTimeout(timer);
      waiters = waiters.filter((waiter) => waiter !== release);
      resolve();
    }
    waiters.push(release);
  });
}

/** Back to a fresh document. Tests only. */
export function resetAppShellHydrationForTests(): void {
  hydrated = false;
  waiters = [];
}
