import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  acquireFences,
  fenceOwners,
  fenceParentDelete,
  fences,
} from "@ws-model-proxy/db/capacity-lock-order";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  assertEffectiveContextPolicy,
  fenceExecutionTargetPolicies,
} from "../lib/capacity-policy-safety";
import { declaredContextWindow } from "../lib/declared-context-window";
import {
  ensureDiscoveredInferenceCapacity,
  existingDiscoveredCapacityCandidates,
  linkExecutionTargetCapacity,
} from "../lib/discovered-inference-capacity";
import { grantPoolAccessServerMessages } from "../lib/effective-provider-egress";
import { parseModelApiSurface } from "../lib/model-api-surface";
import { listVisibleModelTargetsForUser } from "../lib/model-api-token-access";
import {
  audioOperationSupported,
  coarseCapabilitiesFromOpenAi,
  openAiCapabilitiesFromCoarse,
  openAiCompatibleCapabilitiesSchema,
  resolveEffectiveCapabilityMetadata,
} from "../lib/openai-compatible-capabilities";
import {
  capabilityEditImpactedPools,
  discoveredModelPoolMemberWhere,
  poolIdsWithMembers,
} from "../lib/pool-capability-impact";
import { assertProviderEgressReleaseGate } from "../lib/pool-fallback-settings";
import {
  poolGrantSpendCapSchema,
  serializePoolGrantSpendCap,
  upsertPoolGrantSpendCap,
} from "../lib/pool-grant-spend-cap";
import {
  assertRecommendedSurfaceServable,
  discoveredModelSurfaceCapabilities,
} from "../lib/pool-recommended-surface";
import { loadPoolSurfaceMembers } from "../lib/pool-surface-members";
import {
  runCapacityDeleteTransaction,
  runSerializableCapacityCreationTransaction,
  runSerializableTransaction,
} from "../lib/serializable-transaction";
import { ownedPool, seedDeclaredContextWindows } from "./forwarder-pools";
import { serializeVisibleTargets } from "./forwarder-serializers";
import {
  assertAttachmentLimitWithinGlobal,
  assertConcurrencyPolicyWithinHardLimit,
  attachmentLimitSchema,
  createPoolMember,
  idSchema,
  routingStatusSchema,
} from "./forwarder-shared";

async function ownedDiscoveredModel(discoveredModelId: string, userId: string) {
  const model = await prisma.discoveredModel.findUnique({
    where: { id: discoveredModelId },
    select: {
      id: true,
      userId: true,
      upstreamModelId: true,
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

/**
 * A member may be detached when it exists, belongs to the caller's pool and,
 * for a PRIMARY member, the pool's effective recommended surface stays
 * servable across the remaining members (an overflow member leaves
 * selectability untouched).
 */
async function assertPoolMemberRemovable(
  db: Pick<Prisma.TransactionClient, "poolMember">,
  memberId: string,
  userId: string,
): Promise<void> {
  const member = await db.poolMember.findUnique({
    where: { id: memberId },
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
  if (member.tier === "PRIMARY") {
    const surfaceMembers = await loadPoolSurfaceMembers(db, member.poolId, member.id);
    assertRecommendedSurfaceServable({
      override: parseModelApiSurface(member.ModelPool.recommendedSurfaceOverride),
      members: surfaceMembers,
      adaptationEnabled: member.ModelPool.protocolAdaptationEnabled,
    });
  }
}

export const poolMemberProcedures = {
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
      return runSerializableCapacityCreationTransaction(async (tx) => {
        const userId = context.session.user.id;
        // Writer class M (@ws-model-proxy/db/capacity-lock-order): the owner
        // fence; then, planned with reads only, the capacity-policy fences of
        // the operated target and every target sharing a capacity it may seed
        // and the capacity fences of the capacity rows it may write; then the
        // pool row, and only then adopt, fill or link a capacity.
        await fenceOwners(tx, [userId]);
        const plannedTarget = await tx.executionTarget.findUnique({
          where: { discoveredModelId: input.discoveredModelId },
          select: { id: true, inferenceCapacityId: true },
        });
        const candidateCapacityIds =
          plannedTarget?.inferenceCapacityId != null
            ? [plannedTarget.inferenceCapacityId]
            : await existingDiscoveredCapacityCandidates(tx, {
                userId,
                discoveredModelId: input.discoveredModelId,
                executionTargetId: plannedTarget?.id,
              });
        const targetsSharingCandidateCapacity =
          declaredContext != null && candidateCapacityIds.length > 0
            ? await tx.executionTarget.findMany({
                where: {
                  userId,
                  inferenceCapacityId: { in: candidateCapacityIds },
                },
                select: { id: true },
              })
            : [];
        const policyLockTargetIds = new Set([
          ...(plannedTarget ? [plannedTarget.id] : []),
          ...targetsSharingCandidateCapacity.map((sharedTarget) => sharedTarget.id),
        ]);
        await acquireFences(tx, [
          ...[...policyLockTargetIds].map((targetId) => fences.capacityPolicy(targetId)),
          ...candidateCapacityIds.map((capacityId) => fences.capacity(capacityId)),
        ]);
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.poolId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
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
          adaptationEnabled: surfacePool.protocolAdaptationEnabled,
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
        // A target the upsert created is new: it needs no policy fence.
        policyLockTargetIds.add(target.id);
        let inferenceCapacityId = target.inferenceCapacityId;
        if (inferenceCapacityId === null) {
          inferenceCapacityId = await ensureDiscoveredInferenceCapacity(tx, {
            userId,
            discoveredModelId: input.discoveredModelId,
            upstreamModelId: model.upstreamModelId,
            executionTargetId: target.id,
            reportedConcurrency: null,
          });
          const linked = await linkExecutionTargetCapacity(tx, {
            executionTargetId: target.id,
            userId,
            inferenceCapacityId,
          });
          if (linked) target.inferenceCapacityId = inferenceCapacityId;
          else inferenceCapacityId = null;
        }
        const seedCandidates = new Map(
          declaredContext != null && inferenceCapacityId
            ? [[inferenceCapacityId, declaredContext]]
            : [],
        );
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
      if (input.tier === "PRIMARY")
        throw new ORPCError("BAD_REQUEST", {
          message:
            "Provider models can only be external fallback (PUBLIC_OVERFLOW) members; plain pool names never leave the deployment.",
        });
      const userId = context.session.user.id;
      const attached = await runSerializableCapacityCreationTransaction(async (tx) => {
        // Writer class M (@ws-model-proxy/db/capacity-lock-order): the owner
        // fence; then, planned with reads only, the target identity fence and
        // the policy/capacity fences of the rows it may change; then the pool
        // row and the provider account -> model rows (F-LO1) before the first
        // write, whose foreign-key checks re-enter them.
        await fenceOwners(tx, [userId]);
        const candidatePool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: { id: true },
        });
        if (!candidatePool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        const plannedTarget = await tx.executionTarget.findUnique({
          where: { providerModelId: input.providerModelId },
          select: { id: true, inferenceCapacityId: true },
        });
        const plannedCapacity = await tx.inferenceCapacity.findUnique({
          where: {
            userId_runtimeIdentityKey: {
              userId,
              runtimeIdentityKey: `provider-model:${input.providerModelId}`,
            },
          },
          select: { id: true },
        });
        await acquireFences(tx, [
          fences.targetIdentity(`provider-model:${input.providerModelId}`),
          ...(plannedTarget ? [fences.capacityPolicy(plannedTarget.id)] : []),
          ...(plannedCapacity ? [fences.capacity(plannedCapacity.id)] : []),
        ]);
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidatePool.id} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        const pool = await tx.modelPool.findFirst({
          where: { id: candidatePool.id, userId },
          select: {
            id: true,
            name: true,
            fallbackEnabled: true,
            capacityConcurrencyLimit: true,
            capacityReservedSlots: true,
            capacityContextCeiling: true,
            capacityContextMargin: true,
          },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        // External members may be configured while fallback is off; the owner's
        // fallback switch and each caller's `:external` opt-in gate their use.
        if (input.publicOrder === undefined) {
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
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${providerModel.providerAccountId} AND "userId" = ${userId} FOR KEY SHARE`;
        await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${providerModel.id} AND "userId" = ${userId} FOR KEY SHARE`;
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
            // Seeded from the user-configured provider model limit (null = unlimited).
            hardConcurrencyLimitSource: "USER",
            physicalMaxContext: providerModel.contextWindow,
            countStrategy: "CONSERVATIVE_ESTIMATE",
          },
          select: { id: true },
        });
        if (!existingTarget?.inferenceCapacityId)
          await tx.executionTarget.updateMany({
            where: { id: target.id, capacityAssignmentSource: "AUTO" },
            data: { inferenceCapacityId: capacity.id, capacityAssignmentSource: "OWNER" },
          });
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
      return { id: attached.id, executionTargetId: attached.executionTargetId };
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
      const updatedMember = await prisma.$transaction(
        async (tx) => {
          // Writer class M: the owner fence first; it serializes every
          // tier/order transition with pool attachment and reorder.
          await fenceOwners(tx, [userId]);
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

          // The member's capacity-policy fence, then the pool row. Re-read
          // all policy inputs after them so pool settings and protection
          // cannot be revoked concurrently.
          if (candidate.executionTargetId)
            await fenceExecutionTargetPolicies(tx, [candidate.executionTargetId]);
          await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
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
                  name: true,
                  fallbackEnabled: true,
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
              data: { fields: ["weight"] },
            });
          if (input.tier && !providerModel)
            throw new ORPCError("BAD_REQUEST", {
              message: "Only provider-backed members can change tier.",
              data: { fields: ["tier"] },
            });
          // PRIMARY is local-only (also enforced by the schema-hardening tier
          // trigger): plain pool names never leave the deployment.
          if (providerModel && nextTier === "PRIMARY")
            throw new ORPCError("BAD_REQUEST", {
              message:
                "Provider models can only be external fallback (PUBLIC_OVERFLOW) members; plain pool names never leave the deployment.",
              data: { fields: ["tier"] },
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
              data: { fields: ["capacityReservedSlots", "capacityConcurrencyLimit"] },
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
              adaptationEnabled: member.ModelPool.protocolAdaptationEnabled,
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
          const memberResult = Object.hasOwn(updated, "tier")
            ? { ...updated, publicOrder: nextTier === "PUBLIC_OVERFLOW" ? desiredOrder : null }
            : updated;
          return memberResult;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return updatedMember;
    }),

  reorderProviderPoolMember: protectedProcedure
    .input(z.object({ id: idSchema, direction: z.enum(["EARLIER", "LATER"]) }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        // Writer class M: the owner fence before the multi-row reorder.
        await fenceOwners(tx, [userId]);
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
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
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
      // Read-only checks first; the transaction repeats them under its fence.
      await assertPoolMemberRemovable(prisma, input.id, userId);
      return runCapacityDeleteTransaction(async (tx) => {
        // A plain delete under the owner fence (fenceParentDelete), which
        // also keeps the member set this decision is made against stable;
        // then the pool row, matching addPoolMember. Waiters and leases keep
        // the member's id; the capacity sweeper terminalizes live orphans.
        await fenceParentDelete(tx, { userId, poolMemberIds: [input.id] });
        const candidate = await tx.poolMember.findUnique({
          where: { id: input.id },
          select: { id: true, poolId: true, ModelPool: { select: { userId: true } } },
        });
        if (!candidate || candidate.ModelPool.userId !== userId) {
          throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
        }
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        await assertPoolMemberRemovable(tx, input.id, userId);
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
      }),
    )
    .handler(async ({ input, context }) => {
      const pool = await ownedPool(input.poolId, context.session.user.id);
      const userId = context.session.user.id;
      // No grant-time egress acknowledgement: a grantee's data leaves the
      // deployment only when the grantee asks for `owner/pool:external` with
      // a consenting credential AND the owner enabled fallbackForGrantees.
      // Writer class M: a grant links two owners' graphs, so it takes both
      // owner fences (the fence trigger on pool_grant requires them). The
      // pool row lock then keeps grants serialized with pool settings
      // changes and the E0 send claim (lock order: model_pool first).
      return runSerializableTransaction(async (tx) => {
        const grantee = await tx.user.findFirst({
          where: { email: { equals: input.email, mode: "insensitive" } },
          select: { id: true },
        });
        if (!grantee) {
          throw new ORPCError("NOT_FOUND", { message: grantPoolAccessServerMessages.userNotFound });
        }
        if (grantee.id === userId) {
          throw new ORPCError("BAD_REQUEST", {
            message: grantPoolAccessServerMessages.cannotGrantToSelf,
          });
        }
        await fenceOwners(tx, [userId, grantee.id]);
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${pool.id} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        const locked = await tx.modelPool.findUnique({
          where: { id: pool.id },
          select: { id: true, userId: true },
        });
        if (!locked || locked.userId !== userId) {
          throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        }
        return tx.poolGrant.upsert({
          where: {
            poolId_granteeUserId: {
              poolId: input.poolId,
              granteeUserId: grantee.id,
            },
          },
          update: {},
          create: {
            poolId: input.poolId,
            ownerUserId: userId,
            granteeUserId: grantee.id,
          },
          select: { id: true, poolId: true, granteeUserId: true },
        });
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
      // Writer class M: both parties' owner fences (the grant's delete
      // cascades into the grantee's fallback preference), then one statement.
      const result = await prisma.$transaction(async (tx) => {
        await fenceOwners(tx, [context.session.user.id, grantee.id]);
        return tx.poolGrant.deleteMany({
          where: {
            poolId: input.poolId,
            ownerUserId: context.session.user.id,
            granteeUserId: grantee.id,
          },
        });
      });
      return { revokedCount: result.count };
    }),

  /**
   * Owner-only per-grant routing settings (saturation S-C): the grantee's
   * warm-session protection override (null = the pool's share mode,
   * 0 = unprotected, 1..100 = percent), queue priority (0..31, replaces
   * the pool/member capacity priority for this grantee; null inherits), and
   * owner-paid `:external` spend cap (`fallbackSpend`; null clears it).
   * Omitted fields are left unchanged.
   */
  updatePoolGrant: protectedProcedure
    .input(
      z.object({
        poolId: idSchema,
        grantId: idSchema,
        protectionOverridePercent: z.number().int().min(0).max(100).nullable().optional(),
        queuePriority: z.number().int().min(0).max(31).nullable().optional(),
        fallbackSpend: poolGrantSpendCapSchema.nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      await ownedPool(input.poolId, userId);
      const spendGrantee =
        input.fallbackSpend === undefined
          ? null
          : await prisma.poolGrant.findFirst({
              where: { id: input.grantId, poolId: input.poolId, ownerUserId: userId },
              select: { granteeUserId: true },
            });
      if (input.fallbackSpend !== undefined && !spendGrantee)
        throw new ORPCError("NOT_FOUND", { message: "Pool grant not found." });
      // Writer class M: owner fence, then the grant budget fence when the
      // spend cap is written (level 03, keyed by pool+grantee, before any
      // row lock), then the pool row, then the grant. Grantee identity is
      // immutable, so the pre-transaction read is a stable fence key.
      return runSerializableTransaction(async (tx) => {
        await fenceOwners(tx, [userId]);
        if (input.fallbackSpend !== undefined && spendGrantee)
          await acquireFences(tx, [
            fences.budgetGrant(userId, input.poolId, spendGrantee.granteeUserId),
          ]);
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM model_pool WHERE id = ${input.poolId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        if (locked.length !== 1)
          throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        const updated = await tx.poolGrant.updateMany({
          where: { id: input.grantId, poolId: input.poolId, ownerUserId: userId },
          data: {
            ...(input.protectionOverridePercent !== undefined
              ? { protectionOverridePercent: input.protectionOverridePercent }
              : {}),
            ...(input.queuePriority !== undefined ? { queuePriority: input.queuePriority } : {}),
          },
        });
        if (updated.count !== 1)
          throw new ORPCError("NOT_FOUND", { message: "Pool grant not found." });
        const grant = await tx.poolGrant.findUniqueOrThrow({
          where: { id: input.grantId },
          select: {
            id: true,
            poolId: true,
            granteeUserId: true,
            protectionOverridePercent: true,
            queuePriority: true,
          },
        });
        if (input.fallbackSpend !== undefined) {
          await upsertPoolGrantSpendCap(tx, {
            userId,
            poolId: input.poolId,
            poolGrantId: input.grantId,
            granteeUserId: grant.granteeUserId,
            spend: input.fallbackSpend,
          });
        }
        const spendPolicies = await tx.providerBudgetPolicy.findMany({
          where: {
            userId,
            scopeType: "POOL_GRANT",
            poolId: grant.poolId,
            granteeUserId: grant.granteeUserId,
            active: true,
          },
          select: {
            Rules: {
              where: { metric: "SPEND" },
              select: { limitValue: true, currency: true, period: true },
            },
          },
        });
        return {
          id: grant.id,
          poolId: grant.poolId,
          granteeUserId: grant.granteeUserId,
          protectionOverridePercent: grant.protectionOverridePercent,
          queuePriority: grant.queuePriority,
          fallbackSpend: serializePoolGrantSpendCap(spendPolicies),
        };
      });
    }),

  visibleModels: protectedProcedure.handler(async ({ context }) =>
    serializeVisibleTargets(await listVisibleModelTargetsForUser(context.session.user.id)),
  ),
};
