import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const { credentialDigest, credentialLookupPrefix } = await import(
  "@ws-model-proxy/db/node-security"
);
const { authenticateAgentToken, isAgentTokenSecret } = await import("./agent-token-access");

const SECRET = `wsmp_agent_${"Q".repeat(43)}`;
const NOW = new Date("2026-10-06T12:00:00Z");

function prismaWith(row: Record<string, unknown> | null) {
  return {
    agentToken: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    userId: "user-1",
    grantId: "grant-1",
    level: "FULL",
    secretDigest: credentialDigest("agentToken", SECRET),
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("agent token authentication", () => {
  it("accepts a live token by lookup prefix and digest, with its level", async () => {
    const prisma = prismaWith(row());
    await expect(authenticateAgentToken(SECRET, NOW, prisma as never)).resolves.toEqual({
      id: "tok-1",
      userId: "user-1",
      grantId: "grant-1",
      level: "FULL",
      expiresAt: null,
    });
    expect(prisma.agentToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lookupPrefix: credentialLookupPrefix(SECRET) } }),
    );
  });

  it.each([
    ["revoked", row({ revokedAt: new Date("2026-10-01T00:00:00Z") })],
    ["expired", row({ expiresAt: new Date("2026-10-06T11:00:00Z") })],
    ["a wrong digest", row({ secretDigest: "0".repeat(64) })],
    ["unknown", null],
  ])("refuses a %s token", async (_label, stored) => {
    await expect(authenticateAgentToken(SECRET, NOW, prismaWith(stored) as never)).resolves.toBe(
      null,
    );
  });

  it("only takes wsmp_agent_ secrets", async () => {
    expect(isAgentTokenSecret(SECRET)).toBe(true);
    expect(isAgentTokenSecret(`wsmp_key_${"Q".repeat(43)}`)).toBe(false);
    const prisma = prismaWith(row());
    await expect(authenticateAgentToken("wsmp_key_x", NOW, prisma as never)).resolves.toBe(null);
    expect(prisma.agentToken.findUnique).not.toHaveBeenCalled();
  });
});
