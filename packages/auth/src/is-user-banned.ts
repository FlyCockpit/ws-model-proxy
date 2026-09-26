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
 *
 * The implementation lives in `@ws-model-proxy/db/user-deletion-access` (the
 * database package cannot depend on this one) so every access gate shares one
 * rule; this module re-exports it.
 */
export { type BannableUser, isUserBanned } from "@ws-model-proxy/db/user-deletion-access";
