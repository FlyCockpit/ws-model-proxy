import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { persistRelayRegistration, shouldPreserveDashboardCapabilityOverride } = await import(
  "./registration.js"
);
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  user: { findUnique: MockInstance };
  cliDevice: { upsert: MockInstance; update: MockInstance };
  cliToken: { update: MockInstance };
  endpoint: { upsert: MockInstance; findUnique: MockInstance; updateMany: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
    upsert: MockInstance;
    updateMany: MockInstance;
  };
  poolMember: { updateMany: MockInstance };
  executionTarget: { findMany: MockInstance; upsert: MockInstance };
  inferenceCapacity: { findMany: MockInstance; updateMany: MockInstance };
};

const identity: CliWebsocketIdentity = {
  kind: "cliToken",
  id: "token-id",
  userId: "user-id",
  cliDeviceId: null,
  lookupPrefix: "wsmp_cli_lookup",
};

const now = new Date("2026-01-01T00:00:00.000Z");

const cliOverride = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, vision: false },
};

function inventoryEndpoints({ modelOverride = true }: { modelOverride?: boolean } = {}) {
  return [
    {
      slug: "local-openai",
      label: "Local OpenAI",
      kind: "openai-compatible" as const,
      status: "online" as const,
      defaultCapabilities: {
        version: 1 as const,
        protocol: "openai-compatible" as const,
        chatCompletions: { supported: true, streaming: true },
      },
      models: [
        {
          slug: "llava-local",
          upstreamModelId: "llava/local",
          capabilityOverrideMode: modelOverride ? ("override" as const) : ("inherit" as const),
          ...(modelOverride ? { capabilities: cliOverride } : {}),
        },
      ],
    },
  ];
}

describe("capability override origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    db.user.findUnique.mockResolvedValue({ id: "user-id", slug: "owner" });
    db.cliDevice.upsert.mockResolvedValue({
      id: "cli-device-id",
      userId: "user-id",
      slug: "desktop",
    });
    db.cliToken.update.mockResolvedValue({ id: "token-id" });
    db.cliDevice.update.mockResolvedValue({
      inventorySeq: 1,
      inventoryDigest: "digest",
      inventoryAcknowledgedAt: now,
    });
    db.endpoint.findUnique.mockResolvedValue(null);
    db.endpoint.upsert.mockResolvedValue({ id: "endpoint-id", slug: "local-openai" });
    db.endpoint.updateMany.mockResolvedValue({ count: 0 });
    db.discoveredModel.findUnique.mockResolvedValue(null);
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.discoveredModel.upsert.mockResolvedValue({ id: "model-id" });
    db.discoveredModel.updateMany.mockResolvedValue({ count: 0 });
    db.poolMember.updateMany.mockResolvedValue({ count: 0 });
    db.executionTarget.upsert.mockResolvedValue({
      id: "execution-target-id",
      inferenceCapacityId: "capacity-id",
    });
    db.executionTarget.findMany.mockResolvedValue([{ id: "execution-target-id" }]);
    db.inferenceCapacity.findMany.mockResolvedValue([]);
    db.inferenceCapacity.updateMany.mockResolvedValue({ count: 0 });
  });

  it("treats only dashboard origin as protected", () => {
    expect(shouldPreserveDashboardCapabilityOverride("DASHBOARD")).toBe(true);
    expect(shouldPreserveDashboardCapabilityOverride("CLI")).toBe(false);
    expect(shouldPreserveDashboardCapabilityOverride(null)).toBe(false);
  });

  it("seeds an empty local physical context from declared v4 inventory metadata", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: 0,
            PoolMembers: [],
          },
        ],
      },
    ]);
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 1_000_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).toHaveBeenCalledWith({
      where: { id: "capacity-id", userId: "user-id", physicalMaxContext: null },
      data: { physicalMaxContext: 1_000_000 },
    });
  });

  it("retries a raw policy-lock deadlock and then persists the registration", async () => {
    db.$queryRaw.mockRejectedValueOnce({ code: "P2010", meta: { code: "40P01" } });
    const [endpoint] = inventoryEndpoints({ modelOverride: false });
    if (!endpoint) throw new Error("expected inventory endpoint");

    await expect(
      persistRelayRegistration({
        identity,
        cli: { slug: "desktop", label: "Desktop" },
        endpoints: [
          {
            ...endpoint,
            defaultCapabilities: {
              version: 4,
              protocol: "openai-compatible",
              surfaces: {
                openaiChatCompletions: {
                  source: "declared",
                  confidence: "exact",
                  streaming: true,
                  maxContextTokens: 8_192,
                  operations: ["create"],
                },
              },
            },
          },
        ],
        inventoryConfirmed: true,
        endpointTargeting: true,
        now,
      }),
    ).resolves.toMatchObject({ userId: "user-id" });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a non-null local physical context during registration", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: 32_768,
        ExecutionTargets: [],
      },
    ]);
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 1_000_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("does not seed a capacity shared with a target outside this registration", async () => {
    db.inferenceCapacity.findMany.mockResolvedValue([
      {
        id: "capacity-id",
        physicalMaxContext: null,
        ExecutionTargets: [
          {
            id: "execution-target-id",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
          {
            id: "other-device-target",
            directContextCeiling: null,
            directContextMargin: null,
            PoolMembers: [],
          },
        ],
      },
    ]);

    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: [
        {
          slug: "local-openai",
          label: "Local OpenAI",
          kind: "openai-compatible",
          status: "online",
          defaultCapabilities: {
            version: 4,
            protocol: "openai-compatible",
            surfaces: {
              openaiChatCompletions: {
                source: "declared",
                confidence: "exact",
                streaming: true,
                maxContextTokens: 128_000,
                operations: ["create"],
              },
            },
          },
          models: [{ upstreamModelId: "large-local", capabilityOverrideMode: "inherit" }],
        },
      ],
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });

    expect(db.inferenceCapacity.updateMany).not.toHaveBeenCalled();
  });

  it("applies a CLI override when the existing row is CLI-owned or untagged", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "CLI",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "CLI",
          capabilityOverrideMetadata: expect.objectContaining({
            chatCompletions: expect.objectContaining({ vision: false }),
          }),
        }),
      }),
    );
    expect(db.executionTarget.upsert).toHaveBeenCalledWith({
      where: { discoveredModelId: "model-id" },
      update: { userId: "user-id", kind: "DISCOVERED_MODEL" },
      create: {
        userId: "user-id",
        kind: "DISCOVERED_MODEL",
        discoveredModelId: "model-id",
      },
      select: { id: true, inferenceCapacityId: true },
    });
  });

  it("preserves a dashboard-authored override when the CLI inherits", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints({ modelOverride: false }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          capabilityOverrideMode: expect.anything(),
          capabilityOverrideOrigin: expect.anything(),
          capabilityOverrideMetadata: expect.anything(),
        }),
      }),
    );
  });

  it("preserves a dashboard-authored inherit choice when the CLI also inherits", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints({ modelOverride: false }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          capabilityOverrideMode: expect.anything(),
          capabilityOverrideOrigin: expect.anything(),
        }),
      }),
    );
  });

  it("lets an explicit CLI override replace a dashboard-authored override", async () => {
    db.discoveredModel.findUnique.mockResolvedValue({
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideOrigin: "DASHBOARD",
    });
    await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints({ modelOverride: true }),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "CLI",
          capabilityOverrideMetadata: expect.anything(),
        }),
      }),
    );
  });

  it("does not send dashboard-authored state for persistence in CLI config", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      {
        upstreamModelId: "llava/local",
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, vision: true },
        },
        Endpoint: { slug: "local-openai" },
      },
    ]);
    const result = await persistRelayRegistration({
      identity,
      cli: { slug: "desktop", label: "Desktop" },
      endpoints: inventoryEndpoints(),
      inventoryConfirmed: true,
      endpointTargeting: true,
      now,
    });
    expect(db.discoveredModel.findMany).not.toHaveBeenCalled();
    expect(result.desiredCapabilities).toEqual([]);
  });
});
