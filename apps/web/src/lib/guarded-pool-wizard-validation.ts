import {
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  type ModelApiSurface,
  modelApiSurfaces,
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

export function recommendedPrimarySurface(
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
): Exclude<ModelApiSurface, "OPENAI_COMPLETIONS"> | null {
  const matrices = models
    .filter((model) => selectedIds.includes(model.id))
    .map((model) =>
      surfaceAvailabilityMatrix({
        capabilities:
          parseOpenAiCompatibleCapabilities(model.effectiveCapabilities?.metadata) ??
          openAiCapabilitiesFromCoarse(model.effectiveCapabilities?.coarse ?? []),
        adaptationEnabled: true,
      }),
    );
  const order: readonly Exclude<ModelApiSurface, "OPENAI_COMPLETIONS">[] = [
    "OPENAI_RESPONSES",
    "ANTHROPIC_MESSAGES",
    "OPENAI_CHAT_COMPLETIONS",
  ];
  return (
    order.find((surface) => matrices.some((matrix) => matrix[surface].mode === "native")) ??
    order.find((surface) => matrices.some((matrix) => matrix[surface].mode === "adapted")) ??
    null
  );
}

export function primarySurfaceIsSelectable(
  surface: ModelApiSurface,
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
) {
  return recommendedPrimarySurface(selectedIds, models) === surface;
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

export function egressAcknowledgementIsValid(
  providerIds: readonly string[],
  acknowledged: boolean,
) {
  return providerIds.length === 0 || acknowledged;
}

export function firstInvalidWizardField(
  orderedFields: readonly string[],
  errors: Readonly<Record<string, string>>,
) {
  return orderedFields.find((field) => Boolean(errors[field])) ?? null;
}

export const guardedWizardStepCount = 4;
export const guardedWizardSurfaces = modelApiSurfaces;
