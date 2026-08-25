import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import {
  parseDirectModelId,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { forwarderManagementRouter } from "./forwarder-management";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep(), Prisma: { DbNull: { kind: "DbNull" } } };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  user: {
    findUnique: MockInstance;
    findFirst: MockInstance;
    update: MockInstance;
  };
  discoveredModel: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  appSetting: {
    findUnique: MockInstance;
  };
  modelPool: {
    findMany: MockInstance;
    findUnique: MockInstance;
    create: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  cliDevice: {
    findMany: MockInstance;
    findUnique: MockInstance;
    delete: MockInstance;
  };
  endpoint: {
    findUnique: MockInstance;
    delete: MockInstance;
  };
  poolMember: {
    create: MockInstance;
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  executionTarget: { upsert: MockInstance };
  poolGrant: {
    upsert: MockInstance;
    deleteMany: MockInstance;
    findMany: MockInstance;
  };
};

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
        id: "user-id",
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

function client() {
  return createRouterClient(forwarderManagementRouter, { context: buildContext() });
}

function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pool-id",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    slug: "general",
    name: "General",
    description: null,
    maxAttachmentBytes: null,
    optimisticBasicTranscription: false,
    protocolAdaptationEnabled: false,
    allowLossyDeveloperRoleCollapse: false,
    recommendedSurfaceOverride: null,
    transformerDiscoveredModelId: null,
    transformerSystemPrompt: null,
    transformerImages: true,
    transformerAudio: false,
    transformerVideo: false,
    transformerCacheMode: "OFF",
    TransformerDiscoveredModel: null,
    User: { slug: "owner" },
    PoolMembers: [],
    PoolGrants: [],
    ...overrides,
  };
}

describe("forwarderManagementRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.executionTarget.upsert.mockResolvedValue({ id: "target-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
  });

  it("previews and updates the current user's slug without changing internal ids", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "old-owner" })
      .mockResolvedValueOnce(null);
    db.discoveredModel.findMany.mockResolvedValueOnce([
      {
        id: "model-id",
        upstreamModelId: "org/model 1",
        Endpoint: {
          slug: "local",
          CliDevice: { slug: "desk" },
        },
      },
    ]);
    db.modelPool.findMany.mockResolvedValue([{ id: "pool-id", slug: "general", name: "General" }]);
    db.user.update.mockResolvedValue({ id: "user-id", slug: "new-owner" });

    const result = await client().updateProfileSlug({ slug: "new-owner" });

    expect(result.slug).toBe("new-owner");
    expect(result.preview.affectedModels).toEqual([
      {
        kind: "DIRECT_MODEL",
        id: "model-id",
        upstreamModelId: "org/model 1",
        currentModelId: "old-owner/desk/local/org%2Fmodel%201",
        nextModelId: "new-owner/desk/local/org%2Fmodel%201",
      },
      {
        kind: "MODEL_POOL",
        id: "pool-id",
        name: "General",
        currentModelId: "old-owner/general",
        nextModelId: "new-owner/general",
      },
    ]);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "user-id" },
      data: { slug: "new-owner" },
      select: { id: true, slug: true },
    });
  });

  it.each([
    "ab",
    "a".repeat(64),
    "api",
    "-abc",
    "abc-",
    "abc--def",
    "abc_def",
    "abc def",
    "abc.def",
    "abc/def",
    "Abc",
  ])("rejects invalid or reserved slugs: %s", async (slug) => {
    await expect(client().previewProfileSlugChange({ slug })).rejects.toThrow();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("rejects globally colliding user slugs", async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ id: "user-id", slug: "owner" })
      .mockResolvedValueOnce({ id: "other-user-id" });

    await expect(client().previewProfileSlugChange({ slug: "taken" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("CONFLICT");
        return true;
      },
    );
  });

  it("lists owned CLI metadata with effective capabilities and no endpoint secrets", async () => {
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        slug: "desk",
        label: "Desk",
        status: "CONNECTED",
        lastConnectedAt: new Date("2026-01-01T00:00:00Z"),
        lastDisconnectedAt: null,
        lastHeartbeatAt: new Date("2026-01-01T00:00:30Z"),
        connectionCount: 3,
        User: { slug: "renamed-owner" },
        Endpoints: [
          {
            id: "endpoint-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-02"),
            slug: "local",
            label: "Local",
            kind: "OPENAI_COMPATIBLE",
            status: "ONLINE",
            defaultCapabilities: ["TEXT_GENERATION"],
            capabilityMetadata: { chatCompletions: { supported: true } },
            probeSuggestions: null,
            lastSeenAt: new Date("2026-01-01T00:00:30Z"),
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            baseUrl: "http://127.0.0.1:11434",
            secret: "endpoint-secret",
            DiscoveredModels: [
              {
                id: "model-id",
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-02"),
                slug: null,
                upstreamModelId: "llama",
                encodedModelId: "old-owner/desk/local/llama",
                capabilityOverrideMode: "OVERRIDE",
                capabilityOverrides: ["TEXT_GENERATION", "VISION_INPUT"],
                capabilityOverrideMetadata: { chatCompletions: { vision: true } },
                probeSuggestions: null,
                lastSeenAt: new Date("2026-01-01T00:00:30Z"),
              },
            ],
          },
        ],
      },
    ]);

    const result = await client().listCliDevices();

    expect(result[0]?.endpoints[0]?.models[0]?.effectiveCapabilities).toEqual({
      coarse: ["TEXT_GENERATION", "VISION_INPUT"],
      metadata: { chatCompletions: { vision: true } },
      source: "MODEL_OVERRIDE",
    });
    expect(result[0]?.endpoints[0]?.models[0]?.canonicalModelId).toBe(
      "renamed-owner/desk/local/llama",
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("endpoint-secret");
  });

  it("removes metadata only when the row belongs to the current user", async () => {
    db.cliDevice.findUnique.mockResolvedValue({
      id: "cli-id",
      userId: "other-user-id",
      status: "STALE",
      lastHeartbeatAt: new Date("2026-01-01"),
    });

    await expect(client().removeCliDeviceMetadata({ id: "cli-id" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error.code).toBe("NOT_FOUND");
        return true;
      },
    );
    expect(db.cliDevice.delete).not.toHaveBeenCalled();
  });

  it("creates and updates owned model pools without touching grant ids", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "pool-id",
      userId: "user-id",
    });
    db.modelPool.create.mockResolvedValue(poolRow());
    db.modelPool.update.mockResolvedValue(poolRow({ slug: "new-general" }));

    await expect(
      client().createModelPool({ slug: "general", name: "General" }),
    ).resolves.toMatchObject({
      id: "pool-id",
      canonicalModelId: "owner/general",
    });
    await client().updateModelPool({ id: "pool-id", slug: "new-general", name: "New General" });

    expect(db.modelPool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pool-id" },
        data: { slug: "new-general", name: "New General" },
      }),
    );
    expect(db.poolGrant.deleteMany).not.toHaveBeenCalled();
  });

  it("persists explicit protocol policy and reports the full member compatibility matrix", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(
      poolRow({
        protocolAdaptationEnabled: true,
        allowLossyDeveloperRoleCollapse: true,
        recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
        PoolMembers: [
          {
            id: "member-id",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            discoveredModelId: "model-id",
            weight: 1,
            healthStatus: "HEALTHY",
            routingStatus: "ACTIVE",
            lastFailureClass: null,
            consecutiveRetryableFailures: 0,
            lastFailureAt: null,
            nextRetryAt: null,
            halfOpenTrialStartedAt: null,
            ExecutionTarget: null,
            DiscoveredModel: {
              id: "model-id",
              upstreamModelId: "gpt-local",
              capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
              capabilityOverrides: [],
              capabilityOverrideMetadata: null,
              User: { slug: "owner" },
              Endpoint: {
                id: "endpoint-id",
                slug: "local",
                capabilityMetadata: {
                  version: 1,
                  protocol: "openai-compatible",
                  chatCompletions: { supported: true, streaming: true },
                },
                defaultCapabilities: [],
                CliDevice: { slug: "desktop" },
              },
            },
          },
        ],
      }),
    );

    const result = await client().createModelPool({
      slug: "protocols",
      name: "Protocols",
      protocolAdaptationEnabled: true,
      allowLossyDeveloperRoleCollapse: true,
      recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
    });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: true,
          recommendedSurfaceOverride: "ANTHROPIC_MESSAGES",
        }),
      }),
    );
    expect(result.members[0]?.model?.surfaces).toMatchObject({
      OPENAI_CHAT_COMPLETIONS: { mode: "native", streaming: true },
      OPENAI_RESPONSES: { mode: "adapted" },
      ANTHROPIC_MESSAGES: { mode: "adapted" },
      OPENAI_COMPLETIONS: { mode: "unavailable" },
    });
    expect(result.compatibility).toMatchObject({
      recommendedSurface: "ANTHROPIC_MESSAGES",
      warnings: expect.arrayContaining([
        "adaptation_strict_subset",
        "developer_role_collapse_lossy",
      ]),
    });
  });

  it("defensively clears an invalid stored recommended surface", async () => {
    db.modelPool.findMany.mockResolvedValue([
      poolRow({ recommendedSurfaceOverride: "UNSUPPORTED_FUTURE_SURFACE" }),
    ]);

    const [result] = await client().listModelPools();

    expect(result).toMatchObject({
      recommendedSurfaceOverride: null,
      compatibility: { recommendedSurface: null, warnings: [] },
    });
  });

  it("persists an in-range pool attachment limit and rejects one above the global policy", async () => {
    db.modelPool.findUnique.mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(poolRow({ maxAttachmentBytes: 2 * 1024 * 1024 }));

    await client().createModelPool({
      slug: "limited",
      name: "Limited",
      maxAttachmentBytes: 2 * 1024 * 1024,
    });
    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxAttachmentBytes: 2 * 1024 * 1024 }),
      }),
    );

    await expect(
      client().createModelPool({
        slug: "too-large",
        name: "Too large",
        maxAttachmentBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
  });

  it("allows a direct model attachment limit to inherit and rejects one above global policy", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockResolvedValue({ id: "model-id", maxAttachmentBytes: null });

    await expect(
      client().updateDiscoveredModelAttachmentLimit({ id: "model-id", maxAttachmentBytes: null }),
    ).resolves.toEqual({ id: "model-id", maxAttachmentBytes: null });

    await expect(
      client().updateDiscoveredModelAttachmentLimit({
        id: "model-id",
        maxAttachmentBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
  });

  it("accepts dotted model pool slugs on create and update", async () => {
    db.modelPool.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "pool-id", userId: "user-id" })
      .mockResolvedValueOnce(null);
    db.modelPool.create.mockResolvedValue(poolRow({ slug: "gpt-4.1-mini" }));
    db.modelPool.update.mockResolvedValue(poolRow({ slug: "local.mixtral" }));

    await expect(
      client().createModelPool({ slug: "gpt-4.1-mini", name: "GPT 4.1 Mini" }),
    ).resolves.toMatchObject({
      slug: "gpt-4.1-mini",
      canonicalModelId: "owner/gpt-4.1-mini",
    });
    await client().updateModelPool({ id: "pool-id", slug: "local.mixtral" });

    expect(db.modelPool.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "gpt-4.1-mini" }),
      }),
    );
    expect(db.modelPool.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pool-id" },
        data: { slug: "local.mixtral" },
      }),
    );
  });

  it("rejects slashes in model pool slugs", async () => {
    await expect(
      client().createModelPool({ slug: "openai/gpt-4.1", name: "OpenAI" }),
    ).rejects.toThrow();
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate pool slugs within the same user namespace", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "other-pool-id" });

    await expect(
      client().createModelPool({ slug: "gpt-4.1-mini", name: "Duplicate" }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("CONFLICT");
      return true;
    });
    expect(db.modelPool.create).not.toHaveBeenCalled();
  });

  it("keeps direct model id parsing and non-pool slugs strict", () => {
    expect(validateForwarderSlug("gpt-4.1-mini").ok).toBe(false);
    expect(validateForwarderSlug("openai/gpt-4.1").ok).toBe(false);
    expect(parseDirectModelId("owner/gpt-4.1-mini")).toBeNull();
    expect(parseDirectModelId("owner/desk/local/gpt-4.1-mini")).toEqual({
      userSlug: "owner",
      cliSlug: "desk",
      endpointSlug: "local",
      upstreamModelId: "gpt-4.1-mini",
    });
  });

  it("manages pool members within the owner boundary", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.poolMember.create.mockResolvedValue({ id: "member-id" });
    db.poolMember.findUnique.mockResolvedValue({
      id: "member-id",
      ModelPool: { userId: "user-id" },
    });
    db.poolMember.update.mockResolvedValue({
      id: "member-id",
      weight: 0,
      routingStatus: "DISABLED",
    });

    await expect(
      client().addPoolMember({
        poolId: "pool-id",
        discoveredModelId: "model-id",
        weight: 5,
      }),
    ).resolves.toEqual({ id: "member-id", executionTargetId: "target-id" });
    expect(db.poolMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        poolId: "pool-id",
        discoveredModelId: "model-id",
        executionTargetId: "target-id",
      }),
      select: { id: true },
    });
    await expect(
      client().updatePoolMember({
        id: "member-id",
        weight: 0,
        routingStatus: "DISABLED",
      }),
    ).resolves.toEqual({
      id: "member-id",
      weight: 0,
      routingStatus: "DISABLED",
    });
  });

  it("grants and revokes pool access by exact case-insensitive email without search", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.user.findFirst.mockResolvedValue({ id: "grantee-id" });
    db.poolGrant.upsert.mockResolvedValue({
      id: "grant-id",
      poolId: "pool-id",
      granteeUserId: "grantee-id",
    });
    db.poolGrant.deleteMany.mockResolvedValue({ count: 1 });

    await client().grantPoolAccessByEmail({ poolId: "pool-id", email: "Friend@Example.com" });
    await expect(
      client().revokePoolAccessByEmail({ poolId: "pool-id", email: "friend@example.com" }),
    ).resolves.toEqual({ revokedCount: 1 });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: "Friend@Example.com", mode: "insensitive" } },
      select: { id: true },
    });
    expect(JSON.stringify(db.user.findFirst.mock.calls)).not.toContain("contains");
  });

  it("returns a generic not-found result for unmatched grant emails", async () => {
    db.modelPool.findUnique.mockResolvedValue({ id: "pool-id", userId: "user-id" });
    db.user.findFirst.mockResolvedValue(null);

    await expect(
      client().grantPoolAccessByEmail({ poolId: "pool-id", email: "missing@example.com" }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("User not found.");
      return true;
    });
    expect(db.poolGrant.upsert).not.toHaveBeenCalled();
  });

  it("exposes visible model preview with canonical ids and stable internal ids", async () => {
    db.discoveredModel.findMany
      .mockResolvedValueOnce([
        {
          id: "model-id",
          userId: "user-id",
          upstreamModelId: "gpt/local",
          User: { slug: "owner" },
          Endpoint: {
            id: "endpoint-id",
            slug: "local",
            CliDevice: { slug: "desk" },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "model-id",
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideMetadata: expect.anything(),
          Endpoint: {
            capabilityMetadata: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, vision: true, audio: true, video: true },
            },
          },
        },
      ]);
    db.modelPool.findMany
      .mockResolvedValueOnce([
        {
          id: "pool-id",
          userId: "user-id",
          slug: "general",
          name: "General",
          description: null,
          User: { slug: "owner" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pool-id",
          transformerDiscoveredModelId: null,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
          TransformerDiscoveredModel: null,
        },
        {
          id: "grant-pool-id",
          transformerDiscoveredModelId: null,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
          TransformerDiscoveredModel: null,
        },
      ]);
    db.poolMember.findMany.mockResolvedValue([]);
    db.poolGrant.findMany.mockResolvedValue([
      {
        ModelPool: {
          id: "grant-pool-id",
          userId: "other-user-id",
          slug: "shared",
          name: "Shared",
          description: null,
          User: { slug: "friend" },
        },
      },
    ]);

    await expect(client().visibleModels()).resolves.toEqual({
      directModels: [
        {
          target: "DIRECT_MODEL",
          id: "model-id",
          modelId: "owner/desk/local/gpt%2Flocal",
          upstreamModelId: "gpt/local",
          ownerUserId: "user-id",
          ownerUserSlug: "owner",
          endpointId: "endpoint-id",
          endpointSlug: "local",
          cliDeviceSlug: "desk",
          attachmentModalities: { image: true, audio: true, video: true },
        },
      ],
      modelPools: [
        {
          target: "MODEL_POOL",
          id: "pool-id",
          modelId: "owner/general",
          name: "General",
          description: null,
          ownerUserId: "user-id",
          ownerUserSlug: "owner",
          poolSlug: "general",
          attachmentModalities: { image: false, audio: false, video: false },
        },
        {
          target: "MODEL_POOL",
          id: "grant-pool-id",
          modelId: "friend/shared",
          name: "Shared",
          description: null,
          ownerUserId: "other-user-id",
          ownerUserSlug: "friend",
          poolSlug: "shared",
          attachmentModalities: { image: false, audio: false, video: false },
        },
      ],
    });
  });

  it("stores a complete v2 model override without collapsing false and unknown fields", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockImplementation(async ({ data }: { data: unknown }) => data);

    const capabilities = {
      version: 2 as const,
      protocol: "openai-compatible" as const,
      chatCompletions: { supported: true, audio: false },
      audio: {
        transcriptions: {
          supported: true,
          streaming: false,
          timestampGranularities: ["word", "segment"],
          diarization: true,
          languages: ["en", "es"],
          acceptedMimeTypes: ["audio/wav"],
        },
      },
    };
    await client().setDiscoveredModelCapabilityProfile({
      id: "model-id",
      mode: "override",
      capabilities,
      optimisticBasicTranscription: true,
    });

    expect(db.discoveredModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: ["TEXT_GENERATION", "AUDIO_INPUT"] },
          capabilityOverrideMetadata: capabilities,
          optimisticBasicTranscription: true,
        }),
      }),
    );
  });

  it("switches a model back to endpoint inheritance", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({ id: "model-id", userId: "user-id" });
    db.discoveredModel.update.mockResolvedValue({ id: "model-id" });

    await client().setDiscoveredModelCapabilityProfile({
      id: "model-id",
      mode: "inherit",
      optimisticBasicTranscription: false,
    });

    expect(db.discoveredModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: [] },
          capabilityOverrideMetadata: { kind: "DbNull" },
        }),
      }),
    );
  });
});
