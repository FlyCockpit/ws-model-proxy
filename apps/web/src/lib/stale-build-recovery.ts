/**
 * Recovery for a tab that outlived a deploy. Each deploy replaces the hashed
 * /assets/* chunks, so a tab still running the old build fails to import a
 * route or lazy component it has not loaded yet. Vite reports that as a
 * `vite:preloadError` window event; route chunks fail through it too, because
 * TanStack's lazyRouteComponent wraps Vite's preload helper.
 *
 * Recovery is one full document navigation to the page the user was going
 * to. The SW updates silently, so a reload is never forced for any other
 * reason.
 */

export const STALE_BUILD_RELOAD_KEY = "wsmp:stale-build-reload-at";
export const STALE_BUILD_RELOAD_COOLDOWN_MS = 10_000;
/** How recent a click or key press must be to count as the cause of a failed import. */
export const USER_INPUT_WINDOW_MS = 1_000;

type Location = { href: string; publicHref: string };

export type StaleBuildRouter = {
  latestLocation: Location;
  state: { resolvedLocation?: { href: string } };
};

export type StaleBuildRecoveryEnv = {
  router: StaleBuildRouter;
  /** undefined when sessionStorage cannot be opened. */
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  now: number;
  /** A click/tap or Enter/Space press happened within USER_INPUT_WINDOW_MS. */
  userActivated: boolean;
  assign: (href: string) => void;
  reload: () => void;
};

/** The URL the router is navigating to, or undefined when no navigation is in flight. */
export function pendingNavigationHref(router: StaleBuildRouter): string | undefined {
  const target = router.latestLocation;
  const resolved = router.state.resolvedLocation;
  if (!resolved || resolved.href === target.href) return undefined;
  return target.publicHref;
}

/**
 * Takes the once-per-cooldown reload slot. Without working storage there is
 * no loop guard, so it refuses rather than risk a reload loop.
 */
export function claimReloadSlot(storage: StaleBuildRecoveryEnv["storage"], now: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY));
    if (last > 0 && now >= last && now - last < STALE_BUILD_RELOAD_COOLDOWN_MS) return false;
    storage.setItem(STALE_BUILD_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when it started a full navigation. The caller then cancels the
 * error, so the importer gets `undefined` and may briefly render its error UI
 * until the new document commits. With no navigation in flight and no recent click, the failed import
 * came from a hover/intent preload: it does nothing, and the click that follows
 * retries the import and recovers then, so hovering a link never reloads.
 */
export function recoverFromStaleChunk(env: StaleBuildRecoveryEnv): boolean {
  const target = pendingNavigationHref(env.router);
  if (!target && !env.userActivated) return false;
  if (!claimReloadSlot(env.storage, env.now)) return false;
  if (target) env.assign(target);
  else env.reload();
  return true;
}
