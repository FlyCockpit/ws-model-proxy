import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/forwarder-security";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const envMock = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two",
  BETTER_AUTH_URL: "https://proxy.example.com",
  WMP_MCP_ENABLED: true,
}));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: envMock,
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { mcpTokensRouter } = await import("./mcp-tokens");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  mcpPersonalToken: {
    findMany: MockInstance;
    findUnique: MockInstance;
    count: MockInstance;
    create: MockInstance;
    update: MockInstance;
  };
  mcpGrant: {
    create: MockInstance;
    updateMany: MockInstance;
  };
  appSetting: { findUnique: MockInstance };
  $transaction: MockInstance;
};

const createdAt = new Date("2026-07-01T00:00:00.000Z");

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  return {
    session: {
      user: {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt,
        updatedAt: createdAt,
        ...sessionOverride?.user,
      },
      session: {
        id: "session-1",
        userId: sessionOverride?.user?.id ?? "user-1",
        token: "session-token",
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt,
        updatedAt: createdAt,
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "token-1",
    createdAt,
    updatedAt: createdAt,
    name: "Laptop Grok",
    lookupPrefix: "wsmp_mcp_abcdefghijkl",
    scopes: ["mcp:read"],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("mcpTokensRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.WMP_MCP_ENABLED = true;
    db.appSetting.findUnique.mockResolvedValue(null);
    db.mcpPersonalToken.findMany.mockResolvedValue([]);
    db.mcpPersonalToken.findUnique.mockResolvedValue(null);
    db.mcpPersonalToken.count.mockResolvedValue(0);
    db.$transaction.mockImplementation(async (work: unknown) =>
      (work as (tx: unknown) => Promise<unknown>)(prisma),
    );
  });

  it("requires authentication", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: buildContext(null) });
    await expect(client.listMine()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("UNAUTHORIZED");
      return true;
    });
  });

  it("lists only the signed-in user's active tokens by default", async () => {
    db.mcpPersonalToken.findMany.mockResolvedValue([tokenRow()]);
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.listMine()).resolves.toEqual([
      {
        id: "token-1",
        createdAt,
        updatedAt: createdAt,
        name: "Laptop Grok",
        lookupPrefix: "wsmp_mcp_abcdefghijkl",
        scopes: ["mcp:read"],
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    expect(db.mcpPersonalToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          revokedAt: null,
          grant: { revokedAt: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      }),
    );
  });

  it("returns the full history when includeRevoked is set", async () => {
    db.mcpPersonalToken.findMany.mockResolvedValue([tokenRow({ revokedAt: createdAt })]);
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.listMine({ includeRevoked: true })).resolves.toEqual([
      {
        id: "token-1",
        createdAt,
        updatedAt: createdAt,
        name: "Laptop Grok",
        lookupPrefix: "wsmp_mcp_abcdefghijkl",
        scopes: ["mcp:read"],
        lastUsedAt: null,
        revokedAt: createdAt,
        expiresAt: null,
      },
    ]);
    expect(db.mcpPersonalToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
      }),
    );
  });

  it("refuses to create tokens while MCP is disabled", async () => {
    envMock.WMP_MCP_ENABLED = false;
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.create({ name: "Laptop" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("creates a hashed token bound to a new grant generation and returns the secret once", async () => {
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow({ scopes: ["mcp:read", "mcp:write"] }));
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    const result = await client.create({ name: "Laptop Grok", allowWrite: true });

    expect(result.secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.mcpToken)).toBe(true);
    expect(result.token.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(JSON.stringify(db.mcpPersonalToken.create.mock.calls)).not.toContain(result.secret);
    expect(db.mcpPersonalToken.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          revokedAt: null,
          grant: { revokedAt: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      }),
    );
    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Laptop Grok",
          scopes: ["mcp:read", "mcp:write"],
          expiresAt: null,
        }),
      }),
    );
    expect(db.mcpGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          clientId: expect.stringMatching(/^pat:[0-9a-f]{32}$/),
          referenceId: "pat",
        }),
      }),
    );
  });

  it("rejects creating past the active-token cap without writing anything", async () => {
    db.mcpPersonalToken.count.mockResolvedValue(10);
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });

    await expect(client.create({ name: "Laptop" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("CONFLICT");
      return true;
    });
    expect(db.mcpPersonalToken.count).toHaveBeenCalledTimes(1);
    expect(db.mcpGrant.create).not.toHaveBeenCalled();
    expect(db.mcpPersonalToken.create).not.toHaveBeenCalled();
  });

  it("revokes the token and tombstones its grant without clearing an existing tombstone", async () => {
    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      revokedAt: createdAt,
    });
    db.mcpPersonalToken.update.mockResolvedValue(tokenRow({ revokedAt: createdAt }));
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });

    await expect(client.revokeMine({ id: "token-1" })).resolves.toMatchObject({
      id: "token-1",
      revokedAt: createdAt,
    });
    expect(db.mcpPersonalToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "token-1" },
        data: { revokedAt: createdAt },
      }),
    );
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant-1", userId: "user-1", revokedAt: null },
      }),
    );
  });

  it("hides foreign tokens as not found without writing anything", async () => {
    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "other-user",
      grantId: "grant-1",
      revokedAt: null,
    });
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.revokeMine({ id: "token-1" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });
    expect(db.mcpPersonalToken.update).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("hides unknown tokens as not found without writing anything", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.revokeMine({ id: "missing" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });
    expect(db.mcpPersonalToken.update).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
});
