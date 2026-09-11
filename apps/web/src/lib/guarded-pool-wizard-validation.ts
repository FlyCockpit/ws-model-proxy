import {
  openAiCapabilitiesFromCoarse,
  parseOpenAiCompatibleCapabilities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  type ModelApiSurface,
  surfaceAvailabilityMatrix,
} from "@ws-model-proxy/api/lib/surface-capabilities";
import { validateForwarderPoolSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { z } from "zod";

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

export const guardedWizardSurfaces = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
] as const;

/**
 * Defense in depth for the deployment egress gate: when
 * WMP_PUBLIC_PROVIDER_EGRESS_ENABLED is off, any provider selection is an
 * impossible state (the server rejects it with PROVIDER_EGRESS_DISABLED).
 * Used by the wizard schema's superRefine so even programmatic sets fail
 * validation before submission.
 */
export function providerSelectionBlockedByEgress(
  providerEgressEnabled: boolean,
  providerModelIds: readonly string[],
): boolean {
  return !providerEgressEnabled && providerModelIds.length > 0;
}

/**
 * Fail-closed read of the provider egress gate from an appConfig query
 * snapshot: an absent, loading, or malformed snapshot must behave exactly
 * like a deployment with provider egress disabled.
 */
export function providerEgressFromAppConfig(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const { providerEgressEnabled } = data as { providerEgressEnabled?: unknown };
  return providerEgressEnabled === true;
}

export type GuardedPoolWizardSchemaInput = {
  providerEgressEnabled: boolean;
  protocolAdaptationAvailable: boolean;
  directModels: readonly GuardedWizardLocalModel[];
  providerModels: readonly GuardedWizardProviderModel[];
  capacities: readonly GuardedWizardCapacity[];
};

/**
 * Builds the wizard's submit schema closed over the inputs its superRefine
 * branches need. Called once per wizard render with that render's query
 * snapshots, so validation always reflects the current gate and candidate
 * data. The egress gate issue uses its own `providerEgressBlocked` path so
 * the blocked-by-deployment copy never shadows (or borrows) the
 * providerModelIds count/selection copy.
 */
export function buildGuardedPoolWizardSchema(input: GuardedPoolWizardSchemaInput) {
  return z
    .object({
      slug: z
        .string()
        .trim()
        .refine((value) => validateForwarderPoolSlug(value).ok),
      name: z.string().trim().min(1).max(120),
      localModelIds: z.array(z.string()),
      memberConcurrencyLimit: z.number().int().min(1).max(10_000),
      memberContextCeiling: z.number().int().min(1).max(100_000_000).nullable(),
      reservedSlots: z.number().int().min(0).max(10_000),
      localWaitBudgetMs: z.number().int().min(0).max(600_000),
      recommendedSurface: z.enum(guardedWizardSurfaces),
      providerModelIds: z.array(z.string()).max(32),
      providerTier: z.enum(["PRIMARY", "PUBLIC_OVERFLOW"]),
      providerConcurrencyLimit: z.number().int().min(1).max(10_000),
      dailySpendLimit: z.string(),
      publicEgressAcknowledged: z.boolean(),
      physicalCountStrategy: z.enum([
        "TOKENIZER",
        "TEMPLATE_AWARE",
        "ENGINE_REPORTED",
        "CONSERVATIVE_ESTIMATE",
      ]),
      contextMargin: z.number().int().min(0).max(10_000_000),
      borrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
      protocolAdaptationEnabled: z.boolean(),
      allowLossyDeveloperRoleCollapse: z.boolean(),
      affinityEnabled: z.boolean(),
      affinityTtlSeconds: z.number().int().min(60).max(604_800),
      affinityMaxRecords: z.number().int().min(100).max(100_000),
      affinityPrefixWeight: z.number().int().min(0).max(10_000),
      affinityConversationWeight: z.number().int().min(0).max(10_000),
      affinityConfirmedCacheWeight: z.number().int().min(0).max(10_000),
      affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000),
      providerConcurrencyMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenAttemptMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenAttemptLimit: z.string(),
      tokenDayMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenDayLimit: z.string(),
      tokenMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenMonthLimit: z.string(),
      tokenLifetimeMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenLifetimeLimit: z.string(),
      spendDayMode: z.enum(["LIMITED", "UNLIMITED"]),
      spendMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
      spendMonthLimit: z.string(),
    })
    .superRefine((value, ctx) => {
      if (value.localModelIds.length + value.providerModelIds.length === 0)
        ctx.addIssue({ code: "custom", path: ["providerModelIds"] });
      if (value.reservedSlots > value.memberConcurrencyLimit)
        ctx.addIssue({ code: "custom", path: ["reservedSlots"] });
      if (value.providerModelIds.length > 0 && !value.publicEgressAcknowledged)
        ctx.addIssue({ code: "custom", path: ["publicEgressAcknowledged"] });
      if (providerSelectionBlockedByEgress(input.providerEgressEnabled, value.providerModelIds))
        ctx.addIssue({ code: "custom", path: ["providerEgressBlocked"] });
      if (
        value.localModelIds.length +
          (value.providerTier === "PRIMARY" ? value.providerModelIds.length : 0) >
          0 &&
        !combinedPrimarySurfaceIsSelectable(
          value.recommendedSurface,
          value.localModelIds,
          input.directModels,
          value.providerModelIds,
          input.providerModels,
          value.providerTier,
          input.protocolAdaptationAvailable && value.protocolAdaptationEnabled,
        )
      )
        ctx.addIssue({ code: "custom", path: ["recommendedSurface"] });
      const physicalMaximum = minimumSelectedPhysicalContext(
        value.localModelIds,
        input.directModels,
        input.capacities,
      );
      if (
        physicalMaximum != null &&
        value.memberContextCeiling != null &&
        value.memberContextCeiling + value.contextMargin > physicalMaximum
      )
        ctx.addIssue({ code: "custom", path: ["memberContextCeiling"] });
      for (const [mode, limit, path] of [
        [value.tokenAttemptMode, value.tokenAttemptLimit, "tokenAttemptLimit"],
        [value.tokenDayMode, value.tokenDayLimit, "tokenDayLimit"],
        [value.tokenMonthMode, value.tokenMonthLimit, "tokenMonthLimit"],
        [value.tokenLifetimeMode, value.tokenLifetimeLimit, "tokenLifetimeLimit"],
      ] as const) {
        if (mode === "LIMITED" && !/^[1-9]\d*$/.test(limit))
          ctx.addIssue({ code: "custom", path: [path] });
      }
      for (const [mode, limit, path] of [
        [value.spendDayMode, value.dailySpendLimit, "dailySpendLimit"],
        [value.spendMonthMode, value.spendMonthLimit, "spendMonthLimit"],
      ] as const) {
        if (
          mode === "LIMITED" &&
          (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(limit) || Number(limit) <= 0)
        )
          ctx.addIssue({ code: "custom", path: [path] });
      }
    });
}
