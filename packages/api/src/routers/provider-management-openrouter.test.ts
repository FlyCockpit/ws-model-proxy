import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const egressMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/provider-egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-egress")>()),
  providerHttpsRequest: egressMock.request,
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
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
  providerAccount: { create: MockInstance; findFirst: MockInstance };
  providerModel: { create: MockInstance };
  providerCredential: { findFirst: MockInstance; updateMany: MockInstance };
  providerAuditEvent: { create: MockInstance };
};

const context: Context = {
  session: {
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
  } as Session,
};
const client = () => createRouterClient(providerManagementRouter, { context });

const surface = { source: "dashboard", confidence: "exact", operations: ["create"] } as const;
const modelInput = (surfaces: Record<string, unknown>) => ({
  providerAccountId: "acct",
  upstreamModelId: "qwen/qwen3-coder",
  nativeCapabilities: { version: 4, protocol: "openai-compatible", surfaces },
});

describe("OpenRouter provider type in provider management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.providerAccount.findFirst.mockResolvedValue({ id: "acct", providerType: "openrouter" });
    db.providerModel.create.mockResolvedValue({ id: "pm" });
    db.providerAccount.create.mockResolvedValue({ id: "acct" });
  });

  it("accepts an OpenRouter account on the preset base URL", async () => {
    await client().createAccount({
      providerType: "OpenRouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api",
      authType: "BEARER",
    });
    expect(db.providerAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerType: "openrouter",
          baseUrl: "https://openrouter.ai/api",
        }),
      }),
    );
  });

  it("accepts a Chat Completions inventory", async () => {
    await client().createModel(modelInput({ openaiChatCompletions: surface }));
    expect(db.providerModel.create).toHaveBeenCalled();
  });

  it("rejects Responses on OpenRouter, which is not claimed", async () => {
    await expect(
      client().createModel(
        modelInput({ openaiChatCompletions: surface, openaiResponses: surface }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });

  it("rejects legacy inventories that could claim surfaces through old fields", async () => {
    await expect(
      client().createModel({
        providerAccountId: "acct",
        upstreamModelId: "qwen/qwen3-coder",
        nativeCapabilities: {
          version: 1,
          protocol: "openai-compatible",
          responses: { supported: true },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });
});

describe("OpenRouter credential test", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const encrypted = encryptProviderCredential(
      "sk-or-secret",
      {
        userId: "owner",
        providerAccountId: "acct",
        credentialId: "credential",
        credentialType: "BEARER",
        aadVersion: 1,
      },
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "acct",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType: "openrouter",
      baseUrl: "https://openrouter.ai/api",
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "acct",
      credentialType: "BEARER",
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
    db.providerCredential.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
  });

  // The API root answers 404 with or without a key, so probing it could never
  // succeed; /v1/key answers 401 for a bad key.
  it("probes the authenticated key endpoint on the account's base URL", async () => {
    egressMock.request.mockResolvedValue({ statusCode: 200, resume: vi.fn() });
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
      ok: true,
      statusCode: 200,
    });
    expect(egressMock.request).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      { method: "GET", headers: { accept: "application/json" } },
      expect.objectContaining({ egressEnabled: true }),
      "openai",
      { type: "BEARER", token: "sk-or-secret" },
    );
    expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      action: "CREDENTIAL_TESTED",
      metadata: { outcome: "SUCCESS", statusCode: 200 },
    });
  });

  it("reports an invalid key as a failed test", async () => {
    egressMock.request.mockResolvedValue({ statusCode: 401, resume: vi.fn() });
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
      ok: false,
      statusCode: 401,
    });
    expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      metadata: { outcome: "FAILURE", statusCode: 401 },
    });
  });
});
