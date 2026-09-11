import { ORPCError } from "@orpc/server";
import { suggestedConnectionSurface, suggestedConnectionSurfaces } from "./model-connection-type";
import {
  type OpenAiCompatibleCapabilities,
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
} from "./openai-compatible-capabilities";
import { type ModelApiSurface, surfaceAvailabilityMatrix } from "./surface-capabilities";

/**
 * Shared recommended-surface selectability contract for model pools.
 *
 * A pool's effective recommended surface (the operator override when set,
 * otherwise the suggestion derived from the primary members) must stay
 * servable by every PRIMARY member — natively or via protocol adaptation
 * under the deployment gate. This is the single implementation used by both
 * the guarded create path and every update-path mutation that touches one of
 * the selectability inputs (override, adaptation flag, member set, tiers).
 */

/** Minimal member view the selectability contract operates on. */
export type PoolSurfaceMember = {
  tier: string;
  capabilities: OpenAiCompatibleCapabilities | null;
};

/**
 * Resolves a discovered model's servable capabilities exactly like pool
 * serialization: structured capability metadata wins, with the historical
 * coarse inventory as a fallback for older CLI connections.
 */
export function discoveredModelSurfaceCapabilities(model: {
  capabilityOverrideMode?: string | null;
  capabilityOverrideMetadata?: unknown;
  capabilityOverrides?: unknown;
  Endpoint?: { capabilityMetadata?: unknown; defaultCapabilities?: unknown } | null;
}): OpenAiCompatibleCapabilities | null {
  const overrideMode = model.capabilityOverrideMode ?? "INHERIT_ENDPOINT_DEFAULTS";
  const metadata = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: overrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata: model.Endpoint?.capabilityMetadata,
  });
  if (metadata) return metadata;
  const rawCoarse =
    overrideMode === "OVERRIDE" ? model.capabilityOverrides : model.Endpoint?.defaultCapabilities;
  return openAiCapabilitiesFromCoarse(
    Array.isArray(rawCoarse)
      ? rawCoarse.filter((value): value is string => typeof value === "string")
      : [],
  );
}

/**
 * Resolves a provider model's servable capabilities through the single path
 * shared by pool serialization and every selectability gate: structured
 * capability metadata wins; legacy inventories that predate it (a raw
 * `{ surfaces: [...], streaming }` shape from older provider syncs) are
 * normalized into an equivalent synthetic inventory so the dashboard display
 * and the gated mutations can never disagree. Returns null when nothing about
 * the inventory is parseable, which renders every surface unavailable.
 */
export function providerModelSurfaceCapabilities(
  nativeCapabilities: unknown,
): OpenAiCompatibleCapabilities | null {
  const inventory = parseOpenAiCompatibleCapabilities(nativeCapabilities);
  if (inventory) return inventory;
  const native =
    nativeCapabilities && typeof nativeCapabilities === "object"
      ? (nativeCapabilities as { surfaces?: unknown; streaming?: unknown })
      : null;
  const surfaces = Array.isArray(native?.surfaces)
    ? native.surfaces.filter((value): value is string => typeof value === "string")
    : [];
  if (surfaces.length === 0) return null;
  const feature = {
    source: "provider" as const,
    confidence: "exact" as const,
    supported: true,
    streaming: native?.streaming === true,
  };
  return {
    version: 3,
    protocol: "openai-compatible",
    surfaces: {
      ...(surfaces.includes("openai-chat") ? { openaiChatCompletions: { ...feature } } : {}),
      ...(surfaces.includes("openai-responses") ? { openaiResponses: { ...feature } } : {}),
      ...(surfaces.includes("anthropic-messages")
        ? { anthropicMessages: { ...feature, countTokens: false } }
        : {}),
      ...(surfaces.includes("openai-completions") ? { openaiCompletions: { ...feature } } : {}),
    },
  };
}

/**
 * Availability matrices for the primary members only. An empty primary set
 * (a provider-only PUBLIC_OVERFLOW pool) yields an empty list and accepts
 * any recommended surface, matching the guarded create contract.
 */
export function primarySurfaceMatrices({
  members,
  adaptationEnabled,
}: {
  members: readonly PoolSurfaceMember[];
  adaptationEnabled: boolean;
}): Array<ReturnType<typeof surfaceAvailabilityMatrix>> {
  return members
    .filter((member) => member.tier === "PRIMARY")
    .map((member) =>
      surfaceAvailabilityMatrix({ capabilities: member.capabilities, adaptationEnabled }),
    );
}

/**
 * The surface the pool will actually recommend: the operator override when
 * set, else the suggestion ranked from the primary members. Returns null when
 * no override is set and no primary member can serve any suggested surface.
 */
export function effectiveRecommendedSurface({
  override,
  primaryMatrices,
}: {
  override: ModelApiSurface | null;
  primaryMatrices: ReadonlyArray<ReturnType<typeof surfaceAvailabilityMatrix>>;
}): ModelApiSurface | null {
  if (override) return override;
  return suggestedConnectionSurface({
    surfaces: Object.fromEntries(
      suggestedConnectionSurfaces.map((surface) => {
        const entries = primaryMatrices.map((matrix) => matrix[surface]);
        return [
          surface,
          {
            native: entries.filter((entry) => entry.mode === "native").length,
            adapted: entries.filter((entry) => entry.mode === "adapted").length,
          },
        ];
      }),
    ),
  });
}

/**
 * Returns the recommended surface a primary member cannot serve (natively or
 * via adaptation), or null when the post-mutation state is servable.
 */
export function recommendedSurfaceViolation({
  override,
  members,
  adaptationEnabled,
}: {
  override: ModelApiSurface | null;
  members: readonly PoolSurfaceMember[];
  adaptationEnabled: boolean;
}): ModelApiSurface | null {
  const primaryMatrices = primarySurfaceMatrices({ members, adaptationEnabled });
  const surface = effectiveRecommendedSurface({ override, primaryMatrices });
  if (!surface) return null;
  return primaryMatrices.some((matrix) => matrix[surface].mode === "unavailable") ? surface : null;
}

/**
 * Rejects with the same envelope as the guarded create path when any primary
 * member of the post-mutation state cannot serve the effective recommended
 * surface. Callers must only invoke this for mutations that change one of the
 * selectability inputs, keeping the gate non-retroactive.
 */
export function assertRecommendedSurfaceServable({
  override,
  members,
  adaptationEnabled,
}: {
  override: ModelApiSurface | null;
  members: readonly PoolSurfaceMember[];
  adaptationEnabled: boolean;
}): void {
  if (recommendedSurfaceViolation({ override, members, adaptationEnabled }) === null) return;
  throw new ORPCError("BAD_REQUEST", {
    message:
      "Every selected primary member must serve the recommended API natively or via protocol adaptation.",
    data: { reason: "SURFACE_NOT_SUPPORTED" },
  });
}
