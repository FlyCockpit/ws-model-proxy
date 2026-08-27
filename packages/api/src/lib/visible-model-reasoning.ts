import { isDeepStrictEqual } from "node:util";
import prisma from "@ws-model-proxy/db";
import type { VisibleModelTargets } from "./model-api-token-access";
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
} from "./openai-compatible-capabilities";
import {
  type ReasoningConfig,
  type ReasoningEncoding,
  type ReasoningLevel,
  reasoningLevels,
} from "./reasoning-contract";
import { surfaceAvailabilityMatrix } from "./surface-capabilities";

const visibleReasoningSurfaces = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
] as const;
type VisibleReasoningSurface = (typeof visibleReasoningSurfaces)[number];

type InventorySurface = "openaiChatCompletions" | "openaiResponses" | "anthropicMessages";

const inventorySurfaceByVisibleSurface: Record<VisibleReasoningSurface, InventorySurface> = {
  OPENAI_CHAT_COMPLETIONS: "openaiChatCompletions",
  OPENAI_RESPONSES: "openaiResponses",
  ANTHROPIC_MESSAGES: "anthropicMessages",
};

export type VisibleSurfaceReasoning = {
  supported: boolean;
  supportedLevels?: ReasoningLevel[];
  defaultLevel?: ReasoningLevel;
  encoding?: ReasoningEncoding;
  levelsUnknown: boolean;
};

export type VisibleModelReasoning = Partial<
  Record<VisibleReasoningSurface, VisibleSurfaceReasoning>
>;

type CapabilityRow = {
  capabilityOverrideMode: string;
  capabilityOverrideMetadata: unknown | null;
  Endpoint: { capabilityMetadata: unknown | null };
};

function effectiveCapabilities(row: CapabilityRow): OpenAiCompatibleCapabilities | null {
  return resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: row.capabilityOverrideMode,
    capabilityOverrideMetadata: row.capabilityOverrideMetadata,
    endpointCapabilityMetadata: row.Endpoint.capabilityMetadata,
  });
}

function nativeReasoning(
  capabilities: OpenAiCompatibleCapabilities,
  surface: VisibleReasoningSurface,
): { supported: boolean; config?: ReasoningConfig } | undefined {
  if (surfaceAvailabilityMatrix({ capabilities })[surface].mode !== "native") return undefined;
  if (capabilities.version !== 3 && capabilities.version !== 4) return { supported: false };
  const feature = capabilities.surfaces[inventorySurfaceByVisibleSurface[surface]];
  return feature?.reasoning === true
    ? { supported: true, ...(feature.reasoningConfig ? { config: feature.reasoningConfig } : {}) }
    : { supported: false };
}

function nativeSurfaceExists(
  capabilities: OpenAiCompatibleCapabilities,
  surface: VisibleReasoningSurface,
): boolean {
  return surfaceAvailabilityMatrix({ capabilities })[surface].mode === "native";
}

function summaryForMembers(
  members: readonly OpenAiCompatibleCapabilities[],
  surface: VisibleReasoningSurface,
): VisibleSurfaceReasoning | undefined {
  const nativeMembers = members.filter((capabilities) =>
    nativeSurfaceExists(capabilities, surface),
  );
  if (nativeMembers.length === 0) return undefined;

  const supportingConfigs = nativeMembers
    .map((capabilities) => nativeReasoning(capabilities, surface))
    .filter(
      (reasoning): reasoning is { supported: true; config?: ReasoningConfig } =>
        reasoning?.supported === true,
    );
  if (supportingConfigs.length === 0) return { supported: false, levelsUnknown: false };

  const configs = supportingConfigs.map((reasoning) => reasoning.config);
  const anyUnknownLevels = configs.some((config) => config?.supportedLevels === undefined);
  const supportedLevels = anyUnknownLevels
    ? undefined
    : reasoningLevels.filter((level) =>
        configs.some((config) => config?.supportedLevels?.includes(level)),
      );
  const firstDefault = configs[0]?.defaultLevel;
  const defaultLevel =
    firstDefault !== undefined && configs.every((config) => config?.defaultLevel === firstDefault)
      ? firstDefault
      : undefined;
  const firstEncoding = configs[0]?.encoding;
  const encoding =
    firstEncoding !== undefined &&
    configs.every((config) => isDeepStrictEqual(config?.encoding, firstEncoding))
      ? firstEncoding
      : undefined;

  return {
    supported: true,
    ...(supportedLevels ? { supportedLevels } : {}),
    ...(defaultLevel ? { defaultLevel } : {}),
    ...(encoding ? { encoding } : {}),
    levelsUnknown: anyUnknownLevels,
  };
}

/**
 * Resolve native reasoning metadata from the same effective inventories used
 * by routing. Pools deliberately summarize, rather than enforce, their mixed
 * member inventories; level enforcement belongs to a later routing phase.
 */
export async function visibleModelReasoning(targets: VisibleModelTargets): Promise<{
  directById: Map<string, VisibleModelReasoning>;
  poolById: Map<string, VisibleModelReasoning>;
}> {
  const directIds = targets.directModels.map((model) => model.id);
  const poolIds = targets.modelPools.map((pool) => pool.id);
  const [directRows, poolMemberRows] = await Promise.all([
    directIds.length === 0
      ? []
      : prisma.discoveredModel.findMany({
          where: { id: { in: directIds } },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrideMetadata: true,
            Endpoint: { select: { capabilityMetadata: true } },
          },
        }),
    poolIds.length === 0
      ? []
      : prisma.poolMember.findMany({
          where: { poolId: { in: poolIds } },
          select: {
            poolId: true,
            ExecutionTarget: {
              select: {
                DiscoveredModel: {
                  select: {
                    capabilityOverrideMode: true,
                    capabilityOverrideMetadata: true,
                    Endpoint: { select: { capabilityMetadata: true } },
                  },
                },
                ProviderModel: {
                  select: { nativeCapabilities: true },
                },
              },
            },
            DiscoveredModel: {
              select: {
                capabilityOverrideMode: true,
                capabilityOverrideMetadata: true,
                Endpoint: { select: { capabilityMetadata: true } },
              },
            },
          },
        }),
  ]);

  const directById = new Map<string, VisibleModelReasoning>();
  for (const row of directRows) {
    const capabilities = effectiveCapabilities(row);
    if (!capabilities || !nativeSurfaceExists(capabilities, "OPENAI_CHAT_COMPLETIONS")) continue;
    const reasoning = nativeReasoning(capabilities, "OPENAI_CHAT_COMPLETIONS");
    if (!reasoning) continue;
    const config = reasoning.config;
    directById.set(row.id, {
      OPENAI_CHAT_COMPLETIONS: config
        ? {
            supported: true,
            ...(config.supportedLevels ? { supportedLevels: config.supportedLevels } : {}),
            ...(config.defaultLevel ? { defaultLevel: config.defaultLevel } : {}),
            ...(config.encoding ? { encoding: config.encoding } : {}),
            levelsUnknown: config.supportedLevels === undefined,
          }
        : { supported: reasoning.supported, levelsUnknown: reasoning.supported },
    });
  }

  const capabilitiesByPoolId = new Map<string, OpenAiCompatibleCapabilities[]>();
  for (const row of poolMemberRows) {
    const model = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
    const capabilities = row.ExecutionTarget?.ProviderModel
      ? parseOpenAiCompatibleCapabilities(row.ExecutionTarget.ProviderModel.nativeCapabilities)
      : model
        ? effectiveCapabilities(model)
        : null;
    if (!capabilities) continue;
    const members = capabilitiesByPoolId.get(row.poolId) ?? [];
    members.push(capabilities);
    capabilitiesByPoolId.set(row.poolId, members);
  }
  const poolById = new Map<string, VisibleModelReasoning>();
  for (const poolId of poolIds) {
    const members = capabilitiesByPoolId.get(poolId) ?? [];
    const reasoning: VisibleModelReasoning = {};
    for (const surface of visibleReasoningSurfaces) {
      const summary = summaryForMembers(members, surface);
      if (summary) reasoning[surface] = summary;
    }
    poolById.set(poolId, reasoning);
  }
  return { directById, poolById };
}
