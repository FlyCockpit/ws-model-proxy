/**
 * Personal-token mint limits shared by the create procedure and the settings
 * form. This module does not import server env, so the browser can load it.
 */

export const MCP_PAT_NAME_MAX_LENGTH = 120;

/**
 * Client-chosen expiry must be strictly in the future and at most this many
 * days from mint. Null expiry is a separate flag, not this cap.
 */
export const MCP_PAT_MAX_TTL_DAYS = 365;

/**
 * Lifetime applied when create omits expiresAt. Exactly 90×24 hours.
 * Explicit null is still no expiry and is not this default.
 */
export const MCP_PAT_DEFAULT_TTL_MS = 90 * 86_400_000;

export function mcpPatOmittedExpiresAt(now: Date): Date {
  return new Date(now.getTime() + MCP_PAT_DEFAULT_TTL_MS);
}

export const MCP_PAT_MAX_TTL_MS = MCP_PAT_MAX_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Submissions stay this far inside the server cap. The server uses a strict
 * greater-than check, so a client clock a few seconds ahead would otherwise
 * fail the exact 365-day preset.
 */
export const MCP_PAT_EXPIRY_CLIENT_SKEW_MS = 60_000;

export const MCP_PAT_NO_EXPIRY_DISABLED_REASON = "mcp_pat_no_expiry_disabled" as const;

/**
 * An existing agent token without expiry, refused while `WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY` is
 * off. The token is kept (not revoked) and works again once the flag is back on.
 */
export const MCP_PAT_NO_EXPIRY_BLOCKED_REASON = "mcp_pat_no_expiry_blocked" as const;

/**
 * True for a no-expiry agent token while the deployment disallows them. Fails closed: only an
 * explicit `allowNoExpiry === true` lets a no-expiry token through.
 */
export function mcpPatBlockedByPolicy(
  expiresAt: Date | string | null,
  allowNoExpiry: boolean | undefined,
): boolean {
  return expiresAt === null && allowNoExpiry !== true;
}

/**
 * Prisma `where` fragment for a live agent token: unrevoked, unexpired, and (while no-expiry
 * tokens are disallowed) dated. The policy is part of the same statement as the row read, so no
 * decision ever pairs a fresh row with an older policy read.
 */
export function liveAgentTokenWhere(now: Date, allowNoExpiry: boolean | undefined) {
  return {
    revokedAt: null,
    OR:
      allowNoExpiry === true
        ? [{ expiresAt: null }, { expiresAt: { gt: now } }]
        : [{ expiresAt: { gt: now } }],
  };
}

export function mcpPatMaxExpiryMs(nowMs: number): number {
  return nowMs + MCP_PAT_MAX_TTL_MS;
}

export function mcpPatClientExpiryCapMs(nowMs: number): number {
  return mcpPatMaxExpiryMs(nowMs) - MCP_PAT_EXPIRY_CLIENT_SKEW_MS;
}

export function mcpPatExpiryRejection(
  expiresAtMs: number,
  nowMs: number,
): "past" | "too_far" | null {
  if (expiresAtMs <= nowMs) return "past";
  if (expiresAtMs > mcpPatMaxExpiryMs(nowMs)) return "too_far";
  return null;
}

export function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/**
 * Last local calendar date whose end-of-day still fits the client cap.
 * End-of-day on today+365 is later than exactly 365×24h for most of the day.
 */
export function latestMcpPatCustomDate(now: Date): Date {
  const capMs = mcpPatClientExpiryCapMs(now.getTime());
  const cap = new Date(capMs);
  if (endOfLocalDay(cap).getTime() <= capMs) {
    return new Date(cap.getFullYear(), cap.getMonth(), cap.getDate());
  }
  return new Date(cap.getFullYear(), cap.getMonth(), cap.getDate() - 1);
}
