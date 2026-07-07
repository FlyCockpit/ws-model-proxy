import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { adminObservabilityRouter } from "./admin-observability";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
  ADMIN_EMAILS: new Set<string>(),
}));

const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  appSetting: {
    findUnique: MockInstance;
  };
  cliDevice: {
    count: MockInstance;
    findMany: MockInstance;
  };
  endpoint: {
    count: MockInstance;
    findMany: MockInstance;
  };
  discoveredModel: {
    count: MockInstance;
    findMany: MockInstance;
  };
  modelPool: {
    count: MockInstance;
    findMany: MockInstance;
  };
  relayRequest: {
    count: MockInstance;
    findMany: MockInstance;
    groupBy: MockInstance;
    aggregate: MockInstance;
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
        id: "admin-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "admin-id",
        token: "session-token",
        expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

function client(context = buildContext()) {
  return createRouterClient(adminObservabilityRouter, { context });
}

function owner() {
  return {
    id: "owner-id",
    email: "owner@example.com",
    name: "Owner",
    slug: "owner",
  };
}

describe("adminObservabilityRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.cliDevice.count.mockResolvedValue(0);
    db.cliDevice.findMany.mockResolvedValue([]);
    db.endpoint.count.mockResolvedValue(0);
    db.endpoint.findMany.mockResolvedValue([]);
    db.discoveredModel.count.mockResolvedValue(0);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.modelPool.count.mockResolvedValue(0);
    db.modelPool.findMany.mockResolvedValue([]);
    db.relayRequest.count.mockResolvedValue(0);
    db.relayRequest.findMany.mockResolvedValue([]);
    db.relayRequest.groupBy.mockResolvedValue([]);
    db.relayRequest.aggregate.mockResolvedValue({
      _avg: { durationMs: null },
      _min: { durationMs: null },
      _max: { durationMs: null },
      _sum: { promptTokens: null, completionTokens: null, totalTokens: null },
    });
  });

  it("denies every global observability procedure to non-admin users", async () => {
    const nonAdmin = client(buildContext({ user: { role: "user" } }));

    await expect(nonAdmin.listCliDevices()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
    await expect(nonAdmin.listEndpoints()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
    await expect(nonAdmin.listModels()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
    await expect(nonAdmin.listPools()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
    await expect(nonAdmin.listRelayMetadataSummaries()).rejects.toSatisfy((error: ORPCError) => {
      expect(error.code).toBe("FORBIDDEN");
      return true;
    });
  });

  it("lists global CLI metadata with owner identity and without token digests", async () => {
    db.cliDevice.count.mockResolvedValue(1);
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-id",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        slug: "desk",
        label: "Desk",
        status: "CONNECTED",
        lastConnectedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastDisconnectedAt: null,
        lastHeartbeatAt: new Date(Date.now()),
        connectionCount: 4,
        User: owner(),
        secretDigest: "cli-token-digest",
        lookupPrefix: "wsmp_cli_secret",
        _count: { Endpoints: 2, CliTokens: 3, CliDeviceCredentials: 1 },
      },
    ]);

    const result = await client().listCliDevices({
      ownerQuery: "owner",
      status: "CONNECTED",
      page: 2,
      pageSize: 10,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "cli-id",
      owner: owner(),
      slug: "desk",
      status: "CONNECTED",
      endpointCount: 2,
      cliTokenCount: 3,
      credentialCount: 1,
    });
    expect(db.cliDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("cli-token-digest");
    expect(serialized).not.toContain("wsmp_cli_secret");
  });

  it("redacts endpoint secret-shaped fields while preserving safe capability metadata", async () => {
    db.endpoint.count.mockResolvedValue(1);
    db.endpoint.findMany.mockResolvedValue([
      {
        id: "endpoint-id",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        slug: "local",
        label: "Local",
        kind: "OPENAI_COMPATIBLE",
        status: "ONLINE",
        defaultCapabilities: ["TEXT_GENERATION", "VISION_INPUT"],
        capabilityMetadata: { chatCompletions: { supported: true } },
        probeSuggestions: { responses: { supported: false } },
        lastSeenAt: new Date("2026-01-01T00:01:00.000Z"),
        lastHealthCheckAt: new Date("2026-01-01T00:01:00.000Z"),
        statusChangedAt: null,
        failureReasonCode: null,
        baseUrl: "http://127.0.0.1:11434",
        upstreamAuthorizationHeader: "Bearer endpoint-secret",
        User: owner(),
        CliDevice: {
          id: "cli-id",
          slug: "desk",
          label: "Desk",
          status: "CONNECTED",
          lastHeartbeatAt: new Date(Date.now()),
        },
        _count: { DiscoveredModels: 2 },
      },
    ]);

    const result = await client().listEndpoints({ status: "ONLINE" });

    expect(result.items[0]?.defaultCapabilities).toEqual(["TEXT_GENERATION", "VISION_INPUT"]);
    expect(result.items[0]?.capabilityMetadata).toEqual({
      chatCompletions: { supported: true },
    });
    expect(result.items[0]?.discoveredModelCount).toBe(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("endpoint-secret");
  });

  it("returns effective model capability summaries and applies capability filters", async () => {
    db.discoveredModel.count.mockResolvedValue(1);
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: "model-id",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        slug: null,
        upstreamModelId: "llama/vision",
        encodedModelId: "old-canonical-id",
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrides: ["TEXT_GENERATION", "VISION_INPUT"],
        capabilityOverrideMetadata: { vision: { supported: true } },
        probeSuggestions: null,
        lastSeenAt: new Date("2026-01-01T00:01:00.000Z"),
        User: owner(),
        Endpoint: {
          id: "endpoint-id",
          slug: "local",
          label: "Local",
          status: "ONLINE",
          defaultCapabilities: ["TEXT_GENERATION"],
          capabilityMetadata: { text: true },
          CliDevice: {
            id: "cli-id",
            slug: "desk",
            label: "Desk",
            status: "CONNECTED",
            lastHeartbeatAt: new Date(Date.now()),
          },
        },
        _count: { PoolMembers: 1 },
      },
    ]);

    const result = await client().listModels({ capabilityFamily: "VISION" });

    expect(result.items[0]?.canonicalModelId).toBe("owner/desk/local/llama%2Fvision");
    expect(result.items[0]?.effectiveCapabilities).toEqual({
      coarse: ["TEXT_GENERATION", "VISION_INPUT"],
      metadata: { vision: { supported: true } },
      source: "MODEL_OVERRIDE",
    });
    expect(db.discoveredModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ capabilityOverrides: { has: "VISION_INPUT" } }),
          ]),
        }),
      }),
    );
  });

  it("matches both audio input and output capabilities for the audio family filter", async () => {
    await client().listModels({ capabilityFamily: "AUDIO" });

    expect(db.discoveredModel.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ capabilityOverrides: { has: "AUDIO_INPUT" } }),
          expect.objectContaining({ capabilityOverrides: { has: "AUDIO_OUTPUT" } }),
          expect.objectContaining({
            Endpoint: { is: { defaultCapabilities: { has: "AUDIO_INPUT" } } },
          }),
          expect.objectContaining({
            Endpoint: { is: { defaultCapabilities: { has: "AUDIO_OUTPUT" } } },
          }),
        ]),
      }),
    });
  });

  it("lists pools with member health metadata and filters by member health", async () => {
    db.modelPool.count.mockResolvedValue(1);
    db.modelPool.findMany.mockResolvedValue([
      {
        id: "pool-id",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        slug: "general",
        name: "General",
        description: null,
        User: owner(),
        PoolMembers: [
          {
            id: "member-id",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:01:00.000Z"),
            discoveredModelId: "model-id",
            weight: 2,
            healthStatus: "DEGRADED",
            routingStatus: "ACTIVE",
            lastFailureClass: "UPSTREAM_5XX",
            consecutiveRetryableFailures: 2,
            lastFailureAt: new Date("2026-01-01T00:01:00.000Z"),
            nextRetryAt: null,
            halfOpenTrialStartedAt: null,
            lastRoutedAt: new Date("2026-01-01T00:00:30.000Z"),
            DiscoveredModel: {
              id: "model-id",
              upstreamModelId: "llama",
              User: { slug: "owner" },
              Endpoint: {
                id: "endpoint-id",
                slug: "local",
                label: "Local",
                status: "DEGRADED",
                CliDevice: {
                  id: "cli-id",
                  slug: "desk",
                  label: "Desk",
                  status: "CONNECTED",
                  lastHeartbeatAt: new Date(Date.now()),
                },
              },
            },
          },
        ],
        _count: { PoolGrants: 1, ModelApiTokenAllowlistEntries: 2 },
      },
    ]);

    const result = await client().listPools({ memberHealth: "DEGRADED" });

    expect(result.items[0]).toMatchObject({
      canonicalModelId: "owner/general",
      grantCount: 1,
      allowlistEntryCount: 2,
    });
    expect(result.items[0]?.members[0]).toMatchObject({
      healthStatus: "DEGRADED",
      routingStatus: "ACTIVE",
      lastFailureClass: "UPSTREAM_5XX",
      model: { canonicalModelId: "owner/desk/local/llama" },
    });
    expect(db.modelPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          PoolMembers: { some: { healthStatus: "DEGRADED" } },
        }),
      }),
    );
  });

  it("lists relay metadata summaries without request, response, provider, or stickiness material", async () => {
    db.relayRequest.count.mockResolvedValue(1);
    db.relayRequest.groupBy
      .mockResolvedValueOnce([{ status: "SUCCEEDED", _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ errorClass: null, _count: { _all: 1 } }]);
    db.relayRequest.aggregate.mockResolvedValue({
      _avg: { durationMs: 1200 },
      _min: { durationMs: 1200 },
      _max: { durationMs: 1200 },
      _sum: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    });
    db.relayRequest.findMany.mockResolvedValue([
      {
        id: "relay-id",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        modelApiTokenId: "token-id",
        modelApiTokenLookupPrefix: "wsmp_model_abcd",
        status: "SUCCEEDED",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:01.200Z"),
        durationMs: 1200,
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        httpStatusCode: 200,
        upstreamStatusCode: 200,
        errorClass: null,
        requestBody: "secret prompt",
        responseBody: "secret completion",
        providerResponseId: "resp_secret_provider_id",
        routingKeyDigest: "sticky-secret-digest",
        imageBytes: "data:image/png;base64,secret",
        User: owner(),
        ModelApiToken: {
          id: "token-id",
          name: "Production key",
          lookupPrefix: "wsmp_model_abcd",
          secretDigest: "token-secret-digest",
        },
        RequestedDiscoveredModel: {
          id: "model-id",
          upstreamModelId: "llama",
          User: { slug: "owner" },
          Endpoint: { slug: "local", CliDevice: { slug: "desk" } },
        },
        RequestedModelPool: null,
        SelectedDiscoveredModel: {
          id: "model-id",
          upstreamModelId: "llama",
          User: { slug: "owner" },
          Endpoint: { slug: "local", CliDevice: { slug: "desk" } },
        },
      },
    ]);

    const createdAfter = new Date("2026-01-01T00:00:00.000Z");
    const result = await client().listRelayMetadataSummaries({
      status: "SUCCEEDED",
      createdAfter,
    });

    expect(result.items[0]).toMatchObject({
      id: "relay-id",
      owner: owner(),
      modelApiToken: {
        id: "token-id",
        name: "Production key",
        lookupPrefix: "wsmp_model_abcd",
      },
      requestedModel: { canonicalModelId: "owner/desk/local/llama" },
      selectedModel: { canonicalModelId: "owner/desk/local/llama" },
      status: "SUCCEEDED",
      durationMs: 1200,
      totalTokens: 8,
    });
    expect(result.summary).toEqual({
      statusCounts: [{ status: "SUCCEEDED", count: 1 }],
      errorClassCounts: [{ errorClass: null, count: 1 }],
      durationMs: { average: 1200, minimum: 1200, maximum: 1200 },
      tokens: { prompt: 3, completion: 5, total: 8 },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret completion");
    expect(serialized).not.toContain("resp_secret_provider_id");
    expect(serialized).not.toContain("sticky-secret-digest");
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("token-secret-digest");
  });

  it("rejects inverted relay date ranges", async () => {
    await expect(
      client().listRelayMetadataSummaries({
        createdAfter: new Date("2026-02-01T00:00:00.000Z"),
        createdBefore: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("BAD_REQUEST");
      return true;
    });
  });
});
