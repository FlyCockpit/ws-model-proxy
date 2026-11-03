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

import type { Prisma } from "../prisma/generated/client";

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

/** Every owner field `poolOwnerActive` reads; values may be null, keys may not be missing. */
export type PoolOwnerAccessRow = {
  banned: boolean | null;
  banExpires: Date | null;
  deletionRequestedAt: Date | null;
};

/**
 * Whether a pool owner's account is active (#76, decided 2026-09-28): while
 * the owner's ban is active or a deletion is pending, the owner's pools are
 * unavailable to everyone. Every field is required so that a select which
 * omits one is a type error rather than a silently active owner.
 */
export function poolOwnerActive(owner: PoolOwnerAccessRow, now: Date): boolean {
  return !userCredentialAccessBlocked(owner, now);
}

// ── The same rules as Prisma filters ──
//
// Queries that pick users (or rows through a user relation) in the database must apply exactly
// the predicates above, boundary included: a ban whose expiry is EXACTLY `now` is still active.
// Every such filter is built here so the in-memory and SQL forms cannot drift apart.

/** Users whose ban is active at `now` (the SQL form of {@link isUserBanned}). */
export function userBanActiveWhere(now: Date) {
  return {
    banned: true,
    OR: [{ banExpires: null }, { banExpires: { gte: now } }],
  } satisfies Prisma.UserWhereInput;
}

/** Users whose ban is NOT active at `now`: never banned, unbanned, or an expired ban. */
export function userBanInactiveWhere(now: Date) {
  return {
    OR: [{ banned: null }, { banned: false }, { banExpires: { lt: now } }],
  } satisfies Prisma.UserWhereInput;
}

/**
 * Users whose access is blocked at `now` (the SQL form of {@link userCredentialAccessBlocked}):
 * a deletion is pending, or a ban is active.
 */
export function userAccessBlockedWhere(now: Date) {
  return {
    OR: [{ deletionRequestedAt: { not: null } }, userBanActiveWhere(now)],
  } satisfies Prisma.UserWhereInput;
}

/**
 * Users whose access is active at `now` (the SQL form of `!userCredentialAccessBlocked`): no
 * deletion pending and no active ban. Spread it into a where (it sets `deletionRequestedAt` and
 * `OR`), or nest it under `AND` when the where has its own `OR`.
 */
export function userAccessActiveWhere(now: Date) {
  return {
    deletionRequestedAt: null,
    ...userBanInactiveWhere(now),
  } satisfies Prisma.UserWhereInput;
}
