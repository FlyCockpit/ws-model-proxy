import { ORPCError } from "@orpc/server";
import {
  directModelId,
  poolModelId,
  validateForwarderPoolSlug,
  validateForwarderSlug,
} from "@ws-model-proxy/config/forwarder-identifiers";
import { MEDIA_ATTACHMENT_MAX_BYTES_MAX } from "@ws-model-proxy/config/media-policy";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import type { LiveCliFeatureSnapshot } from "../context";
import { protectedProcedure } from "../index";
import {
  assertCapacityManagementEnabled,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  assertModelPoolCapacityPolicy,
  type CapacityPolicyFailureReasons,
  lockAndValidateModelPoolCapacityPolicy,
  lockExecutionTargetIdentities,
  lockExecutionTargetPolicies,
  modelPoolCapacityPolicyFields,
} from "../lib/capacity-policy-safety";
import {
  type ContextWindowSeedDependent,
  declaredContextWindow,
  isContextWindowSeedAdmissible,
} from "../lib/declared-context-window";
import type { GuardedPoolCreateFailureReason } from "../lib/guarded-pool-create-reasons";
import {
  getConfiguredMediaAttachmentMaxBytes,
  resolveAttachmentLimit,
} from "../lib/media-attachment-limits";
import { parseModelApiSurface } from "../lib/model-api-surface";
import {
  listVisibleModelTargetsForUser,
  type VisibleModelTargets,
} from "../lib/model-api-token-access";
import { suggestedConnectionSurface } from "../lib/model-connection-type";
import { poolMemberRoutingStatuses } from "../lib/model-pool-routing";
import {
  audioOperationSupported,
  coarseCapabilitiesFromOpenAi,
  openAiCapabilitiesFromCoarse,
  openAiCompatibleCapabilitiesSchema,
  parseOpenAiCompatibleCapabilities,
  resolveEffectiveCapabilityMetadata,
  transformerModalityMismatchErrors,
  transformerSupportedModalities,
} from "../lib/openai-compatible-capabilities";
import {
  capabilityEditImpactedPools,
  discoveredModelPoolMemberWhere,
  poolIdsWithMembers,
} from "../lib/pool-capability-impact";
import {
  assertRecommendedSurfaceServable,
  discoveredModelSurfaceCapabilities,
  providerModelSurfaceCapabilities,
} from "../lib/pool-recommended-surface";
import { loadPoolSurfaceMembers } from "../lib/pool-surface-members";
import { runSerializableTransaction } from "../lib/serializable-transaction";
import {
  type ModelApiSurface,
  modelApiSurfaces,
  surfaceAvailabilityMatrix,
} from "../lib/surface-capabilities";
import { visibleModelAttachmentModalities } from "../lib/visible-model-modalities";
import { visibleModelReasoning } from "../lib/visible-model-reasoning";

const CLI_HEARTBEAT_STALE_AFTER_MS = 60_000;

let guardedSetupTestFailure: (() => void) | undefined;

export function setGuardedSetupTestFailureInjector(injector: (() => void) | undefined) {
  if (env.NODE_ENV !== "test") throw new Error("Guarded setup failure injection is test-only.");
  guardedSetupTestFailure = injector;
}

const slugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `forwarderSlug.${result.reason}` });
    }
  });

const poolSlugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateForwarderPoolSlug(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: "forwarderSlug." + result.reason });
    }
  });

const poolNameSchema = z.string().trim().min(1).max(120);
const poolDescriptionSchema = z.string().trim().max(1000).nullable().optional();
const idSchema = z.string().min(1);
const routingStatusSchema = z.enum(poolMemberRoutingStatuses);
const poolRecommendedSurfaceSchema = z.enum([
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
]);
const attachmentLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MEDIA_ATTACHMENT_MAX_BYTES_MAX)
  .nullable()
  .optional();
const poolTransformerFields = {
  transformerDiscoveredModelId: z.string().min(1).nullable().optional(),
  transformerSystemPrompt: z.string().max(16_000).nullable().optional(),
  transformerImages: z.boolean().optional(),
  transformerAudio: z.boolean().optional(),
  transformerVideo: z.boolean().optional(),
  transformerCacheMode: z.enum(["OFF", "MEMORY"]).optional(),
  transformerIncludePrimaryTools: z.boolean().optional(),
  transformerMaxTools: z.number().int().min(1).max(128).optional(),
  transformerMaxToolChars: z.number().int().min(256).max(32_000).optional(),
  transformerTimeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
  transformerMaxAssets: z.number().int().min(1).max(64).nullable().optional(),
};
function hasModelPoolCapacityPolicy(input: Record<string, unknown>): boolean {
  return (
    input.capacityPriority !== undefined ||
    input.capacityConcurrencyLimit !== undefined ||
    input.capacityReservedSlots !== undefined ||
    input.capacityBorrowPolicy !== undefined ||
    input.capacityWaitBudgetMs !== undefined ||
    input.capacityContextCeiling !== undefined ||
    input.capacityContextMargin !== undefined
  );
}

function assertLossyDeveloperRoleCollapseRequiresAdaptation(
  {
    protocolAdaptationEnabled,
    allowLossyDeveloperRoleCollapse,
  }: {
    protocolAdaptationEnabled: boolean;
    allowLossyDeveloperRoleCollapse: boolean;
  },
  reason?: GuardedPoolCreateFailureReason,
): void {
  if (allowLossyDeveloperRoleCollapse && !protocolAdaptationEnabled) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Lossy developer-role collapse requires protocol adaptation to be enabled.",
      ...(reason !== undefined ? { data: { reason } } : {}),
    });
  }
}

function assertProviderEgressReleaseGate(reason?: GuardedPoolCreateFailureReason): void {
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
    throw new ORPCError("NOT_FOUND", {
      message: "Provider egress is not enabled for this deployment.",
      ...(reason !== undefined ? { data: { reason } } : {}),
    });
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function createPoolMember<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ORPCError("CONFLICT", {
        message: "That model is already a member of this pool.",
        cause: error,
      });
    }
    throw error;
  }
}

function assertConcurrencyPolicyWithinHardLimit(
  input: {
    hardLimit: number | null | undefined;
    poolLimit: number | null;
    poolReserved: number;
    memberMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
    memberLimit?: number | null;
    memberReserved?: number | null;
  },
  reasons?: CapacityPolicyFailureReasons,
): void {
  assertEffectiveConcurrencyPolicy(input, reasons);
}

/**
 * Seeds only capacities whose already-locked, fresh policies admit the
 * declared window. Callers acquire pool row locks first, then one sorted
 * union of target policy locks, then invoke this helper to read and write.
 */
async function seedDeclaredContextWindows({
  tx,
  userId,
  candidates,
  lockedExecutionTargetIds,
  additionalDependentsByCapacityId = new Map(),
}: {
  tx: Prisma.TransactionClient;
  userId: string;
  candidates: ReadonlyMap<string, number>;
  lockedExecutionTargetIds: ReadonlySet<string>;
  additionalDependentsByCapacityId?: ReadonlyMap<string, readonly ContextWindowSeedDependent[]>;
}): Promise<Map<string, number | null>> {
  if (candidates.size === 0) return new Map();
  const capacityIds = [...candidates.keys()];
  const capacities = await tx.inferenceCapacity.findMany({
    where: { userId, id: { in: capacityIds } },
    select: {
      id: true,
      physicalMaxContext: true,
      ExecutionTargets: {
        select: {
          id: true,
          directContextCeiling: true,
          directContextMargin: true,
          PoolMembers: {
            select: {
              capacityContextCeilingMode: true,
              capacityContextCeiling: true,
              capacityContextMargin: true,
              ModelPool: {
                select: { capacityContextCeiling: true, capacityContextMargin: true },
              },
            },
          },
        },
      },
    },
  });
  const physicalByCapacityId = new Map<string, number | null>();
  for (const capacity of capacities) {
    if (capacity.ExecutionTargets.some((target) => !lockedExecutionTargetIds.has(target.id))) {
      throw new Error("A declared context seed was evaluated without every target policy lock.");
    }
    const declared = candidates.get(capacity.id);
    if (declared === undefined) continue;
    const dependents: ContextWindowSeedDependent[] = capacity.ExecutionTargets.flatMap((target) => [
      {
        kind: "direct" as const,
        contextCeiling: target.directContextCeiling,
        contextMargin: target.directContextMargin,
      },
      ...target.PoolMembers.map(
        (member): ContextWindowSeedDependent => ({
          kind: "member",
          contextCeilingMode: member.capacityContextCeilingMode,
          contextCeiling: member.capacityContextCeiling,
          contextMargin: member.capacityContextMargin,
          poolContextCeiling: member.ModelPool.capacityContextCeiling,
          poolContextMargin: member.ModelPool.capacityContextMargin,
        }),
      ),
    ]);
    dependents.push(...(additionalDependentsByCapacityId.get(capacity.id) ?? []));
    if (
      capacity.physicalMaxContext === null &&
      isContextWindowSeedAdmissible(declared, dependents)
    ) {
      await tx.inferenceCapacity.updateMany({
        where: { id: capacity.id, userId, physicalMaxContext: null },
        data: { physicalMaxContext: declared },
      });
      physicalByCapacityId.set(capacity.id, declared);
    } else {
      physicalByCapacityId.set(capacity.id, capacity.physicalMaxContext);
    }
  }
  return physicalByCapacityId;
}

type UserSlugRow = {
  id: string;
  slug: string;
};

const listCliDevicesSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  label: true,
  status: true,
  lastConnectedAt: true,
  lastDisconnectedAt: true,
  lastHeartbeatAt: true,
  connectionCount: true,
  inventorySeq: true,
  inventoryDigest: true,
  inventoryAcknowledgedAt: true,
  inventoryConfirmed: true,
  endpointTargeting: true,
  allowHumanTerminal: true,
  allowMcpCommands: true,
  cliVersion: true,
  relayProtocolVersion: true,
  reportedHumanTerminal: true,
  reportedMcpCommands: true,
  reportedTerminalApproval: true,
  reportedTerminalSupported: true,
  User: { select: { slug: true } },
  Endpoints: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      slug: true,
      label: true,
      kind: true,
      status: true,
      defaultCapabilities: true,
      capabilityMetadata: true,
      probeSuggestions: true,
      lastSeenAt: true,
      lastHealthCheckAt: true,
      statusChangedAt: true,
      failureReasonCode: true,
      published: true,
      unpublishedAt: true,
      DiscoveredModels: {
        orderBy: { createdAt: "asc" as const },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          slug: true,
          upstreamModelId: true,
          encodedModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
          optimisticBasicTranscription: true,
          probeSuggestions: true,
          lastSeenAt: true,
          published: true,
          unpublishedAt: true,
          maxAttachmentBytes: true,
          ExecutionTarget: {
            select: {
              id: true,
              inferenceCapacityId: true,
              directPriority: true,
              directConcurrencyLimit: true,
              directReservedSlots: true,
              directBorrowPolicy: true,
              directWaitBudgetMs: true,
              directContextCeiling: true,
              directContextMargin: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CliDeviceSelect;

type CliDeviceRow = Prisma.CliDeviceGetPayload<{ select: typeof listCliDevicesSelect }>;
type EndpointRow = CliDeviceRow["Endpoints"][number];
type DiscoveredModelRow = EndpointRow["DiscoveredModels"][number];

type ModelPoolRow = Prisma.ModelPoolGetPayload<{ select: typeof poolSelect }>;
type PoolMemberModelRow = NonNullable<ModelPoolRow["PoolMembers"][number]["DiscoveredModel"]>;

async function assertAttachmentLimitWithinGlobal(maxAttachmentBytes: number | null | undefined) {
  if (maxAttachmentBytes === undefined || maxAttachmentBytes === null) return;
  const globalMax = resolveAttachmentLimit({
    configuredBytes: await getConfiguredMediaAttachmentMaxBytes(),
    deploymentMaxBytes: env.MEDIA_MAX_UPLOAD_BYTES,
  });
  if (maxAttachmentBytes > globalMax) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Attachment limit cannot exceed the global attachment limit.",
    });
  }
}

function slugValidationError(slug: string) {
  const result = validateForwarderSlug(slug);
  if (result.ok) return null;
  return new ORPCError("BAD_REQUEST", { message: `forwarderSlug.${result.reason}` });
}

async function currentUserSlug(userId: string): Promise<UserSlugRow> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, slug: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found." });
  return user;
}

async function assertUserSlugAvailable(slug: string, currentUserId: string) {
  const validationError = slugValidationError(slug);
  if (validationError) throw validationError;

  const existing = await prisma.user.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existing && existing.id !== currentUserId) {
    throw new ORPCError("CONFLICT", { message: "forwarderSlug.taken" });
  }
}

async function userSlugChangePreview({ userId, nextSlug }: { userId: string; nextSlug: string }) {
  const user = await currentUserSlug(userId);
  await assertUserSlugAvailable(nextSlug, userId);

  const [directRows, poolRows] = await Promise.all([
    prisma.discoveredModel.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        upstreamModelId: true,
        Endpoint: {
          select: {
            slug: true,
            CliDevice: { select: { slug: true } },
          },
        },
      },
    }),
    prisma.modelPool.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
      },
    }),
  ]);

  const directModels = directRows.map((model) => ({
    kind: "DIRECT_MODEL" as const,
    id: model.id,
    upstreamModelId: model.upstreamModelId,
    currentModelId: directModelId({
      userSlug: user.slug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
    nextModelId: directModelId({
      userSlug: nextSlug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
  }));

  const modelPools = poolRows.map((pool) => ({
    kind: "MODEL_POOL" as const,
    id: pool.id,
    name: pool.name,
    currentModelId: poolModelId({ userSlug: user.slug, poolSlug: pool.slug }),
    nextModelId: poolModelId({ userSlug: nextSlug, poolSlug: pool.slug }),
  }));

  return {
    currentSlug: user.slug,
    nextSlug,
    willChange: user.slug !== nextSlug,
    affectedModels: [...directModels, ...modelPools],
  };
}

async function serializeVisibleTargets(targets: VisibleModelTargets) {
  const [modalities, reasoning, poolRows] = await Promise.all([
    visibleModelAttachmentModalities(targets),
    visibleModelReasoning(targets),
    targets.modelPools.length
      ? prisma.modelPool.findMany({
          where: { id: { in: targets.modelPools.map((pool) => pool.id) } },
          select: poolSelect,
        })
      : [],
  ]);
  const poolCompatibility = new Map(
    poolRows.map((row) => {
      const serialized = serializePool(row);
      return [row.id, serialized.compatibility] as const;
    }),
  );
  return {
    directModels: targets.directModels.map((model) => ({
      target: model.target,
      id: model.id,
      modelId: model.modelId,
      upstreamModelId: model.upstreamModelId,
      ownerUserId: model.ownerUserId,
      ownerUserSlug: model.ownerUserSlug,
      endpointId: model.endpointId,
      endpointSlug: model.endpointSlug,
      cliDeviceSlug: model.cliDeviceSlug,
      maxAttachmentBytes: model.maxAttachmentBytes,
      attachmentModalities: modalities.directById.get(model.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
      reasoning: reasoning.directById.get(model.id) ?? {},
    })),
    modelPools: targets.modelPools.map((pool) => ({
      target: pool.target,
      id: pool.id,
      modelId: pool.modelId,
      name: pool.name,
      description: pool.description,
      ownerUserId: pool.ownerUserId,
      ownerUserSlug: pool.ownerUserSlug,
      poolSlug: pool.poolSlug,
      maxAttachmentBytes: pool.maxAttachmentBytes,
      publicEgressEnabled: pool.publicEgressEnabled,
      publicEgressAcknowledged: pool.publicEgressAcknowledged,
      compatibility: poolCompatibility.get(pool.id) ?? null,
      attachmentModalities: modalities.poolById.get(pool.id) ?? {
        image: false,
        audio: false,
        video: false,
      },
      reasoning: reasoning.poolById.get(pool.id) ?? {},
    })),
  };
}

function effectiveCapabilities(endpoint: EndpointRow, model: DiscoveredModelRow) {
  if (model.capabilityOverrideMode === "OVERRIDE") {
    return {
      coarse: model.capabilityOverrides,
      metadata: model.capabilityOverrideMetadata,
      source: "MODEL_OVERRIDE" as const,
    };
  }
  return {
    coarse: endpoint.defaultCapabilities,
    metadata: endpoint.capabilityMetadata,
    source: "ENDPOINT_DEFAULT" as const,
  };
}

function liveTerminalFeature(snapshot: LiveCliFeatureSnapshot | null): boolean {
  return (
    snapshot?.protocolVersion === "2.4" &&
    snapshot.humanTerminal === true &&
    snapshot.terminalSupported === true
  );
}

function liveCommandFeature(snapshot: LiveCliFeatureSnapshot | null): boolean {
  return snapshot?.protocolVersion === "2.4" && snapshot.mcpCommands === true;
}

function serializeCliDevice(row: CliDeviceRow, now: Date, live: LiveCliFeatureSnapshot | null) {
  const terminalLive = liveTerminalFeature(live);
  const commandsLive = liveCommandFeature(live);
  const terminalDeviceAllows = row.reportedHumanTerminal ?? null;
  const terminalSupported = row.reportedTerminalSupported ?? null;
  const commandsDeviceAllows = row.reportedMcpCommands ?? null;
  const staleAt = row.lastHeartbeatAt
    ? new Date(row.lastHeartbeatAt.getTime() + CLI_HEARTBEAT_STALE_AFTER_MS)
    : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    label: row.label,
    status: row.status,
    lastConnectedAt: row.lastConnectedAt,
    lastDisconnectedAt: row.lastDisconnectedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    staleAt,
    isStale: Boolean(staleAt && staleAt <= now),
    connectionCount: row.connectionCount,
    inventorySeq: row.inventorySeq,
    inventoryDigest: row.inventoryDigest,
    inventoryAcknowledgedAt: row.inventoryAcknowledgedAt,
    inventoryConfirmed: row.inventoryConfirmed,
    endpointTargeting: row.endpointTargeting,
    cliVersion: row.cliVersion ?? null,
    relayProtocolVersion: row.relayProtocolVersion ?? null,
    features: {
      terminal: {
        granted: row.allowHumanTerminal === true,
        deviceAllows: terminalDeviceAllows,
        supported: terminalSupported,
        live: terminalLive,
        available:
          row.allowHumanTerminal === true &&
          terminalDeviceAllows === true &&
          terminalLive &&
          terminalSupported === true,
      },
      commands: {
        granted: row.allowMcpCommands === true,
        deviceAllows: commandsDeviceAllows,
        live: commandsLive,
        available: row.allowMcpCommands === true && commandsDeviceAllows === true && commandsLive,
      },
    },
    endpoints: row.Endpoints.map((endpoint) => ({
      id: endpoint.id,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      slug: endpoint.slug,
      label: endpoint.label,
      kind: endpoint.kind,
      status: endpoint.status,
      defaultCapabilities: endpoint.defaultCapabilities,
      capabilityMetadata: endpoint.capabilityMetadata,
      probeSuggestions: endpoint.probeSuggestions,
      lastSeenAt: endpoint.lastSeenAt,
      lastHealthCheckAt: endpoint.lastHealthCheckAt,
      statusChangedAt: endpoint.statusChangedAt,
      failureReasonCode: endpoint.failureReasonCode,
      published: endpoint.published,
      unpublishedAt: endpoint.unpublishedAt,
      models: endpoint.DiscoveredModels.map((model) => ({
        id: model.id,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
        slug: model.slug,
        upstreamModelId: model.upstreamModelId,
        canonicalModelId: directModelId({
          userSlug: row.User.slug,
          cliSlug: row.slug,
          endpointSlug: endpoint.slug,
          upstreamModelId: model.upstreamModelId,
        }),
        capabilityOverrideMode: model.capabilityOverrideMode,
        capabilityOverrides: model.capabilityOverrides,
        capabilityOverrideMetadata: model.capabilityOverrideMetadata,
        optimisticBasicTranscription: model.optimisticBasicTranscription,
        probeSuggestions: model.probeSuggestions,
        effectiveCapabilities: effectiveCapabilities(endpoint, model),
        suggestedConnectionType: (() => {
          const effective = effectiveCapabilities(endpoint, model);
          return suggestedConnectionSurface({
            // Match pool semantics: structured capability metadata takes
            // precedence, with the historical coarse inventory as a safe
            // fallback for older CLI connections.
            capabilities:
              parseOpenAiCompatibleCapabilities(effective.metadata) ??
              openAiCapabilitiesFromCoarse(effective.coarse),
          });
        })(),
        lastSeenAt: model.lastSeenAt,
        published: model.published,
        unpublishedAt: model.unpublishedAt,
        maxAttachmentBytes: model.maxAttachmentBytes,
        executionTarget: model.ExecutionTarget ?? null,
      })),
    })),
  };
}

function serializePool(row: ModelPoolRow) {
  const protocolAdaptationAvailable = env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED;
  const adaptationEnabled = row.protocolAdaptationEnabled && protocolAdaptationAvailable;
  const recommendedSurfaceOverride = parseModelApiSurface(row.recommendedSurfaceOverride);
  const memberCapabilities = (model: PoolMemberModelRow) =>
    discoveredModelSurfaceCapabilities(model);
  const memberMatrices = row.PoolMembers.map((member) => {
    const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
    if (model)
      return {
        tier: member.tier,
        matrix: surfaceAvailabilityMatrix({
          capabilities: memberCapabilities(model),
          adaptationEnabled,
        }),
      };
    const provider = member.ExecutionTarget?.ProviderModel;
    // Single shared provider-capability resolution: structured inventories
    // parse directly, while legacy raw-surface shapes are normalized, so the
    // dashboard matrix and the selectability gates can never drift.
    const providerInventory = providerModelSurfaceCapabilities(provider?.nativeCapabilities);
    return {
      tier: member.tier,
      matrix: surfaceAvailabilityMatrix({
        capabilities: providerInventory,
        adaptationEnabled,
      }),
    };
  });
  const surfaces = Object.fromEntries(
    modelApiSurfaces.map((surface) => {
      const entries = memberMatrices.map(({ matrix }) => matrix[surface]);
      const tierCounts = (tier: "PRIMARY" | "PUBLIC_OVERFLOW") => {
        const tierEntries = memberMatrices
          .filter((entry) => entry.tier === tier)
          .map(({ matrix }) => matrix[surface]);
        return {
          native: tierEntries.filter((entry) => entry.mode === "native").length,
          adapted: tierEntries.filter((entry) => entry.mode === "adapted").length,
          unavailable: tierEntries.filter((entry) => entry.mode === "unavailable").length,
        };
      };
      return [
        surface,
        {
          native: entries.filter((entry) => entry.mode === "native").length,
          adapted: entries.filter((entry) => entry.mode === "adapted").length,
          unavailable: entries.filter((entry) => entry.mode === "unavailable").length,
          streaming: entries.some((entry) => entry.mode !== "unavailable" && entry.streaming),
          limitations: [...new Set(entries.flatMap((entry) => entry.limitations))],
          primary: tierCounts("PRIMARY"),
          publicOverflow: tierCounts("PUBLIC_OVERFLOW"),
        },
      ];
    }),
  ) as Record<
    ModelApiSurface,
    {
      native: number;
      adapted: number;
      unavailable: number;
      streaming: boolean;
      limitations: string[];
      primary: { native: number; adapted: number; unavailable: number };
      publicOverflow: { native: number; adapted: number; unavailable: number };
    }
  >;
  const suggestedSurface = suggestedConnectionSurface({
    surfaces: Object.fromEntries(
      ["OPENAI_RESPONSES", "OPENAI_CHAT_COMPLETIONS", "ANTHROPIC_MESSAGES"].map((surface) => [
        surface,
        {
          native: surfaces[surface as ModelApiSurface].primary.native,
          adapted: surfaces[surface as ModelApiSurface].primary.adapted,
        },
      ]),
    ),
  });
  const recommendedSurface = recommendedSurfaceOverride ?? suggestedSurface;
  const transformerModel = row.TransformerDiscoveredModel
    ? {
        id: row.TransformerDiscoveredModel.id,
        upstreamModelId: row.TransformerDiscoveredModel.upstreamModelId,
        canonicalModelId: directModelId({
          userSlug: row.TransformerDiscoveredModel.User.slug,
          cliSlug: row.TransformerDiscoveredModel.Endpoint.CliDevice.slug,
          endpointSlug: row.TransformerDiscoveredModel.Endpoint.slug,
          upstreamModelId: row.TransformerDiscoveredModel.upstreamModelId,
        }),
        endpointId: row.TransformerDiscoveredModel.Endpoint.id,
        endpointSlug: row.TransformerDiscoveredModel.Endpoint.slug,
        cliDeviceSlug: row.TransformerDiscoveredModel.Endpoint.CliDevice.slug,
      }
    : null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    slug: row.slug,
    name: row.name,
    description: row.description,
    maxAttachmentBytes: row.maxAttachmentBytes,
    optimisticBasicTranscription: row.optimisticBasicTranscription,
    protocolAdaptationEnabled: row.protocolAdaptationEnabled,
    protocolAdaptationAvailable,
    publicEgressEnabled: row.publicEgressEnabled,
    publicEgressAcknowledged: row.publicEgressAcknowledged,
    allowLossyDeveloperRoleCollapse: row.allowLossyDeveloperRoleCollapse,
    recommendedSurfaceOverride,
    capacityPriority: row.capacityPriority,
    capacityConcurrencyLimit: row.capacityConcurrencyLimit,
    capacityReservedSlots: row.capacityReservedSlots,
    capacityBorrowPolicy: row.capacityBorrowPolicy,
    capacityWaitBudgetMs: row.capacityWaitBudgetMs,
    capacityContextCeiling: row.capacityContextCeiling,
    capacityContextMargin: row.capacityContextMargin,
    affinity: {
      enabled: row.affinityEnabled,
      ttlSeconds: row.affinityTtlSeconds,
      maxRecords: row.affinityMaxRecords,
      prefixWeight: row.affinityPrefixWeight,
      conversationWeight: row.affinityConversationWeight,
      confirmedCacheWeight: row.affinityConfirmedCacheWeight,
      loadPenaltyWeight: row.affinityLoadPenaltyWeight,
    },
    compatibility: {
      recommendedSurface,
      suggestedConnectionType: suggestedSurface,
      surfaces,
      warnings: [
        ...(adaptationEnabled ? ["adaptation_strict_subset"] : []),
        ...(adaptationEnabled && row.allowLossyDeveloperRoleCollapse
          ? ["developer_role_collapse_lossy"]
          : []),
        ...(recommendedSurfaceOverride &&
        surfaces[recommendedSurfaceOverride].unavailable === row.PoolMembers.length
          ? ["recommended_surface_unavailable"]
          : []),
      ],
    },
    canonicalModelId: poolModelId({ userSlug: row.User.slug, poolSlug: row.slug }),
    transformer: {
      discoveredModelId: row.transformerDiscoveredModelId,
      systemPrompt: row.transformerSystemPrompt,
      images: row.transformerImages,
      audio: row.transformerAudio,
      video: row.transformerVideo,
      cacheMode: row.transformerCacheMode,
      includePrimaryTools: row.transformerIncludePrimaryTools,
      maxTools: row.transformerMaxTools,
      maxToolChars: row.transformerMaxToolChars,
      timeoutMs: row.transformerTimeoutMs,
      maxAssets: row.transformerMaxAssets,
      model: transformerModel,
    },
    members: row.PoolMembers.map((member, memberIndex) => {
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      return {
        id: member.id,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
        discoveredModelId: model?.id ?? member.discoveredModelId,
        tier: member.tier,
        publicOrder: member.publicOrder,
        executionTargetId: member.ExecutionTarget?.id ?? null,
        inferenceCapacityId: member.ExecutionTarget?.inferenceCapacityId ?? null,
        capacityPriority: member.capacityPriority,
        capacityConcurrencyMode: member.capacityConcurrencyMode,
        capacityConcurrencyLimit: member.capacityConcurrencyLimit,
        capacityReservedSlots: member.capacityReservedSlots,
        capacityBorrowPolicy: member.capacityBorrowPolicy,
        capacityWaitBudgetMode: member.capacityWaitBudgetMode,
        capacityWaitBudgetMs: member.capacityWaitBudgetMs,
        capacityContextCeilingMode: member.capacityContextCeilingMode,
        capacityContextCeiling: member.capacityContextCeiling,
        capacityContextMargin: member.capacityContextMargin,
        weight: member.weight,
        healthStatus: member.healthStatus,
        routingStatus: member.routingStatus,
        lastFailureClass: member.lastFailureClass,
        consecutiveRetryableFailures: member.consecutiveRetryableFailures,
        lastFailureAt: member.lastFailureAt,
        nextRetryAt: member.nextRetryAt,
        halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
        model: model
          ? {
              id: model.id,
              upstreamModelId: model.upstreamModelId,
              canonicalModelId: directModelId({
                userSlug: model.User.slug,
                cliSlug: model.Endpoint.CliDevice.slug,
                endpointSlug: model.Endpoint.slug,
                upstreamModelId: model.upstreamModelId,
              }),
              endpointId: model.Endpoint.id,
              endpointSlug: model.Endpoint.slug,
              cliDeviceSlug: model.Endpoint.CliDevice.slug,
              declaredContextWindow: declaredContextWindow(memberCapabilities(model)),
              surfaces: surfaceAvailabilityMatrix({
                capabilities: memberCapabilities(model),
                adaptationEnabled,
              }),
            }
          : null,
        providerModel: member.ExecutionTarget?.ProviderModel
          ? {
              id: member.ExecutionTarget.ProviderModel.id,
              upstreamModelId: member.ExecutionTarget.ProviderModel.upstreamModelId,
              displayName: member.ExecutionTarget.ProviderModel.displayName,
              healthStatus: member.ExecutionTarget.ProviderModel.healthStatus,
              enabled: member.ExecutionTarget.ProviderModel.enabled,
              ProviderAccount: member.ExecutionTarget.ProviderModel.ProviderAccount,
              pricingVersion:
                member.ExecutionTarget.ProviderModel.PricingVersions[0]?.version ?? null,
              pricingCurrency:
                member.ExecutionTarget.ProviderModel.PricingVersions[0]?.currency ?? null,
              surfaces: memberMatrices[memberIndex]!.matrix,
            }
          : null,
      };
    }),
    grants: row.PoolGrants.map((grant) => ({
      id: grant.id,
      createdAt: grant.createdAt,
      granteeUserId: grant.granteeUserId,
      granteeEmail: grant.Grantee.email,
      granteeName: grant.Grantee.name,
    })),
  };
}

async function ownedPool(poolId: string, userId: string) {
  const pool = await prisma.modelPool.findUnique({
    where: { id: poolId },
    select: { id: true, userId: true, publicEgressEnabled: true },
  });
  if (!pool || pool.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
  }
  return pool;
}

async function ownedDiscoveredModel(discoveredModelId: string, userId: string) {
  const model = await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      userId: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      capabilityOverrides: true,
      Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
    },
  });
  if (!model || model.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  return model;
}

async function transformerCapabilitiesForOwnedModel(
  discoveredModelId: string,
  userId: string,
): Promise<ReturnType<typeof transformerSupportedModalities>> {
  const model = await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      userId: true,
      published: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      Endpoint: { select: { published: true, capabilityMetadata: true } },
    },
  });
  if (!model || model.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  if (!model.published || !model.Endpoint.published) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Transformer model must be published (model and endpoint).",
    });
  }
  const caps = resolveEffectiveCapabilityMetadata({
    capabilityOverrideMode: model.capabilityOverrideMode,
    capabilityOverrideMetadata: model.capabilityOverrideMetadata,
    endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
  });
  return transformerSupportedModalities(caps);
}

function assertTransformerMatchesModalities({
  caps,
  images,
  audio,
  video,
}: {
  caps: ReturnType<typeof transformerSupportedModalities>;
  images: boolean;
  audio: boolean;
  video: boolean;
}) {
  const errors = transformerModalityMismatchErrors({
    pool: { images, audio, video },
    transformerCaps: caps,
  });
  if (errors.length > 0) {
    throw new ORPCError("BAD_REQUEST", { message: errors.join(" ") });
  }
}

async function assertPoolTransformerIsValid(
  input: {
    transformerDiscoveredModelId?: string | null;
    transformerImages?: boolean;
    transformerAudio?: boolean;
    transformerVideo?: boolean;
  },
  current: {
    transformerDiscoveredModelId: string | null;
    transformerImages: boolean;
    transformerAudio: boolean;
    transformerVideo: boolean;
  },
  userId: string,
): Promise<void> {
  const discoveredModelId =
    input.transformerDiscoveredModelId !== undefined
      ? input.transformerDiscoveredModelId
      : current.transformerDiscoveredModelId;
  if (!discoveredModelId) return;
  const caps = await transformerCapabilitiesForOwnedModel(discoveredModelId, userId);
  assertTransformerMatchesModalities({
    caps,
    images: input.transformerImages ?? current.transformerImages,
    audio: input.transformerAudio ?? current.transformerAudio,
    video: input.transformerVideo ?? current.transformerVideo,
  });
}

export async function assertPoolSlugAvailable(
  slug: string,
  userId: string,
  currentPoolId?: string,
  reasons?: {
    invalid?: GuardedPoolCreateFailureReason;
    taken?: GuardedPoolCreateFailureReason;
  },
) {
  const validation = validateForwarderPoolSlug(slug);
  if (!validation.ok) {
    throw new ORPCError("BAD_REQUEST", {
      message: "forwarderSlug." + validation.reason,
      ...(reasons?.invalid !== undefined ? { data: { reason: reasons.invalid } } : {}),
    });
  }

  const existing = await prisma.modelPool.findUnique({
    where: { userId_slug: { userId, slug } },
    select: { id: true },
  });
  if (existing && existing.id !== currentPoolId) {
    throw new ORPCError("CONFLICT", {
      message: "Model pool slug already exists.",
      ...(reasons?.taken !== undefined ? { data: { reason: reasons.taken } } : {}),
    });
  }
}

/**
 * Advisory (non-blocking) impact report for a discovered-model edit: which
 * pools' effective recommended surface is now unservable after the write.
 * Computed from the post-edit member state; never throws.
 */
async function discoveredModelEditImpact(discoveredModelId: string, userId: string) {
  return capabilityEditImpactedPools(prisma, {
    userId,
    poolIds: await poolIdsWithMembers(
      prisma,
      userId,
      discoveredModelPoolMemberWhere(discoveredModelId),
    ),
  });
}

async function removeOwnedRow({
  kind,
  id,
  userId,
  staleBefore,
}: {
  kind: "cliDevice" | "endpoint" | "discoveredModel";
  id: string;
  userId: string;
  staleBefore?: Date;
}) {
  if (kind === "cliDevice") {
    const row = await prisma.cliDevice.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, lastHeartbeatAt: true },
    });
    if (!row || row.userId !== userId) {
      throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
    }
    if (staleBefore && row.lastHeartbeatAt && row.lastHeartbeatAt >= staleBefore) {
      throw new ORPCError("CONFLICT", { message: "CLI device is not stale." });
    }
    await prisma.cliDevice.delete({ where: { id } });
    return { deleted: true };
  }

  if (kind === "endpoint") {
    const row = await prisma.endpoint.findUnique({
      where: { id },
      select: { id: true, userId: true, lastSeenAt: true },
    });
    if (!row || row.userId !== userId) {
      throw new ORPCError("NOT_FOUND", { message: "Endpoint not found." });
    }
    if (staleBefore && row.lastSeenAt && row.lastSeenAt >= staleBefore) {
      throw new ORPCError("CONFLICT", { message: "Endpoint is not stale." });
    }
    await prisma.endpoint.delete({ where: { id } });
    return { deleted: true };
  }

  const row = await prisma.discoveredModel.findUnique({
    where: { id },
    select: { id: true, userId: true, lastSeenAt: true },
  });
  if (!row || row.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
  }
  if (staleBefore && row.lastSeenAt && row.lastSeenAt >= staleBefore) {
    throw new ORPCError("CONFLICT", { message: "Discovered model is not stale." });
  }
  await prisma.discoveredModel.delete({ where: { id } });
  return { deleted: true };
}

const poolSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  slug: true,
  name: true,
  description: true,
  maxAttachmentBytes: true,
  optimisticBasicTranscription: true,
  protocolAdaptationEnabled: true,
  publicEgressEnabled: true,
  publicEgressAcknowledged: true,
  allowLossyDeveloperRoleCollapse: true,
  recommendedSurfaceOverride: true,
  capacityPriority: true,
  capacityConcurrencyLimit: true,
  capacityReservedSlots: true,
  capacityBorrowPolicy: true,
  capacityWaitBudgetMs: true,
  capacityContextCeiling: true,
  capacityContextMargin: true,
  affinityEnabled: true,
  affinityTtlSeconds: true,
  affinityMaxRecords: true,
  affinityPrefixWeight: true,
  affinityConversationWeight: true,
  affinityConfirmedCacheWeight: true,
  affinityLoadPenaltyWeight: true,
  transformerDiscoveredModelId: true,
  transformerSystemPrompt: true,
  transformerImages: true,
  transformerAudio: true,
  transformerVideo: true,
  transformerCacheMode: true,
  transformerIncludePrimaryTools: true,
  transformerMaxTools: true,
  transformerMaxToolChars: true,
  transformerTimeoutMs: true,
  transformerMaxAssets: true,
  User: { select: { slug: true } },
  TransformerDiscoveredModel: {
    select: {
      id: true,
      upstreamModelId: true,
      User: { select: { slug: true } },
      Endpoint: {
        select: {
          id: true,
          slug: true,
          CliDevice: { select: { slug: true } },
        },
      },
    },
  },
  PoolMembers: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      discoveredModelId: true,
      tier: true,
      publicOrder: true,
      ExecutionTarget: {
        select: {
          id: true,
          kind: true,
          inferenceCapacityId: true,
          DiscoveredModel: {
            select: {
              id: true,
              upstreamModelId: true,
              capabilityOverrideMode: true,
              capabilityOverrides: true,
              capabilityOverrideMetadata: true,
              User: { select: { slug: true } },
              Endpoint: {
                select: {
                  id: true,
                  slug: true,
                  capabilityMetadata: true,
                  defaultCapabilities: true,
                  CliDevice: { select: { slug: true } },
                },
              },
            },
          },
          ProviderModel: {
            select: {
              id: true,
              upstreamModelId: true,
              displayName: true,
              nativeCapabilities: true,
              contextWindow: true,
              concurrencyLimit: true,
              healthStatus: true,
              enabled: true,
              PricingVersions: {
                where: { status: "ACTIVE" as const, retiredAt: null },
                orderBy: { effectiveAt: "desc" as const },
                take: 1,
                select: { version: true, currency: true },
              },
              ProviderAccount: {
                select: { id: true, label: true, providerType: true, enabled: true },
              },
            },
          },
        },
      },
      weight: true,
      capacityPriority: true,
      capacityConcurrencyMode: true,
      capacityConcurrencyLimit: true,
      capacityReservedSlots: true,
      capacityBorrowPolicy: true,
      capacityWaitBudgetMode: true,
      capacityWaitBudgetMs: true,
      capacityContextCeilingMode: true,
      capacityContextCeiling: true,
      capacityContextMargin: true,
      healthStatus: true,
      routingStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
      DiscoveredModel: {
        select: {
          id: true,
          upstreamModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
          User: { select: { slug: true } },
          Endpoint: {
            select: {
              id: true,
              slug: true,
              capabilityMetadata: true,
              defaultCapabilities: true,
              CliDevice: { select: { slug: true } },
            },
          },
        },
      },
    },
  },
  PoolGrants: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      createdAt: true,
      granteeUserId: true,
      Grantee: { select: { email: true, name: true } },
    },
  },
} satisfies Prisma.ModelPoolSelect;

export const forwarderManagementRouter = {
  listGuardedOverflowCandidates: protectedProcedure.handler(async ({ context }) => {
    const now = new Date();
    const rows = await prisma.providerModel.findMany({
      where: {
        userId: context.session.user.id,
        enabled: true,
        deletedAt: null,
        ProviderAccount: {
          enabled: true,
          deletedAt: null,
          CurrentCredential: { status: "ACTIVE" },
        },
        PricingVersions: {
          some: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
        },
      },
      select: {
        id: true,
        upstreamModelId: true,
        displayName: true,
        nativeCapabilities: true,
        capabilityMetadata: true,
        contextWindow: true,
        concurrencyLimit: true,
        ProviderAccount: { select: { id: true, label: true, providerType: true } },
        PricingVersions: {
          where: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
          orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true, version: true, currency: true },
        },
      },
      orderBy: [{ ProviderAccount: { label: "asc" } }, { upstreamModelId: "asc" }],
    });
    return rows.flatMap((row) => {
      const pricing = row.PricingVersions[0];
      return pricing
        ? [
            {
              id: row.id,
              upstreamModelId: row.upstreamModelId,
              displayName: row.displayName,
              nativeCapabilities: row.nativeCapabilities,
              capabilityMetadata: row.capabilityMetadata,
              contextWindow: row.contextWindow,
              concurrencyLimit: row.concurrencyLimit,
              providerAccount: row.ProviderAccount,
              pricing,
            },
          ]
        : [];
    });
  }),
  createGuardedModelPool: protectedProcedure
    .input(
      (() => {
        const positiveDecimal = z
          .string()
          .regex(/^\d+(?:\.\d{1,9})?$/)
          .refine((value) => new Prisma.Decimal(value).greaterThan(0));
        const integerRule = (maximum: number) =>
          z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("UNLIMITED"), limitValue: z.null() }),
            z.object({
              mode: z.literal("LIMITED"),
              limitValue: z.number().int().min(1).max(maximum),
            }),
          ]);
        const spendRule = z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("UNLIMITED"), limitValue: z.null() }),
          z.object({ mode: z.literal("LIMITED"), limitValue: positiveDecimal }),
        ]);
        return z
          .object({
            slug: poolSlugSchema,
            name: poolNameSchema,
            localModelIds: z.array(idSchema).max(64),
            recommendedSurface: z.enum(modelApiSurfaces),
            memberConcurrencyLimit: z.number().int().min(1).max(10_000),
            memberContextCeiling: z.number().int().min(1).max(100_000_000).nullable().default(null),
            reservedSlots: z.number().int().min(0).max(10_000),
            localWaitBudgetMs: z.number().int().min(0).max(600_000),
            publicEgressAcknowledged: z.boolean(),
            advanced: z
              .object({
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
                affinity: z.object({
                  enabled: z.boolean(),
                  ttlSeconds: z.number().int().min(60).max(604_800),
                  maxRecords: z.number().int().min(100).max(100_000),
                  prefixWeight: z.number().int().min(0).max(10_000),
                  conversationWeight: z.number().int().min(0).max(10_000),
                  confirmedCacheWeight: z.number().int().min(0).max(10_000),
                  loadPenaltyWeight: z.number().int().min(0).max(10_000),
                }),
                memberOverrides: z
                  .array(
                    z.object({
                      discoveredModelId: idSchema,
                      concurrency: integerRule(10_000),
                      reservedSlots: z.number().int().min(0).max(10_000),
                      borrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
                      waitBudget: integerRule(600_000),
                      contextCeiling: z.union([
                        z.object({ mode: z.literal("INHERIT"), limitValue: z.null() }),
                        integerRule(100_000_000),
                      ]),
                      contextMargin: z.number().int().min(0).max(10_000_000),
                    }),
                  )
                  .max(64),
              })
              .optional(),
            providerModels: z
              .array(
                z.object({
                  providerModelId: idSchema,
                  tier: z.enum(["PRIMARY", "PUBLIC_OVERFLOW"]).default("PUBLIC_OVERFLOW"),
                  concurrencyLimit: z.number().int().min(1).max(10_000),
                  dailySpendLimit: z.string(),
                  budgetRules: z
                    .object({
                      concurrency: integerRule(10_000),
                      tokensPerAttempt: integerRule(100_000_000_000),
                      tokensPerDay: integerRule(100_000_000_000),
                      tokensPerMonth: integerRule(100_000_000_000),
                      tokensLifetime: integerRule(100_000_000_000),
                      spendPerDay: spendRule,
                      spendPerMonth: spendRule,
                    })
                    .optional(),
                }),
              )
              .max(32),
          })
          .superRefine((input, ctx) => {
            if (input.localModelIds.length + input.providerModels.length === 0) {
              ctx.addIssue({
                code: "custom",
                path: ["localModelIds"],
                message: "Select at least one local or provider target",
              });
            }
            if (input.reservedSlots > input.memberConcurrencyLimit) {
              ctx.addIssue({
                code: "custom",
                path: ["reservedSlots"],
                message: "Reserved slots exceed member concurrency",
              });
            }
            if (input.providerModels.length > 0 && !input.publicEgressAcknowledged) {
              ctx.addIssue({
                code: "custom",
                path: ["publicEgressAcknowledged"],
                message: "Provider egress acknowledgement is required",
              });
            }
            if (new Set(input.localModelIds).size !== input.localModelIds.length) {
              ctx.addIssue({
                code: "custom",
                path: ["localModelIds"],
                message: "Duplicate local model",
              });
            }
            if (
              new Set(input.providerModels.map((item) => item.providerModelId)).size !==
              input.providerModels.length
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["providerModels"],
                message: "Duplicate provider model",
              });
            }
            if (
              input.advanced &&
              new Set(input.advanced.memberOverrides.map((item) => item.discoveredModelId)).size !==
                input.advanced.memberOverrides.length
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["advanced", "memberOverrides"],
                message: "Duplicate local member override",
              });
            }
            for (const [index, provider] of input.providerModels.entries()) {
              if (
                !provider.budgetRules &&
                !positiveDecimal.safeParse(provider.dailySpendLimit).success
              )
                ctx.addIssue({
                  code: "custom",
                  path: ["providerModels", index, "dailySpendLimit"],
                  message: "Legacy guarded setup requires a positive daily spend limit",
                });
            }
          });
      })(),
    )
    .handler(async ({ input, context }) => {
      if (input.providerModels.length > 0)
        assertProviderEgressReleaseGate("PROVIDER_EGRESS_DISABLED");
      assertLossyDeveloperRoleCollapseRequiresAdaptation(
        {
          protocolAdaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
          allowLossyDeveloperRoleCollapse: input.advanced?.allowLossyDeveloperRoleCollapse ?? false,
        },
        "LOSSY_COLLAPSE_REQUIRES_ADAPTATION",
      );
      assertModelPoolCapacityPolicy(
        {
          concurrencyLimit: input.memberConcurrencyLimit,
          reservedSlots: input.reservedSlots,
          contextCeiling: input.memberContextCeiling,
          contextMargin: input.advanced?.contextMargin,
        },
        "POOL_POLICY_INVALID",
      );
      const userId = context.session.user.id;
      await assertPoolSlugAvailable(input.slug, userId, undefined, {
        invalid: "SLUG_INVALID",
        taken: "SLUG_TAKEN",
      });
      const now = new Date();
      return runSerializableTransaction(async (tx) => {
        const localModels = await tx.discoveredModel.findMany({
          where: {
            id: { in: input.localModelIds },
            userId,
            published: true,
            Endpoint: { published: true },
          },
          select: {
            id: true,
            upstreamModelId: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
            Endpoint: {
              select: { capabilityMetadata: true, defaultCapabilities: true },
            },
          },
        });
        if (localModels.length !== input.localModelIds.length) {
          throw new ORPCError("NOT_FOUND", {
            message: "A selected local model is unavailable",
            data: { reason: "LOCAL_MODEL_UNAVAILABLE" },
          });
        }
        const providerIds = input.providerModels.map((item) => item.providerModelId);
        const hasPublicOverflow = input.providerModels.some(
          (item) => item.tier === "PUBLIC_OVERFLOW",
        );
        const providers = providerIds.length
          ? await tx.providerModel.findMany({
              where: {
                id: { in: providerIds },
                userId,
                enabled: true,
                deletedAt: null,
                ProviderAccount: {
                  enabled: true,
                  deletedAt: null,
                  CurrentCredential: { status: "ACTIVE" },
                },
              },
              select: {
                id: true,
                providerAccountId: true,
                upstreamModelId: true,
                contextWindow: true,
                concurrencyLimit: true,
                nativeCapabilities: true,
                PricingVersions: {
                  where: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
                  orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
                  take: 1,
                  select: { id: true, currency: true },
                },
              },
            })
          : [];
        if (
          providers.length !== providerIds.length ||
          providers.some((row) => !row.PricingVersions[0])
        ) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message: "A selected provider is not ready for guarded routing",
            data: { reason: "PROVIDER_NOT_READY" },
          });
        }
        const primaryProviderIds = new Set(
          input.providerModels
            .filter((item) => item.tier === "PRIMARY")
            .map((item) => item.providerModelId),
        );
        // The recommended API is an operator choice: any surface that every
        // primary member can serve — natively or via protocol adaptation — is
        // accepted, not only the top-ranked one. An empty primary set (a
        // provider-only PUBLIC_OVERFLOW pool) accepts any surface. The
        // selectability contract is shared with the update path via
        // assertRecommendedSurfaceServable.
        assertRecommendedSurfaceServable({
          override: input.recommendedSurface,
          members: [
            ...localModels.map((model) => ({
              tier: "PRIMARY" as const,
              capabilities: discoveredModelSurfaceCapabilities(model),
            })),
            ...providers.map((provider) => ({
              tier: primaryProviderIds.has(provider.id) ? ("PRIMARY" as const) : "PUBLIC_OVERFLOW",
              capabilities: providerModelSurfaceCapabilities(provider.nativeCapabilities),
            })),
          ],
          adaptationEnabled:
            (input.advanced?.protocolAdaptationEnabled ?? false) &&
            env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
        });
        const localTargets = await tx.executionTarget.findMany({
          where: { userId, discoveredModelId: { in: input.localModelIds } },
          select: {
            id: true,
            discoveredModelId: true,
            inferenceCapacityId: true,
            InferenceCapacity: {
              select: { physicalMaxContext: true, hardConcurrencyLimit: true },
            },
          },
        });
        if (
          localTargets.length !== localModels.length ||
          localTargets.some((target) => !target.inferenceCapacityId)
        ) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message:
              "Every selected local model must already have an explicitly assigned physical capacity.",
            data: { reason: "LOCAL_CAPACITY_REQUIRED" },
          });
        }
        const declaredContextByModelId = new Map(
          localModels.map((model) => [
            model.id,
            declaredContextWindow(
              resolveEffectiveCapabilityMetadata({
                capabilityOverrideMode: model.capabilityOverrideMode,
                capabilityOverrideMetadata: model.capabilityOverrideMetadata,
                endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
              }),
            ),
          ]),
        );
        const memberOverrideByModelId = new Map(
          input.advanced?.memberOverrides.map((override) => [
            override.discoveredModelId,
            override,
          ]) ?? [],
        );
        if (
          memberOverrideByModelId.size > 0 &&
          [...memberOverrideByModelId.keys()].some(
            (modelId) => !input.localModelIds.includes(modelId),
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A member override does not belong to a selected local model.",
            data: { reason: "MEMBER_OVERRIDE_MISMATCH" },
          });
        }
        for (const target of localTargets) {
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          assertConcurrencyPolicyWithinHardLimit(
            {
              hardLimit: target.InferenceCapacity?.hardConcurrencyLimit,
              poolLimit: input.memberConcurrencyLimit,
              poolReserved: input.reservedSlots,
              memberMode: override?.concurrency.mode,
              memberLimit:
                override?.concurrency.mode === "LIMITED" ? override.concurrency.limitValue : null,
              memberReserved: override?.reservedSlots,
            },
            {
              reservedExceeds: "RESERVED_EXCEEDS_CONCURRENCY",
              reservedExceedsPhysical: "RESERVED_EXCEEDS_PHYSICAL",
              concurrencyExceedsPhysical: "CONCURRENCY_EXCEEDS_PHYSICAL",
            },
          );
          if (!override) continue;
          if (
            override.concurrency.mode === "LIMITED" &&
            override.reservedSlots > override.concurrency.limitValue
          ) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Reserved slots exceed a member concurrency override.",
              data: { reason: "RESERVED_EXCEEDS_CONCURRENCY" },
            });
          }
        }
        // Stable mutation order for mixed local/provider setup:
        // identity fences -> target rows (sorted policy locks) -> capacities.
        await lockExecutionTargetIdentities(
          tx,
          providers.map((provider) => `provider-model:${provider.id}`),
        );
        const orderedProviders = [...providers].sort((left, right) =>
          left.id.localeCompare(right.id),
        );
        const providerTargets = await Promise.all(
          orderedProviders.map((provider) =>
            tx.executionTarget.upsert({
              where: { providerModelId: provider.id },
              update: {},
              create: {
                userId,
                kind: "PROVIDER_MODEL",
                providerModelId: provider.id,
              },
              select: { id: true, providerModelId: true, inferenceCapacityId: true },
            }),
          ),
        );
        const seedCandidates = new Map<string, number>();
        for (const target of localTargets) {
          const declared = target.discoveredModelId
            ? declaredContextByModelId.get(target.discoveredModelId)
            : null;
          if (target.inferenceCapacityId && declared != null) {
            // A shared runtime can be declared by several models. The largest
            // declared window is the only candidate that cannot tighten one
            // model relative to another; policy admissibility is checked below.
            seedCandidates.set(
              target.inferenceCapacityId,
              Math.max(seedCandidates.get(target.inferenceCapacityId) ?? 0, declared),
            );
          }
        }
        const targetsSharingCandidateCapacity =
          seedCandidates.size > 0
            ? await tx.executionTarget.findMany({
                where: {
                  userId,
                  inferenceCapacityId: { in: [...seedCandidates.keys()] },
                },
                select: { id: true },
              })
            : [];
        // Pool row locks (where applicable) precede this one sorted policy-lock
        // union: operated targets plus every target sharing a seed candidate.
        const policyLockTargetIds = new Set([
          ...localTargets.map((target) => target.id),
          ...providerTargets.map((target) => target.id),
          ...targetsSharingCandidateCapacity.map((target) => target.id),
        ]);
        await lockExecutionTargetPolicies(tx, [...policyLockTargetIds]);
        const additionalDependentsByCapacityId = new Map<string, ContextWindowSeedDependent[]>();
        for (const target of localTargets) {
          if (!target.inferenceCapacityId) continue;
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          const dependent: ContextWindowSeedDependent = {
            kind: "member",
            contextCeilingMode: override?.contextCeiling.mode ?? "INHERIT",
            contextCeiling:
              override?.contextCeiling.mode === "LIMITED"
                ? override.contextCeiling.limitValue
                : null,
            contextMargin:
              override && override.contextCeiling.mode !== "INHERIT"
                ? override.contextMargin
                : null,
            poolContextCeiling: input.memberContextCeiling,
            poolContextMargin: input.advanced?.contextMargin ?? 0,
          };
          const dependents = additionalDependentsByCapacityId.get(target.inferenceCapacityId);
          if (dependents) dependents.push(dependent);
          else additionalDependentsByCapacityId.set(target.inferenceCapacityId, [dependent]);
        }
        const seededPhysicalByCapacityId = await seedDeclaredContextWindows({
          tx,
          userId,
          candidates: seedCandidates,
          lockedExecutionTargetIds: policyLockTargetIds,
          additionalDependentsByCapacityId,
        });
        for (const target of localTargets) {
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          const physicalMaximum =
            target.inferenceCapacityId && seededPhysicalByCapacityId.has(target.inferenceCapacityId)
              ? seededPhysicalByCapacityId.get(target.inferenceCapacityId)
              : target.InferenceCapacity?.physicalMaxContext;
          assertEffectiveContextPolicy(
            {
              physicalMaxContext: physicalMaximum,
              poolCeiling: input.memberContextCeiling,
              poolMargin: input.advanced?.contextMargin ?? 0,
              memberMode: override?.contextCeiling.mode,
              memberCeiling:
                override?.contextCeiling.mode === "LIMITED"
                  ? override.contextCeiling.limitValue
                  : null,
              memberMargin:
                override && override.contextCeiling.mode !== "INHERIT"
                  ? override.contextMargin
                  : null,
            },
            {
              marginExceedsCeiling: "CONTEXT_MARGIN_EXCEEDS_CEILING",
              exceedsPhysical: "CONTEXT_EXCEEDS_PHYSICAL",
            },
          );
        }
        if (
          providers.some(
            (provider) =>
              primaryProviderIds.has(provider.id) &&
              provider.contextWindow != null &&
              input.memberContextCeiling != null &&
              input.memberContextCeiling + (input.advanced?.contextMargin ?? 0) >
                provider.contextWindow,
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Member context exceeds a selected provider's context window.",
            data: { reason: "PROVIDER_CONTEXT_EXCEEDED" },
          });
        }
        for (const provider of providers) {
          assertConcurrencyPolicyWithinHardLimit(
            {
              hardLimit: provider.concurrencyLimit,
              poolLimit: input.memberConcurrencyLimit,
              poolReserved: input.reservedSlots,
            },
            {
              reservedExceeds: "RESERVED_EXCEEDS_CONCURRENCY",
              reservedExceedsPhysical: "RESERVED_EXCEEDS_PHYSICAL",
              concurrencyExceedsPhysical: "CONCURRENCY_EXCEEDS_PHYSICAL",
            },
          );
        }
        const pool = await tx.modelPool.create({
          data: {
            userId,
            slug: input.slug,
            name: input.name,
            protocolAdaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
            allowLossyDeveloperRoleCollapse:
              input.advanced?.allowLossyDeveloperRoleCollapse ?? false,
            publicEgressEnabled: hasPublicOverflow,
            publicEgressAcknowledged: input.publicEgressAcknowledged,
            recommendedSurfaceOverride: input.recommendedSurface,
            capacityPriority: 16,
            capacityConcurrencyLimit: input.memberConcurrencyLimit,
            capacityReservedSlots: input.reservedSlots,
            capacityWaitBudgetMs: input.localWaitBudgetMs,
            capacityContextCeiling: input.memberContextCeiling,
            capacityContextMargin: input.advanced?.contextMargin ?? 0,
            capacityBorrowPolicy: input.advanced?.borrowPolicy ?? "WHEN_IDLE",
            // Cache-affinity routing is ON by default for new guarded pools so
            // identical follow-up requests stick to the warm member.
            affinityEnabled: input.advanced?.affinity.enabled ?? true,
            affinityTtlSeconds: input.advanced?.affinity.ttlSeconds ?? 3600,
            affinityMaxRecords: input.advanced?.affinity.maxRecords ?? 10_000,
            affinityPrefixWeight: input.advanced?.affinity.prefixWeight ?? 100,
            affinityConversationWeight: input.advanced?.affinity.conversationWeight ?? 150,
            affinityConfirmedCacheWeight: input.advanced?.affinity.confirmedCacheWeight ?? 250,
            affinityLoadPenaltyWeight: input.advanced?.affinity.loadPenaltyWeight ?? 100,
          },
          select: { id: true },
        });
        if (input.advanced) {
          await tx.inferenceCapacity.updateMany({
            where: {
              userId,
              id: {
                in: [
                  ...new Set(localTargets.flatMap((target) => target.inferenceCapacityId ?? [])),
                ],
              },
            },
            data: { countStrategy: input.advanced.physicalCountStrategy },
          });
        }
        const localTargetByModelId = new Map(
          localTargets.map((target) => [target.discoveredModelId, target]),
        );
        for (const model of localModels) {
          const target = localTargetByModelId.get(model.id)!;
          const override = memberOverrideByModelId.get(model.id);
          await tx.poolMember.create({
            data: {
              poolId: pool.id,
              discoveredModelId: model.id,
              executionTargetId: target.id,
              tier: "PRIMARY",
              weight: 1,
              ...(override
                ? {
                    capacityConcurrencyMode: override.concurrency.mode,
                    capacityConcurrencyLimit:
                      override.concurrency.mode === "LIMITED"
                        ? override.concurrency.limitValue
                        : null,
                    capacityReservedSlots: override.reservedSlots,
                    capacityBorrowPolicy: override.borrowPolicy,
                    capacityWaitBudgetMode: override.waitBudget.mode,
                    capacityWaitBudgetMs:
                      override.waitBudget.mode === "LIMITED"
                        ? override.waitBudget.limitValue
                        : null,
                    capacityContextCeilingMode: override.contextCeiling.mode,
                    capacityContextCeiling:
                      override.contextCeiling.mode === "LIMITED"
                        ? override.contextCeiling.limitValue
                        : null,
                    capacityContextMargin:
                      override.contextCeiling.mode === "INHERIT" ? null : override.contextMargin,
                  }
                : {
                    capacityContextCeilingMode: "INHERIT",
                    capacityContextCeiling: null,
                    capacityContextMargin: null,
                  }),
            },
          });
        }
        const providerById = new Map(providers.map((provider) => [provider.id, provider]));
        const providerTargetByModelId = new Map(
          providerTargets.map((target, index) => [orderedProviders[index]?.id, target]),
        );
        let publicOrder = 0;
        for (const protection of input.providerModels) {
          const provider = providerById.get(protection.providerModelId);
          if (!provider) throw new ORPCError("PRECONDITION_FAILED");
          const capacity = await tx.inferenceCapacity.upsert({
            where: {
              userId_runtimeIdentityKey: {
                userId,
                runtimeIdentityKey: `provider-model:${provider.id}`,
              },
            },
            update: {},
            create: {
              userId,
              label: `Provider model ${provider.id}`,
              runtimeIdentityKey: `provider-model:${provider.id}`,
              runtimeModel: provider.upstreamModelId,
              hardConcurrencyLimit: provider.concurrencyLimit,
              physicalMaxContext: provider.contextWindow,
              countStrategy: "CONSERVATIVE_ESTIMATE",
            },
            select: { id: true },
          });
          const target = providerTargetByModelId.get(provider.id);
          if (!target) throw new ORPCError("PRECONDITION_FAILED");
          if (!target.inferenceCapacityId)
            await tx.executionTarget.update({
              where: { id: target.id },
              data: { inferenceCapacityId: capacity.id },
            });
          await tx.poolMember.create({
            data: {
              poolId: pool.id,
              executionTargetId: target.id,
              tier: protection.tier,
              publicOrder: protection.tier === "PUBLIC_OVERFLOW" ? publicOrder++ : null,
              weight: protection.tier === "PRIMARY" ? 1 : 0,
            },
          });
          const budget = await tx.providerBudgetPolicy.create({
            data: {
              userId,
              scopeType: "POOL_PROVIDER_MODEL",
              providerAccountId: provider.providerAccountId,
              poolId: pool.id,
              providerModelId: provider.id,
              active: true,
              activatedAt: now,
              Rules: {
                create: (() => {
                  const rules = protection.budgetRules;
                  if (!rules)
                    return [
                      {
                        metric: "CONCURRENCY" as const,
                        period: "PER_ATTEMPT" as const,
                        mode: "LIMITED" as const,
                        limitValue: new Prisma.Decimal(protection.concurrencyLimit),
                      },
                      {
                        metric: "SPEND" as const,
                        period: "UTC_DAY" as const,
                        mode: "LIMITED" as const,
                        limitValue: new Prisma.Decimal(protection.dailySpendLimit),
                        currency: provider.PricingVersions[0]!.currency,
                      },
                    ];
                  const rule = (
                    metric: "CONCURRENCY" | "TOKENS" | "SPEND",
                    period: "PER_ATTEMPT" | "UTC_DAY" | "UTC_MONTH" | "LIFETIME",
                    value:
                      | { mode: "UNLIMITED"; limitValue: null }
                      | { mode: "LIMITED"; limitValue: string | number },
                  ) => ({
                    metric,
                    period,
                    mode: value.mode,
                    limitValue:
                      value.mode === "LIMITED" ? new Prisma.Decimal(value.limitValue) : null,
                    currency: metric === "SPEND" ? provider.PricingVersions[0]!.currency : null,
                  });
                  return [
                    rule("CONCURRENCY", "PER_ATTEMPT", rules.concurrency),
                    rule("TOKENS", "PER_ATTEMPT", rules.tokensPerAttempt),
                    rule("TOKENS", "UTC_DAY", rules.tokensPerDay),
                    rule("TOKENS", "UTC_MONTH", rules.tokensPerMonth),
                    rule("TOKENS", "LIFETIME", rules.tokensLifetime),
                    rule("SPEND", "UTC_DAY", rules.spendPerDay),
                    rule("SPEND", "UTC_MONTH", rules.spendPerMonth),
                  ];
                })(),
              },
            },
            select: { id: true },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: provider.providerAccountId,
              action: "BUDGET_CREATED",
              subjectId: budget.id,
              metadata: { source: "guarded_pool_wizard" },
            },
          });
        }
        await tx.capacityAuditEvent.create({
          data: {
            userId,
            actorUserId: userId,
            action: "CREATE",
            resourceType: "MODEL_POOL",
            resourceId: pool.id,
          },
        });
        guardedSetupTestFailure?.();
        const created = await tx.modelPool.findUnique({
          where: { id: pool.id },
          select: poolSelect,
        });
        // Documented, accepted exception: no `data.reason` is attached here.
        // This is an internal invariant violation (the pool row vanished after
        // a successful create inside the same transaction); it is not a user
        // correctable guarded-create failure, so the client's generic rollback
        // copy applies. Do not add a reason code for this branch.
        if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
        return serializePool(created);
      });
    }),
  getProfileSlug: protectedProcedure.handler(async ({ context }) => {
    const user = await currentUserSlug(context.session.user.id);
    return { slug: user.slug };
  }),

  previewProfileSlugChange: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) =>
      userSlugChangePreview({ userId: context.session.user.id, nextSlug: input.slug }),
    ),

  updateProfileSlug: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) => {
      const preview = await userSlugChangePreview({
        userId: context.session.user.id,
        nextSlug: input.slug,
      });
      const updated = await prisma.user.update({
        where: { id: context.session.user.id },
        data: { slug: input.slug },
        select: { id: true, slug: true },
      });
      return { slug: updated.slug, preview };
    }),

  listCliDevices: protectedProcedure
    .input(z.object({ includeModels: z.boolean().default(true) }).optional())
    .handler(async ({ context }) => {
      const rows = await prisma.cliDevice.findMany({
        where: { userId: context.session.user.id },
        orderBy: { createdAt: "desc" },
        select: listCliDevicesSelect,
      });

      const now = new Date();
      const live = await context.services?.getLiveCliFeatures?.(rows.map((row) => row.id));
      return rows.map((row) => serializeCliDevice(row, now, live?.get(row.id) ?? null));
    }),

  setCliDeviceFeatureGrants: protectedProcedure
    .input(
      z
        .object({
          cliDeviceId: idSchema,
          humanTerminal: z.boolean().optional(),
          mcpCommands: z.boolean().optional(),
        })
        .refine((value) => value.humanTerminal !== undefined || value.mcpCommands !== undefined, {
          message: "At least one feature grant is required.",
        }),
    )
    .handler(async ({ input, context }) => {
      const row = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: {
          id: true,
          userId: true,
          reportedHumanTerminal: true,
          reportedMcpCommands: true,
          reportedTerminalSupported: true,
        },
      });
      if (!row || row.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      if (
        input.humanTerminal === true &&
        (row.reportedHumanTerminal !== true || row.reportedTerminalSupported !== true)
      ) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Browser terminal cannot be enabled until this CLI reports support.",
        });
      }
      if (input.mcpCommands === true && row.reportedMcpCommands !== true) {
        throw new ORPCError("BAD_REQUEST", {
          message: "MCP commands cannot be enabled until this CLI reports support.",
        });
      }
      const updated = await prisma.cliDevice.update({
        where: { id: row.id },
        data: {
          ...(input.humanTerminal !== undefined ? { allowHumanTerminal: input.humanTerminal } : {}),
          ...(input.mcpCommands !== undefined ? { allowMcpCommands: input.mcpCommands } : {}),
        },
        select: { id: true, allowHumanTerminal: true, allowMcpCommands: true },
      });
      await context.services?.onCliFeatureGrantsChanged?.(updated.id);
      return {
        cliDeviceId: updated.id,
        humanTerminal: updated.allowHumanTerminal,
        mcpCommands: updated.allowMcpCommands,
      };
    }),

  removeCliDeviceMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "cliDevice",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  removeEndpointMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "endpoint",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  removeDiscoveredModelMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(async ({ input, context }) => {
      // Pool membership cascades away with the model, so capture the affected
      // pools before the delete; the impact itself is computed from the
      // post-delete member state.
      const poolIds = await poolIdsWithMembers(
        prisma,
        context.session.user.id,
        discoveredModelPoolMemberWhere(input.id),
      );
      const removed = await removeOwnedRow({
        kind: "discoveredModel",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      });
      return {
        ...removed,
        impactedPools: await capabilityEditImpactedPools(prisma, {
          userId: context.session.user.id,
          poolIds,
        }),
      };
    }),

  listModelPools: protectedProcedure.handler(async ({ context }) => {
    const rows = await prisma.modelPool.findMany({
      where: { userId: context.session.user.id },
      orderBy: { createdAt: "desc" },
      select: poolSelect,
    });
    return rows.map(serializePool);
  }),

  cacheAffinityStats: protectedProcedure
    .input(z.object({ poolId: idSchema }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const now = new Date();
      const [activeRecords, confirmedRecords, targetGroups] = await Promise.all([
        prisma.cacheAffinityRecord.count({
          where: { userId: context.session.user.id, poolId: input.poolId, expiresAt: { gt: now } },
        }),
        prisma.cacheAffinityRecord.count({
          where: {
            userId: context.session.user.id,
            poolId: input.poolId,
            expiresAt: { gt: now },
            engineCacheConfirmed: true,
          },
        }),
        prisma.cacheAffinityRecord.groupBy({
          by: ["executionTargetId"],
          where: { userId: context.session.user.id, poolId: input.poolId, expiresAt: { gt: now } },
          _count: { _all: true },
          _max: { lastUsedAt: true, expiresAt: true },
        }),
      ]);
      return {
        activeRecords,
        confirmedRecords,
        targets: targetGroups.map((group) => ({
          executionTargetId: group.executionTargetId,
          records: group._count._all,
          lastUsedAt: group._max.lastUsedAt,
          expiresAt: group._max.expiresAt,
        })),
      };
    }),

  clearCacheAffinity: protectedProcedure
    .input(z.object({ poolId: idSchema }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const result = await prisma.cacheAffinityRecord.deleteMany({
        where: { userId: context.session.user.id, poolId: input.poolId },
      });
      return { deleted: result.count };
    }),

  createModelPool: protectedProcedure
    .input(
      z.object({
        slug: poolSlugSchema,
        name: poolNameSchema,
        description: poolDescriptionSchema,
        maxAttachmentBytes: attachmentLimitSchema,
        optimisticBasicTranscription: z.boolean().optional(),
        protocolAdaptationEnabled: z.boolean().optional(),
        publicEgressEnabled: z.boolean().optional(),
        publicEgressAcknowledged: z.literal(true).optional(),
        allowLossyDeveloperRoleCollapse: z.boolean().optional(),
        recommendedSurfaceOverride: poolRecommendedSurfaceSchema.nullable().optional(),
        ...poolTransformerFields,
        ...modelPoolCapacityPolicyFields,
        affinityEnabled: z.boolean().optional(),
        affinityTtlSeconds: z.number().int().min(60).max(604_800).optional(),
        affinityMaxRecords: z.number().int().min(100).max(100_000).optional(),
        affinityPrefixWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConversationWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConfirmedCacheWeight: z.number().int().min(0).max(10_000).optional(),
        affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.publicEgressEnabled === true || input.publicEgressAcknowledged === true)
        assertProviderEgressReleaseGate();
      assertLossyDeveloperRoleCollapseRequiresAdaptation({
        protocolAdaptationEnabled: input.protocolAdaptationEnabled ?? false,
        allowLossyDeveloperRoleCollapse: input.allowLossyDeveloperRoleCollapse ?? false,
      });
      assertModelPoolCapacityPolicy({
        concurrencyLimit: input.capacityConcurrencyLimit,
        reservedSlots: input.capacityReservedSlots,
        contextCeiling: input.capacityContextCeiling,
        contextMargin: input.capacityContextMargin,
      });
      await assertPoolSlugAvailable(input.slug, context.session.user.id);
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);
      const userId = context.session.user.id;
      await assertPoolTransformerIsValid(
        input,
        {
          transformerDiscoveredModelId: null,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
        },
        userId,
      );
      const data = {
        userId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        ...(input.maxAttachmentBytes !== undefined
          ? { maxAttachmentBytes: input.maxAttachmentBytes }
          : {}),
        optimisticBasicTranscription: input.optimisticBasicTranscription ?? false,
        protocolAdaptationEnabled: input.protocolAdaptationEnabled ?? false,
        publicEgressEnabled: input.publicEgressEnabled ?? false,
        publicEgressAcknowledged: input.publicEgressAcknowledged ?? false,
        allowLossyDeveloperRoleCollapse: input.allowLossyDeveloperRoleCollapse ?? false,
        recommendedSurfaceOverride: input.recommendedSurfaceOverride ?? null,
        transformerDiscoveredModelId: input.transformerDiscoveredModelId ?? null,
        transformerSystemPrompt: input.transformerSystemPrompt ?? null,
        transformerImages: input.transformerImages ?? true,
        transformerAudio: input.transformerAudio ?? false,
        transformerVideo: input.transformerVideo ?? false,
        transformerCacheMode: input.transformerCacheMode ?? "OFF",
        transformerIncludePrimaryTools: input.transformerIncludePrimaryTools ?? false,
        transformerMaxTools: input.transformerMaxTools ?? 32,
        transformerMaxToolChars: input.transformerMaxToolChars ?? 8000,
        transformerTimeoutMs: input.transformerTimeoutMs ?? null,
        transformerMaxAssets: input.transformerMaxAssets ?? null,
        capacityPriority: input.capacityPriority ?? 16,
        capacityConcurrencyLimit: input.capacityConcurrencyLimit ?? null,
        capacityReservedSlots: input.capacityReservedSlots ?? 0,
        capacityWaitBudgetMs: input.capacityWaitBudgetMs ?? null,
        capacityContextCeiling: input.capacityContextCeiling ?? null,
        capacityContextMargin: input.capacityContextMargin ?? 0,
        capacityBorrowPolicy: input.capacityBorrowPolicy ?? "WHEN_IDLE",
        // Cache-affinity routing defaults ON for legacy creates too, matching
        // the guarded wizard path; explicit opt-out is honored below.
        affinityEnabled: input.affinityEnabled ?? true,
        affinityTtlSeconds: input.affinityTtlSeconds ?? 3600,
        affinityMaxRecords: input.affinityMaxRecords ?? 10_000,
        affinityPrefixWeight: input.affinityPrefixWeight ?? 100,
        affinityConversationWeight: input.affinityConversationWeight ?? 150,
        affinityConfirmedCacheWeight: input.affinityConfirmedCacheWeight ?? 250,
        affinityLoadPenaltyWeight: input.affinityLoadPenaltyWeight ?? 100,
      } as const;
      const capacityPolicy = {
        capacityPriority: data.capacityPriority,
        capacityConcurrencyLimit: data.capacityConcurrencyLimit,
        capacityReservedSlots: data.capacityReservedSlots,
        capacityWaitBudgetMs: data.capacityWaitBudgetMs,
        capacityContextCeiling: data.capacityContextCeiling,
        capacityContextMargin: data.capacityContextMargin,
        capacityBorrowPolicy: data.capacityBorrowPolicy,
      } as const;
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.modelPool.create({
          data,
          select: poolSelect,
        });
        await tx.capacityAuditEvent.create({
          data: {
            userId,
            actorUserId: userId,
            action: "CREATE",
            resourceType: "MODEL_POOL",
            resourceId: created.id,
            after: JSON.parse(JSON.stringify(capacityPolicy)) as Prisma.InputJsonValue,
          },
        });
        return created;
      });
      return serializePool(row);
    }),

  updateModelPool: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        slug: poolSlugSchema.optional(),
        name: poolNameSchema.optional(),
        description: poolDescriptionSchema,
        /** Set to a discovered model id owned by the user, or null to clear. */
        ...poolTransformerFields,
        maxAttachmentBytes: attachmentLimitSchema,
        optimisticBasicTranscription: z.boolean().optional(),
        protocolAdaptationEnabled: z.boolean().optional(),
        publicEgressEnabled: z.boolean().optional(),
        publicEgressAcknowledged: z.literal(true).optional(),
        allowLossyDeveloperRoleCollapse: z.boolean().optional(),
        recommendedSurfaceOverride: poolRecommendedSurfaceSchema.nullable().optional(),
        affinityEnabled: z.boolean().optional(),
        affinityTtlSeconds: z.number().int().min(60).max(604_800).optional(),
        affinityMaxRecords: z.number().int().min(100).max(100_000).optional(),
        affinityPrefixWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConversationWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConfirmedCacheWeight: z.number().int().min(0).max(10_000).optional(),
        affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000).optional(),
        ...modelPoolCapacityPolicyFields,
      }),
    )
    .handler(async ({ input, context }) => {
      const existing = await prisma.modelPool.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          userId: true,
          transformerDiscoveredModelId: true,
          transformerImages: true,
          transformerAudio: true,
          transformerVideo: true,
          transformerCacheMode: true,
          publicEgressEnabled: true,
          publicEgressAcknowledged: true,
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: true,
        },
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      const hasCapacityPolicy = hasModelPoolCapacityPolicy(input);
      if (hasCapacityPolicy) assertCapacityManagementEnabled(env.MODEL_API_GLOBAL_CAPACITY_ENABLED);
      if (input.slug) {
        await assertPoolSlugAvailable(input.slug, context.session.user.id, input.id);
      }
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);

      const nextPublicEgressEnabled = input.publicEgressEnabled ?? existing.publicEgressEnabled;
      const nextPublicEgressAcknowledged =
        input.publicEgressAcknowledged ?? existing.publicEgressAcknowledged;
      if (input.publicEgressEnabled === true || input.publicEgressAcknowledged === true)
        assertProviderEgressReleaseGate();
      if (nextPublicEgressEnabled && !nextPublicEgressAcknowledged) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Acknowledge public egress before enabling it.",
        });
      }
      if (input.publicEgressEnabled === true) {
        const attachments = await prisma.poolMember.findMany({
          where: { poolId: existing.id, tier: "PUBLIC_OVERFLOW" },
          select: {
            id: true,
            ExecutionTarget: {
              select: {
                ProviderModel: { select: { id: true, providerAccountId: true } },
              },
            },
          },
        });
        const targets = attachments.flatMap((attachment) => {
          const model = attachment.ExecutionTarget?.ProviderModel;
          return model ? [{ attachmentId: attachment.id, ...model }] : [];
        });
        if (targets.length !== attachments.length) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Every public overflow attachment must reference a provider model.",
          });
        }
        const policies = await prisma.providerBudgetPolicy.findMany({
          where: {
            userId: context.session.user.id,
            active: true,
            scopeType: "POOL_PROVIDER_MODEL",
            poolId: existing.id,
            OR: targets.map(({ id, providerAccountId }) => ({
              providerModelId: id,
              providerAccountId,
            })),
          },
          select: {
            id: true,
            providerModelId: true,
            providerAccountId: true,
            activatedAt: true,
            Rules: {
              where: { metric: "CONCURRENCY", period: "PER_ATTEMPT" },
              select: { mode: true, limitValue: true },
            },
          },
        });
        const validPolicies = new Map(
          policies
            .filter(
              (policy) =>
                policy.activatedAt &&
                policy.Rules.length === 1 &&
                policy.Rules.every(
                  (rule) =>
                    (rule.mode === "LIMITED" &&
                      rule.limitValue !== null &&
                      Number(rule.limitValue.toString()) > 0) ||
                    (rule.mode === "UNLIMITED" && rule.limitValue === null),
                ),
            )
            .map((policy) => [`${policy.providerAccountId}:${policy.providerModelId}`, policy]),
        );
        const selectedPolicies = targets.map((target) =>
          validPolicies.get(`${target.providerAccountId}:${target.id}`),
        );
        if (selectedPolicies.some((policy) => !policy)) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Every public overflow attachment requires an active explicit LIMITED or UNLIMITED concurrency policy.",
          });
        }
        const auditChecks = await Promise.all(
          selectedPolicies.map((policy) =>
            prisma.providerAuditEvent.findFirst({
              where: {
                userId: context.session.user.id,
                providerAccountId: policy!.providerAccountId,
                subjectId: policy!.id,
                action: { in: ["BUDGET_CREATED", "BUDGET_UPDATED", "BUDGET_ACTIVATED"] },
              },
              select: { id: true },
            }),
          ),
        );
        if (auditChecks.some((audit) => !audit)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Every public overflow protection policy must have an activation audit trail.",
          });
        }
      }

      await assertPoolTransformerIsValid(input, existing, context.session.user.id);

      const row = await runSerializableTransaction(async (tx) => {
        if (hasCapacityPolicy)
          await lockAndValidateModelPoolCapacityPolicy(tx, {
            modelPoolId: input.id,
            userId: context.session.user.id,
            policy: input,
            notFound: () => {
              throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
            },
          });
        const current = await tx.modelPool.findUnique({
          where: { id: input.id },
          select: {
            userId: true,
            protocolAdaptationEnabled: true,
            allowLossyDeveloperRoleCollapse: true,
            recommendedSurfaceOverride: true,
          },
        });
        if (!current || current.userId !== context.session.user.id) {
          throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        }
        if (
          input.protocolAdaptationEnabled !== undefined ||
          input.allowLossyDeveloperRoleCollapse !== undefined
        ) {
          assertLossyDeveloperRoleCollapseRequiresAdaptation({
            protocolAdaptationEnabled:
              input.protocolAdaptationEnabled ?? current.protocolAdaptationEnabled,
            allowLossyDeveloperRoleCollapse:
              input.allowLossyDeveloperRoleCollapse ?? current.allowLossyDeveloperRoleCollapse,
          });
        }
        // Non-retroactive selectability gate: only updates that touch the
        // override or the adaptation flag validate the post-state, so a pool
        // already holding a legacy-invalid override can still be renamed or
        // have unrelated policy fields edited.
        if (
          input.recommendedSurfaceOverride !== undefined ||
          input.protocolAdaptationEnabled !== undefined
        ) {
          const members = await loadPoolSurfaceMembers(tx, input.id);
          assertRecommendedSurfaceServable({
            override: parseModelApiSurface(
              input.recommendedSurfaceOverride !== undefined
                ? input.recommendedSurfaceOverride
                : current.recommendedSurfaceOverride,
            ),
            members,
            adaptationEnabled:
              (input.protocolAdaptationEnabled ?? current.protocolAdaptationEnabled) &&
              env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
          });
        }
        return tx.modelPool.update({
          where: { id: input.id },
          data: {
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.transformerDiscoveredModelId !== undefined
              ? { transformerDiscoveredModelId: input.transformerDiscoveredModelId }
              : {}),
            ...(input.transformerSystemPrompt !== undefined
              ? { transformerSystemPrompt: input.transformerSystemPrompt }
              : {}),
            ...(input.transformerImages !== undefined
              ? { transformerImages: input.transformerImages }
              : {}),
            ...(input.transformerAudio !== undefined
              ? { transformerAudio: input.transformerAudio }
              : {}),
            ...(input.transformerVideo !== undefined
              ? { transformerVideo: input.transformerVideo }
              : {}),
            ...(input.transformerCacheMode !== undefined
              ? { transformerCacheMode: input.transformerCacheMode }
              : {}),
            ...(input.transformerIncludePrimaryTools !== undefined
              ? { transformerIncludePrimaryTools: input.transformerIncludePrimaryTools }
              : {}),
            ...(input.transformerMaxTools !== undefined
              ? { transformerMaxTools: input.transformerMaxTools }
              : {}),
            ...(input.transformerMaxToolChars !== undefined
              ? { transformerMaxToolChars: input.transformerMaxToolChars }
              : {}),
            ...(input.transformerTimeoutMs !== undefined
              ? { transformerTimeoutMs: input.transformerTimeoutMs }
              : {}),
            ...(input.transformerMaxAssets !== undefined
              ? { transformerMaxAssets: input.transformerMaxAssets }
              : {}),
            ...(input.maxAttachmentBytes !== undefined
              ? { maxAttachmentBytes: input.maxAttachmentBytes }
              : {}),
            ...(input.optimisticBasicTranscription !== undefined
              ? { optimisticBasicTranscription: input.optimisticBasicTranscription }
              : {}),
            ...(input.protocolAdaptationEnabled !== undefined
              ? { protocolAdaptationEnabled: input.protocolAdaptationEnabled }
              : {}),
            ...(input.publicEgressEnabled !== undefined
              ? { publicEgressEnabled: input.publicEgressEnabled }
              : {}),
            ...(input.publicEgressAcknowledged !== undefined
              ? { publicEgressAcknowledged: input.publicEgressAcknowledged }
              : {}),
            ...(input.allowLossyDeveloperRoleCollapse !== undefined
              ? { allowLossyDeveloperRoleCollapse: input.allowLossyDeveloperRoleCollapse }
              : {}),
            ...(input.recommendedSurfaceOverride !== undefined
              ? { recommendedSurfaceOverride: input.recommendedSurfaceOverride }
              : {}),
            ...(input.affinityEnabled !== undefined
              ? { affinityEnabled: input.affinityEnabled }
              : {}),
            ...(input.affinityTtlSeconds !== undefined
              ? { affinityTtlSeconds: input.affinityTtlSeconds }
              : {}),
            ...(input.affinityMaxRecords !== undefined
              ? { affinityMaxRecords: input.affinityMaxRecords }
              : {}),
            ...(input.affinityPrefixWeight !== undefined
              ? { affinityPrefixWeight: input.affinityPrefixWeight }
              : {}),
            ...(input.affinityConversationWeight !== undefined
              ? { affinityConversationWeight: input.affinityConversationWeight }
              : {}),
            ...(input.affinityConfirmedCacheWeight !== undefined
              ? { affinityConfirmedCacheWeight: input.affinityConfirmedCacheWeight }
              : {}),
            ...(input.affinityLoadPenaltyWeight !== undefined
              ? { affinityLoadPenaltyWeight: input.affinityLoadPenaltyWeight }
              : {}),
            ...(input.capacityPriority !== undefined
              ? { capacityPriority: input.capacityPriority }
              : {}),
            ...(input.capacityConcurrencyLimit !== undefined
              ? { capacityConcurrencyLimit: input.capacityConcurrencyLimit }
              : {}),
            ...(input.capacityReservedSlots !== undefined
              ? { capacityReservedSlots: input.capacityReservedSlots }
              : {}),
            ...(input.capacityBorrowPolicy !== undefined
              ? { capacityBorrowPolicy: input.capacityBorrowPolicy }
              : {}),
            ...(input.capacityWaitBudgetMs !== undefined
              ? { capacityWaitBudgetMs: input.capacityWaitBudgetMs }
              : {}),
            ...(input.capacityContextCeiling !== undefined
              ? { capacityContextCeiling: input.capacityContextCeiling }
              : {}),
            ...(input.capacityContextMargin !== undefined
              ? { capacityContextMargin: input.capacityContextMargin }
              : {}),
          },
          select: poolSelect,
        });
      });
      return serializePool(row);
    }),

  deleteModelPool: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.id, context.session.user.id);
      await prisma.modelPool.delete({ where: { id: input.id } });
      return { deleted: true };
    }),

  addPoolMember: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        discoveredModelId: idSchema,
        weight: z.number().int().min(0).max(10_000).default(1),
        routingStatus: routingStatusSchema.default("ACTIVE"),
      }),
    )
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const model = await ownedDiscoveredModel(input.discoveredModelId, context.session.user.id);
      const declaredContext = declaredContextWindow(
        resolveEffectiveCapabilityMetadata({
          capabilityOverrideMode: model.capabilityOverrideMode,
          capabilityOverrideMetadata: model.capabilityOverrideMetadata,
          endpointCapabilityMetadata: model.Endpoint?.capabilityMetadata ?? null,
        }),
      );
      return runSerializableTransaction(async (tx) => {
        const userId = context.session.user.id;
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.poolId} AND "userId" = ${userId} FOR UPDATE`;
        // Local members always join at PRIMARY tier, so every attach changes
        // the primary member set and must keep the effective recommended
        // surface servable before any write lands.
        const surfacePool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: {
            recommendedSurfaceOverride: true,
            protocolAdaptationEnabled: true,
          },
        });
        if (!surfacePool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        const surfaceMembers = await loadPoolSurfaceMembers(tx, input.poolId);
        surfaceMembers.push({
          id: input.discoveredModelId,
          tier: "PRIMARY",
          capabilities: discoveredModelSurfaceCapabilities(model),
        });
        assertRecommendedSurfaceServable({
          override: parseModelApiSurface(surfacePool.recommendedSurfaceOverride),
          members: surfaceMembers,
          adaptationEnabled:
            surfacePool.protocolAdaptationEnabled && env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
        });
        const target = await tx.executionTarget.upsert({
          where: { discoveredModelId: input.discoveredModelId },
          update: {},
          create: {
            userId: context.session.user.id,
            kind: "DISCOVERED_MODEL",
            discoveredModelId: input.discoveredModelId,
          },
          select: {
            id: true,
            inferenceCapacityId: true,
            InferenceCapacity: {
              select: { hardConcurrencyLimit: true, physicalMaxContext: true },
            },
          },
        });
        const seedCandidates = new Map(
          declaredContext != null && target.inferenceCapacityId
            ? [[target.inferenceCapacityId, declaredContext]]
            : [],
        );
        const targetsSharingCandidateCapacity =
          seedCandidates.size > 0
            ? await tx.executionTarget.findMany({
                where: {
                  userId,
                  inferenceCapacityId: { in: [...seedCandidates.keys()] },
                },
                select: { id: true },
              })
            : [];
        // The pool row is locked above. Take one sorted union of the operated
        // target and every target sharing its candidate capacity before the
        // fresh policy read and null-only seed.
        const policyLockTargetIds = new Set([
          target.id,
          ...targetsSharingCandidateCapacity.map((sharedTarget) => sharedTarget.id),
        ]);
        await lockExecutionTargetPolicies(tx, [...policyLockTargetIds]);
        const reloadedTarget = await tx.executionTarget.findUnique({
          where: { id: target.id },
          select: {
            id: true,
            inferenceCapacityId: true,
            InferenceCapacity: {
              select: { hardConcurrencyLimit: true, physicalMaxContext: true },
            },
          },
        });
        const lockedTarget = reloadedTarget ?? target;
        const pool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: {
            capacityConcurrencyLimit: true,
            capacityReservedSlots: true,
            capacityContextCeiling: true,
            capacityContextMargin: true,
          },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        const seededPhysicalByCapacityId = await seedDeclaredContextWindows({
          tx,
          userId,
          candidates: seedCandidates,
          lockedExecutionTargetIds: policyLockTargetIds,
          additionalDependentsByCapacityId: new Map(
            lockedTarget.inferenceCapacityId
              ? [
                  [
                    lockedTarget.inferenceCapacityId,
                    [
                      {
                        kind: "member" as const,
                        contextCeilingMode: "INHERIT" as const,
                        contextCeiling: null,
                        contextMargin: null,
                        poolContextCeiling: pool.capacityContextCeiling,
                        poolContextMargin: pool.capacityContextMargin,
                      },
                    ],
                  ],
                ]
              : [],
          ),
        });
        const physicalMaxContext =
          lockedTarget.inferenceCapacityId &&
          seededPhysicalByCapacityId.has(lockedTarget.inferenceCapacityId)
            ? seededPhysicalByCapacityId.get(lockedTarget.inferenceCapacityId)
            : lockedTarget.InferenceCapacity?.physicalMaxContext;
        assertConcurrencyPolicyWithinHardLimit({
          hardLimit: lockedTarget.InferenceCapacity?.hardConcurrencyLimit,
          poolLimit: pool.capacityConcurrencyLimit,
          poolReserved: pool.capacityReservedSlots,
        });
        assertEffectiveContextPolicy({
          physicalMaxContext,
          poolCeiling: pool.capacityContextCeiling,
          poolMargin: pool.capacityContextMargin,
        });
        const member = await createPoolMember(() =>
          tx.poolMember.create({
            data: {
              poolId: input.poolId,
              discoveredModelId: input.discoveredModelId,
              executionTargetId: target.id,
              weight: input.weight,
              routingStatus: input.routingStatus,
            },
            select: { id: true },
          }),
        );
        return { id: member.id, executionTargetId: lockedTarget.id };
      });
    }),

  addProviderPoolMember: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        providerModelId: idSchema,
        tier: z.enum(["PRIMARY", "PUBLIC_OVERFLOW"]).default("PUBLIC_OVERFLOW"),
        publicOrder: z.number().int().min(0).max(10_000).optional(),
        weight: z.number().int().min(0).max(10_000).default(1),
      }),
    )
    .handler(async ({ input, context }) => {
      assertProviderEgressReleaseGate();
      const userId = context.session.user.id;
      return runSerializableTransaction(async (tx) => {
        const candidatePool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: { id: true },
        });
        if (!candidatePool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidatePool.id} AND "userId" = ${userId} FOR UPDATE`;
        const pool = await tx.modelPool.findFirst({
          where: { id: candidatePool.id, userId },
          select: {
            id: true,
            publicEgressEnabled: true,
            publicEgressAcknowledged: true,
            recommendedSurfaceOverride: true,
            protocolAdaptationEnabled: true,
            capacityConcurrencyLimit: true,
            capacityReservedSlots: true,
            capacityContextCeiling: true,
            capacityContextMargin: true,
          },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        if (!pool.publicEgressAcknowledged) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Acknowledge provider egress before adding a provider target.",
          });
        }
        if (input.tier === "PUBLIC_OVERFLOW" && !pool.publicEgressEnabled) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Acknowledge and enable public egress before adding an overflow target.",
          });
        }
        if (input.tier === "PUBLIC_OVERFLOW" && input.publicOrder === undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Public overflow targets require an explicit order.",
          });
        }
        const providerModel = await tx.providerModel.findFirst({
          where: { id: input.providerModelId, userId, deletedAt: null },
          select: {
            id: true,
            providerAccountId: true,
            upstreamModelId: true,
            contextWindow: true,
            concurrencyLimit: true,
            nativeCapabilities: true,
            enabled: true,
          },
        });
        if (!providerModel) {
          throw new ORPCError("NOT_FOUND", { message: "Provider model not found." });
        }
        if (!providerModel.enabled) {
          throw new ORPCError("BAD_REQUEST", { message: "Enable the provider model first." });
        }
        // Attaching at PRIMARY tier changes the primary member set: the
        // effective recommended surface must stay servable before any write.
        if (input.tier === "PRIMARY") {
          const surfaceMembers = await loadPoolSurfaceMembers(tx, input.poolId);
          surfaceMembers.push({
            id: providerModel.id,
            tier: "PRIMARY",
            capabilities: providerModelSurfaceCapabilities(providerModel.nativeCapabilities),
          });
          assertRecommendedSurfaceServable({
            override: parseModelApiSurface(pool.recommendedSurfaceOverride),
            members: surfaceMembers,
            adaptationEnabled:
              pool.protocolAdaptationEnabled && env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
          });
        }
        await lockExecutionTargetIdentities(tx, [`provider-model:${providerModel.id}`]);
        // Fast rejection; the same invariant is checked again after the target
        // policy fence below, which is the authoritative race-safe check.
        assertConcurrencyPolicyWithinHardLimit({
          hardLimit: providerModel.concurrencyLimit,
          poolLimit: pool.capacityConcurrencyLimit,
          poolReserved: pool.capacityReservedSlots,
        });
        assertEffectiveContextPolicy({
          physicalMaxContext: providerModel.contextWindow,
          poolCeiling: pool.capacityContextCeiling,
          poolMargin: pool.capacityContextMargin,
        });
        const protectionPolicy = await tx.providerBudgetPolicy.findFirst({
          where: {
            userId,
            active: true,
            scopeType: "POOL_PROVIDER_MODEL",
            poolId: input.poolId,
            providerModelId: providerModel.id,
            providerAccountId: providerModel.providerAccountId,
          },
          select: {
            id: true,
            activatedAt: true,
            Rules: {
              where: { metric: "CONCURRENCY", period: "PER_ATTEMPT" },
              select: { id: true, mode: true, limitValue: true },
            },
          },
        });
        if (
          !protectionPolicy?.activatedAt ||
          protectionPolicy.Rules.length !== 1 ||
          protectionPolicy.Rules.some(
            (rule) =>
              (rule.mode === "LIMITED" &&
                (rule.limitValue === null || Number(rule.limitValue.toString()) <= 0)) ||
              (rule.mode === "UNLIMITED" && rule.limitValue !== null),
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Create and activate an attachment protection policy with explicit LIMITED or UNLIMITED concurrency before adding this overflow target.",
          });
        }
        const protectionAudit = await tx.providerAuditEvent.findFirst({
          where: {
            userId,
            providerAccountId: providerModel.providerAccountId,
            subjectId: protectionPolicy.id,
            action: { in: ["BUDGET_CREATED", "BUDGET_UPDATED", "BUDGET_ACTIVATED"] },
          },
          select: { id: true },
        });
        if (!protectionAudit) {
          throw new ORPCError("BAD_REQUEST", {
            message: "The attachment protection policy must have an activation audit trail.",
          });
        }
        const existingTarget = await tx.executionTarget.findUnique({
          where: { providerModelId: input.providerModelId },
          select: { id: true, inferenceCapacityId: true },
        });
        const target = await tx.executionTarget.upsert({
          where: { providerModelId: input.providerModelId },
          update: {},
          create: {
            userId,
            kind: "PROVIDER_MODEL",
            providerModelId: input.providerModelId,
          },
          select: { id: true },
        });
        await lockExecutionTargetPolicies(tx, [target.id]);
        const capacity = await tx.inferenceCapacity.upsert({
          where: {
            userId_runtimeIdentityKey: {
              userId,
              runtimeIdentityKey: `provider-model:${providerModel.id}`,
            },
          },
          update: {},
          create: {
            userId,
            label: `Provider model ${providerModel.id}`,
            runtimeIdentityKey: `provider-model:${providerModel.id}`,
            runtimeModel: providerModel.upstreamModelId,
            hardConcurrencyLimit: providerModel.concurrencyLimit,
            physicalMaxContext: providerModel.contextWindow,
            countStrategy: "CONSERVATIVE_ESTIMATE",
          },
          select: { id: true },
        });
        if (!existingTarget?.inferenceCapacityId)
          await tx.executionTarget.update({
            where: { id: target.id },
            data: { inferenceCapacityId: capacity.id },
          });
        await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacity.id} AND "userId" = ${userId} FOR UPDATE`;
        const [reloadedProviderModel, reloadedPool, reloadedCapacity] = await Promise.all([
          tx.providerModel.findFirst({
            where: { id: input.providerModelId, userId, deletedAt: null },
            select: { concurrencyLimit: true, contextWindow: true, enabled: true },
          }),
          tx.modelPool.findFirst({
            where: { id: input.poolId, userId },
            select: {
              capacityConcurrencyLimit: true,
              capacityReservedSlots: true,
              capacityContextCeiling: true,
              capacityContextMargin: true,
            },
          }),
          tx.inferenceCapacity.findUnique({
            where: { id: capacity.id },
            select: { hardConcurrencyLimit: true, physicalMaxContext: true },
          }),
        ]);
        const lockedProviderModel = reloadedProviderModel ?? providerModel;
        const lockedPool = reloadedPool ?? pool;
        const lockedCapacity = reloadedCapacity ?? {
          hardConcurrencyLimit: lockedProviderModel.concurrencyLimit,
          physicalMaxContext: lockedProviderModel.contextWindow,
        };
        if (!lockedProviderModel.enabled)
          throw new ORPCError("CONFLICT", {
            message: "Provider attachment changed concurrently.",
          });
        assertConcurrencyPolicyWithinHardLimit({
          hardLimit: lockedCapacity.hardConcurrencyLimit,
          poolLimit: lockedPool.capacityConcurrencyLimit,
          poolReserved: lockedPool.capacityReservedSlots,
        });
        assertEffectiveContextPolicy({
          physicalMaxContext: lockedCapacity.physicalMaxContext,
          poolCeiling: lockedPool.capacityContextCeiling,
          poolMargin: lockedPool.capacityContextMargin,
        });
        const member = await createPoolMember(() =>
          tx.poolMember.create({
            data: {
              poolId: input.poolId,
              executionTargetId: target.id,
              tier: input.tier,
              publicOrder: input.tier === "PUBLIC_OVERFLOW" ? input.publicOrder : null,
              weight: input.tier === "PRIMARY" ? input.weight : 0,
            },
            select: { id: true },
          }),
        );
        if (input.tier === "PUBLIC_OVERFLOW") {
          const ordered = await tx.poolMember.findMany({
            where: { poolId: input.poolId, tier: "PUBLIC_OVERFLOW", id: { not: member.id } },
            orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
            select: { id: true },
          });
          ordered.splice(Math.min(input.publicOrder ?? 0, ordered.length), 0, member);
          for (const [publicOrder, orderedMember] of ordered.entries()) {
            await tx.poolMember.update({
              where: { id: orderedMember.id },
              data: { publicOrder },
            });
          }
        }
        return { id: member.id, executionTargetId: target.id };
      });
    }),

  updatePoolMember: protectedProcedure
    .input(
      z
        .object({
          id: idSchema,
          weight: z.number().int().min(0).max(10_000).optional(),
          routingStatus: routingStatusSchema.optional(),
          tier: z.enum(["PRIMARY", "PUBLIC_OVERFLOW"]).optional(),
          publicOrder: z.number().int().min(0).max(10_000).optional(),
          capacityPriority: z.number().int().min(0).max(31).nullable().optional(),
          capacityConcurrencyMode: z.enum(["INHERIT", "LIMITED", "UNLIMITED"]).optional(),
          capacityConcurrencyLimit: z.number().int().min(1).max(10_000).nullable().optional(),
          capacityReservedSlots: z.number().int().min(0).max(10_000).nullable().optional(),
          capacityBorrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]).nullable().optional(),
          capacityWaitBudgetMode: z.enum(["INHERIT", "LIMITED", "UNLIMITED"]).optional(),
          capacityWaitBudgetMs: z.number().int().min(1).max(600_000).nullable().optional(),
          capacityContextCeilingMode: z.enum(["INHERIT", "LIMITED", "UNLIMITED"]).optional(),
          capacityContextCeiling: z.number().int().min(1).max(100_000_000).nullable().optional(),
          capacityContextMargin: z.number().int().min(0).max(10_000_000).nullable().optional(),
        })
        .superRefine((input, context) => {
          const requireLimit = (
            mode: "INHERIT" | "LIMITED" | "UNLIMITED" | undefined,
            value: number | null | undefined,
            path: string,
          ) => {
            if (mode === "LIMITED" && value == null)
              context.addIssue({
                code: "custom",
                path: [path],
                message: "Limited mode requires a limit",
              });
            if ((mode === "INHERIT" || mode === "UNLIMITED") && value != null)
              context.addIssue({
                code: "custom",
                path: [path],
                message: "This mode cannot include a limit",
              });
            if (mode === undefined && value !== undefined)
              context.addIssue({
                code: "custom",
                path: [path],
                message: "Changing a limit requires its mode",
              });
          };
          requireLimit(
            input.capacityConcurrencyMode,
            input.capacityConcurrencyLimit,
            "capacityConcurrencyLimit",
          );
          requireLimit(
            input.capacityWaitBudgetMode,
            input.capacityWaitBudgetMs,
            "capacityWaitBudgetMs",
          );
          requireLimit(
            input.capacityContextCeilingMode,
            input.capacityContextCeiling,
            "capacityContextCeiling",
          );
        }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return prisma.$transaction(
        async (tx) => {
          const candidate = await tx.poolMember.findUnique({
            where: { id: input.id },
            select: {
              poolId: true,
              executionTargetId: true,
              ModelPool: { select: { userId: true } },
            },
          });
          if (!candidate || candidate.ModelPool.userId !== userId)
            throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });

          // Serialize every tier/order transition with pool attachment and
          // reorder operations. Re-read all policy inputs after taking the lock
          // so acknowledgement and protection cannot be revoked concurrently.
          await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR UPDATE`;
          if (candidate.executionTargetId)
            await lockExecutionTargetPolicies(tx, [candidate.executionTargetId]);
          const member = await tx.poolMember.findUnique({
            where: { id: input.id },
            select: {
              id: true,
              poolId: true,
              tier: true,
              publicOrder: true,
              weight: true,
              routingStatus: true,
              capacityConcurrencyMode: true,
              capacityConcurrencyLimit: true,
              capacityReservedSlots: true,
              capacityContextCeilingMode: true,
              capacityContextCeiling: true,
              capacityContextMargin: true,
              ExecutionTarget: {
                select: {
                  ProviderModel: { select: { id: true, providerAccountId: true } },
                  InferenceCapacity: {
                    select: { physicalMaxContext: true, hardConcurrencyLimit: true },
                  },
                },
              },
              ModelPool: {
                select: {
                  userId: true,
                  publicEgressEnabled: true,
                  publicEgressAcknowledged: true,
                  recommendedSurfaceOverride: true,
                  protocolAdaptationEnabled: true,
                  capacityConcurrencyLimit: true,
                  capacityReservedSlots: true,
                  capacityContextCeiling: true,
                  capacityContextMargin: true,
                },
              },
            },
          });
          if (!member || member.ModelPool.userId !== userId)
            throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
          const providerModel = member.ExecutionTarget?.ProviderModel;
          if (providerModel) assertProviderEgressReleaseGate();
          const nextTier = input.tier ?? member.tier;
          const nextWeight = input.weight ?? member.weight;
          const nextRoutingStatus = input.routingStatus ?? member.routingStatus;
          if (nextTier === "PRIMARY" && nextRoutingStatus === "ACTIVE" && nextWeight <= 0)
            throw new ORPCError("BAD_REQUEST", {
              message: "Primary members require a positive routing weight.",
            });
          if (input.tier && !providerModel)
            throw new ORPCError("BAD_REQUEST", {
              message: "Only provider-backed members can change tier.",
            });
          if (providerModel && !member.ModelPool.publicEgressAcknowledged)
            throw new ORPCError("BAD_REQUEST", {
              message: "Acknowledge provider egress before updating a provider target.",
            });
          if (nextTier === "PUBLIC_OVERFLOW" && !member.ModelPool.publicEgressEnabled)
            throw new ORPCError("BAD_REQUEST", {
              message: "Acknowledge and enable public egress before moving a target to overflow.",
            });
          const nextConcurrencyMode =
            input.capacityConcurrencyMode ?? member.capacityConcurrencyMode;
          const nextConcurrencyLimit =
            input.capacityConcurrencyLimit !== undefined
              ? input.capacityConcurrencyLimit
              : member.capacityConcurrencyLimit;
          const nextReservedSlots =
            input.capacityReservedSlots !== undefined
              ? input.capacityReservedSlots
              : member.capacityReservedSlots;
          if (
            nextConcurrencyMode === "LIMITED" &&
            nextConcurrencyLimit != null &&
            nextReservedSlots != null &&
            nextReservedSlots > nextConcurrencyLimit
          )
            throw new ORPCError("BAD_REQUEST", {
              message: "Reserved slots exceed the member concurrency limit.",
            });
          assertConcurrencyPolicyWithinHardLimit({
            hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
            poolLimit: member.ModelPool.capacityConcurrencyLimit,
            poolReserved: member.ModelPool.capacityReservedSlots,
            memberMode: nextConcurrencyMode,
            memberLimit: nextConcurrencyLimit,
            memberReserved: nextReservedSlots,
          });
          const nextContextMode =
            input.capacityContextCeilingMode ?? member.capacityContextCeilingMode;
          const nextContextCeiling =
            input.capacityContextCeiling !== undefined
              ? input.capacityContextCeiling
              : member.capacityContextCeiling;
          const nextContextMargin =
            input.capacityContextMargin !== undefined
              ? input.capacityContextMargin
              : member.capacityContextMargin;
          const physicalMaxContext = member.ExecutionTarget?.InferenceCapacity?.physicalMaxContext;
          assertEffectiveContextPolicy({
            physicalMaxContext,
            poolCeiling: member.ModelPool.capacityContextCeiling,
            poolMargin: member.ModelPool.capacityContextMargin,
            memberMode: nextContextMode,
            memberCeiling: nextContextCeiling,
            memberMargin: nextContextMargin,
          });

          if (nextTier === "PUBLIC_OVERFLOW" && member.tier !== "PUBLIC_OVERFLOW") {
            if (!providerModel) throw new ORPCError("BAD_REQUEST");
            const protection = await tx.providerBudgetPolicy.findFirst({
              where: {
                userId,
                active: true,
                scopeType: "POOL_PROVIDER_MODEL",
                poolId: member.poolId,
                providerModelId: providerModel.id,
                providerAccountId: providerModel.providerAccountId,
                activatedAt: { not: null },
                Rules: {
                  some: { metric: "CONCURRENCY", period: "PER_ATTEMPT" },
                },
              },
              select: {
                id: true,
                Rules: {
                  where: { metric: "CONCURRENCY", period: "PER_ATTEMPT" },
                  select: { mode: true, limitValue: true },
                },
              },
            });
            const concurrency = protection?.Rules[0];
            const validProtection =
              protection &&
              protection.Rules.length === 1 &&
              concurrency &&
              ((concurrency.mode === "LIMITED" &&
                concurrency.limitValue !== null &&
                Number(concurrency.limitValue.toString()) > 0) ||
                (concurrency.mode === "UNLIMITED" && concurrency.limitValue === null));
            const protectionAudit = protection
              ? await tx.providerAuditEvent.findFirst({
                  where: {
                    userId,
                    providerAccountId: providerModel.providerAccountId,
                    subjectId: protection.id,
                    action: { in: ["BUDGET_CREATED", "BUDGET_UPDATED", "BUDGET_ACTIVATED"] },
                  },
                  select: { id: true },
                })
              : null;
            if (!validProtection || !protectionAudit)
              throw new ORPCError("BAD_REQUEST", {
                message:
                  "Create and activate an audited attachment protection policy before moving this target to overflow.",
              });
          }

          const overflow = await tx.poolMember.findMany({
            where: { poolId: member.poolId, tier: "PUBLIC_OVERFLOW", id: { not: member.id } },
            orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
            select: { id: true },
          });
          const desiredOrder = Math.min(
            input.publicOrder ?? member.publicOrder ?? overflow.length,
            overflow.length,
          );
          if (nextTier === "PUBLIC_OVERFLOW") overflow.splice(desiredOrder, 0, { id: member.id });

          // A tier transition re-shapes the primary member set, so the
          // effective recommended surface must stay servable in the
          // post-transition state before any write lands. Tier-preserving
          // updates (weight, policy fields, order) leave the selectability
          // inputs untouched and stay non-retroactive.
          if (input.tier !== undefined && input.tier !== member.tier) {
            const surfaceMembers = await loadPoolSurfaceMembers(tx, member.poolId);
            for (const surfaceMember of surfaceMembers) {
              if (surfaceMember.id === member.id) surfaceMember.tier = input.tier;
            }
            assertRecommendedSurfaceServable({
              override: parseModelApiSurface(member.ModelPool.recommendedSurfaceOverride),
              members: surfaceMembers,
              adaptationEnabled:
                member.ModelPool.protocolAdaptationEnabled &&
                env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
            });
          }

          // Move existing rows out of the unique public-order range before
          // assigning the normalized contiguous order.
          if (overflow.length > 0)
            await tx.poolMember.updateMany({
              where: { poolId: member.poolId, tier: "PUBLIC_OVERFLOW" },
              data: { publicOrder: { increment: 20_000 } },
            });
          const updated = await tx.poolMember.update({
            where: { id: member.id },
            data: {
              ...(input.weight !== undefined || input.tier
                ? { weight: nextTier === "PUBLIC_OVERFLOW" ? 0 : nextWeight }
                : {}),
              ...(input.routingStatus ? { routingStatus: input.routingStatus } : {}),
              ...(input.tier ? { tier: input.tier } : {}),
              ...(input.capacityPriority !== undefined
                ? { capacityPriority: input.capacityPriority }
                : {}),
              ...(input.capacityConcurrencyMode
                ? {
                    capacityConcurrencyMode: input.capacityConcurrencyMode,
                    capacityConcurrencyLimit:
                      input.capacityConcurrencyMode === "LIMITED"
                        ? input.capacityConcurrencyLimit
                        : null,
                  }
                : {}),
              ...(input.capacityReservedSlots !== undefined
                ? { capacityReservedSlots: input.capacityReservedSlots }
                : {}),
              ...(input.capacityBorrowPolicy !== undefined
                ? { capacityBorrowPolicy: input.capacityBorrowPolicy }
                : {}),
              ...(input.capacityWaitBudgetMode
                ? {
                    capacityWaitBudgetMode: input.capacityWaitBudgetMode,
                    capacityWaitBudgetMs:
                      input.capacityWaitBudgetMode === "LIMITED"
                        ? input.capacityWaitBudgetMs
                        : null,
                  }
                : {}),
              ...(input.capacityContextCeilingMode
                ? {
                    capacityContextCeilingMode: input.capacityContextCeilingMode,
                    capacityContextCeiling:
                      input.capacityContextCeilingMode === "LIMITED"
                        ? input.capacityContextCeiling
                        : null,
                  }
                : {}),
              ...(input.capacityContextMargin !== undefined
                ? { capacityContextMargin: input.capacityContextMargin }
                : {}),
              publicOrder: nextTier === "PUBLIC_OVERFLOW" ? desiredOrder + 40_000 : null,
            },
            select: { id: true, weight: true, routingStatus: true, tier: true, publicOrder: true },
          });
          for (const [publicOrder, orderedMember] of overflow.entries())
            await tx.poolMember.update({
              where: { id: orderedMember.id },
              data: { publicOrder },
            });
          if (providerModel && member.tier !== nextTier)
            await tx.providerAuditEvent.create({
              data: {
                userId,
                providerAccountId: providerModel.providerAccountId,
                action: "MODEL_UPDATED",
                subjectId: providerModel.id,
                metadata: {
                  source: "pool_member_tier_transition",
                  poolId: member.poolId,
                  poolMemberId: member.id,
                  fromTier: member.tier,
                  toTier: nextTier,
                },
              },
            });
          return Object.hasOwn(updated, "tier")
            ? { ...updated, publicOrder: nextTier === "PUBLIC_OVERFLOW" ? desiredOrder : null }
            : updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),

  reorderProviderPoolMember: protectedProcedure
    .input(z.object({ id: idSchema, direction: z.enum(["EARLIER", "LATER"]) }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        const candidate = await tx.poolMember.findUnique({
          where: { id: input.id },
          select: { id: true, poolId: true, tier: true, ModelPool: { select: { userId: true } } },
        });
        if (
          !candidate ||
          candidate.ModelPool.userId !== userId ||
          candidate.tier !== "PUBLIC_OVERFLOW"
        )
          throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR UPDATE`;
        const members = await tx.poolMember.findMany({
          where: { poolId: candidate.poolId, tier: "PUBLIC_OVERFLOW" },
          orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        const currentIndex = members.findIndex((member) => member.id === candidate.id);
        const nextIndex = input.direction === "EARLIER" ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= members.length)
          return { moved: false };
        [members[currentIndex], members[nextIndex]] = [members[nextIndex]!, members[currentIndex]!];
        await tx.poolMember.updateMany({
          where: { poolId: candidate.poolId, tier: "PUBLIC_OVERFLOW" },
          data: { publicOrder: { increment: 20_000 } },
        });
        for (const [publicOrder, member] of members.entries()) {
          await tx.poolMember.update({ where: { id: member.id }, data: { publicOrder } });
        }
        return { moved: true };
      });
    }),

  removePoolMember: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return runSerializableTransaction(async (tx) => {
        const candidate = await tx.poolMember.findUnique({
          where: { id: input.id },
          select: { id: true, poolId: true, ModelPool: { select: { userId: true } } },
        });
        if (!candidate || candidate.ModelPool.userId !== userId) {
          throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
        }
        // Lock the pool row first (matching addPoolMember) so the member set
        // this decision is made against cannot change concurrently.
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR UPDATE`;
        const member = await tx.poolMember.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            poolId: true,
            tier: true,
            ModelPool: {
              select: {
                userId: true,
                recommendedSurfaceOverride: true,
                protocolAdaptationEnabled: true,
              },
            },
          },
        });
        if (!member || member.ModelPool.userId !== userId) {
          throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
        }
        // Detaching a PRIMARY member re-shapes the primary member set: the
        // effective recommended surface must stay servable across the remaining
        // members. Detaching an overflow member leaves selectability untouched.
        if (member.tier === "PRIMARY") {
          const surfaceMembers = await loadPoolSurfaceMembers(tx, member.poolId, member.id);
          assertRecommendedSurfaceServable({
            override: parseModelApiSurface(member.ModelPool.recommendedSurfaceOverride),
            members: surfaceMembers,
            adaptationEnabled:
              member.ModelPool.protocolAdaptationEnabled &&
              env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
          });
        }
        await tx.poolMember.delete({ where: { id: input.id } });
        return { deleted: true };
      });
    }),

  updateDiscoveredModelCapabilities: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        vision: z.boolean(),
        audio: z.boolean(),
        video: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      const model = await prisma.discoveredModel.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          userId: true,
          capabilityOverrideMode: true,
          capabilityOverrideMetadata: true,
          capabilityOverrides: true,
          Endpoint: { select: { capabilityMetadata: true, defaultCapabilities: true } },
        },
      });
      if (!model || model.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
      }
      const parsed = resolveEffectiveCapabilityMetadata({
        capabilityOverrideMode: model.capabilityOverrideMode,
        capabilityOverrideMetadata: model.capabilityOverrideMetadata,
        endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
      });
      if (!parsed) {
        const existingCoarse =
          model.capabilityOverrideMode === "OVERRIDE"
            ? model.capabilityOverrides
            : model.Endpoint.defaultCapabilities;
        const nextCoarse = existingCoarse.filter(
          (capability) =>
            capability !== "VISION_INPUT" &&
            capability !== "AUDIO_INPUT" &&
            capability !== "VIDEO_INPUT",
        ) as typeof existingCoarse;
        if (input.vision) nextCoarse.push("VISION_INPUT");
        if (input.audio) nextCoarse.push("AUDIO_INPUT");
        if (input.video) nextCoarse.push("VIDEO_INPUT");
        if (
          (input.vision || input.audio || input.video) &&
          !nextCoarse.includes("TEXT_GENERATION")
        ) {
          nextCoarse.push("TEXT_GENERATION");
        }
        const metadata = openAiCapabilitiesFromCoarse(nextCoarse);
        await prisma.discoveredModel.update({
          where: { id: input.id },
          data: {
            capabilityOverrideMode: "OVERRIDE",
            capabilityOverrideOrigin: "DASHBOARD",
            capabilityOverrides: { set: nextCoarse },
            capabilityOverrideMetadata: metadata,
          },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
          },
        });
        return {
          id: input.id,
          capabilityOverrideMode: "OVERRIDE" as const,
          capabilityOverrides: nextCoarse,
          capabilityOverrideMetadata: metadata,
          impactedPools: await discoveredModelEditImpact(input.id, context.session.user.id),
        };
      }
      if (parsed.version === 4) {
        const current = parsed.surfaces.openaiChatCompletions;
        const metadata = {
          ...parsed,
          surfaces: {
            ...parsed.surfaces,
            openaiChatCompletions: current
              ? {
                  ...current,
                  inputImages: input.vision,
                  inputAudio: input.audio,
                  inputVideo: input.video,
                }
              : current,
          },
        };
        const updated = await prisma.discoveredModel.update({
          where: { id: input.id },
          data: {
            capabilityOverrideMode: "OVERRIDE",
            capabilityOverrideOrigin: "DASHBOARD",
            capabilityOverrides: { set: coarseCapabilitiesFromOpenAi(metadata) },
            capabilityOverrideMetadata: metadata,
          },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
          },
        });
        return {
          ...updated,
          impactedPools: await discoveredModelEditImpact(input.id, context.session.user.id),
        };
      }
      const base = parsed;
      const chatExisted = Boolean(base.chatCompletions);
      const needsChat = chatExisted || input.vision || input.audio || input.video;
      const metadata = {
        ...base,
        chatCompletions: needsChat
          ? {
              ...base.chatCompletions,
              ...(input.vision || input.audio || input.video ? { supported: true } : {}),
              vision: input.vision,
              audio: input.audio,
              video: input.video,
            }
          : base.chatCompletions,
      };
      const coarse: Array<
        | "TEXT_GENERATION"
        | "VISION_INPUT"
        | "AUDIO_INPUT"
        | "AUDIO_OUTPUT"
        | "VIDEO_INPUT"
        | "EMBEDDING"
        | "RESPONSES_API"
      > = [];
      if (metadata.chatCompletions?.supported || metadata.responses?.supported) {
        coarse.push("TEXT_GENERATION");
      }
      if (input.vision) coarse.push("VISION_INPUT");
      if (input.video) coarse.push("VIDEO_INPUT");
      if (
        input.audio ||
        audioOperationSupported(metadata.audio?.transcriptions) ||
        audioOperationSupported(metadata.audio?.translations)
      ) {
        coarse.push("AUDIO_INPUT");
      }
      if (metadata.audio?.speech) coarse.push("AUDIO_OUTPUT");
      if (metadata.embeddings?.supported) coarse.push("EMBEDDING");
      if (metadata.responses?.supported) coarse.push("RESPONSES_API");
      const updated = await prisma.discoveredModel.update({
        where: { id: input.id },
        data: {
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: { set: coarse },
          capabilityOverrideMetadata: metadata,
        },
        select: {
          id: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
        },
      });
      return {
        ...updated,
        impactedPools: await discoveredModelEditImpact(input.id, context.session.user.id),
      };
    }),

  /**
   * Authoritative, backend-neutral capability editor. `inherit` removes the
   * manual model profile; `override` stores the complete validated profile.
   * Optional booleans deliberately retain the distinction between unknown
   * (omitted) and explicitly unsupported (`false`).
   */
  setDiscoveredModelCapabilityProfile: protectedProcedure
    .input(
      z.discriminatedUnion("mode", [
        z.object({
          id: idSchema,
          mode: z.literal("inherit"),
          optimisticBasicTranscription: z.boolean(),
        }),
        z.object({
          id: idSchema,
          mode: z.literal("override"),
          capabilities: openAiCompatibleCapabilitiesSchema,
          optimisticBasicTranscription: z.boolean(),
        }),
      ]),
    )
    .handler(async ({ input, context }) => {
      const model = await prisma.discoveredModel.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true },
      });
      if (!model || model.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
      }
      const override = input.mode === "override";
      const updated = await prisma.discoveredModel.update({
        where: { id: input.id },
        data: {
          capabilityOverrideMode: override ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
          // Dashboard ownership applies to both choices. This prevents a later
          // inherited CLI inventory from undoing an explicit dashboard reset.
          // A CLI model configured with an override remains authoritative.
          capabilityOverrideOrigin: "DASHBOARD",
          capabilityOverrides: {
            set: override ? coarseCapabilitiesFromOpenAi(input.capabilities) : [],
          },
          capabilityOverrideMetadata: override ? input.capabilities : Prisma.DbNull,
          optimisticBasicTranscription: input.optimisticBasicTranscription,
        },
        select: {
          id: true,
          capabilityOverrideMode: true,
          capabilityOverrideOrigin: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
        },
      });
      return {
        ...updated,
        impactedPools: await discoveredModelEditImpact(input.id, context.session.user.id),
      };
    }),

  updateDiscoveredModelAttachmentLimit: protectedProcedure
    .input(z.object({ id: idSchema, maxAttachmentBytes: attachmentLimitSchema.unwrap() }))
    .handler(async ({ input, context }) => {
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);
      const model = await prisma.discoveredModel.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true },
      });
      if (!model || model.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
      }
      return prisma.discoveredModel.update({
        where: { id: input.id },
        data: { maxAttachmentBytes: input.maxAttachmentBytes },
        select: { id: true, maxAttachmentBytes: true },
      });
    }),

  grantPoolAccessByEmail: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        email: z.string().trim().email().max(320),
        publicEgressAcknowledged: z.boolean().default(false),
      }),
    )
    .handler(async ({ input, context }) => {
      const pool = await ownedPool(input.poolId, context.session.user.id);
      const hasProviderPrimary = pool.publicEgressEnabled
        ? false
        : Boolean(
            await prisma.poolMember.findFirst({
              where: {
                poolId: pool.id,
                tier: "PRIMARY",
                // The provider relation also includes userId, which is never
                // null, so a relation null-check matches every execution target.
                ExecutionTarget: { providerModelId: { not: null } },
              },
              select: { id: true },
            }),
          );
      if ((pool.publicEgressEnabled || hasProviderPrimary) && !input.publicEgressAcknowledged) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Provider egress acknowledgement is required for this grant.",
        });
      }
      const grantee = await prisma.user.findFirst({
        where: { email: { equals: input.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!grantee) {
        throw new ORPCError("NOT_FOUND", { message: "User not found." });
      }
      if (grantee.id === context.session.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "Cannot grant a pool to yourself." });
      }
      return prisma.poolGrant.upsert({
        where: {
          poolId_granteeUserId: {
            poolId: input.poolId,
            granteeUserId: grantee.id,
          },
        },
        update: {},
        create: {
          poolId: input.poolId,
          ownerUserId: context.session.user.id,
          granteeUserId: grantee.id,
        },
        select: { id: true, poolId: true, granteeUserId: true },
      });
    }),

  revokePoolAccessByEmail: protectedProcedure
    .input(z.object({ poolId: idSchema, email: z.string().trim().email().max(320) }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const grantee = await prisma.user.findFirst({
        where: { email: { equals: input.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (!grantee) {
        throw new ORPCError("NOT_FOUND", { message: "User not found." });
      }
      const result = await prisma.poolGrant.deleteMany({
        where: {
          poolId: input.poolId,
          ownerUserId: context.session.user.id,
          granteeUserId: grantee.id,
        },
      });
      return { revokedCount: result.count };
    }),

  visibleModels: protectedProcedure.handler(async ({ context }) =>
    serializeVisibleTargets(await listVisibleModelTargetsForUser(context.session.user.id)),
  ),
};
