import {
  discoveredModelSurfaceCapabilities,
  type OpenAiCompatibleCapabilities,
  providerModelSurfaceCapabilities,
} from "@ws-model-proxy/api/lib/pool-model-capabilities";
import {
  type ModelApiSurface,
  surfaceAvailabilityMatrix,
} from "@ws-model-proxy/api/lib/surface-capabilities";
import { validateForwarderPoolSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { z } from "zod";

/**
 * Discovered/local model view for capability resolution. Carries exactly the
 * fields the server's canonical resolver (discoveredModelSurfaceCapabilities)
 * needs, flattened from the listCliDevices model + endpoint projection: the
 * model's override fields plus the owning endpoint's metadata and default
 * coarse inventory.
 */
export type GuardedWizardLocalModel = {
  id: string;
  capabilityOverrideMode?: string | null;
  capabilityOverrideMetadata?: unknown;
  capabilityOverrides?: unknown;
  endpointCapabilityMetadata?: unknown;
  endpointDefaultCapabilities?: unknown;
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

/**
 * Wizard-side capability resolution for a discovered/local model: the server's
 * canonical discoveredModelSurfaceCapabilities over the flattened
 * override + endpoint fields. Exported so the wizard component derives the
 * declared context window from the same effective capabilities.
 */
export function localModelSurfaceCapabilities(
  model: GuardedWizardLocalModel,
): OpenAiCompatibleCapabilities | null {
  return discoveredModelSurfaceCapabilities({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    capabilityOverrides: model.capabilityOverrides,
    Endpoint: {
      capabilityMetadata: model.endpointCapabilityMetadata,
      defaultCapabilities: model.endpointDefaultCapabilities,
    },
  });
}

/** A primary-member candidate with canonically resolved capabilities. */
type SurfaceCandidate = {
  id: string;
  capabilities: OpenAiCompatibleCapabilities | null;
};

function localCandidates(models: readonly GuardedWizardLocalModel[]): SurfaceCandidate[] {
  return models.map((model) => ({
    id: model.id,
    capabilities: localModelSurfaceCapabilities(model),
  }));
}

function providerCandidates(models: readonly GuardedWizardProviderModel[]): SurfaceCandidate[] {
  return models.map((provider) => ({
    id: provider.id,
    capabilities: providerModelSurfaceCapabilities(provider.nativeCapabilities),
  }));
}

/**
 * The combined PRIMARY member set: locals always, plus provider models only
 * when the provider tier is PRIMARY. PUBLIC_OVERFLOW providers are not
 * primary members.
 */
function combinedPrimaryCandidates(
  localModels: readonly GuardedWizardLocalModel[],
  providerModels: readonly GuardedWizardProviderModel[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
): SurfaceCandidate[] {
  if (providerTier !== "PRIMARY") return localCandidates(localModels);
  return [...localCandidates(localModels), ...providerCandidates(providerModels)];
}

export function recommendedCombinedPrimarySurface(
  localIds: readonly string[],
  localModels: readonly GuardedWizardLocalModel[],
  providerIds: readonly string[],
  providerModels: readonly GuardedWizardProviderModel[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
  protocolAdaptationEnabled = false,
) {
  const combined = combinedPrimaryCandidates(localModels, providerModels, providerTier);
  return recommendedSurfaceFromCandidates(
    combined,
    [...localIds, ...providerIds],
    protocolAdaptationEnabled,
  );
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
  const combined = combinedPrimaryCandidates(localModels, providerModels, providerTier);
  return surfaceIsSelectableFromCandidates(
    surface,
    combined,
    [...localIds, ...providerIds],
    protocolAdaptationEnabled,
  );
}

function recommendedSurfaceFromCandidates(
  candidates: readonly SurfaceCandidate[],
  selectedIds: readonly string[],
  protocolAdaptationEnabled: boolean,
): ModelApiSurface | null {
  const matrices = candidates
    .filter((candidate) => selectedIds.includes(candidate.id))
    .map((candidate) =>
      surfaceAvailabilityMatrix({
        capabilities: candidate.capabilities,
        adaptationEnabled: protocolAdaptationEnabled,
      }),
    );
  const order: readonly ModelApiSurface[] = [
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

function surfaceIsSelectableFromCandidates(
  surface: ModelApiSurface,
  candidates: readonly SurfaceCandidate[],
  selectedIds: readonly string[],
  protocolAdaptationEnabled: boolean,
) {
  const matrices = candidates
    .filter((candidate) => selectedIds.includes(candidate.id))
    .map((candidate) =>
      surfaceAvailabilityMatrix({
        capabilities: candidate.capabilities,
        adaptationEnabled: protocolAdaptationEnabled,
      }),
    );
  return matrices.length > 0 && matrices.every((matrix) => matrix[surface].mode !== "unavailable");
}

export function recommendedPrimarySurface(
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
  protocolAdaptationEnabled = false,
): ModelApiSurface | null {
  return recommendedSurfaceFromCandidates(
    localCandidates(models),
    selectedIds,
    protocolAdaptationEnabled,
  );
}

export function primarySurfaceIsSelectable(
  surface: ModelApiSurface,
  selectedIds: readonly string[],
  models: readonly GuardedWizardLocalModel[],
  protocolAdaptationEnabled = false,
) {
  return surfaceIsSelectableFromCandidates(
    surface,
    localCandidates(models),
    selectedIds,
    protocolAdaptationEnabled,
  );
}

export type RecommendedSurfaceFlags = {
  /** Set when the user changes the recommended API select directly. */
  manuallyChosen: boolean;
  /** Set once any member-driven auto-set (first default or repair) ran. */
  autoSetByMember: boolean;
};

export type RecommendedSurfaceSelection = {
  localIds: readonly string[];
  localModels: readonly GuardedWizardLocalModel[];
  providerIds: readonly string[];
  providerModels: readonly GuardedWizardProviderModel[];
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW";
  protocolAdaptationEnabled: boolean;
};

/**
 * Number of PRIMARY members under the given tier: locals plus providers when
 * the provider tier is PRIMARY. PUBLIC_OVERFLOW providers are not primary
 * members and never count toward first-member or repair decisions.
 */
export function combinedPrimaryMemberCount(
  localIds: readonly string[],
  providerIds: readonly string[],
  providerTier: "PRIMARY" | "PUBLIC_OVERFLOW",
): number {
  return localIds.length + (providerTier === "PRIMARY" ? providerIds.length : 0);
}

/**
 * Auto-set-once policy for the wizard's recommended API:
 * - When the pool's PRIMARY member set (locals + PRIMARY-tier providers)
 *   transitions empty → non-empty and the surface was neither manually chosen
 *   nor previously set by a member, default to the best-ranked surface of the
 *   COMBINED primary set at that moment. If that combined ranking returns
 *   null (no common selectable surface), nothing is written and a later
 *   addition may still fire this branch.
 * - Never recompute on later member additions/removals, provider selection,
 *   tier changes, or adaptation toggles — except auto-repair: when the current
 *   surface is no longer selectable for the primary set, fall back to the
 *   best-ranked selectable surface so the form stays valid.
 */
export function nextRecommendedSurface(
  current: ModelApiSurface,
  flags: RecommendedSurfaceFlags,
  selection: RecommendedSurfaceSelection,
  firstMemberSelection: boolean,
): { surface: ModelApiSurface; flags: RecommendedSurfaceFlags } {
  if (firstMemberSelection && !flags.manuallyChosen && !flags.autoSetByMember) {
    const first = recommendedCombinedPrimarySurface(
      selection.localIds,
      selection.localModels,
      selection.providerIds,
      selection.providerModels,
      selection.providerTier,
      selection.protocolAdaptationEnabled,
    );
    if (first) return { surface: first, flags: { manuallyChosen: false, autoSetByMember: true } };
  }
  const primaryCount = combinedPrimaryMemberCount(
    selection.localIds,
    selection.providerIds,
    selection.providerTier,
  );
  if (
    primaryCount > 0 &&
    !combinedPrimarySurfaceIsSelectable(
      current,
      selection.localIds,
      selection.localModels,
      selection.providerIds,
      selection.providerModels,
      selection.providerTier,
      selection.protocolAdaptationEnabled,
    )
  ) {
    const fallback = recommendedCombinedPrimarySurface(
      selection.localIds,
      selection.localModels,
      selection.providerIds,
      selection.providerModels,
      selection.providerTier,
      selection.protocolAdaptationEnabled,
    );
    if (fallback)
      return { surface: fallback, flags: { manuallyChosen: false, autoSetByMember: true } };
  }
  return { surface: current, flags };
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
