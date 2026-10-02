import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { fenceOwners, fenceParentDelete } from "@ws-model-proxy/db/capacity-lock-order";
import { clearCacheAffinityRecords } from "@ws-model-proxy/db/hot-path-sweeps";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  CACHE_STATS_MAX_LAST_DAYS,
  CACHE_STATS_MAX_LAST_MINUTES,
  type CacheStatsQueryRow,
  resolveCacheStatsWindow,
  shapeCacheStats,
} from "../lib/cache-stats";
import {
  assertModelPoolCapacityPolicy,
  cacheHolderWaitMsSchema,
  fenceAndValidateModelPoolCapacityPolicy,
  modelPoolCapacityPolicyFields,
} from "../lib/capacity-policy-safety";
import {
  type ContextWindowSeedDependent,
  isContextWindowSeedAdmissible,
} from "../lib/declared-context-window";
import { parseModelApiSurface } from "../lib/model-api-surface";
import {
  resolveEffectiveCapabilityMetadata,
  transformerModalityMismatchErrors,
  transformerSupportedModalities,
} from "../lib/openai-compatible-capabilities";
import {
  assertExternalAfterWaitWithinBudget,
  assertPoolFallbackEnableable,
  assertProviderEgressReleaseGate,
  poolFallbackChangeSource,
  recordPoolFallbackAudit,
} from "../lib/pool-fallback-settings";
import { assertRecommendedSurfaceServable } from "../lib/pool-recommended-surface";
import { loadPoolSurfaceMembers } from "../lib/pool-surface-members";
import {
  runCapacityDeleteTransaction,
  runSerializableTransaction,
} from "../lib/serializable-transaction";
import {
  poolSelect,
  poolSummarySelect,
  serializePool,
  serializePoolSummary,
} from "./forwarder-serializers";
import {
  assertAttachmentLimitWithinGlobal,
  assertLossyDeveloperRoleCollapseRequiresAdaptation,
  assertPoolSlugAvailable,
  attachmentLimitSchema,
  encodeSummaryCursor,
  hasModelPoolCapacityPolicy,
  idSchema,
  poolDescriptionSchema,
  poolFallbackFields,
  poolNameSchema,
  poolProtectionFields,
  poolRecommendedSurfaceSchema,
  poolSlugSchema,
  poolTransformerFields,
  resolvePoolProtectionShare,
  summaryPageInput,
  summaryPageWhere,
} from "./forwarder-shared";

export async function seedDeclaredContextWindows({
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

export async function ownedPool(poolId: string, userId: string) {
  const pool = await prisma.modelPool.findUnique({
    where: { id: poolId },
    select: { id: true, userId: true, fallbackEnabled: true },
  });
  if (!pool || pool.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
  }
  return pool;
}

async function accessiblePool(poolId: string, userId: string) {
  const pool = await prisma.modelPool.findUnique({
    where: { id: poolId },
    select: { id: true, userId: true },
  });
  if (!pool) {
    throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
  }
  if (pool.userId === userId) return { pool, ownerScope: true };
  const grant = await prisma.poolGrant.findFirst({
    where: { poolId, granteeUserId: userId },
    select: { id: true },
  });
  if (!grant) {
    throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
  }
  return { pool, ownerScope: false };
}

const poolCacheStatsInput = z
  .object({
    poolId: idSchema,
    poolMemberId: idSchema.optional(),
    lastMinutes: z.number().int().min(1).max(CACHE_STATS_MAX_LAST_MINUTES).optional(),
    lastDays: z.number().int().min(1).max(CACHE_STATS_MAX_LAST_DAYS).optional(),
    bucket: z.number().int().min(1).max(CACHE_STATS_MAX_LAST_MINUTES).optional(),
    split: z.literal("member").optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.lastMinutes != null) === (value.lastDays != null)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of lastMinutes or lastDays.",
      });
    }
  });

async function queryCacheStatsRows({
  table,
  poolId,
  poolMemberId,
  userId,
  ownerScope,
  start,
  end,
}: {
  table: "usage_rollup_minute" | "usage_rollup_hour";
  poolId: string;
  poolMemberId: string | undefined;
  userId: string;
  ownerScope: boolean;
  start: Date;
  end: Date;
}): Promise<CacheStatsQueryRow[]> {
  const memberId = poolMemberId ?? "";
  if (table === "usage_rollup_hour") {
    return prisma.$queryRaw<CacheStatsQueryRow[]>`
      SELECT r."bucketStart", r."poolMemberId",
             SUM(r.requests)::bigint AS requests,
             SUM(r."cacheReadTokens")::bigint AS "cacheReadTokens",
             SUM(r."cacheKnownRequests")::bigint AS "cacheKnownRequests",
             SUM(r."cacheKnownInputTokens")::bigint AS "cacheKnownInputTokens",
             SUM(r."continuationRequests")::bigint AS "continuationRequests",
             SUM(r."continuationInputTokens")::bigint AS "continuationInputTokens",
             SUM(r."continuationCacheReadTokens")::bigint AS "continuationCacheReadTokens"
        FROM usage_rollup_hour r
       WHERE r."poolId" = ${poolId}
         AND r."bucketStart" >= ${start}
         AND r."bucketStart" < ${end}
         AND r.source::text = 'API_TOKEN'
         AND (
           (${ownerScope} AND r."ownerUserId" = ${userId})
           OR (NOT ${ownerScope} AND r."requesterUserId" = ${userId} AND r."ownerUserId" <> ${userId})
         )
         AND (${memberId} = '' OR r."poolMemberId" = ${memberId})
       GROUP BY 1, 2`;
  }
  return prisma.$queryRaw<CacheStatsQueryRow[]>`
    SELECT r."bucketStart", r."poolMemberId",
           SUM(r.requests)::bigint AS requests,
           SUM(r."cacheReadTokens")::bigint AS "cacheReadTokens",
           SUM(r."cacheKnownRequests")::bigint AS "cacheKnownRequests",
           SUM(r."cacheKnownInputTokens")::bigint AS "cacheKnownInputTokens",
           SUM(r."continuationRequests")::bigint AS "continuationRequests",
           SUM(r."continuationInputTokens")::bigint AS "continuationInputTokens",
           SUM(r."continuationCacheReadTokens")::bigint AS "continuationCacheReadTokens"
      FROM usage_rollup_minute r
     WHERE r."poolId" = ${poolId}
       AND r."bucketStart" >= ${start}
       AND r."bucketStart" < ${end}
       AND r.source::text = 'API_TOKEN'
       AND (
         (${ownerScope} AND r."ownerUserId" = ${userId})
         OR (NOT ${ownerScope} AND r."requesterUserId" = ${userId} AND r."ownerUserId" <> ${userId})
       )
       AND (${memberId} = '' OR r."poolMemberId" = ${memberId})
     GROUP BY 1, 2`;
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

export const poolProcedures = {
  /** Dashboard inventory. Inlines members and models; not an MCP tool. */
  listModelPools: protectedProcedure.handler(async ({ context }) => {
    const rows = await prisma.modelPool.findMany({
      where: { userId: context.session.user.id },
      orderBy: { createdAt: "desc" },
      select: poolSelect,
    });
    return rows.map(serializePool);
  }),

  /**
   * MCP `forwarder_model_pools_list`. Summaries only, one page at a time.
   * Members carry endpoint slugs and probe-like routing status, not models.
   */
  listModelPoolSummaries: protectedProcedure
    .input(summaryPageInput)
    .handler(async ({ input, context }) => {
      const rows = await prisma.modelPool.findMany({
        where: summaryPageWhere(context.session.user.id, input.cursor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: poolSummarySelect,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(serializePoolSummary),
        nextCursor:
          rows.length > input.limit && last !== undefined ? encodeSummaryCursor(last) : null,
      };
    }),

  /** MCP `forwarder_model_pool_get`. The full pool, including members and models. */
  getModelPool: protectedProcedure
    .input(z.object({ poolId: idSchema }))
    .handler(async ({ input, context }) => {
      const row = await prisma.modelPool.findUnique({
        where: { id: input.poolId },
        select: { ...poolSelect, userId: true },
      });
      if (!row || row.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      return serializePool(row);
    }),

  poolCacheStats: protectedProcedure
    .input(poolCacheStatsInput)
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const { ownerScope } = await accessiblePool(input.poolId, userId);
      if (input.poolMemberId) {
        const member = await prisma.poolMember.findUnique({
          where: { id: input.poolMemberId },
          select: { id: true, poolId: true },
        });
        if (!member || member.poolId !== input.poolId) {
          throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        }
      }
      const window = resolveCacheStatsWindow(
        {
          lastMinutes: input.lastMinutes,
          lastDays: input.lastDays,
          bucket: input.bucket,
        },
        new Date(),
      );
      const minuteStart = window.hourUntil ?? window.start;
      const [minuteRows, hourRows] = await Promise.all([
        minuteStart < window.end
          ? queryCacheStatsRows({
              table: "usage_rollup_minute",
              poolId: input.poolId,
              poolMemberId: input.poolMemberId,
              userId,
              ownerScope,
              start: minuteStart,
              end: window.end,
            })
          : Promise.resolve([] as CacheStatsQueryRow[]),
        window.hourUntil && window.start < window.hourUntil
          ? queryCacheStatsRows({
              table: "usage_rollup_hour",
              poolId: input.poolId,
              poolMemberId: input.poolMemberId,
              userId,
              ownerScope,
              start: window.start,
              end: window.hourUntil,
            })
          : Promise.resolve([] as CacheStatsQueryRow[]),
      ]);
      return shapeCacheStats({
        window,
        rows: [...hourRows, ...minuteRows],
        split: input.split,
      });
    }),

  cacheAffinityStats: protectedProcedure
    .input(z.object({ poolId: idSchema }))
    .handler(async ({ input, context }) => {
      await ownedPool(input.poolId, context.session.user.id);
      const now = new Date();
      const [activeRecords, confirmedRecords, targetGroups, activeNodes] = await Promise.all([
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
        prisma.cacheAffinityNode.count({
          where: { userId: context.session.user.id, poolId: input.poolId, expiresAt: { gt: now } },
        }),
      ]);
      return {
        activeRecords,
        activeNodes,
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
      return {
        deleted: await clearCacheAffinityRecords(prisma, {
          ownerUserId: context.session.user.id,
          poolId: input.poolId,
        }),
      };
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
        ...poolFallbackFields,
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
        affinityResidencyWeight: z.number().int().min(0).max(10_000).optional(),
        cacheHolderWaitMs: cacheHolderWaitMsSchema,
        ...poolProtectionFields,
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.fallbackEnabled === true)
        assertProviderEgressReleaseGate("PROVIDER_EGRESS_DISABLED");
      const protectionShare = resolvePoolProtectionShare(input, {
        protectionShare: "EQUAL_SHARE",
        protectionFixedPercent: null,
      });
      assertExternalAfterWaitWithinBudget({
        externalAfterWaitMs: input.externalAfterWaitMs,
        currentExternalAfterWaitMs: null,
        capacityWaitBudgetMs: input.capacityWaitBudgetMs ?? null,
      });
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
        // Fallback fields not given keep the schema defaults (forwarder.prisma).
        ...(input.fallbackEnabled !== undefined ? { fallbackEnabled: input.fallbackEnabled } : {}),
        ...(input.fallbackForGrantees !== undefined
          ? { fallbackForGrantees: input.fallbackForGrantees }
          : {}),
        ...(input.externalAfterWaitMs !== undefined
          ? { externalAfterWaitMs: input.externalAfterWaitMs }
          : {}),
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
        affinityResidencyWeight: input.affinityResidencyWeight ?? 100,
        cacheHolderWaitMs: input.cacheHolderWaitMs ?? null,
        protectionEnabled: input.protectionEnabled ?? true,
        evictionFeedbackEnabled: input.evictionFeedbackEnabled ?? true,
        protectionWindowSeconds: input.protectionWindowSeconds ?? 300,
        protectMinTokens: input.protectMinTokens ?? 8192,
        protectionShare: protectionShare.protectionShare ?? "EQUAL_SHARE",
        protectionFixedPercent: protectionShare.protectionFixedPercent ?? null,
        ownerProtectionPercent: input.ownerProtectionPercent ?? null,
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
        // Writer class M: the owner fence before the graph insert.
        await fenceOwners(tx, [userId]);
        const created = await tx.modelPool.create({
          data,
          select: poolSelect,
        });
        // Fallback values the creator set explicitly are recorded (from the
        // stored row, before = null); schema defaults are not a change.
        await recordPoolFallbackAudit(tx, {
          userId,
          poolId: created.id,
          before: null,
          after: {
            ...(input.fallbackEnabled !== undefined
              ? { fallbackEnabled: created.fallbackEnabled }
              : {}),
            ...(input.fallbackForGrantees !== undefined
              ? { fallbackForGrantees: created.fallbackForGrantees }
              : {}),
            ...(input.externalAfterWaitMs !== undefined
              ? { externalAfterWaitMs: created.externalAfterWaitMs }
              : {}),
          },
          source: poolFallbackChangeSource(context),
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
        ...poolFallbackFields,
        allowLossyDeveloperRoleCollapse: z.boolean().optional(),
        recommendedSurfaceOverride: poolRecommendedSurfaceSchema.nullable().optional(),
        affinityEnabled: z.boolean().optional(),
        affinityTtlSeconds: z.number().int().min(60).max(604_800).optional(),
        affinityMaxRecords: z.number().int().min(100).max(100_000).optional(),
        affinityPrefixWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConversationWeight: z.number().int().min(0).max(10_000).optional(),
        affinityConfirmedCacheWeight: z.number().int().min(0).max(10_000).optional(),
        affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000).optional(),
        affinityResidencyWeight: z.number().int().min(0).max(10_000).optional(),
        cacheHolderWaitMs: cacheHolderWaitMsSchema,
        ...poolProtectionFields,
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
          fallbackEnabled: true,
          capacityWaitBudgetMs: true,
          externalAfterWaitMs: true,
          protocolAdaptationEnabled: true,
          allowLossyDeveloperRoleCollapse: true,
        },
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      const hasCapacityPolicy = hasModelPoolCapacityPolicy(input);
      if (input.slug) {
        await assertPoolSlugAvailable(input.slug, context.session.user.id, input.id);
      }
      await assertAttachmentLimitWithinGlobal(input.maxAttachmentBytes);

      // Turning fallback OFF is always allowed (members stay configured and
      // the runtime stops using them). Turning it ON needs the deployment
      // switch and audited protection policies on every external member. No
      // separate acknowledgement: callers opt in per request with `:external`.
      if (input.fallbackEnabled === true)
        assertProviderEgressReleaseGate("PROVIDER_EGRESS_DISABLED");
      assertExternalAfterWaitWithinBudget({
        externalAfterWaitMs: input.externalAfterWaitMs,
        currentExternalAfterWaitMs: existing.externalAfterWaitMs,
        capacityWaitBudgetMs:
          input.capacityWaitBudgetMs !== undefined
            ? input.capacityWaitBudgetMs
            : existing.capacityWaitBudgetMs,
      });
      if (input.fallbackEnabled === true)
        await assertPoolFallbackEnableable(existing.id, context.session.user.id);

      await assertPoolTransformerIsValid(input, existing, context.session.user.id);

      const updated = await runSerializableTransaction(async (tx) => {
        const userId = context.session.user.id;
        // Writer class M: the owner fence, then (for a capacity policy edit)
        // the capacity-policy fences of every member target, then the pool
        // row (the E0 send claim's C1 order) before any other write.
        await fenceOwners(tx, [userId]);
        if (hasCapacityPolicy)
          await fenceAndValidateModelPoolCapacityPolicy(tx, {
            modelPoolId: input.id,
            userId,
            policy: input,
            notFound: () => {
              throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
            },
          });
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.id} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        const current = await tx.modelPool.findUnique({
          where: { id: input.id },
          select: {
            userId: true,
            name: true,
            fallbackEnabled: true,
            fallbackForGrantees: true,
            externalAfterWaitMs: true,
            protocolAdaptationEnabled: true,
            allowLossyDeveloperRoleCollapse: true,
            recommendedSurfaceOverride: true,
            protectionShare: true,
            protectionFixedPercent: true,
          },
        });
        if (!current || current.userId !== userId) {
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
            adaptationEnabled: input.protocolAdaptationEnabled ?? current.protocolAdaptationEnabled,
          });
        }
        const row = await tx.modelPool.update({
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
            ...(input.fallbackEnabled !== undefined
              ? { fallbackEnabled: input.fallbackEnabled }
              : {}),
            ...(input.fallbackForGrantees !== undefined
              ? { fallbackForGrantees: input.fallbackForGrantees }
              : {}),
            ...(input.externalAfterWaitMs !== undefined
              ? { externalAfterWaitMs: input.externalAfterWaitMs }
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
            ...(input.affinityResidencyWeight !== undefined
              ? { affinityResidencyWeight: input.affinityResidencyWeight }
              : {}),
            ...(input.cacheHolderWaitMs !== undefined
              ? { cacheHolderWaitMs: input.cacheHolderWaitMs }
              : {}),
            ...(input.protectionEnabled !== undefined
              ? { protectionEnabled: input.protectionEnabled }
              : {}),
            ...(input.evictionFeedbackEnabled !== undefined
              ? { evictionFeedbackEnabled: input.evictionFeedbackEnabled }
              : {}),
            ...(input.protectionWindowSeconds !== undefined
              ? { protectionWindowSeconds: input.protectionWindowSeconds }
              : {}),
            ...(input.protectMinTokens !== undefined
              ? { protectMinTokens: input.protectMinTokens }
              : {}),
            ...resolvePoolProtectionShare(input, current),
            ...(input.ownerProtectionPercent !== undefined
              ? { ownerProtectionPercent: input.ownerProtectionPercent }
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
        // Every change of the external-fallback settings is audited, from
        // the dashboard and from MCP alike (issue #67).
        await recordPoolFallbackAudit(tx, {
          userId,
          poolId: input.id,
          before: {
            fallbackEnabled: current.fallbackEnabled,
            fallbackForGrantees: current.fallbackForGrantees,
            externalAfterWaitMs: current.externalAfterWaitMs,
          },
          after: {
            fallbackEnabled: row.fallbackEnabled,
            fallbackForGrantees: row.fallbackForGrantees,
            externalAfterWaitMs: row.externalAfterWaitMs,
          },
          source: poolFallbackChangeSource(context),
        });
        return row;
      });
      return serializePool(updated);
    }),

  deleteModelPool: protectedProcedure
    .input(z.object({ id: idSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      await ownedPool(input.id, userId);
      // A plain delete under the owner fences of every user its cascade
      // writes (the owner, the pool's grantees, the owners of allowlist
      // entries naming it): fenceParentDelete. Request, admission and lease
      // history keeps the pool's id; the capacity sweeper terminalizes its
      // live orphans.
      await runCapacityDeleteTransaction(async (tx) => {
        await fenceParentDelete(tx, { userId, poolIds: [input.id] });
        await tx.modelPool.delete({ where: { id: input.id } });
      });
      return { deleted: true };
    }),
};
