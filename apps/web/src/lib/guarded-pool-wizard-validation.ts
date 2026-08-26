import {
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  type ModelApiSurface,
  surfaceAvailabilityMatrix,
} from "@ws-model-proxy/api/lib/surface-capabilities";

export type GuardedWizardLocalModel = {
  id: string;
  effectiveCapabilities?: { metadata?: unknown; coarse?: string[] } | null;
  executionTarget?: { inferenceCapacityId: string | null } | null;
};

export type GuardedWizardCapacity = {
  id: string;
  physicalMaxContext: number | null;
};

export type GuardedWizardProviderModel = {
  id: string;
  nativeCapabilities?: unknown;
};

function combinedPrimarySelection(
  localIds: readonly string[],
  localModels: readonly GuardedWizardLocalModel[],
  providerIds: readonly string[],
  providerModels: readonly GuardedWizardProviderModel[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
) {
  if (providerTier !== "PRIMARY") return { ids: [...localIds], models: [...localModels] };
  return {
    ids: [...localIds, ...providerIds],
    models: [
      ...localModels,
      ...providerModels.map((provider) => ({
        id: provider.id,
        effectiveCapabilities: { metadata: provider.nativeCapabilities },
      })),
    ],
  };
}

export function recommendedCombinedPrimarySurface(
  localIds: readonly string[],
  localModels: readonly GuardedWizardLocalModel[],
  providerIds: readonly string[],
  providerModels: readonly GuardedWizardProviderModel[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
  protocolAdaptationEnabled = false,
) {
  const combined = combinedPrimarySelection(
    localIds,
    localModels,
    providerIds,
    providerModels,
    providerTier,
  );
  return recommendedPrimarySurface(combined.ids, combined.models, protocolAdaptationEnabled);
}

export function combinedPrimarySurfaceIsSelectable(
  surface: ModelApiSurface,
  localIds: readonly string[],
  localModels: readonly GuardedWizardLocalModel[],
  providerIds: readonly string[],
  providerModels: readonly GuardedWizardProviderModel[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
  protocolAdaptationEnabled = false,
) {
  const combined = combinedPrimarySelection(
    localIds,
    localModels,
    providerIds,
    providerModels,
    providerTier,
  );
  return primarySurfaceIsSelectable(
    surface,
    combined.ids,
    combined.models,
    protocolAdaptationEnabled,
  );
}

export function recommendedPrimarySurface(
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
  protocolAdaptationEnabled = false,
): Exclude<ModelApiSurface, "OPENAI_COMPLETIONS"> | null {
  const matrices = models
    .filter((model) => selectedIds.includes(model.id))
    .map((model) =>
      surfaceAvailabilityMatrix({
        capabilities:
          parseOpenAiCompatibleCapabilities(model.effectiveCapabilities?.metadata) ??
          openAiCapabilitiesFromCoarse(model.effectiveCapabilities?.coarse ?? []),
        adaptationEnabled: protocolAdaptationEnabled,
      }),
    );
  const order: readonly Exclude<ModelApiSurface, "OPENAI_COMPLETIONS">[] = [
    "OPENAI_RESPONSES",
    "OPENAI_CHAT_COMPLETIONS",
    "ANTHROPIC_MESSAGES",
  ];
  if (matrices.length === 0) return null;
  return (
    order
      .filter((surface) => matrices.every((matrix) => matrix[surface].mode !== "unavailable"))
      .map((surface, orderIndex) => ({
        surface,
        nativeCount: matrices.filter((matrix) => matrix[surface].mode === "native").length,
        limitations: matrices.reduce(
          (count, matrix) => count + matrix[surface].limitations.length,
          0,
        ),
        orderIndex,
      }))
      .sort(
        (left, right) =>
          right.nativeCount - left.nativeCount ||
          left.limitations - right.limitations ||
          left.orderIndex - right.orderIndex,
      )[0]?.surface ?? null
  );
}

export function primarySurfaceIsSelectable(
  surface: ModelApiSurface,
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
  protocolAdaptationEnabled = false,
) {
  const matrices = models
    .filter((model) => selectedIds.includes(model.id))
    .map((model) =>
      surfaceAvailabilityMatrix({
        capabilities:
          parseOpenAiCompatibleCapabilities(model.effectiveCapabilities?.metadata) ??
          openAiCapabilitiesFromCoarse(model.effectiveCapabilities?.coarse ?? []),
        adaptationEnabled: protocolAdaptationEnabled,
      }),
    );
  return matrices.length > 0 && matrices.every((matrix) => matrix[surface].mode !== "unavailable");
}

export function safeContextControls(physicalMaxContext: number | null | undefined) {
  if (physicalMaxContext == null) return { contextCeiling: 31_744, contextMargin: 1_024 } as const;
  const contextMargin = Math.min(1_024, Math.max(0, physicalMaxContext - 1));
  return {
    contextCeiling: Math.max(1, physicalMaxContext - contextMargin),
    contextMargin,
  };
}

export function minimumSelectedPhysicalContext(
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
  capacities: readonly GuardedWizardCapacity[],
) {
  const byId = new Map(capacities.map((capacity) => [capacity.id, capacity]));
  const finite = models
    .filter((model) => selectedIds.includes(model.id))
    .flatMap((model) => {
      const id = model.executionTarget?.inferenceCapacityId;
      const maximum = id ? byId.get(id)?.physicalMaxContext : null;
      return maximum == null ? [] : [maximum];
    });
  return finite.length > 0 ? Math.min(...finite) : null;
}

export function providerOrderAfterToggle(current: readonly string[], id: string, checked: boolean) {
  return checked
    ? current.includes(id)
      ? [...current]
      : [...current, id]
    : current.filter((v) => v !== id);
}

export function providerOrderAfterMove(
  current: readonly string[],
  index: number,
  direction: -1 | 1,
) {
  const target = index + direction;
  if (index < 0 || target < 0 || index >= current.length || target >= current.length)
    return [...current];
  const next = [...current];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
