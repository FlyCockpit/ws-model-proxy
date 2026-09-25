import type { Prisma } from "@ws-model-proxy/db";

/**
 * Where-clause for a user's ACTIVE personal tokens — token and grant both
 * unrevoked, and not yet expired (null expiry = lives until revoked). Shared
 * by listMine, the create-path active-token cap, and the relay's live
 * re-check when it admits a CLI command, so they can't drift.
 */
export function activeMcpPersonalTokenWhere(
  userId: string,
  now: Date,
): Prisma.McpPersonalTokenWhereInput {
  return {
    userId,
    revokedAt: null,
    grant: { revokedAt: null },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}
