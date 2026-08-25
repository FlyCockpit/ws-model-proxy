import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const envMock = { enabled: false };
const egressMock = vi.hoisted(() => ({ request: vi.fn() }));
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
vi.mock("../lib/provider-egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-egress")>()),
  providerHttpsRequest: egressMock.request,
}));

const { providerManagementRouter } = await import("./provider-management");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  providerAccount: {
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  providerModel: {
    create: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  executionTarget: { create: MockInstance };
  modelPool: { findFirst: MockInstance };
  providerCredential: {
    count: MockInstance;
    create: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
  };
  providerAuditEvent: { create: MockInstance; findMany: MockInstance };
  providerBudgetPolicy: {
    create: MockInstance;
    findMany: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
  };
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
    egressMock.request.mockReset();
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

  it("rechecks the locked account inside createModel and loses a race with account deletion", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createModel({
        providerAccountId: "deleted-account",
        upstreamModelId: "model",
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("locks the owning account first and denies updateModel after account deletion", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateModel({ id: "model", enabled: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.providerAccount.findFirst).not.toHaveBeenCalled();
  });

  it("denies a budget policy whose model is deleted or belongs to another account", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(
      client.createBudgetPolicy({
        scopeType: "POOL_PROVIDER_MODEL",
        providerAccountId: "account",
        providerModelId: "foreign-or-deleted-model",
        poolId: "pool",
        active: false,
        rules: [
          {
            metric: "CONCURRENCY",
            period: "PER_ATTEMPT",
            mode: "LIMITED",
            limitValue: "1",
            currency: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerModel.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "foreign-or-deleted-model",
        userId: "owner",
        providerAccountId: "account",
        deletedAt: null,
      }),
      select: { id: true },
    });
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
    expect(db.providerBudgetPolicy.create).not.toHaveBeenCalled();
  });

  it("audits an explicit UNLIMITED choice with only safe rule identity", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([{ id: "account" }]);
    db.providerAccount.findFirst.mockResolvedValue({ id: "account" });
    db.providerBudgetPolicy.create.mockResolvedValue({ id: "policy", Rules: [] });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await client.createBudgetPolicy({
      scopeType: "PROVIDER_ACCOUNT",
      providerAccountId: "account",
      providerModelId: null,
      poolId: null,
      active: true,
      rules: [
        {
          metric: "CONCURRENCY",
          period: "PER_ATTEMPT",
          mode: "UNLIMITED",
          limitValue: null,
          currency: null,
        },
      ],
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        providerAccountId: "account",
        action: "BUDGET_CREATED",
        subjectId: "policy",
        metadata: {
          unlimitedRules: [{ metric: "CONCURRENCY", period: "PER_ATTEMPT" }],
        },
      },
    });
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
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.providerCredential.count).toHaveBeenCalledWith({
      where: { userId: "owner", providerAccountId: "account" },
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it("rechecks updateAccount ownership and liveness after locking", async () => {
    envMock.enabled = true;
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateAccount({ id: "deleted", label: "changed" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("conditionally updates a live account and emits exactly one audit", async () => {
    envMock.enabled = true;
    db.providerAccount.findFirst
      .mockResolvedValueOnce({
        id: "account",
        userId: "owner",
        authType: "BEARER",
        baseUrl: "https://old.example",
      })
      .mockResolvedValueOnce({ id: "account", label: "changed" });
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.updateAccount({ id: "account", label: "changed" })).resolves.toEqual({
      id: "account",
      label: "changed",
    });
    expect(db.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "account", userId: "owner", deletedAt: null } }),
    );
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
  });

  it("locks account then model and audits deleteModel exactly once", async () => {
    envMock.enabled = true;
    db.providerModel.findFirst.mockResolvedValue({
      id: "model",
      userId: "owner",
      providerAccountId: "account",
      deletedAt: null,
    });
    db.providerModel.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.deleteModel({ id: "model" })).resolves.toEqual({ success: true });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.providerModel.updateMany).toHaveBeenCalledWith({
      where: {
        id: "model",
        userId: "owner",
        providerAccountId: "account",
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date), enabled: false },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
  });

  it("does not duplicate deleteModel writes or audits after deletion", async () => {
    envMock.enabled = true;
    db.providerModel.findFirst.mockResolvedValue(null);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.deleteModel({ id: "model" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerModel.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("serializes credential revocation against replacement and remains idempotent", async () => {
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
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it.each(["REVOKED", "REPLACED"])(
    "refuses rotation when a concurrent operation has made the credential %s",
    async () => {
      envMock.enabled = true;
      db.providerCredential.findFirst
        .mockResolvedValueOnce({ id: "credential", providerAccountId: "account" })
        .mockResolvedValueOnce(null);
      db.$queryRaw.mockResolvedValue([{ id: "locked" }]);
      const client = createRouterClient(providerManagementRouter, { context });
      await expect(client.rotateCredential({ id: "credential" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(db.$queryRaw).toHaveBeenCalledTimes(2);
      expect(db.providerCredential.updateMany).not.toHaveBeenCalled();
      expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
    },
  );

  it("hides budget policies owned by soft-deleted provider accounts", async () => {
    envMock.enabled = true;
    db.providerBudgetPolicy.findMany.mockResolvedValue([]);
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.listBudgetPolicies()).resolves.toEqual([]);
    expect(db.providerBudgetPolicy.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", ProviderAccount: { deletedAt: null } },
      include: { Rules: true },
    });
  });

  it("audits successful and failed credential tests without secrets or endpoint data", async () => {
    envMock.enabled = true;
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const identity = {
      userId: "owner",
      providerAccountId: "account",
      credentialId: "credential",
      credentialType: "BEARER" as const,
      aadVersion: 1,
    };
    const encrypted = encryptProviderCredential(
      "super-secret-value",
      identity,
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    db.providerCredential.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    egressMock.request.mockResolvedValue({ statusCode: 204, resume: vi.fn() });
    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.testCredential({ providerAccountId: "account" })).resolves.toEqual({
      ok: true,
      statusCode: 204,
    });
    const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(audit.data).toMatchObject({
      action: "CREDENTIAL_TESTED",
      subjectId: "credential",
      metadata: { outcome: "SUCCESS", statusCode: 204 },
    });
    expect(JSON.stringify(audit)).not.toContain("super-secret-value");
    expect(JSON.stringify(audit)).not.toContain("provider.example");
    expect(egressMock.request).toHaveBeenLastCalledWith(
      "https://provider.example/v1",
      { method: "GET", headers: { accept: "application/json" } },
      expect.objectContaining({ egressEnabled: true }),
      "openai",
      { type: "BEARER", token: "super-secret-value" },
    );

    egressMock.request.mockRejectedValueOnce(new Error("provider.example super-secret-value"));
    await expect(client.testCredential({ providerAccountId: "account" })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Provider request failed",
    });
    const failedAudit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(failedAudit.data.metadata).toEqual({ outcome: "FAILURE", statusCode: null });
    expect(JSON.stringify(failedAudit)).not.toContain("super-secret-value");
    expect(JSON.stringify(failedAudit)).not.toContain("provider.example");
  });

  it("records a successful test exactly once when revocation wins during egress", async () => {
    envMock.enabled = true;
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const encrypted = encryptProviderCredential(
      "concurrent-secret",
      {
        userId: "owner",
        providerAccountId: "account",
        credentialId: "credential",
        credentialType: "BEARER",
        aadVersion: 1,
      },
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "account",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openai",
      baseUrl: "https://provider.example/v1",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    // The request selected an active credential, but revokeCredential committed
    // before the post-egress transaction acquired its lifecycle locks.
    db.providerCredential.updateMany.mockResolvedValue({ count: 0 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
    egressMock.request.mockResolvedValue({ statusCode: 204, resume: vi.fn() });

    const client = createRouterClient(providerManagementRouter, { context });
    await expect(client.testCredential({ providerAccountId: "account" })).resolves.toEqual({
      ok: true,
      statusCode: 204,
    });

    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.providerCredential.updateMany).toHaveBeenCalledWith({
      where: { id: "credential", userId: "owner", status: "ACTIVE" },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledOnce();
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        providerAccountId: "account",
        action: "CREDENTIAL_TESTED",
        subjectId: "credential",
        metadata: { outcome: "SUCCESS", statusCode: 204 },
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  });
});
