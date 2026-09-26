/**
 * Account-access rules shared by every live consumer (Better Auth session
 * creation, MCP admission, CLI credentials, model API tokens, relay
 * registration and CLI command admission).
 *
 * Ban semantics follow Better Auth's admin plugin (re-exported as
 * `@ws-model-proxy/auth/is-user-banned`, whose tests pin parity with the
 * installed hook). The deletion marker is authoritative on its own: once
 * `deletionRequestedAt` is set, access is refused whatever the ban fields say,
 * because Better Auth's unban-user, update-user and ban-with-expiry (and its
 * own session hook, which clears an expired ban) can all rewrite them.
 */

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

/** Row fields used to refuse access during a ban or a pending deletion. */
export type UserDeletionAccessRow = BannableUser & {
  deletionRequestedAt: Date | null;
};

/**
 * True when CLI, model API, relay registration, command admission, MCP
 * admission and session creation must refuse: a deletion is pending, or a ban
 * is active at `now` (an expired temporary ban no longer refuses).
 */
export function userCredentialAccessBlocked(row: UserDeletionAccessRow, now: Date): boolean {
  return row.deletionRequestedAt != null || isUserBanned(row, now);
}
