import prisma from "@ws-model-proxy/db";
import { declaredContextWindow } from "./declared-context-window";
import type { OpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";
import {
  discoveredModelSurfaceCapabilities,
  providerModelSurfaceCapabilities,
} from "./pool-model-capabilities";
import type { PoolCatalogProfile } from "./provider-catalog-model";

type SurfaceFeatures = { tools?: boolean; inputImages?: boolean; reasoning?: boolean };

function inventoryFeatures(caps: OpenAiCompatibleCapabilities | null): {
  tools: boolean;
  imageInput: boolean;
  reasoning: boolean;
} {
  if (!caps) return { tools: false, imageInput: false, reasoning: false };
  if (caps.version === 3 || caps.version === 4) {
    const surfaces = Object.values(caps.surfaces as Record<string, SurfaceFeatures | undefined>);
    return {
      tools: surfaces.some((surface) => surface?.tools === true),
      imageInput: surfaces.some((surface) => surface?.inputImages === true),
      reasoning: surfaces.some((surface) => surface?.reasoning === true),
    };
  }
  return { tools: false, imageInput: caps.chatCompletions?.vision === true, reasoning: false };
}

const discoveredSelect = {
  capabilityOverrideMode: true,
  capabilityOverrideMetadata: true,
  capabilityOverrides: true,
  Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
} as const;

/**
 * Profile of a pool's local (PRIMARY) members for catalog compatibility
 * verdicts. Features are the optimistic union across members (a feature any
 * member advertises); the context ceiling is the largest known member window,
 * capped by the pool's own context ceiling. Returns null when the pool is not
 * visible to the caller (owner or grantee), and never distinguishes that from
 * a pool that does not exist.
 */
export async function loadPoolCatalogProfile(
  userId: string,
  poolId: string,
): Promise<PoolCatalogProfile | null> {
  const pool = await prisma.modelPool.findFirst({
    where: {
      id: poolId,
      OR: [{ userId }, { PoolGrants: { some: { granteeUserId: userId } } }],
    },
    select: {
      capacityContextCeiling: true,
      PoolMembers: {
        where: { tier: "PRIMARY" },
        select: {
          DiscoveredModel: { select: discoveredSelect },
          ExecutionTarget: {
            select: {
              DiscoveredModel: { select: discoveredSelect },
              ProviderModel: { select: { nativeCapabilities: true, contextWindow: true } },
              InferenceCapacity: { select: { physicalMaxContext: true } },
            },
          },
        },
      },
    },
  });
  if (!pool) return null;
  let tools = false;
  let imageInput = false;
  let reasoning = false;
  let widest: number | null = null;
  for (const member of pool.PoolMembers) {
    const target = member.ExecutionTarget;
    const providerModel = target?.ProviderModel ?? null;
    const discovered = target?.DiscoveredModel ?? member.DiscoveredModel ?? null;
    const caps = providerModel
      ? providerModelSurfaceCapabilities(providerModel.nativeCapabilities)
      : discovered
        ? discoveredModelSurfaceCapabilities(discovered)
        : null;
    const features = inventoryFeatures(caps);
    tools ||= features.tools;
    imageInput ||= features.imageInput;
    reasoning ||= features.reasoning;
    const window =
      declaredContextWindow(caps) ??
      providerModel?.contextWindow ??
      target?.InferenceCapacity?.physicalMaxContext ??
      null;
    if (window !== null) widest = widest === null ? window : Math.max(widest, window);
  }
  const ceiling = pool.capacityContextCeiling;
  const contextCeiling =
    widest === null ? ceiling : ceiling === null ? widest : Math.min(widest, ceiling);
  return { contextCeiling, tools, imageInput, reasoning };
}
