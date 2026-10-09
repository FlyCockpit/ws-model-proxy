import { timingSafeEqual } from "node:crypto";
import { MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS } from "@ws-model-proxy/auth/mcp-config";
import defaultPrisma from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/node-security";
import type { McpLevel } from "./context";

/** A verified, live agent token (`wsmp_agent_…`, minted by a person). */
export type AgentTokenIdentity = {
  id: string;
  userId: string;
  grantId: string;
  level: McpLevel;
  expiresAt: Date | null;
};

export type AgentTokenPrisma = {
  agentToken: Pick<typeof defaultPrisma.agentToken, "findUnique" | "updateMany">;
};

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
 * Revoked, expired and unknown tokens are all `null`. `lastUsedAt` is stamped at most every
 * `MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS` (best effort; never fails admission).
 */
export async function authenticateAgentToken(
  secret: string,
  now: Date,
  prisma: AgentTokenPrisma = defaultPrisma,
): Promise<AgentTokenIdentity | null> {
  if (!isAgentTokenSecret(secret)) return null;
  const token = await prisma.agentToken.findUnique({
    where: { lookupPrefix: credentialLookupPrefix(secret) },
    select: {
      id: true,
      userId: true,
      grantId: true,
      level: true,
      secretDigest: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!token || token.revokedAt !== null) return null;
  if (token.expiresAt !== null && token.expiresAt <= now) return null;
  if (!digestsEqual(credentialDigest("agentToken", secret), token.secretDigest)) return null;
  const threshold = new Date(now.getTime() - MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS);
  try {
    await prisma.agentToken.updateMany({
      where: { id: token.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }] },
      data: { lastUsedAt: now },
    });
  } catch {
    // Usage stamping is informational.
  }
  return {
    id: token.id,
    userId: token.userId,
    grantId: token.grantId,
    level: token.level,
    expiresAt: token.expiresAt,
  };
}
