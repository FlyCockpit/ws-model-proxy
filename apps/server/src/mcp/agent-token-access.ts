import { timingSafeEqual } from "node:crypto";
import type { AgentAccess } from "@ws-model-proxy/auth/agent-scopes";
import { MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS } from "@ws-model-proxy/auth/mcp-config";
import { readMcpGrantAccess } from "@ws-model-proxy/auth/mcp-grant-access";
import { mcpPatBlockedByPolicy } from "@ws-model-proxy/auth/mcp-pat-limits";
import defaultPrisma from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/node-security";
import { env } from "@ws-model-proxy/env/server";

/** A verified, live agent token (`wsmp_agent_…`, minted by a person). A no-expiry one may
 * still be refused by policy at the MCP handler's final fence. */
export type AgentTokenIdentity = {
  id: string;
  userId: string;
  grantId: string;
  access: AgentAccess;
  accessReadAt: number;
  expiresAt: Date | null;
};

export type AgentTokenPrisma = {
  mcpGrant: typeof defaultPrisma.mcpGrant;
  agentToken: Pick<typeof defaultPrisma.agentToken, "findUnique" | "updateMany">;
};

/**
 * True when this verified token has no expiry and the deployment currently disallows
 * no-expiry tokens. Synchronous: the MCP handler calls it at its final admission fence, after
 * the grant re-read and the owner checks, right before the transport, so no later await is
 * trusted and a revoked token or blocked owner gets its ordinary refusal first.
 */
export function agentTokenBlockedByPolicy(
  identity: Pick<AgentTokenIdentity, "expiresAt">,
  allowNoExpiry: () => boolean | undefined = () => env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY,
): boolean {
  return mcpPatBlockedByPolicy(identity.expiresAt, allowNoExpiry());
}

export function isAgentTokenSecret(secret: string): boolean {
  return secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.agentToken);
}

function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Looks the token up by its lookup prefix and checks the purpose HMAC in constant time.
 * Revoked, expired and unknown tokens are all `null`. A no-expiry token is returned even while
 * the deployment disallows them: the MCP handler refuses it with a typed 401 at its final fence
 * (`agentTokenBlockedByPolicy`). Such a token is not stamped as used. `lastUsedAt` is stamped at
 * most every `MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS` (best effort; never fails admission).
 */
export async function authenticateAgentToken(
  secret: string,
  now: Date,
  prisma: AgentTokenPrisma = defaultPrisma,
  allowNoExpiry: () => boolean | undefined = () => env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY,
): Promise<AgentTokenIdentity | null> {
  if (!isAgentTokenSecret(secret)) return null;
  const token = await prisma.agentToken.findUnique({
    where: { lookupPrefix: credentialLookupPrefix(secret) },
    select: {
      id: true,
      userId: true,
      grantId: true,
      grant: { select: { revokedAt: true, userId: true } },
      secretDigest: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!token || token.revokedAt !== null) return null;
  if (token.expiresAt !== null && token.expiresAt <= now) return null;
  if (!digestsEqual(credentialDigest("agentToken", secret), token.secretDigest)) return null;
  if (token.grant.revokedAt !== null || token.grant.userId !== token.userId) return null;
  const accessReadAt = performance.now();
  const access = await readMcpGrantAccess(prisma, token.grantId);
  if (!access) return null;
  // A token the policy blocks is not stamped as used; the refusal is decided by the caller.
  if (!agentTokenBlockedByPolicy(token, allowNoExpiry)) {
    const threshold = new Date(now.getTime() - MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS);
    try {
      await prisma.agentToken.updateMany({
        where: { id: token.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }] },
        data: { lastUsedAt: now },
      });
    } catch {
      // Usage stamping is informational.
    }
  }
  return {
    id: token.id,
    userId: token.userId,
    grantId: token.grantId,
    access,
    accessReadAt,
    expiresAt: token.expiresAt,
  };
}
