import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
    WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: true,
  },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const { credentialDigest, credentialLookupPrefix } = await import(
  "@ws-model-proxy/db/node-security"
);
const { agentTokenBlockedByPolicy, authenticateAgentToken, isAgentTokenSecret } = await import(
  "./agent-token-access"
);
const { env } = (await import("@ws-model-proxy/env/server")) as unknown as {
  env: { WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: boolean };
};

const SECRET = `wsmp_agent_${"Q".repeat(43)}`;
const NOW = new Date("2026-10-06T12:00:00Z");

function prismaWith(row: Record<string, unknown> | null) {
  return {
    mcpGrant: {
      findFirst: vi.fn(async () => ({
        scopes: ["READ", "FILES"],
        allNodes: false,
        Nodes: [{ nodeId: "node-1" }],
      })),
    },
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
    grant: { userId: "user-1", revokedAt: null },
    secretDigest: credentialDigest("agentToken", SECRET),
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("agent token authentication", () => {
  it("accepts a live token by lookup prefix and digest, with its grant access", async () => {
    const prisma = prismaWith(row());
    await expect(authenticateAgentToken(SECRET, NOW, prisma as never)).resolves.toEqual({
      id: "tok-1",
      userId: "user-1",
      grantId: "grant-1",
      access: { scopes: ["read", "files"], nodeIds: ["node-1"] },
      accessReadAt: expect.any(Number),
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

  describe("while WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY is off", () => {
    it("returns the verified no-expiry token unstamped, judged blocked; once on it is stamped and not blocked", async () => {
      const prisma = prismaWith(row());
      const identity = await authenticateAgentToken(SECRET, NOW, prisma as never, () => false);
      expect(identity).toMatchObject({ id: "tok-1", expiresAt: null });
      expect(prisma.agentToken.updateMany).not.toHaveBeenCalled();
      expect(agentTokenBlockedByPolicy(identity!, () => false)).toBe(true);
      expect(agentTokenBlockedByPolicy(identity!, () => true)).toBe(false);
      await authenticateAgentToken(SECRET, NOW, prisma as never, () => true);
      expect(prisma.agentToken.updateMany).toHaveBeenCalledOnce();
    });

    it("reads the deployment flag at call time by default and fails closed when it is unset", () => {
      const identity = { expiresAt: null };
      try {
        env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = false;
        expect(agentTokenBlockedByPolicy(identity)).toBe(true);
        (env as { WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY?: boolean }).WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY =
          undefined;
        expect(agentTokenBlockedByPolicy(identity)).toBe(true);
        env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = true;
        expect(agentTokenBlockedByPolicy(identity)).toBe(false);
      } finally {
        env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = true;
      }
    });

    it("leaves dated tokens alone", async () => {
      const identity = await authenticateAgentToken(
        SECRET,
        NOW,
        prismaWith(row({ expiresAt: new Date("2026-10-07T00:00:00Z") })) as never,
        () => false,
      );
      expect(identity).toMatchObject({ id: "tok-1" });
      expect(agentTokenBlockedByPolicy(identity!, () => false)).toBe(false);
    });

    it.each([
      ["revoked", row({ revokedAt: new Date("2026-10-01T00:00:00Z") })],
      ["a wrong digest", row({ secretDigest: "0".repeat(64) })],
      ["a revoked grant", row({ grant: { userId: "user-1", revokedAt: new Date() } })],
    ])(
      "still answers a %s no-expiry token with a plain refusal (no policy disclosure)",
      async (_l, stored) => {
        await expect(
          authenticateAgentToken(SECRET, NOW, prismaWith(stored) as never, () => false),
        ).resolves.toBe(null);
      },
    );
  });
});
