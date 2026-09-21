import type { ContextServices, Context as ProductionContext } from "@ws-model-proxy/api/context";
import type { Session } from "@ws-model-proxy/auth";

/**
 * Synthetic oRPC context for MCP requests (Phase 4 item 8).
 *
 * MCP requests arrive with a VERIFIED access JWT, not a Better Auth cookie
 * session. The tools (Phase 5) call oRPC procedures through
 * `createRouterClient(appRouter, { context })`, and ownership checks read
 * `context.session.user.id` — so the MCP path builds a SYNTHETIC session
 * from the verified claims plus the live FULL Prisma user row.
 *
 * CONTRACT (F4, Part F pass 2): the synthetic session is explicitly
 * COMPATIBLE with the production oRPC `Context`
 * (packages/api/src/context.ts → Better Auth `$Infer.Session`) — the
 * session/user shapes are derived FROM those types (not re-declared), and
 * the type-level assertion at the bottom of this file fails `pnpm
 * check-types` if the two ever drift apart. Constructing the context from
 * the production types (no casts) is what makes that guarantee real.
 *
 * SECURITY INVARIANT (load-bearing): the synthetic session NEVER contains
 * the presented access token (or any digest of it). Its `token` field is a
 * fixed synthetic marker; the expiry mirrors the token's `exp` claim so
 * downstream freshness logic sees a horizon consistent with the credential.
 * Pinned by tests: the serialized session must not contain the token bytes.
 *
 * The services object is the SAME `ContextServices` used by the normal
 * server path (`packages/api/src/context.ts` → `repairExpiredProviderBudgets`
 * injected by app.ts) — MCP must not fork the server's dependency surface.
 */

/** Fixed marker for the synthetic session's token slot — never a real credential. */
export const MCP_SYNTHETIC_SESSION_TOKEN = "mcp-synthetic-session";

/**
 * The user carried by the synthetic session: the FULL user row of the
 * production `Session` type (invariant 5 — mcp/auth.ts loads the complete
 * live Prisma user, never a projection).
 */
export type McpSessionUser = Session["user"];

/** The synthetic session shape: exactly the production `Session` shape. */
export type McpSyntheticSession = Session;

/** The per-request MCP context handed to Phase 5's router client. */
export interface McpContext {
  session: McpSyntheticSession;
  services: ContextServices | undefined;
}

/**
 * Build the synthetic session. `user` must be the LIVE full Prisma row
 * loaded by requireMcpAuth after the ban/2FA checks (never trust
 * JWT-embedded profile claims). `expiresAt` is the access token's `exp`
 * claim as a Date; `now` stamps the synthetic row's audit timestamps.
 */
export function createMcpSyntheticSession({
  user,
  expiresAt,
  now,
}: {
  user: McpSessionUser;
  expiresAt: Date;
  now: Date;
}): McpSyntheticSession {
  return {
    session: {
      // Session id is the VERIFIED user id with an `mcp:` marker — it
      // identifies the principal, never a cookie-session row (there is
      // none), and never carries token material.
      id: `mcp:${user.id}`,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      token: MCP_SYNTHETIC_SESSION_TOKEN,
      ipAddress: null,
      userAgent: null,
      impersonatedBy: null,
    },
    user: { ...user },
  };
}

/** Build the oRPC-shaped context for one MCP request. */
export function createMcpContext({
  user,
  expiresAt,
  now,
  services,
}: {
  user: McpSessionUser;
  expiresAt: Date;
  now: Date;
  services: ContextServices | undefined;
}): McpContext {
  return {
    session: createMcpSyntheticSession({ user, expiresAt, now }),
    services,
  };
}

// ---------------------------------------------------------------------------
// Type-level contract assertion (F4) — runs in normal `pnpm check-types`.
//
// `McpContext` must remain assignable to the production oRPC `Context` so
// Phase 5's `createRouterClient(appRouter, { context })` accepts it without
// casts. The generic constraint fails to compile the moment the synthetic
// shape drifts from the production one (missing session timestamps, missing
// user fields, incompatible services).
// ---------------------------------------------------------------------------

type AssertAssignable<Base, Derived extends Base> = Derived;
export type McpContextSatisfiesProductionContext = AssertAssignable<ProductionContext, McpContext>;
