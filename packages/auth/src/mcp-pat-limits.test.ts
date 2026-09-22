import * as viaSubpath from "@ws-model-proxy/auth/mcp-pat-limits";
import { describe, expect, it } from "vitest";
import {
  endOfLocalDay,
  latestMcpPatCustomDate,
  MCP_PAT_EXPIRY_CLIENT_SKEW_MS,
  MCP_PAT_MAX_TTL_DAYS,
  MCP_PAT_MAX_TTL_MS,
  MCP_PAT_NAME_MAX_LENGTH,
  mcpPatClientExpiryCapMs,
  mcpPatExpiryRejection,
  mcpPatMaxExpiryMs,
} from "./mcp-pat-limits";

describe("MCP personal-token expiry bounds", () => {
  it("publishes the shared name and TTL limits", () => {
    expect(MCP_PAT_NAME_MAX_LENGTH).toBe(120);
    expect(MCP_PAT_MAX_TTL_DAYS).toBe(365);
    expect(MCP_PAT_MAX_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(MCP_PAT_EXPIRY_CLIENT_SKEW_MS).toBe(60_000);
    expect(viaSubpath.MCP_PAT_MAX_TTL_DAYS).toBe(MCP_PAT_MAX_TTL_DAYS);
  });

  it("accepts the client cap and the exact server cap, and rejects one millisecond past it", () => {
    const now = 1_700_000_000_000;
    expect(mcpPatExpiryRejection(mcpPatClientExpiryCapMs(now), now)).toBeNull();
    expect(mcpPatExpiryRejection(mcpPatMaxExpiryMs(now), now)).toBeNull();
    expect(mcpPatExpiryRejection(mcpPatMaxExpiryMs(now) + 1, now)).toBe("too_far");
    expect(mcpPatExpiryRejection(now, now)).toBe("past");
  });

  it("does not offer a custom date whose end-of-day is past the server cap", () => {
    const now = new Date(2026, 8, 21, 10, 0, 0, 0);
    const naiveMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 365);
    expect(mcpPatExpiryRejection(endOfLocalDay(naiveMax).getTime(), now.getTime())).toBe("too_far");

    const latest = latestMcpPatCustomDate(now);
    const end = endOfLocalDay(latest);
    expect(latest.getTime()).toBeLessThan(naiveMax.getTime());
    expect(end.getTime()).toBeLessThanOrEqual(mcpPatClientExpiryCapMs(now.getTime()));
    expect(mcpPatExpiryRejection(end.getTime(), now.getTime())).toBeNull();

    const next = new Date(latest.getFullYear(), latest.getMonth(), latest.getDate() + 1);
    expect(endOfLocalDay(next).getTime()).toBeGreaterThan(mcpPatClientExpiryCapMs(now.getTime()));
  });
});
