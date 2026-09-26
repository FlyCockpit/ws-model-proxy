import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

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
