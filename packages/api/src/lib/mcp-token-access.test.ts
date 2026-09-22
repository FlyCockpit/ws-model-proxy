import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/forwarder-security";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two",
    BETTER_AUTH_URL: "https://proxy.example.com",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  activeMcpPersonalTokenWhere,
  authenticateMcpPersonalToken,
  digestMcpPersonalTokenSecret,
  isMcpPersonalTokenSecret,
} = await import("./mcp-token-access");

const db = prisma as unknown as {
  mcpPersonalToken: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const NOW = new Date("2026-06-01T00:00:00.000Z");
const RAW = `${PRODUCT_CREDENTIAL_PREFIXES.mcpToken}${"a".repeat(43)}`;

describe("isMcpPersonalTokenSecret", () => {
  it("accepts only the mcp token prefix", () => {
    expect(isMcpPersonalTokenSecret(RAW)).toBe(true);
    expect(
      isMcpPersonalTokenSecret(`${PRODUCT_CREDENTIAL_PREFIXES.cliToken}${"a".repeat(43)}`),
    ).toBe(false);
    expect(isMcpPersonalTokenSecret("eyJhbGciOiJIUzI1NiJ9.aaa.bbb")).toBe(false);
  });
});

describe("activeMcpPersonalTokenWhere", () => {
  it("matches unrevoked tokens with live grants that are not expired", () => {
    expect(activeMcpPersonalTokenWhere("user-1", NOW)).toEqual({
      userId: "user-1",
      revokedAt: null,
      grant: { revokedAt: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
    });
  });
});

describe("authenticateMcpPersonalToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.mcpPersonalToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it("returns null for a non-prefix secret without looking up", async () => {
    await expect(authenticateMcpPersonalToken("not-a-pat", NOW)).resolves.toBeNull();
    expect(db.mcpPersonalToken.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown, revoked, expired, or mismatched secret", async () => {
    db.mcpPersonalToken.findUnique.mockResolvedValue(null);
    await expect(authenticateMcpPersonalToken(RAW, NOW)).resolves.toBeNull();

    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      lookupPrefix: RAW.slice(0, PRODUCT_CREDENTIAL_PREFIXES.mcpToken.length + 12),
      secretDigest: digestMcpPersonalTokenSecret(RAW),
      scopes: ["mcp:read"],
      revokedAt: NOW,
      expiresAt: null,
    });
    await expect(authenticateMcpPersonalToken(RAW, NOW)).resolves.toBeNull();

    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      lookupPrefix: RAW.slice(0, PRODUCT_CREDENTIAL_PREFIXES.mcpToken.length + 12),
      secretDigest: digestMcpPersonalTokenSecret(RAW),
      scopes: ["mcp:read"],
      revokedAt: null,
      expiresAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    await expect(authenticateMcpPersonalToken(RAW, NOW)).resolves.toBeNull();

    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      lookupPrefix: RAW.slice(0, PRODUCT_CREDENTIAL_PREFIXES.mcpToken.length + 12),
      secretDigest: "not-the-digest",
      scopes: ["mcp:read"],
      revokedAt: null,
      expiresAt: null,
    });
    await expect(authenticateMcpPersonalToken(RAW, NOW)).resolves.toBeNull();
    expect(db.mcpPersonalToken.updateMany).not.toHaveBeenCalled();
  });

  it("returns identity and throttled-stamps lastUsedAt for a live matching secret", async () => {
    const lookupPrefix = RAW.slice(0, PRODUCT_CREDENTIAL_PREFIXES.mcpToken.length + 12);
    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      lookupPrefix,
      secretDigest: digestMcpPersonalTokenSecret(RAW),
      scopes: ["mcp:read", "mcp:write"],
      revokedAt: null,
      expiresAt: null,
    });

    await expect(authenticateMcpPersonalToken(RAW, NOW)).resolves.toEqual({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      scopes: ["mcp:read", "mcp:write"],
      expiresAt: null,
      lookupPrefix,
    });
    // Throttled stamp: the where shape makes the DB rewrite only rows whose
    // lastUsedAt is null or older than the touch interval; a zero-row match
    // (recently stamped) still admits the identity.
    expect(db.mcpPersonalToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: "token-1",
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: expect.any(Date) } }],
      },
      data: { lastUsedAt: NOW },
    });
  });
});
