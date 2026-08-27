import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisibleModelTargets } from "./model-api-token-access";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { visibleModelReasoning } = await import("./visible-model-reasoning");

const db = prisma as unknown as {
  discoveredModel: { findMany: ReturnType<typeof vi.fn> };
  poolMember: { findMany: ReturnType<typeof vi.fn> };
};

const targets: VisibleModelTargets = {
  directModels: [
    {
      target: "DIRECT_MODEL",
      id: "direct-id",
      modelId: "owner/device/endpoint/model",
      upstreamModelId: "model",
      ownerUserId: "owner-id",
      ownerUserSlug: "owner",
      endpointId: "endpoint-id",
      endpointSlug: "endpoint",
      cliDeviceSlug: "device",
      maxAttachmentBytes: null,
    },
  ],
  modelPools: [
    {
      target: "MODEL_POOL",
      id: "pool-id",
      modelId: "owner/pool",
      name: "Pool",
      description: null,
      ownerUserId: "owner-id",
      ownerUserSlug: "owner",
      accessGrantId: null,
      poolSlug: "pool",
      maxAttachmentBytes: null,
      optimisticBasicTranscription: false,
      protocolAdaptationEnabled: false,
      publicEgressEnabled: false,
      publicEgressAcknowledged: false,
      effectiveProviderEgress: false,
      providerPrimaryMemberCount: 0,
      allowLossyDeveloperRoleCollapse: false,
      recommendedSurfaceOverride: null,
    },
  ],
};

function v4Surface(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    protocol: "openai-compatible",
    surfaces: {
      openaiChatCompletions: {
        source: "declared",
        confidence: "exact",
        operations: ["create"],
        ...overrides,
      },
    },
  };
}

function model(capabilityMetadata: unknown) {
  return {
    capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata: null,
    Endpoint: { capabilityMetadata },
  };
}

describe("visible model reasoning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("summarizes direct Chat Completions reasoning without inventing other surfaces", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: "direct-id",
        ...model(
          v4Surface({
            reasoning: true,
            reasoningConfig: {
              supportedLevels: ["low", "high"],
              defaultLevel: "low",
              encoding: { kind: "openai_reasoning_effort" },
            },
          }),
        ),
      },
    ]);
    db.poolMember.findMany.mockResolvedValue([]);

    const result = await visibleModelReasoning(targets);

    expect(result.directById.get("direct-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: {
        supported: true,
        supportedLevels: ["low", "high"],
        defaultLevel: "low",
        encoding: { kind: "openai_reasoning_effort" },
        levelsUnknown: false,
      },
    });
  });

  it("unions native pool ladders but leaves levels unknown when any supporting member omits one", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({ reasoning: true, reasoningConfig: { supportedLevels: ["low"] } }),
        ),
        ExecutionTarget: null,
      },
      {
        poolId: "pool-id",
        DiscoveredModel: model(v4Surface({ reasoning: true })),
        ExecutionTarget: null,
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: { supported: true, levelsUnknown: true },
    });
  });

  it("unions only known native member ladders", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({ reasoning: true, reasoningConfig: { supportedLevels: ["low", "medium"] } }),
        ),
        ExecutionTarget: null,
      },
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({ reasoning: true, reasoningConfig: { supportedLevels: ["medium", "high"] } }),
        ),
        ExecutionTarget: null,
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: {
        supported: true,
        supportedLevels: ["low", "medium", "high"],
        levelsUnknown: false,
      },
    });
  });

  it("keeps a shared pool default but omits a conflicting one", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({
            reasoning: true,
            reasoningConfig: { supportedLevels: ["low", "medium"], defaultLevel: "low" },
          }),
        ),
        ExecutionTarget: null,
      },
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({
            reasoning: true,
            reasoningConfig: { supportedLevels: ["low", "high"], defaultLevel: "low" },
          }),
        ),
        ExecutionTarget: null,
      },
    ]);

    const sharedDefault = await visibleModelReasoning(targets);
    expect(sharedDefault.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: {
        supported: true,
        supportedLevels: ["low", "medium", "high"],
        defaultLevel: "low",
        levelsUnknown: false,
      },
    });

    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({
            reasoning: true,
            reasoningConfig: { supportedLevels: ["low", "medium"], defaultLevel: "low" },
          }),
        ),
        ExecutionTarget: null,
      },
      {
        poolId: "pool-id",
        DiscoveredModel: model(
          v4Surface({
            reasoning: true,
            reasoningConfig: { supportedLevels: ["low", "high"], defaultLevel: "high" },
          }),
        ),
        ExecutionTarget: null,
      },
    ]);

    const conflicting = await visibleModelReasoning(targets);
    expect(conflicting.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: {
        supported: true,
        supportedLevels: ["low", "medium", "high"],
        levelsUnknown: false,
      },
    });
  });

  it("omits adapted-only reasoning surfaces from a pool summary", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model(v4Surface({ reasoning: true })),
        ExecutionTarget: null,
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: { supported: true, levelsUnknown: true },
    });
  });

  it("omits Completions-only reasoning from the Chat Test payload", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model({
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiCompletions: {
              source: "declared",
              confidence: "exact",
              operations: ["create"],
              reasoning: true,
              reasoningConfig: { supportedLevels: ["low"] },
            },
          },
        }),
        ExecutionTarget: null,
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({});
  });

  it("summarizes native reasoning for provider-backed pool members", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: null,
        ExecutionTarget: {
          DiscoveredModel: null,
          ProviderModel: {
            nativeCapabilities: v4Surface({
              reasoning: true,
              reasoningConfig: { supportedLevels: ["minimal", "high"], defaultLevel: "high" },
            }),
          },
        },
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({
      OPENAI_CHAT_COMPLETIONS: {
        supported: true,
        supportedLevels: ["minimal", "high"],
        defaultLevel: "high",
        levelsUnknown: false,
      },
    });
  });

  it("omits a pool encoding when native Anthropic members disagree on budget maps", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-id",
        DiscoveredModel: model({
          version: 4,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              operations: ["create"],
              protocolVersions: [{ version: "2023-06-01", betaFeatures: [] }],
              reasoning: true,
              reasoningConfig: {
                supportedLevels: ["high"],
                encoding: { kind: "anthropic_thinking", budgetByLevel: { high: 4096 } },
              },
            },
          },
        }),
        ExecutionTarget: null,
      },
      {
        poolId: "pool-id",
        DiscoveredModel: model({
          version: 4,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              operations: ["create"],
              protocolVersions: [{ version: "2023-06-01", betaFeatures: [] }],
              reasoning: true,
              reasoningConfig: {
                supportedLevels: ["high"],
                encoding: { kind: "anthropic_thinking", budgetByLevel: { high: 8192 } },
              },
            },
          },
        }),
        ExecutionTarget: null,
      },
    ]);

    const result = await visibleModelReasoning(targets);

    expect(result.poolById.get("pool-id")).toEqual({
      ANTHROPIC_MESSAGES: { supported: true, supportedLevels: ["high"], levelsUnknown: false },
    });
  });
});
