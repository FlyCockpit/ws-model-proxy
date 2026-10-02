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
  providerAccount: {
    create: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
  };
  providerCredential: { findFirst: MockInstance; updateMany: MockInstance; count: MockInstance };
  providerModel: { create: MockInstance; findMany: MockInstance };
  $queryRaw: MockInstance;
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
/** The synthetic session MCP tool calls run with (apps/server/src/mcp/context.ts). */
const mcpClient = () =>
  createRouterClient(providerManagementRouter, {
    context: {
      session: { ...context.session!, session: { ...context.session!.session, id: "mcp:owner" } },
    } as Context,
  });

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

  it("accepts Responses and Messages on OpenRouter", async () => {
    await client().createModel(
      modelInput({ openaiChatCompletions: surface, openaiResponses: surface }),
    );
    expect(db.providerModel.create).toHaveBeenCalled();
    db.providerModel.create.mockClear();
    await client().createModel(
      modelInput({
        openaiChatCompletions: surface,
        anthropicMessages: {
          ...surface,
          protocolVersions: [{ version: "2023-06-01" }],
        },
      }),
    );
    expect(db.providerModel.create).toHaveBeenCalled();
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

describe("OpenRouter data-collection setting (D9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
  });

  it("is off by default and a person can allow it, with an audit event", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce({ id: "acct", providerType: "openrouter", allowDataCollection: false })
      .mockResolvedValueOnce({ id: "acct", allowDataCollection: true });
    await expect(
      client().setAllowDataCollection({ id: "acct", allowDataCollection: true }),
    ).resolves.toMatchObject({ allowDataCollection: true });
    expect(db.providerAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "acct", userId: "owner", deletedAt: null },
      data: { allowDataCollection: true },
    });
    expect(db.providerAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "ACCOUNT_UPDATED",
        subjectId: "acct",
        metadata: { allowDataCollection: true },
      }),
    });
  });

  it("applies only to OpenRouter accounts", async () => {
    db.providerAccount.findFirst.mockResolvedValueOnce({
      id: "acct",
      providerType: "openai",
      allowDataCollection: false,
    });
    await expect(
      client().setAllowDataCollection({ id: "acct", allowDataCollection: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
  });

  it("is owner-scoped: another user's account is NOT_FOUND", async () => {
    db.providerAccount.findFirst.mockResolvedValueOnce(null);
    await expect(
      client().setAllowDataCollection({ id: "foreign", allowDataCollection: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "foreign", userId: "owner", deletedAt: null } }),
    );
  });

  it("the general account update ignores the field and a type change resets it", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce({
        id: "acct",
        providerType: "openrouter",
        baseUrl: "https://openrouter.ai/api",
        authType: "BEARER",
        allowDataCollection: true,
      })
      .mockResolvedValueOnce({ id: "acct" });
    db.providerModel.findMany.mockResolvedValue([]);
    await client().updateAccount({
      id: "acct",
      providerType: "openai-compatible",
      allowDataCollection: true,
    } as { id: string; providerType: string });
    const call = db.providerAccount.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.allowDataCollection).toBe(false);
    expect(call.data.providerType).toBe("openai-compatible");
  });
});

describe("OpenRouter account type changes and legacy spellings (D9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.$queryRaw.mockResolvedValue([]);
    db.providerAccount.updateMany.mockResolvedValue({ count: 1 });
    db.providerModel.findMany.mockResolvedValue([]);
  });

  const openRouterAccount = (providerType = "openrouter") => ({
    id: "acct",
    providerType,
    baseUrl: "https://openrouter.ai/api",
    authType: "BEARER",
    allowDataCollection: false,
  });

  it.each(["openrouter", "OpenRouter "])(
    "MCP may not move a %j account to another type (it would drop the deny)",
    async (current) => {
      db.providerAccount.findFirst.mockResolvedValueOnce(openRouterAccount(current));
      await expect(
        mcpClient().updateAccount({ id: "acct", providerType: "openai-compatible" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(db.providerAccount.updateMany).not.toHaveBeenCalled();
    },
  );

  it("MCP may still edit other fields and keep the OpenRouter type", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce(openRouterAccount("OpenRouter"))
      .mockResolvedValueOnce({ id: "acct" });
    await mcpClient().updateAccount({ id: "acct", providerType: "openrouter", label: "Renamed" });
    const call = db.providerAccount.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.label).toBe("Renamed");
    // A spelling normalization is not a type change: nothing is reset.
    expect(call.data.allowDataCollection).toBeUndefined();
  });

  it("MCP may change the type of a non-OpenRouter account", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce({ ...openRouterAccount("openai"), baseUrl: "https://api.example" })
      .mockResolvedValueOnce({ id: "acct" });
    await mcpClient().updateAccount({ id: "acct", providerType: "openai-compatible" });
    expect(db.providerAccount.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a person may still move an OpenRouter account to another type (the opt-out resets)", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce(openRouterAccount())
      .mockResolvedValueOnce({ id: "acct" });
    await client().updateAccount({ id: "acct", providerType: "openai-compatible" });
    const call = db.providerAccount.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.allowDataCollection).toBe(false);
  });

  it("a legacy non-normalized OpenRouter row can use the opt-out", async () => {
    db.providerAccount.findFirst
      .mockResolvedValueOnce({ id: "acct", providerType: "OpenRouter", allowDataCollection: false })
      .mockResolvedValueOnce({ id: "acct", allowDataCollection: true });
    await expect(
      client().setAllowDataCollection({ id: "acct", allowDataCollection: true }),
    ).resolves.toMatchObject({ allowDataCollection: true });
    expect(db.providerAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { allowDataCollection: true } }),
    );
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
      outcome: "SUCCESS",
      statusCode: 200,
      reason: null,
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

  it("reports an invalid key as a rejected credential", async () => {
    egressMock.request.mockResolvedValue({ statusCode: 401, resume: vi.fn() });
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
      ok: false,
      outcome: "FAILURE",
      statusCode: 401,
      reason: "INVALID_CREDENTIAL",
    });
    expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      metadata: { outcome: "FAILURE", statusCode: 401, reason: "INVALID_CREDENTIAL" },
    });
  });
});

// OpenAI's API root answers 421 and Anthropic's 404 with or without a key, so
// probing the base URL reported valid keys as failures.
describe("OpenAI and Anthropic credential tests", () => {
  const secret = "sk-direct-secret";

  async function arrange(
    providerType: "openai" | "anthropic",
    baseUrl: string,
    credentialType: "BEARER" | "API_KEY",
  ) {
    const { encryptProviderCredential, parseProviderCredentialKeyring } = await import(
      "../lib/provider-credential-crypto"
    );
    const encrypted = encryptProviderCredential(
      secret,
      {
        userId: "owner",
        providerAccountId: "acct",
        credentialId: "credential",
        credentialType,
        aadVersion: 1,
      },
      parseProviderCredentialKeyring("v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    db.providerAccount.findFirst.mockResolvedValue({
      id: "acct",
      userId: "owner",
      deletedAt: null,
      currentCredentialId: "credential",
      providerType,
      baseUrl,
    });
    db.providerCredential.findFirst.mockResolvedValue({
      id: "credential",
      providerAccountId: "acct",
      credentialType,
      aadVersion: 1,
      status: "ACTIVE",
      ...encrypted,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.providerCredential.updateMany.mockResolvedValue({ count: 1 });
    db.providerAuditEvent.create.mockResolvedValue({ id: "audit" });
  });

  it.each(["https://api.openai.com", "https://api.openai.com/v1"])(
    "probes OpenAI's Bearer-authenticated model list for base %s",
    async (baseUrl) => {
      await arrange("openai", baseUrl, "BEARER");
      egressMock.request.mockResolvedValue({ statusCode: 200, resume: vi.fn() });
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: true,
        outcome: "SUCCESS",
        statusCode: 200,
        reason: null,
      });
      expect(egressMock.request).toHaveBeenCalledWith(
        "https://api.openai.com/v1/models",
        { method: "GET", headers: { accept: "application/json" } },
        expect.objectContaining({ egressEnabled: true }),
        "openai",
        { type: "BEARER", token: secret },
      );
      expect(db.providerAuditEvent.create.mock.calls.at(-1)?.[0].data).toMatchObject({
        metadata: { outcome: "SUCCESS", statusCode: 200 },
      });
    },
  );

  it("probes Anthropic's model list with x-api-key and anthropic-version", async () => {
    await arrange("anthropic", "https://api.anthropic.com", "API_KEY");
    egressMock.request.mockResolvedValue({ statusCode: 200, resume: vi.fn() });
    await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toMatchObject({
      ok: true,
    });
    expect(egressMock.request).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      {
        method: "GET",
        headers: { accept: "application/json", "anthropic-version": "2023-06-01" },
      },
      expect.objectContaining({ egressEnabled: true }),
      "anthropic",
      { type: "API_KEY", apiKey: secret },
    );
  });

  it.each([
    [401, "FAILURE", "INVALID_CREDENTIAL"],
    // A 403 may only mean the key cannot list models (restricted key).
    [403, "INCONCLUSIVE", "INSUFFICIENT_PERMISSION"],
    [404, "FAILURE", "UNEXPECTED_STATUS"],
    [421, "FAILURE", "UNEXPECTED_STATUS"],
    [500, "FAILURE", "UNEXPECTED_STATUS"],
  ] as const)(
    "classifies status %s as %s/%s without leaking the key",
    async (status, outcome, reason) => {
      await arrange("anthropic", "https://api.anthropic.com", "API_KEY");
      egressMock.request.mockResolvedValue({ statusCode: status, resume: vi.fn() });
      await expect(client().testCredential({ providerAccountId: "acct" })).resolves.toEqual({
        ok: false,
        outcome,
        statusCode: status,
        reason,
      });
      const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
      expect(audit.data.metadata).toEqual({ outcome, statusCode: status, reason });
      expect(JSON.stringify(audit)).not.toContain(secret);
    },
  );

  it("reports a transport failure or timeout as a redacted BAD_GATEWAY", async () => {
    await arrange("openai", "https://api.openai.com", "BEARER");
    egressMock.request.mockRejectedValueOnce(new Error(`timeout ${secret}`));
    await expect(client().testCredential({ providerAccountId: "acct" })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "Provider request failed",
    });
    const audit = db.providerAuditEvent.create.mock.calls.at(-1)?.[0];
    expect(audit.data.metadata).toEqual({
      outcome: "FAILURE",
      statusCode: null,
      reason: "REQUEST_FAILED",
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });
});
