import { ORPCError } from "@orpc/server";
import { MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS } from "@ws-model-proxy/auth/mcp-config";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";

export type McpPersonalTokenIdentity = {
  id: string;
  userId: string;
  grantId: string;
  scopes: string[];
  expiresAt: Date | null;
  lookupPrefix: string;
  allowCliCommands: boolean;
};

const tokenCredentialSelect = {
  id: true,
  userId: true,
  grantId: true,
  lookupPrefix: true,
  secretDigest: true,
  scopes: true,
  revokedAt: true,
  expiresAt: true,
  allowCliCommands: true,
} satisfies Prisma.McpPersonalTokenSelect;

type TokenCredentialRow = Prisma.McpPersonalTokenGetPayload<{
  select: typeof tokenCredentialSelect;
}>;

/**
 * Full McpPersonalToken row for the settings router: display metadata plus
 * lifecycle timestamps. Deliberately excludes the secret digest, which never
 * leaves the server.
 */
export const mcpPersonalTokenSelection = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  lookupPrefix: true,
  scopes: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  allowCliCommands: true,
} satisfies Prisma.McpPersonalTokenSelect;

export type McpPersonalTokenRow = Prisma.McpPersonalTokenGetPayload<{
  select: typeof mcpPersonalTokenSelection;
}>;

export { activeMcpPersonalTokenWhere } from "./mcp-token-active";

export function digestMcpPersonalTokenSecret(rawSecret: string): string {
  return hmacDigestForForwarderPurpose({ purpose: "mcpToken", value: rawSecret });
}

export function isMcpPersonalTokenSecret(rawSecret: string): boolean {
  return rawSecret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.mcpToken);
}

function isExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  return Boolean(expiresAt && expiresAt <= now);
}

export async function authenticateMcpPersonalToken(
  rawSecret: string,
  now: Date,
): Promise<McpPersonalTokenIdentity | null> {
  if (!isMcpPersonalTokenSecret(rawSecret)) return null;

  const lookupPrefix = credentialLookupPrefix(rawSecret);
  const token: TokenCredentialRow | null = await prisma.mcpPersonalToken.findUnique({
    where: { lookupPrefix },
    select: tokenCredentialSelect,
  });

  if (!token || token.revokedAt !== null || isExpired(token.expiresAt, now)) return null;
  if (
    !verifyForwarderHmacDigest({
      purpose: "mcpToken",
      value: rawSecret,
      digest: token.secretDigest,
    })
  ) {
    return null;
  }

  // Best-effort usage stamping, throttled: only rewrite lastUsedAt when the
  // stored value is null or older than the touch interval, so hot MCP
  // traffic does not write the token row on every request. Matching zero
  // rows (recently stamped) is fine — stamping must never fail admission.
  const threshold = new Date(now.getTime() - MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS);
  await prisma.mcpPersonalToken.updateMany({
    where: { id: token.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }] },
    data: { lastUsedAt: now },
  });

  return {
    id: token.id,
    userId: token.userId,
    grantId: token.grantId,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    lookupPrefix: token.lookupPrefix,
    allowCliCommands: token.allowCliCommands,
  };
}

/**
 * Revokes a personal token and tombstones its McpGrant inside the caller's
 * transaction — /mcp admission treats the grant row as the revocation
 * tombstone, so both must flip together. Ownership is checked in-transaction
 * (no TOCTOU between a pre-check and the write); unknown and foreign token
 * ids are both hidden as NOT_FOUND. Idempotent: an existing token tombstone
 * is never cleared, and the grant update only touches still-live grants.
 */
export async function revokeMcpPersonalTokenById(
  tx: Prisma.TransactionClient,
  { userId, tokenId, now }: { userId: string; tokenId: string; now: Date },
): Promise<McpPersonalTokenRow> {
  const existing = await tx.mcpPersonalToken.findUnique({
    where: { id: tokenId },
    select: { id: true, userId: true, grantId: true, revokedAt: true },
  });
  if (!existing || existing.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "MCP token not found." });
  }

  const updated = await tx.mcpPersonalToken.update({
    where: { id: existing.id },
    data: { revokedAt: existing.revokedAt ?? now },
    select: mcpPersonalTokenSelection,
  });
  await tx.mcpGrant.updateMany({
    where: { id: existing.grantId, userId, revokedAt: null },
    data: { revokedAt: now },
  });
  return updated;
}
