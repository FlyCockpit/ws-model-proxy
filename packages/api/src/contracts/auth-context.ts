/**
 * Who is calling: the discriminant every procedure's access check reads (review #8). S0c adds
 * it to `packages/api/src/context.ts` as `Context.auth`; every transport fills it from the
 * credential it actually verified, never from a header the caller chose.
 *
 * - `cookie_session`: a Better Auth session cookie on `/rpc`. `csrfVerified` is true ONLY when
 *   the request carried an `x-csrf-token` header that the server validated against the session
 *   (double-submit check in `apps/server/src/csrf-policy.ts`). CORS or an Origin check alone
 *   never sets it. The RPC layer requires that header for every procedure in
 *   `CSRF_REQUIRED_PROCEDURES` (every `human`/`human_admin` procedure, queries included) on
 *   every deployment shape, same-origin or not; the set is derived from the contract's access
 *   tags, never kept by hand.
 * - `agent_token`, `oauth_access_token`: an MCP call (`/mcp`), with the token's level.
 * - `api_key`: `/v1` only; never reaches a procedure.
 *
 * Rules (a positive check, not "no agent marker"):
 * - `human` / `human_admin`: `kind === "cookie_session" && csrfVerified` (plus admin role).
 * - `session` / `admin`: `kind === "cookie_session"`; `/rpc` accepts no other credential, so
 *   these procedures are unreachable for tokens even if routed by mistake.
 * - `agent`: a cookie session (the web app) or an MCP token whose tool names the procedure.
 *   Agent-only refusals (Relay-only nodes, `restartRunning` skips, `profile_apply` refused whole)
 *   apply unless `isHumanCaller(auth)`: a cookie whose CSRF check failed is NOT a person
 *   (`agentRulesApply`). The preview fingerprint (D13) is required exactly when
 *   `isHumanCaller(auth)`.
 * - `public`: any.
 */
import type { ProcedureAccess } from "./procedure";

export const CALLER_KINDS = [
  "cookie_session",
  "agent_token",
  "oauth_access_token",
  "api_key",
] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

export type CallerAuth =
  | { kind: "cookie_session"; userId: string; sessionId: string; csrfVerified: boolean }
  | { kind: "agent_token"; userId: string; agentTokenId: string; level: "READ" | "FULL" }
  | { kind: "oauth_access_token"; userId: string; grantId: string; level: "READ" | "FULL" }
  | { kind: "api_key"; userId: string; apiKeyId: string };

export type AnonymousAuth = { kind: "anonymous" };

export function isHumanCaller(auth: CallerAuth | AnonymousAuth): boolean {
  return auth.kind === "cookie_session" && auth.csrfVerified;
}

export function isAgentCaller(auth: CallerAuth | AnonymousAuth): boolean {
  return auth.kind === "agent_token" || auth.kind === "oauth_access_token";
}

/** Whether a caller may reach a procedure of this access level at all (role checks aside). */
export function callerMayReach(access: ProcedureAccess, auth: CallerAuth | AnonymousAuth): boolean {
  switch (access) {
    case "public":
      return true;
    case "session":
    case "admin":
      return auth.kind === "cookie_session";
    case "human":
    case "human_admin":
      return isHumanCaller(auth);
    case "agent":
      return auth.kind === "cookie_session" || isAgentCaller(auth);
  }
}

/** Agent-only refusals and agent defaults apply to everyone who is not a verified person. */
export function agentRulesApply(auth: CallerAuth | AnonymousAuth): boolean {
  return !isHumanCaller(auth);
}
