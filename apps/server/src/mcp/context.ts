import type { ContextServices, Context as ProductionContext } from "@ws-model-proxy/api/context";
import type { CallerAuth } from "@ws-model-proxy/api/contracts";
import type { Session } from "@ws-model-proxy/auth";

/**
 * The oRPC context of one MCP request.
 *
 * MCP requests arrive with a verified agent credential (an agent token or an OAuth access
 * token), not a Better Auth cookie. Procedures check `context.auth` (who is calling, with the
 * credential's level) and read `context.session.user` (the live user row), so the MCP path
 * builds a synthetic session from the verified principal plus the full Prisma user row.
 *
 * SECURITY INVARIANT: the synthetic session never contains the presented credential (or any
 * digest of it). Its `token` field is a fixed marker; its expiry mirrors the credential's.
 *
 * `McpContextSatisfiesProductionContext` (bottom) fails type checking if this shape drifts
 * from the production oRPC `Context`.
 */

/** Fixed marker for the synthetic session's token slot — never a real credential. */
export const MCP_SYNTHETIC_SESSION_TOKEN = "mcp-synthetic-session";

/** The full live user row (never a projection). */
export type McpSessionUser = Session["user"];

/** An agent credential level: READ tokens see the read tools, FULL tokens all 27. */
export type McpLevel = "READ" | "FULL";

/** How a request was admitted (never inferred from a client id). */
export type McpRequestCredential =
  | { kind: "agent_token"; tokenId: string; level: McpLevel; expiresAt: Date | null }
  | { kind: "oauth"; grantId: string; level: McpLevel };

/** The agent `CallerAuth` of a verified MCP credential. */
export type McpCallerAuth = Extract<CallerAuth, { kind: "agent_token" | "oauth_access_token" }>;

export type McpContext = ProductionContext & {
  session: Session;
  auth: McpCallerAuth;
};

export function createMcpSyntheticSession({
  user,
  expiresAt,
  now,
}: {
  user: McpSessionUser;
  expiresAt: Date;
  now: Date;
}): Session {
  return {
    session: {
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

/** The caller identity procedures see for a verified credential. */
export function mcpCallerAuth(userId: string, credential: McpRequestCredential): McpCallerAuth {
  return credential.kind === "agent_token"
    ? { kind: "agent_token", userId, agentTokenId: credential.tokenId, level: credential.level }
    : { kind: "oauth_access_token", userId, grantId: credential.grantId, level: credential.level };
}

/** Build the oRPC context for one verified MCP request. */
export function createMcpContext({
  user,
  credential,
  expiresAt,
  now,
  services,
}: {
  user: McpSessionUser;
  credential: McpRequestCredential;
  expiresAt: Date;
  now: Date;
  services: ContextServices | undefined;
}): McpContext {
  return {
    session: createMcpSyntheticSession({ user, expiresAt, now }),
    auth: mcpCallerAuth(user.id, credential),
    ...(services ? { services } : {}),
  };
}

type AssertAssignable<Base, Derived extends Base> = Derived;
/** Compile-time pin: an MCP context is a production oRPC context. */
export type McpContextSatisfiesProductionContext = AssertAssignable<ProductionContext, McpContext>;
