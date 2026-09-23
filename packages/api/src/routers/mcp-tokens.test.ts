import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import { MCP_PAT_NO_EXPIRY_DISABLED_REASON } from "@ws-model-proxy/auth/mcp-pat-limits";
import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/forwarder-security";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const envMock = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-thirty-two",
  BETTER_AUTH_URL: "https://proxy.example.com",
  WMP_MCP_ENABLED: true,
  WMP_MCP_PAT_ALLOW_NO_EXPIRY: true,
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
    allowCliCommands: false,
    ...overrides,
  };
}

describe("mcpTokensRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.WMP_MCP_ENABLED = true;
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = true;
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
        allowCliCommands: false,
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
        allowCliCommands: false,
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

  it("creates a no-expiry token while WMP_MCP_PAT_ALLOW_NO_EXPIRY is on", async () => {
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = true;
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow());
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.create({ name: "Laptop" })).resolves.toMatchObject({
      token: { expiresAt: null },
    });
    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: null }),
      }),
    );
  });

  it("stores a valid future ISO-string expiry as a Date", async () => {
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow());
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await client.create({ name: "Laptop", expiresAt: expiresAt.toISOString() });

    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt }),
      }),
    );
  });

  it("accepts an ISO-string expiry through the RPC wire (RPCLink to RPCHandler)", async () => {
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow());
    // Same loopback shape as the PostgreSQL integration tests: a real RPCLink
    // JSON-encodes the input and a real RPCHandler decodes + validates it,
    // proving the wire form Phase B sends survives the schema.
    const handler = new RPCHandler(mcpTokensRouter);
    const link = new RPCLink({
      url: "http://unit.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context: buildContext() satisfies Context,
        });
        return result.matched ? result.response : new Response(null, { status: 404 });
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof mcpTokensRouter>
    >;

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    db.mcpPersonalToken.create.mockResolvedValue(
      tokenRow({ expiresAt: new Date(expiresAt.toISOString()) }),
    );
    const result = await client.create({ name: "Laptop", expiresAt: expiresAt.toISOString() });

    expect(new Date(result.token.expiresAt).toISOString()).toBe(expiresAt.toISOString());
    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date(expiresAt.toISOString()),
        }),
      }),
    );
  });

  it("also accepts a Date object expiry", async () => {
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow());
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await client.create({ name: "Laptop", expiresAt });

    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt }),
      }),
    );
  });

  it("rejects a past expiry as a field-level validation failure", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(
      client.create({ name: "Laptop", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      expect(JSON.stringify(error.data)).toContain("Expiry must be in the future.");
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an expiry beyond the 365-day cap as a field-level validation failure", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    const beyondCap = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
    await expect(
      client.create({ name: "Laptop", expiresAt: beyondCap.toISOString() }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      expect(JSON.stringify(error.data)).toContain("Expiry must be at most 365 days from now.");
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a no-expiry token while WMP_MCP_PAT_ALLOW_NO_EXPIRY is off", async () => {
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = false;
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.create({ name: "Laptop" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe(
        "No-expiry MCP tokens are disabled on this deployment. Choose an expiry date.",
      );
      expect(error.data).toEqual({ reason: MCP_PAT_NO_EXPIRY_DISABLED_REASON });
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("creates a capped expiry token while WMP_MCP_PAT_ALLOW_NO_EXPIRY is off", async () => {
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = false;
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    db.mcpPersonalToken.create.mockResolvedValue(tokenRow({ expiresAt }));
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(client.create({ name: "Laptop", expiresAt })).resolves.toMatchObject({
      token: { expiresAt },
    });
    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt }),
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

  it("rejects allowCliCommands without write access", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(
      client.create({ name: "Laptop", allowWrite: false, allowCliCommands: true }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      expect(JSON.stringify(error.data)).toContain("CLI commands require write access.");
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("round-trips allowCliCommands on create and list", async () => {
    db.mcpGrant.create.mockResolvedValue({ id: "grant-1" });
    db.mcpPersonalToken.create.mockResolvedValue(
      tokenRow({ scopes: ["mcp:read", "mcp:write"], allowCliCommands: true }),
    );
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    const created = await client.create({
      name: "Laptop Grok",
      allowWrite: true,
      allowCliCommands: true,
    });
    expect(created.token.allowCliCommands).toBe(true);
    expect(db.mcpPersonalToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          allowCliCommands: true,
          scopes: ["mcp:read", "mcp:write"],
        }),
      }),
    );

    db.mcpPersonalToken.findMany.mockResolvedValue([
      tokenRow({ scopes: ["mcp:read", "mcp:write"], allowCliCommands: true }),
    ]);
    await expect(client.listMine()).resolves.toEqual([
      expect.objectContaining({ id: "token-1", allowCliCommands: true }),
    ]);
  });

  it("still refuses a no-expiry token while WMP_MCP_PAT_ALLOW_NO_EXPIRY is off when CLI commands are requested", async () => {
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = false;
    const client = createRouterClient(mcpTokensRouter, { context: buildContext() });
    await expect(
      client.create({ name: "Laptop", allowWrite: true, allowCliCommands: true }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.data).toEqual({ reason: MCP_PAT_NO_EXPIRY_DISABLED_REASON });
      return true;
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("cancels CLI commands after the revoke transaction commits", async () => {
    const events: string[] = [];
    db.$transaction.mockImplementation(async (work: unknown) => {
      events.push("begin");
      const result = await (work as (tx: unknown) => Promise<unknown>)(prisma);
      events.push("commit");
      return result;
    });
    db.mcpPersonalToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      grantId: "grant-1",
      revokedAt: null,
    });
    db.mcpPersonalToken.update.mockResolvedValue(tokenRow({ revokedAt: createdAt }));
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    const cancelMcpTokenCommands = vi.fn(() => {
      events.push("cancel");
    });
    const client = createRouterClient(mcpTokensRouter, {
      context: { ...buildContext(), services: { cancelMcpTokenCommands } },
    });

    await expect(client.revokeMine({ id: "token-1" })).resolves.toMatchObject({
      id: "token-1",
      revokedAt: createdAt,
    });
    expect(cancelMcpTokenCommands).toHaveBeenCalledTimes(1);
    expect(cancelMcpTokenCommands).toHaveBeenCalledWith("token-1");
    expect(events).toEqual(["begin", "commit", "cancel"]);
  });

  it("does not cancel CLI commands when revoke does not commit", async () => {
    const cancelMcpTokenCommands = vi.fn();
    const client = createRouterClient(mcpTokensRouter, {
      context: { ...buildContext(), services: { cancelMcpTokenCommands } },
    });
    await expect(client.revokeMine({ id: "missing" })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      return true;
    });
    expect(cancelMcpTokenCommands).not.toHaveBeenCalled();
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
