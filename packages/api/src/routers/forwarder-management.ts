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
import { protectedProcedure } from "../index";
import {
  getConfiguredMediaAttachmentMaxBytes,
  resolveAttachmentLimit,
} from "../lib/media-attachment-limits";
import { parseModelApiSurface } from "../lib/model-api-surface";
import {
  listVisibleModelTargetsForUser,
  type VisibleModelTargets,
} from "../lib/model-api-token-access";
import { poolMemberRoutingStatuses } from "../lib/model-pool-routing";
import {
  audioOperationSupported,
  coarseCapabilitiesFromOpenAi,
  openAiCapabilitiesFromCoarse,
  openAiCompatibleCapabilitiesSchema,
  resolveEffectiveCapabilityMetadata,
  transformerModalityMismatchErrors,
  transformerSupportedModalities,
} from "../lib/openai-compatible-capabilities";
import {
  type ModelApiSurface,
  modelApiSurfaces,
  surfaceAvailabilityMatrix,
} from "../lib/surface-capabilities";
import { visibleModelAttachmentModalities } from "../lib/visible-model-modalities";

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
const attachmentLimitSchema = z
  .number()
  .int()
  .positive()
  .max(MEDIA_ATTACHMENT_MAX_BYTES_MAX)
  .nullable()
  .optional();

type UserSlugRow = {
  id: string;
  slug: string;
};

type SlugPreviewDirectModelRow = {
  id: string;
  upstreamModelId: string;
  Endpoint: {
    slug: string;
    CliDevice: { slug: string };
  };
};

type SlugPreviewPoolRow = {
  id: string;
  slug: string;
  name: string;
};

type CliDeviceRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  label: string;
  status: string;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastHeartbeatAt: Date | null;
  connectionCount: number;
  inventorySeq: number;
  inventoryDigest: string | null;
  inventoryAcknowledgedAt: Date | null;
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  User: { slug: string };
  Endpoints: EndpointRow[];
};

type EndpointRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  label: string;
  kind: string;
  status: string;
  defaultCapabilities: string[];
  capabilityMetadata: unknown | null;
  probeSuggestions: unknown | null;
  lastSeenAt: Date | null;
  lastHealthCheckAt: Date | null;
  statusChangedAt: Date | null;
  failureReasonCode: string | null;
  published: boolean;
  unpublishedAt: Date | null;
  DiscoveredModels: DiscoveredModelRow[];
};

type DiscoveredModelRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string | null;
  upstreamModelId: string;
  encodedModelId: string;
  capabilityOverrideMode: string;
  capabilityOverrides: string[];
  capabilityOverrideMetadata: unknown | null;
  optimisticBasicTranscription: boolean;
  probeSuggestions: unknown | null;
  lastSeenAt: Date | null;
  published: boolean;
  unpublishedAt: Date | null;
  maxAttachmentBytes: number | null;
  ExecutionTargets: Array<{
    id: string;
    inferenceCapacityId: string | null;
    directPriority: number;
    directConcurrencyLimit: number | null;
    directReservedSlots: number;
    directBorrowPolicy: string;
    directWaitBudgetMs: number | null;
    directContextCeiling: number | null;
    directContextMargin: number;
  }>;
};

type ModelPoolRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  slug: string;
  name: string;
  description: string | null;
  maxAttachmentBytes: number | null;
  optimisticBasicTranscription: boolean;
  protocolAdaptationEnabled: boolean;
  publicEgressEnabled: boolean;
  publicEgressAcknowledged: boolean;
  allowLossyDeveloperRoleCollapse: boolean;
  recommendedSurfaceOverride: string | null;
  capacityPriority: number;
  capacityConcurrencyLimit: number | null;
  capacityReservedSlots: number;
  capacityBorrowPolicy: string;
  capacityWaitBudgetMs: number | null;
  capacityContextCeiling: number | null;
  capacityContextMargin: number;
  affinityEnabled: boolean;
  affinityTtlSeconds: number;
  affinityMaxRecords: number;
  affinityPrefixWeight: number;
  affinityConversationWeight: number;
  affinityConfirmedCacheWeight: number;
  affinityLoadPenaltyWeight: number;
  transformerDiscoveredModelId: string | null;
  transformerSystemPrompt: string | null;
  transformerImages: boolean;
  transformerAudio: boolean;
  transformerVideo: boolean;
  transformerCacheMode: string;
  transformerIncludePrimaryTools: boolean;
  transformerMaxTools: number;
  transformerMaxToolChars: number;
  transformerTimeoutMs: number | null;
  transformerMaxAssets: number | null;
  User: { slug: string };
  TransformerDiscoveredModel: {
    id: string;
    upstreamModelId: string;
    User: { slug: string };
    Endpoint: {
      id: string;
      slug: string;
      CliDevice: { slug: string };
    };
  } | null;
  PoolMembers: PoolMemberRow[];
  PoolGrants: PoolGrantRow[];
};

type PoolMemberRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  discoveredModelId: string | null;
  tier: "PRIMARY" | "PUBLIC_OVERFLOW";
  publicOrder: number | null;
  weight: number;
  healthStatus: string;
  routingStatus: string;
  lastFailureClass: string | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
  capacityPriority: number | null;
  capacityConcurrencyMode: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityConcurrencyLimit: number | null;
  capacityReservedSlots: number | null;
  capacityBorrowPolicy: string | null;
  capacityWaitBudgetMode: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityWaitBudgetMs: number | null;
  capacityContextCeilingMode: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityContextCeiling: number | null;
  capacityContextMargin: number | null;
  DiscoveredModel: PoolMemberModelRow | null;
  ExecutionTarget: {
    id: string;
    kind: string;
    inferenceCapacityId: string | null;
    DiscoveredModel: PoolMemberModelRow | null;
    ProviderModel: {
      id: string;
      upstreamModelId: string;
      displayName: string | null;
      nativeCapabilities: unknown | null;
      contextWindow: number | null;
      concurrencyLimit: number | null;
      healthStatus: string;
      enabled: boolean;
      PricingVersions: Array<{ version: string; currency: string }>;
      ProviderAccount: { id: string; label: string; providerType: string; enabled: boolean };
    } | null;
  } | null;
};

type PoolMemberModelRow = {
  id: string;
  upstreamModelId: string;
  capabilityOverrideMode: string;
  capabilityOverrides: string[];
  capabilityOverrideMetadata: unknown | null;
  User: { slug: string };
  Endpoint: {
    id: string;
    slug: string;
    capabilityMetadata: unknown | null;
    defaultCapabilities: string[];
    CliDevice: { slug: string };
  };
};

type PoolGrantRow = {
  id: string;
  createdAt: Date;
  granteeUserId: string;
  Grantee: {
    email: string;
    name: string;
  };
};

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
  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, slug: true },
  })) as UserSlugRow | null;
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

  const directModels = (directRows as SlugPreviewDirectModelRow[]).map((model) => ({
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

  const modelPools = (poolRows as SlugPreviewPoolRow[]).map((pool) => ({
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
  const [modalities, poolRows] = await Promise.all([
    visibleModelAttachmentModalities(targets),
    targets.modelPools.length
      ? prisma.modelPool.findMany({
          where: { id: { in: targets.modelPools.map((pool) => pool.id) } },
          select: poolSelect,
        })
      : [],
  ]);
  const poolCompatibility = new Map(
    (poolRows as ModelPoolRow[]).map((row) => {
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

function serializeCliDevice(row: CliDeviceRow, now: Date) {
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
        lastSeenAt: model.lastSeenAt,
        published: model.published,
        unpublishedAt: model.unpublishedAt,
        maxAttachmentBytes: model.maxAttachmentBytes,
        // Older mocked/serialized inventory rows predate execution targets.
        executionTarget: model.ExecutionTargets?.[0] ?? null,
      })),
    })),
  };
}

function serializePool(row: ModelPoolRow) {
  const recommendedSurfaceOverride = parseModelApiSurface(row.recommendedSurfaceOverride);
  const recommendationOrder: readonly ModelApiSurface[] = [
    "OPENAI_RESPONSES",
    "OPENAI_CHAT_COMPLETIONS",
    "ANTHROPIC_MESSAGES",
    "OPENAI_COMPLETIONS",
  ];
  const memberCapabilities = (model: PoolMemberModelRow) =>
    resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: model.capabilityOverrideMode,
      capabilityOverrideMetadata: model.capabilityOverrideMetadata,
      endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
    }) ??
    openAiCapabilitiesFromCoarse(
      model.capabilityOverrideMode === "OVERRIDE"
        ? model.capabilityOverrides
        : model.Endpoint.defaultCapabilities,
    );
  const memberMatrices = row.PoolMembers.map((member) => {
    const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
    if (model)
      return {
        tier: member.tier,
        matrix: surfaceAvailabilityMatrix({
          capabilities: memberCapabilities(model),
          adaptationEnabled: row.protocolAdaptationEnabled,
        }),
      };
    const provider = member.ExecutionTarget?.ProviderModel;
    const native =
      provider?.nativeCapabilities && typeof provider.nativeCapabilities === "object"
        ? (provider.nativeCapabilities as { surfaces?: unknown; streaming?: unknown })
        : null;
    const nativeSurfaces = new Set(
      Array.isArray(native?.surfaces)
        ? native.surfaces.filter((value): value is string => typeof value === "string")
        : [],
    );
    const surfaceNames: Record<ModelApiSurface, string> = {
      OPENAI_CHAT_COMPLETIONS: "openai-chat",
      OPENAI_RESPONSES: "openai-responses",
      ANTHROPIC_MESSAGES: "anthropic-messages",
      OPENAI_COMPLETIONS: "openai-completions",
    };
    const adaptable = [...nativeSurfaces].some((surface) =>
      ["openai-chat", "openai-responses", "anthropic-messages"].includes(surface),
    );
    return {
      tier: member.tier,
      matrix: Object.fromEntries(
        modelApiSurfaces.map((surface) => {
          const nativeSurface = nativeSurfaces.has(surfaceNames[surface]);
          const adapted =
            !nativeSurface &&
            row.protocolAdaptationEnabled &&
            surface !== "OPENAI_COMPLETIONS" &&
            adaptable;
          return [
            surface,
            {
              mode: nativeSurface ? "native" : adapted ? "adapted" : "unavailable",
              streaming: Boolean(native?.streaming) && (nativeSurface || adapted),
              limitations: adapted ? ["strict_common_subset"] : [],
            },
          ];
        }),
      ) as ReturnType<typeof surfaceAvailabilityMatrix>,
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
  const recommendedSurface =
    recommendedSurfaceOverride ??
    recommendationOrder.find((surface) => surfaces[surface].primary.native > 0) ??
    recommendationOrder.find((surface) => surfaces[surface].primary.adapted > 0) ??
    null;
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
      surfaces,
      warnings: [
        ...(row.protocolAdaptationEnabled ? ["adaptation_strict_subset"] : []),
        ...(row.allowLossyDeveloperRoleCollapse ? ["developer_role_collapse_lossy"] : []),
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
              surfaces: surfaceAvailabilityMatrix({
                capabilities: memberCapabilities(model),
                adaptationEnabled: row.protocolAdaptationEnabled,
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
    select: { id: true, userId: true },
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
  const model = (await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      userId: true,
      published: true,
      capabilityOverrideMode: true,
      capabilityOverrideMetadata: true,
      Endpoint: { select: { published: true, capabilityMetadata: true } },
    },
  })) as {
    id: string;
    userId: string;
    published: boolean;
    capabilityOverrideMode: string;
    capabilityOverrideMetadata: unknown | null;
    Endpoint: { published: boolean; capabilityMetadata: unknown | null };
  } | null;
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

async function assertPoolSlugAvailable(slug: string, userId: string, currentPoolId?: string) {
  const validation = validateForwarderPoolSlug(slug);
  if (!validation.ok) {
    throw new ORPCError("BAD_REQUEST", { message: "forwarderSlug." + validation.reason });
  }

  const existing = await prisma.modelPool.findUnique({
    where: { userId_slug: { userId, slug } },
    select: { id: true },
  });
  if (existing && existing.id !== currentPoolId) {
    throw new ORPCError("CONFLICT", { message: "Model pool slug already exists." });
  }
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
} as const;

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
            localModelIds: z.array(idSchema).min(1).max(64),
            recommendedSurface: z.enum(modelApiSurfaces),
            memberConcurrencyLimit: z.number().int().min(1).max(10_000),
            memberContextCeiling: z.number().int().min(1).max(100_000_000),
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
                      contextCeiling: integerRule(100_000_000),
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
                message: "Public egress acknowledgement is required",
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
      const userId = context.session.user.id;
      await assertPoolSlugAvailable(input.slug, userId);
      const now = new Date();
      return prisma.$transaction(
        async (tx) => {
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
            throw new ORPCError("NOT_FOUND", { message: "A selected local model is unavailable" });
          }
          const primaryMatrices = localModels.map((model) =>
            surfaceAvailabilityMatrix({
              capabilities:
                resolveEffectiveCapabilityMetadata({
                  capabilityOverrideMode: model.capabilityOverrideMode,
                  capabilityOverrideMetadata: model.capabilityOverrideMetadata,
                  endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
                }) ??
                openAiCapabilitiesFromCoarse(
                  model.capabilityOverrideMode === "OVERRIDE"
                    ? model.capabilityOverrides
                    : model.Endpoint.defaultCapabilities,
                ),
              adaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
            }),
          );
          const recommendedSurface = [
            "OPENAI_RESPONSES",
            "OPENAI_CHAT_COMPLETIONS",
            "ANTHROPIC_MESSAGES",
          ]
            .map((surface, orderIndex) => {
              const typedSurface = surface as Exclude<
                (typeof modelApiSurfaces)[number],
                "OPENAI_COMPLETIONS"
              >;
              return {
                surface: typedSurface,
                orderIndex,
                nativeCount: primaryMatrices.filter(
                  (matrix) => matrix[typedSurface].mode === "native",
                ).length,
                limitations: primaryMatrices.reduce(
                  (count, matrix) => count + matrix[typedSurface].limitations.length,
                  0,
                ),
                available: primaryMatrices.every(
                  (matrix) => matrix[typedSurface].mode !== "unavailable",
                ),
              };
            })
            .filter((candidate) => candidate.available)
            .sort(
              (left, right) =>
                right.nativeCount - left.nativeCount ||
                left.limitations - right.limitations ||
                left.orderIndex - right.orderIndex,
            )[0]?.surface;
          if (!recommendedSurface || input.recommendedSurface !== recommendedSurface) {
            throw new ORPCError("BAD_REQUEST", {
              message:
                "Recommended API must be the best API supported by every selected primary model.",
            });
          }
          const localTargets = await tx.executionTarget.findMany({
            where: { userId, discoveredModelId: { in: input.localModelIds } },
            select: {
              id: true,
              discoveredModelId: true,
              inferenceCapacityId: true,
              InferenceCapacity: { select: { physicalMaxContext: true } },
            },
          });
          if (
            localTargets.length !== localModels.length ||
            localTargets.some((target) => !target.inferenceCapacityId)
          ) {
            throw new ORPCError("PRECONDITION_FAILED", {
              message:
                "Every selected local model must already have an explicitly assigned physical capacity.",
            });
          }
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
            });
          }
          for (const target of localTargets) {
            const override = target.discoveredModelId
              ? memberOverrideByModelId.get(target.discoveredModelId)
              : undefined;
            if (!override) continue;
            if (
              override.concurrency.mode === "LIMITED" &&
              override.reservedSlots > override.concurrency.limitValue
            ) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Reserved slots exceed a member concurrency override.",
              });
            }
            const physicalMaximum = target.InferenceCapacity?.physicalMaxContext;
            if (
              override.contextCeiling.mode === "LIMITED" &&
              physicalMaximum != null &&
              override.contextCeiling.limitValue + override.contextMargin > physicalMaximum
            ) {
              throw new ORPCError("BAD_REQUEST", {
                message: "A member context override exceeds physical capacity after margin.",
              });
            }
          }
          if (
            localTargets.some((target) => {
              const maximum = target.InferenceCapacity?.physicalMaxContext;
              return (
                maximum != null &&
                input.memberContextCeiling + (input.advanced?.contextMargin ?? 0) > maximum
              );
            })
          ) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Member context exceeds a selected model's physical capacity.",
            });
          }
          const providerIds = input.providerModels.map((item) => item.providerModelId);
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
              message: "A selected provider is not ready for guarded overflow",
            });
          }
          const pool = await tx.modelPool.create({
            data: {
              userId,
              slug: input.slug,
              name: input.name,
              protocolAdaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
              allowLossyDeveloperRoleCollapse:
                input.advanced?.allowLossyDeveloperRoleCollapse ?? false,
              publicEgressEnabled: providerIds.length > 0,
              publicEgressAcknowledged: providerIds.length > 0,
              recommendedSurfaceOverride: input.recommendedSurface,
              capacityPriority: 16,
              capacityConcurrencyLimit: input.memberConcurrencyLimit,
              capacityReservedSlots: input.reservedSlots,
              capacityWaitBudgetMs: input.localWaitBudgetMs,
              capacityContextCeiling: input.memberContextCeiling,
              capacityContextMargin:
                input.advanced?.contextMargin ??
                Math.min(1024, Math.max(0, input.memberContextCeiling - 1)),
              capacityBorrowPolicy: input.advanced?.borrowPolicy ?? "WHEN_IDLE",
              affinityEnabled: input.advanced?.affinity.enabled ?? false,
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
                      capacityContextMargin: override.contextMargin,
                    }
                  : {}),
              },
            });
          }
          const providerById = new Map(providers.map((provider) => [provider.id, provider]));
          for (const [publicOrder, protection] of input.providerModels.entries()) {
            const provider = providerById.get(protection.providerModelId);
            if (!provider) throw new ORPCError("PRECONDITION_FAILED");
            const target = await tx.executionTarget.upsert({
              where: { providerModelId: provider.id },
              update: {},
              create: { userId, kind: "PROVIDER_MODEL", providerModelId: provider.id },
              select: { id: true },
            });
            await tx.poolMember.create({
              data: {
                poolId: pool.id,
                executionTargetId: target.id,
                tier: "PUBLIC_OVERFLOW",
                publicOrder,
                weight: 0,
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
          const created = (await tx.modelPool.findUnique({
            where: { id: pool.id },
            select: poolSelect,
          })) as ModelPoolRow | null;
          if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
          return serializePool(created);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
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
      const rows = (await prisma.cliDevice.findMany({
        where: { userId: context.session.user.id },
        orderBy: { createdAt: "desc" },
        select: {
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
          User: { select: { slug: true } },
          Endpoints: {
            orderBy: { createdAt: "asc" },
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
                orderBy: { createdAt: "asc" },
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
                  ExecutionTargets: {
                    take: 1,
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
        },
      })) as CliDeviceRow[];

      const now = new Date();
      return rows.map((row) => serializeCliDevice(row, now));
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
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "discoveredModel",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  listModelPools: protectedProcedure.handler(async ({ context }) => {
    const rows = (await prisma.modelPool.findMany({
      where: { userId: context.session.user.id },
      orderBy: { createdAt: "desc" },
      select: poolSelect,
    })) as ModelPoolRow[];
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
        recommendedSurfaceOverride: z.enum(modelApiSurfaces).nullable().optional(),
        capacityPriority: z.number().int().min(0).max(31).optional(),
        capacityConcurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
        capacityReservedSlots: z.number().int().min(0).max(10_000).optional(),
        capacityWaitBudgetMs: z.number().int().min(0).max(600_000).nullable().optional(),
        capacityContextCeiling: z.number().int().positive().max(100_000_000).nullable().optional(),
        capacityContextMargin: z.number().int().min(0).max(100_000_000).optional(),
        capacityBorrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]).optional(),
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
      await assertPoolSlugAvailable(input.slug, context.session.user.id);
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);
      const userId = context.session.user.id;
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
        capacityPriority: input.capacityPriority ?? 16,
        capacityConcurrencyLimit: input.capacityConcurrencyLimit ?? null,
        capacityReservedSlots: input.capacityReservedSlots ?? 0,
        capacityWaitBudgetMs: input.capacityWaitBudgetMs ?? null,
        capacityContextCeiling: input.capacityContextCeiling ?? null,
        capacityContextMargin: input.capacityContextMargin ?? 0,
        capacityBorrowPolicy: input.capacityBorrowPolicy ?? "WHEN_IDLE",
        affinityEnabled: input.affinityEnabled ?? false,
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
        const created = (await tx.modelPool.create({
          data,
          select: poolSelect,
        })) as ModelPoolRow;
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
        maxAttachmentBytes: attachmentLimitSchema,
        optimisticBasicTranscription: z.boolean().optional(),
        protocolAdaptationEnabled: z.boolean().optional(),
        publicEgressEnabled: z.boolean().optional(),
        publicEgressAcknowledged: z.literal(true).optional(),
        allowLossyDeveloperRoleCollapse: z.boolean().optional(),
        recommendedSurfaceOverride: z.enum(modelApiSurfaces).nullable().optional(),
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
      const existing = (await prisma.modelPool.findUnique({
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
        },
      })) as {
        id: string;
        userId: string;
        transformerDiscoveredModelId: string | null;
        transformerImages: boolean;
        transformerAudio: boolean;
        transformerVideo: boolean;
        transformerCacheMode: string;
        publicEgressEnabled: boolean;
        publicEgressAcknowledged: boolean;
      } | null;
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      if (input.slug) {
        await assertPoolSlugAvailable(input.slug, context.session.user.id, input.id);
      }
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);

      const nextPublicEgressEnabled = input.publicEgressEnabled ?? existing.publicEgressEnabled;
      const nextPublicEgressAcknowledged =
        input.publicEgressAcknowledged ?? existing.publicEgressAcknowledged;
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

      const nextTransformerId =
        input.transformerDiscoveredModelId !== undefined
          ? input.transformerDiscoveredModelId
          : existing.transformerDiscoveredModelId;
      const nextImages =
        input.transformerImages !== undefined
          ? input.transformerImages
          : existing.transformerImages;
      const nextAudio =
        input.transformerAudio !== undefined ? input.transformerAudio : existing.transformerAudio;
      const nextVideo =
        input.transformerVideo !== undefined ? input.transformerVideo : existing.transformerVideo;

      if (nextTransformerId) {
        const caps = await transformerCapabilitiesForOwnedModel(
          nextTransformerId,
          context.session.user.id,
        );
        assertTransformerMatchesModalities({
          caps,
          images: nextImages,
          audio: nextAudio,
          video: nextVideo,
        });
      } else if (input.transformerDiscoveredModelId === null) {
        // clearing transformer — ok
      }

      const row = (await prisma.modelPool.update({
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
        },
        select: poolSelect,
      })) as ModelPoolRow;
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
      await ownedDiscoveredModel(input.discoveredModelId, context.session.user.id);
      return prisma.$transaction(async (tx) => {
        const target = await tx.executionTarget.upsert({
          where: { discoveredModelId: input.discoveredModelId },
          update: {},
          create: {
            userId: context.session.user.id,
            kind: "DISCOVERED_MODEL",
            discoveredModelId: input.discoveredModelId,
          },
          select: { id: true },
        });
        const member = await tx.poolMember.create({
          data: {
            poolId: input.poolId,
            discoveredModelId: input.discoveredModelId,
            executionTargetId: target.id,
            weight: input.weight,
            routingStatus: input.routingStatus,
          },
          select: { id: true },
        });
        return { id: member.id, executionTargetId: target.id };
      });
    }),

  addProviderPoolMember: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        providerModelId: idSchema,
        publicOrder: z.number().int().min(0).max(10_000),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        const candidatePool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: { id: true },
        });
        if (!candidatePool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidatePool.id} AND "userId" = ${userId} FOR UPDATE`;
        const pool = await tx.modelPool.findFirst({
          where: { id: candidatePool.id, userId },
          select: { id: true, publicEgressEnabled: true, publicEgressAcknowledged: true },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        if (!pool.publicEgressEnabled || !pool.publicEgressAcknowledged) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Acknowledge and enable public egress before adding an overflow target.",
          });
        }
        const providerModel = await tx.providerModel.findFirst({
          where: { id: input.providerModelId, userId, deletedAt: null },
          select: { id: true, providerAccountId: true, enabled: true },
        });
        if (!providerModel) {
          throw new ORPCError("NOT_FOUND", { message: "Provider model not found." });
        }
        if (!providerModel.enabled) {
          throw new ORPCError("BAD_REQUEST", { message: "Enable the provider model first." });
        }
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
        const target = await tx.executionTarget.upsert({
          where: { providerModelId: input.providerModelId },
          update: {},
          create: { userId, kind: "PROVIDER_MODEL", providerModelId: input.providerModelId },
          select: { id: true },
        });
        const member = await tx.poolMember.create({
          data: {
            poolId: input.poolId,
            executionTargetId: target.id,
            tier: "PUBLIC_OVERFLOW",
            publicOrder: input.publicOrder,
            weight: 0,
          },
          select: { id: true },
        });
        const ordered = await tx.poolMember.findMany({
          where: { poolId: input.poolId, tier: "PUBLIC_OVERFLOW", id: { not: member.id } },
          orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        ordered.splice(Math.min(input.publicOrder, ordered.length), 0, member);
        for (const [publicOrder, orderedMember] of ordered.entries()) {
          await tx.poolMember.update({
            where: { id: orderedMember.id },
            data: { publicOrder },
          });
        }
        return { id: member.id, executionTargetId: target.id };
      });
    }),

  updatePoolMember: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        weight: z.number().int().min(0).max(10_000).optional(),
        routingStatus: routingStatusSchema.optional(),
        publicOrder: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const member = await prisma.poolMember.findUnique({
        where: { id: input.id },
        select: { id: true, ModelPool: { select: { userId: true } } },
      });
      if (!member || member.ModelPool.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
      }
      return prisma.poolMember.update({
        where: { id: input.id },
        data: {
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.routingStatus ? { routingStatus: input.routingStatus } : {}),
          ...(input.publicOrder !== undefined ? { publicOrder: input.publicOrder } : {}),
        },
        select: { id: true, weight: true, routingStatus: true, tier: true, publicOrder: true },
      });
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
        for (const [publicOrder, member] of members.entries()) {
          await tx.poolMember.update({ where: { id: member.id }, data: { publicOrder } });
        }
        return { moved: true };
      });
    }),

  removePoolMember: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      const member = await prisma.poolMember.findUnique({
        where: { id: input.id },
        select: { id: true, ModelPool: { select: { userId: true } } },
      });
      if (!member || member.ModelPool.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
      }
      await prisma.poolMember.delete({ where: { id: input.id } });
      return { deleted: true };
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
        return prisma.discoveredModel.update({
          where: { id: input.id },
          data: {
            capabilityOverrideMode: "OVERRIDE",
            capabilityOverrideOrigin: "DASHBOARD",
            capabilityOverrides: { set: nextCoarse },
            capabilityOverrideMetadata: openAiCapabilitiesFromCoarse(nextCoarse),
          },
          select: {
            id: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
          },
        });
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
      if (
        metadata.chatCompletions?.supported ||
        metadata.completions?.supported ||
        metadata.responses?.supported
      ) {
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
      return prisma.discoveredModel.update({
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
      return prisma.discoveredModel.update({
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
      if (pool.publicEgressEnabled && !input.publicEgressAcknowledged) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Public-provider egress acknowledgement is required for this grant.",
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
