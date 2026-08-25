import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const envMock = { enabled: false };
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return envMock.enabled;
    },
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    default: mockDeep(),
    Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  };
});

const { providerManagementRouter } = await import("./provider-management");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  providerAccount: {
    findMany: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  providerCredential: {
    count: MockInstance;
    create: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
  };
  providerAuditEvent: { create: MockInstance; findMany: MockInstance };
};

const session = {
  user: {
    id: "owner",
    email: "owner@example.com",
    name: "Owner",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
    image: null,
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "session",
    userId: "owner",
    token: "token",
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
} as Session;
const context: Context = { session };

describe("providerManagementRouter security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.enabled = false;
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
  });

  it("is hidden by default for authenticated callers and still requires authentication", async () => {
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const anonymous = createRouterClient(providerManagementRouter, { context: { session: null } });
    await expect(anonymous.listAccounts()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.providerAccount.findMany).not.toHaveBeenCalled();
  });

  it("enforces the same disabled gate through the HTTP RPC transport", async () => {
    const handler = new RPCHandler(providerManagementRouter);
    const link = new RPCLink({
      url: "https://example.test/rpc",
      fetch: async (request, init) => {
        const result = await handler.handle(new Request(request, init), {
          prefix: "/rpc",
          context,
        });
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as ReturnType<
      typeof createRouterClient<typeof providerManagementRouter>
    >;
    await expect(client.listAccounts()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.findMany).not.toHaveBeenCalled();
  });

  it("owner-scopes audit history and never returns credential envelopes", async () => {
    envMock.enabled = true;
    db.providerAuditEvent.findMany.mockResolvedValue([
      { id: "audit", action: "CREDENTIAL_CREATED" },
    ]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listAuditEvents({ limit: 25 })).resolves.toEqual([
      { id: "audit", action: "CREDENTIAL_CREATED" },
    ]);
    expect(db.providerAuditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner" },
        select: expect.not.objectContaining({ ciphertext: true, nonce: true, authTag: true }),
      }),
    );
  });

  it("serializes credential creation on the account and never reflects plaintext", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      authType: "BEARER",
      currentCredentialId: null,
    });
    db.providerCredential.create.mockResolvedValue({
      id: "credential",
      createdAt: new Date(0),
      credentialType: "BEARER",
      keyVersion: "v1",
      displaySuffix: "alue",
      status: "ACTIVE",
    });
    db.providerAccount.update.mockResolvedValue({ id: "account" });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    const result = await client.createCredential({
      providerAccountId: "account",
      credential: "super-secret-value",
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    const write = db.providerCredential.create.mock.calls[0]?.[0];
    expect(JSON.stringify(write)).not.toContain("super-secret-value");
    expect(write.data.ciphertext).toBeInstanceOf(Uint8Array);
  });

  it("requires credential cleanup before an authentication-type change", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      authType: "BEARER",
    });
    db.providerCredential.count.mockResolvedValue(1);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.updateAccount({ id: "account", authType: "API_KEY" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("makes credential revocation idempotent without duplicate audit events", async () => {
    envMock.enabled = true;
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      userId: "owner",
      providerAccountId: "account",
      status: "REVOKED",
      ProviderAccount: { deletedAt: null },
    });
    db.providerCredential.updateMany.mockResolvedValue({ count: 0 });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.revokeCredential({ id: "credential" })).resolves.toEqual({ success: true });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });
});
