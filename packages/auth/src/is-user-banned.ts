/**
 * Pure Better Auth admin-plugin ban semantics (Phase 4).
 *
 * Better Auth's admin plugin stores bans as `banned: boolean` plus an
 * optional `banExpires: Date` (temporary ban). The upstream session-side
 * rule treats a ban as ACTIVE when the flag is set and the expiry is either
 * absent (indefinite) or still in the future; an expired temporary ban no
 * longer blocks the account. This helper centralizes exactly that rule so
 * the `/mcp` admission check (Phase 4) and any other live account-policy
 * check share one definition.
 *
 * Boundary (F5, Part F pass 2): `banExpires` exactly equal to `now` is
 * STILL BANNED — the installed Better Auth admin plugin expires a
 * temporary ban only when `banExpires < Date.now()` (admin.mjs session
 * hook), so the active window is `banExpires >= now`. Parity with that
 * strict-inequality comparison is pinned by an installed-hook test with a
 * frozen clock.

/** The ban-relevant subset of a Better Auth / Prisma user row. */
export interface BannableUser {
  banned?: boolean | null;
  banExpires?: Date | null;
}

/**
 * Whether the user's ban is ACTIVE at `now`.
 *
 * - no ban flag / `banned: false` / `banned: null` → never banned here;
 * - `banned: true` with no expiry → indefinite ban, always active;
 * - `banned: true` with a future expiry → active until the expiry;
 * - `banned: true` with an expiry in the past (`banExpires < now`) →
 *   expired, not active (the account is admissible again; Better Auth
 *   clears nothing on its own, so the stale flag + past date pair keeps
 *   occurring in real data). An expiry EXACTLY at `now` is still active.
 */
export function isUserBanned(user: BannableUser, now: Date): boolean {
  if (user.banned !== true) return false;
  const expires = user.banExpires;
  if (expires === null || expires === undefined) return true;
  return expires.getTime() >= now.getTime();
}
