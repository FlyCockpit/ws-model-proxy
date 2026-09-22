import {
  type OpenAiCompatibleCapabilities,
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
} from "./openai-compatible-capabilities";

export type { OpenAiCompatibleCapabilities };

/**
 * Pure member-capability resolvers shared by pool serialization, the
 * selectability gates, and the guarded pool wizard. Split out of
 * pool-recommended-surface.ts (which re-exports them unchanged) so
 * browser bundles can import the resolvers without pulling the gate
 * module's server-only @orpc/server dependency.
 */

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
  const normalized = {
    ...(surfaces.includes("openai-chat") ? { openaiChatCompletions: { ...feature } } : {}),
    ...(surfaces.includes("openai-responses") ? { openaiResponses: { ...feature } } : {}),
    ...(surfaces.includes("anthropic-messages")
      ? { anthropicMessages: { ...feature, countTokens: false } }
      : {}),
  };
  if (Object.keys(normalized).length === 0) return null;
  return {
    version: 3,
    protocol: "openai-compatible",
    surfaces: normalized,
  };
}
