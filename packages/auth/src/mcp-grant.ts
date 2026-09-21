import { createHmac } from "node:crypto";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import prisma from "@ws-model-proxy/db";

/**
 * Application-owned MCP grant generation integration (Phase 2).
 *
 * Better Auth owns the OAuth protocol; this module owns the application-side
 * grant generation record (`McpGrant`):
 *
 * - `postLogin.consentReferenceId` derives a fixed-length HMAC reference from
 *   the Better Auth session ID plus the client ID validated inside the signed
 *   `oauth_query` (read via the public `getOAuthProviderState()` API). Neither
 *   postLogin callback receives `clientId` as an argument, so the signed query
 *   is the only validated source. The callback fails closed (throws) when the
 *   reference is underivable — per the upstream option contract, the callback
 *   MUST fail when a reference should exist and cannot be derived.
 * - An OAuth access-token claims extension (the oauth-provider
 *   `extensions[].claims.accessToken` hook) creates the grant only when
 *   absent, reuses it only while active, and REJECTS an existing tombstone on
 *   authorization-code exchange. On refresh it requires the exact existing
 *   grant to remain active. The immutable grant ID is stamped as the private
 *   `mcp_grant_id` JWT claim.
 * - NO custom refresh lease: Better Auth writes cannot join the application's
 *   Prisma transaction and a cached refresh retry can bypass claim hooks. The
 *   authoritative protection is the live grant/tombstone check on `/mcp`
 *   (Phase 4). This module never writes `revokedAt` — only Phase 7's human
 *   revocation sets it, and a tombstone is never cleared here.
 */

/** Private JWT claim carrying the immutable McpGrant row ID. */
export const MCP_GRANT_ID_CLAIM = "mcp_grant_id";

/** Fixed length of the hex HMAC consent reference (SHA-256 → 64 hex chars). */
export const MCP_CONSENT_REFERENCE_LENGTH = 64;

const CONSENT_REFERENCE_DOMAIN = "mcp-consent-reference-v1";

/**
 * Deterministic, fixed-length HMAC reference binding a Better Auth session ID
 * to a signed OAuth client ID. Same (secret, session, client) → same value;
 * any input change → different value. Hex output is URL/DB-safe and never
 * decodable back to the session ID (HMAC is one-way).
 */
export function deriveMcpConsentReferenceId({
  secret,
  sessionId,
  clientId,
}: {
  secret: string;
  sessionId: string;
  clientId: string;
}): string {
  return createHmac("sha256", secret)
    .update(`${CONSENT_REFERENCE_DOMAIN}\0${sessionId}\0${clientId}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Pure grant decision logic (unit-tested without Prisma).
// ---------------------------------------------------------------------------

/** The subset of a Prisma `McpGrant` row this module reasons about. */
export interface McpGrantRecord {
  id: string;
  userId: string;
  clientId: string;
  referenceId: string;
  revokedAt: Date | null;
}

export type McpGrantDecision =
  | { action: "create" }
  | { action: "reuse"; grant: McpGrantRecord }
  | { action: "reject"; reason: McpGrantRejectReason };

export type McpGrantRejectReason =
  | "missing-user"
  | "missing-session"
  | "tombstone"
  | "inactive-on-refresh";

export class McpGrantError extends Error {
  readonly reason: McpGrantRejectReason;
  constructor(reason: McpGrantRejectReason, message: string) {
    super(message);
    this.name = "McpGrantError";
    this.reason = reason;
  }
}

function isMcpGrantRecord(value: unknown): value is McpGrantRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.userId === "string" &&
    typeof row.clientId === "string" &&
    typeof row.referenceId === "string" &&
    (row.revokedAt === null || row.revokedAt instanceof Date)
  );
}

/**
 * Pure decision for the token-issuance grant check.
 *
 * - authorization_code: create when absent, reuse when active, reject a
 *   tombstone (revoked grants are never resurrected, never re-created under
 *   the same reference — only a genuinely new session/reference generation,
 *   i.e. a different referenceId, can authorize after revocation).
 * - refresh_token: require the exact existing grant (unique
 *   userId+clientId+referenceId) to exist and remain active.
 *
 * `existing` must be the row looked up by the exact
 * (userId, clientId, referenceId) unique key, or null.
 */
export function resolveMcpGrantDecision({
  grantType,
  userId,
  referenceId,
  existing,
}: {
  grantType: "authorization_code" | "refresh_token";
  userId: string | undefined;
  referenceId: string | undefined;
  existing: McpGrantRecord | null;
}): McpGrantDecision {
  if (!userId) return { action: "reject", reason: "missing-user" };
  if (!referenceId) return { action: "reject", reason: "missing-session" };

  if (grantType === "authorization_code") {
    if (existing === null) return { action: "create" };
    if (existing.revokedAt === null) return { action: "reuse", grant: existing };
    return { action: "reject", reason: "tombstone" };
  }

  // refresh_token: the grant must already exist and be active.
  if (existing === null) return { action: "reject", reason: "inactive-on-refresh" };
  if (existing.revokedAt !== null) return { action: "reject", reason: "tombstone" };
  return { action: "reuse", grant: existing };
}

// ---------------------------------------------------------------------------
// Prisma-backed claim issuance (the claims extension calls this).
// ---------------------------------------------------------------------------

const GRANT_SELECT = {
  id: true,
  userId: true,
  clientId: true,
  referenceId: true,
  revokedAt: true,
} as const;

/**
 * Sanitized Prisma boundary (invariant 10): a grant-storage failure is
 * logged as ONE line carrying only the operation and the error's constructor
 * name — never the message, meta, query, or params (better-auth's logger
 * forwards errors to console.error and has a special case that logs
 * e.message wholesale for Prisma-shaped "column"/"table"/"relation"/"does not
 * exist" errors). The original error object is then replaced by a fresh
 * generic Error so issuance fails closed without leaking anything analyzable.
 * McpGrantError never crosses this boundary — it is thrown after the Prisma
 * promise resolves, so its distinguishable reason strings survive intact.
 */
async function sanitizedGrantStorage<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(
      `[mcp-grant] ${operation} failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
    );
    throw new Error("MCP grant storage failure");
  }
}

async function findGrantByReference(
  userId: string,
  clientId: string,
  referenceId: string,
): Promise<McpGrantRecord | null> {
  const row = await sanitizedGrantStorage("findGrantByReference", () =>
    prisma.mcpGrant.findUnique({
      where: { userId_clientId_referenceId: { userId, clientId, referenceId } },
      select: GRANT_SELECT,
    }),
  );
  return isMcpGrantRecord(row) ? row : null;
}

/**
 * Grant check + `mcp_grant_id` claim for a token issuance.
 *
 * The AUTHORITATIVE durable reference on every path is the hook-supplied
 * `referenceId` — the very HMAC `postLogin.consentReferenceId` returned at
 * consent time, persisted on the consent/verification record and forwarded
 * by the oauth-provider claims hook at code exchange
 * (`verificationValue.referenceId`), on refresh (`refreshToken.referenceId`),
 * and on opaque-token introspection (`accessToken.referenceId`, sessionId
 * deliberately undefined there). Session derivation is a FALLBACK used only
 * on the authorization_code MINT path when referenceId is absent: upstream
 * requires a live session at exchange, so the derived value equals the
 * consent HMAC there. Refresh and introspection with no referenceId fail
 * closed — there is never a fallback to any other active generation for the
 * user/client (sibling substitution would mint a token under a reference the
 * presenter never demonstrated).
 *
 * - grantType "authorization_code" / "refresh_token": exact-reference
 *   decision (create/reuse/reject per {@link resolveMcpGrantDecision}).
 * - grantType undefined (opaque-token introspection): read-only. Requires
 *   the exact (userId, clientId, referenceId) grant to exist and be active;
 *   never creates; throws otherwise so a tombstoned generation cannot
 *   introspect as valid.
 *
 * Throws {@link McpGrantError} on every reject — failing closed means no
 * token is minted/stamped, not a token without the claim.
 */
export async function issueMcpGrantClaims({
  grantType,
  userId,
  clientId,
  referenceId,
  sessionId,
  secret,
}: {
  grantType: string | undefined;
  userId: string | undefined;
  clientId: string;
  referenceId?: string | undefined;
  sessionId?: string | null | undefined;
  secret: string;
}): Promise<Record<string, unknown>> {
  if (!userId) throw new McpGrantError("missing-user", "MCP grant requires an authenticated user");

  // Authoritative durable reference; the session-derived HMAC is only a
  // mint-time fallback (see the doc comment above).
  const reference =
    referenceId ??
    (grantType === "authorization_code" && sessionId != null
      ? deriveMcpConsentReferenceId({ secret, sessionId, clientId })
      : undefined);
  if (reference === undefined) {
    // Without the durable reference the exact generation is underivable —
    // fail closed rather than guess, and NEVER fall back to an
    // any-active-sibling lookup.
    throw new McpGrantError("missing-session", "MCP grant requires the durable consent reference");
  }

  if (grantType === "authorization_code" || grantType === "refresh_token") {
    const existing = await findGrantByReference(userId, clientId, reference);
    const decision = resolveMcpGrantDecision({
      grantType,
      userId,
      referenceId: reference,
      existing,
    });
    if (decision.action === "reject") {
      throw new McpGrantError(
        decision.reason,
        `MCP grant decision rejected token issuance: ${decision.reason}`,
      );
    }
    if (decision.action === "reuse") {
      return { [MCP_GRANT_ID_CLAIM]: decision.grant.id };
    }
    // create: NEVER writes revokedAt — only Phase 7 revocation sets it.
    const created = await sanitizedGrantStorage("createMcpGrant", () =>
      prisma.mcpGrant.create({
        data: { userId, clientId, referenceId: reference },
        select: GRANT_SELECT,
      }),
    );
    if (!isMcpGrantRecord(created)) {
      throw new McpGrantError("inactive-on-refresh", "MCP grant create returned an invalid row");
    }
    return { [MCP_GRANT_ID_CLAIM]: created.id };
  }

  // Read-only path (introspection, grantType undefined): exact reference,
  // active grant, never create, never substitute a sibling generation.
  const exact = await findGrantByReference(userId, clientId, reference);
  if (exact !== null && exact.revokedAt === null) {
    return { [MCP_GRANT_ID_CLAIM]: exact.id };
  }
  throw new McpGrantError("inactive-on-refresh", "No active MCP grant generation for token claims");
}

// ---------------------------------------------------------------------------
// postLogin integration (consentReferenceId + shouldRedirect).
// ---------------------------------------------------------------------------

/** Minimal structural context the postLogin callbacks need. */
export interface McpPostLoginContext {
  user?: { id?: string | undefined } | undefined;
  session?: { id?: string | undefined } | undefined;
}

/**
 * Read the validated, request-local signed OAuth query via the public
 * `getOAuthProviderState()` API and extract the client ID Better Auth already
 * validated (signature, client existence). Returns null when underivable —
 * including when called outside a request context, where the underlying
 * request-state store throws (treated as "no validated state", not an error:
 * the callers fail closed on null).
 */
export async function validatedClientIdFromOAuthState(): Promise<string | null> {
  let query: string | undefined;
  try {
    const state = await getOAuthProviderState();
    query = state?.query;
  } catch {
    return null;
  }
  if (!query) return null;
  const clientId = new URLSearchParams(query).get("client_id");
  return clientId && clientId.length > 0 ? clientId : null;
}

async function resolveConsentReference({
  context,
  secret,
}: {
  context: McpPostLoginContext;
  secret: string;
}): Promise<string | null> {
  const sessionId = context.session?.id;
  if (!sessionId) return null;
  const clientId = await validatedClientIdFromOAuthState();
  if (!clientId) return null;
  return deriveMcpConsentReferenceId({ secret, sessionId, clientId });
}

/**
 * Tombstone check for the exact (userId, clientId, referenceId) generation.
 * Exported separately so the shouldRedirect decision is unit-testable
 * without a live Better Auth request context.
 */
export async function isMcpGrantGenerationTombstoned({
  userId,
  clientId,
  referenceId,
}: {
  userId: string;
  clientId: string;
  referenceId: string;
}): Promise<boolean> {
  const grant = await findGrantByReference(userId, clientId, referenceId);
  return grant?.revokedAt != null;
}

/**
 * The wired `postLogin` option object consumed by `mcp()` in mcp-plugins.ts.
 * `page` is the localized MCP login route (Phase 6 mounts it); the two
 * callbacks are configured together as the upstream option contract requires.
 */
export function createMcpPostLoginOptions({
  secret,
  loginPage,
}: {
  secret: string;
  loginPage: string;
}) {
  return {
    page: loginPage,
    consentReferenceId: async (context: McpPostLoginContext): Promise<string> => {
      const reference = await resolveConsentReference({ context, secret });
      if (reference === null) {
        // Fail closed: the upstream contract REQUIRES throwing when a
        // reference should exist but cannot be derived.
        throw new Error("MCP consent reference unavailable: session or signed client missing");
      }
      return reference;
    },
    /**
     * Redirect to the post-login page (the MCP login route) exactly when the
     * current session/client grant generation is tombstoned, so Phase 6's
     * authenticated branch can render "Sign in again to reauthorize". When
     * the reference is underivable there is no evidence of a tombstone —
     * return false and let Better Auth's own validation handle the request.
     */
    shouldRedirect: async (context: McpPostLoginContext): Promise<boolean> => {
      const userId = context.user?.id;
      const sessionId = context.session?.id;
      if (!userId || !sessionId) return false;
      const clientId = await validatedClientIdFromOAuthState();
      if (!clientId) return false;
      const referenceId = deriveMcpConsentReferenceId({ secret, sessionId, clientId });
      return isMcpGrantGenerationTombstoned({ userId, clientId, referenceId });
    },
  };
}
