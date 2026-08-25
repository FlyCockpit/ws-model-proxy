import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  assertDirectCapacityPolicy,
  assertEffectiveConcurrencyPolicy,
  assertEffectiveContextPolicy,
  lockExecutionTargetPolicies,
} from "../lib/capacity-policy-safety";
import { runSerializableTransaction } from "../lib/serializable-transaction";

const id = z.string().min(1);
const priority = z.number().int().min(0).max(31);
const optionalLimit = z.number().int().positive().nullable();
const reservedSlots = z.number().int().min(0);
const waitBudget = z.number().int().min(0).max(600_000).nullable();
const memberWaitBudget = z.number().int().min(0).max(600_000).nullable();
const contextMargin = z.number().int().min(0).max(10_000_000);
const borrowPolicy = z.enum(["NEVER", "WHEN_IDLE"]);
const capacityLimitMode = z.enum(["INHERIT", "LIMITED", "UNLIMITED"]);
const countStrategy = z.enum([
  "TOKENIZER",
  "TEMPLATE_AWARE",
  "ENGINE_REPORTED",
  "CONSERVATIVE_ESTIMATE",
]);

function enabled() {
  if (!env.MODEL_API_GLOBAL_CAPACITY_ENABLED) throw new ORPCError("NOT_FOUND");
}

function notFound(): never {
  throw new ORPCError("NOT_FOUND", { message: "Capacity resource not found." });
}

async function capacityTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  _options?: { isolationLevel: "Serializable" },
): Promise<T> {
  return runSerializableTransaction(work);
}

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function audit(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.capacityAuditEvent.create({
    data: {
      userId: input.userId,
      actorUserId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before === undefined ? undefined : auditJson(input.before),
      after: input.after === undefined ? undefined : auditJson(input.after),
    },
  });
}

const capacityFields = {
  label: z.string().trim().min(1).max(120),
  runtimeIdentityKey: z.string().trim().min(1).max(500),
  runtimeModel: z.string().trim().min(1).max(500),
  runtimeRevision: z.string().trim().max(500).nullable().optional(),
  tokenizer: z.string().trim().max(500).nullable().optional(),
  tokenizerVersion: z.string().trim().max(500).nullable().optional(),
  template: z.string().trim().max(500).nullable().optional(),
  templateVersion: z.string().trim().max(500).nullable().optional(),
  engine: z.string().trim().max(500).nullable().optional(),
  cacheNamespace: z.string().trim().max(500).nullable().optional(),
  hardConcurrencyLimit: optionalLimit,
  physicalMaxContext: optionalLimit,
  countStrategy,
};

const directPolicy = z.object({
  executionTargetId: id,
  inferenceCapacityId: id.nullable().optional(),
  directPriority: priority.optional(),
  directConcurrencyLimit: optionalLimit.optional(),
  directReservedSlots: reservedSlots.optional(),
  directBorrowPolicy: borrowPolicy.optional(),
  directWaitBudgetMs: waitBudget.optional(),
  directContextCeiling: optionalLimit.optional(),
  directContextMargin: contextMargin.optional(),
});

const sharedPolicyFields = {
  capacityPriority: priority.optional(),
  capacityConcurrencyLimit: optionalLimit.optional(),
  capacityReservedSlots: reservedSlots.optional(),
  capacityBorrowPolicy: borrowPolicy.optional(),
  capacityWaitBudgetMs: waitBudget.optional(),
  capacityContextCeiling: optionalLimit.optional(),
  capacityContextMargin: contextMargin.optional(),
};

const memberPolicy = z
  .object({
    poolMemberId: id,
    capacityPriority: priority.nullable().optional(),
    capacityConcurrencyMode: capacityLimitMode.optional(),
    capacityConcurrencyLimit: optionalLimit.optional(),
    capacityReservedSlots: reservedSlots.nullable().optional(),
    capacityBorrowPolicy: borrowPolicy.nullable().optional(),
    capacityWaitBudgetMode: capacityLimitMode.optional(),
    capacityWaitBudgetMs: memberWaitBudget.optional(),
    capacityContextCeilingMode: capacityLimitMode.optional(),
    capacityContextCeiling: optionalLimit.optional(),
    capacityContextMargin: contextMargin.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    for (const [modeKey, valueKey] of [
      ["capacityConcurrencyMode", "capacityConcurrencyLimit"],
      ["capacityWaitBudgetMode", "capacityWaitBudgetMs"],
      ["capacityContextCeilingMode", "capacityContextCeiling"],
    ] as const) {
      const mode = value[modeKey];
      const limit = value[valueKey];
      if (mode === undefined) continue;
      if (mode === "LIMITED" && limit == null) {
        ctx.addIssue({
          code: "custom",
          path: [valueKey],
          message: "A limited policy requires a value.",
        });
      }
      if (mode !== "LIMITED" && limit != null) {
        ctx.addIssue({
          code: "custom",
          path: [valueKey],
          message: "Inherited and unlimited policies cannot include a value.",
        });
      }
    }
  });

export const capacityManagementRouter = {
  list: protectedProcedure.handler(async ({ context }) => {
    enabled();
    const userId = context.session.user.id;
    return prisma.inferenceCapacity.findMany({
      where: { userId },
      orderBy: [{ label: "asc" }, { id: "asc" }],
      include: {
        _count: {
          select: {
            ExecutionTargets: true,
            CapacityLeases: { where: { state: "ACTIVE" } },
            CapacityWaiters: { where: { state: "WAITING" } },
          },
        },
      },
    });
  }),

  listAudit: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .handler(async ({ input, context }) => {
      enabled();
      return prisma.capacityAuditEvent.findMany({
        where: { userId: context.session.user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input?.limit ?? 50,
      });
    }),

  create: protectedProcedure.input(z.object(capacityFields)).handler(async ({ input, context }) => {
    enabled();
    if (
      input.hardConcurrencyLimit !== null &&
      input.hardConcurrencyLimit !== undefined &&
      input.hardConcurrencyLimit < 1
    )
      throw new ORPCError("BAD_REQUEST");
    const userId = context.session.user.id;
    return capacityTransaction(
      async (tx) => {
        const created = await tx.inferenceCapacity.create({ data: { userId, ...input } });
        await audit(tx, {
          userId,
          action: "CREATE",
          resourceType: "INFERENCE_CAPACITY",
          resourceId: created.id,
          after: input,
        });
        return created;
      },
      { isolationLevel: "Serializable" },
    );
  }),

  update: protectedProcedure
    .input(
      z.object({
        id,
        ...Object.fromEntries(
          Object.entries(capacityFields).map(([key, value]) => [key, value.optional()]),
        ),
      }),
    )
    .handler(async ({ input, context }) => {
      enabled();
      const { id: capacityId, ...data } = input;
      const userId = context.session.user.id;
      return capacityTransaction(
        async (tx) => {
          const candidate = await tx.inferenceCapacity.findUnique({
            where: { id: capacityId },
            select: { userId: true, ExecutionTargets: { select: { id: true } } },
          });
          if (!candidate || candidate.userId !== userId) return notFound();
          await lockExecutionTargetPolicies(
            tx,
            candidate.ExecutionTargets.map((target) => target.id),
          );
          await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id = ${capacityId} AND "userId" = ${userId} FOR UPDATE`;
          const current = await tx.inferenceCapacity.findUnique({
            where: { id: capacityId },
            include: {
              ExecutionTargets: {
                select: {
                  id: true,
                  directConcurrencyLimit: true,
                  directReservedSlots: true,
                  directContextCeiling: true,
                  directContextMargin: true,
                  PoolMembers: {
                    select: {
                      capacityConcurrencyMode: true,
                      capacityConcurrencyLimit: true,
                      capacityReservedSlots: true,
                      capacityContextCeilingMode: true,
                      capacityContextCeiling: true,
                      capacityContextMargin: true,
                      ModelPool: {
                        select: {
                          capacityConcurrencyLimit: true,
                          capacityReservedSlots: true,
                          capacityContextCeiling: true,
                          capacityContextMargin: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          });
          if (!current || current.userId !== userId) return notFound();
          const requestedHardLimit = (data as { hardConcurrencyLimit?: number | null })
            .hardConcurrencyLimit;
          const requestedPhysicalMaxContext = (data as { physicalMaxContext?: number | null })
            .physicalMaxContext;
          if (requestedHardLimit !== undefined) {
            for (const target of current.ExecutionTargets ?? []) {
              assertDirectCapacityPolicy({
                hardLimit: requestedHardLimit,
                concurrencyLimit: target.directConcurrencyLimit,
                reservedSlots: target.directReservedSlots,
                physicalMaxContext:
                  requestedPhysicalMaxContext !== undefined
                    ? requestedPhysicalMaxContext
                    : current.physicalMaxContext,
                contextCeiling: target.directContextCeiling,
                contextMargin: target.directContextMargin,
              });
              for (const member of target.PoolMembers) {
                assertEffectiveConcurrencyPolicy({
                  hardLimit: requestedHardLimit,
                  poolLimit: member.ModelPool.capacityConcurrencyLimit,
                  poolReserved: member.ModelPool.capacityReservedSlots,
                  memberMode: member.capacityConcurrencyMode,
                  memberLimit: member.capacityConcurrencyLimit,
                  memberReserved: member.capacityReservedSlots,
                });
              }
            }
          }
          if (requestedPhysicalMaxContext !== undefined) {
            for (const target of current.ExecutionTargets ?? []) {
              assertDirectCapacityPolicy({
                hardLimit:
                  requestedHardLimit !== undefined
                    ? requestedHardLimit
                    : current.hardConcurrencyLimit,
                concurrencyLimit: target.directConcurrencyLimit,
                reservedSlots: target.directReservedSlots,
                physicalMaxContext: requestedPhysicalMaxContext,
                contextCeiling: target.directContextCeiling,
                contextMargin: target.directContextMargin,
              });
              for (const member of target.PoolMembers)
                assertEffectiveContextPolicy({
                  physicalMaxContext: requestedPhysicalMaxContext,
                  poolCeiling: member.ModelPool.capacityContextCeiling,
                  poolMargin: member.ModelPool.capacityContextMargin,
                  memberMode: member.capacityContextCeilingMode,
                  memberCeiling: member.capacityContextCeiling,
                  memberMargin: member.capacityContextMargin,
                });
            }
          }
          const updated = await tx.inferenceCapacity.update({ where: { id: capacityId }, data });
          await audit(tx, {
            userId,
            action: "UPDATE",
            resourceType: "INFERENCE_CAPACITY",
            resourceId: capacityId,
            before: current,
            after: updated,
          });
          return updated;
        },
        { isolationLevel: "Serializable" },
      );
    }),

  remove: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    return capacityTransaction(
      async (tx) => {
        const current = await tx.inferenceCapacity.findUnique({
          where: { id: input.id },
          select: { userId: true, _count: { select: { ExecutionTargets: true } } },
        });
        if (!current || current.userId !== userId) return notFound();
        if (current._count.ExecutionTargets > 0) {
          throw new ORPCError("CONFLICT", { message: "Capacity is still attached." });
        }
        await tx.inferenceCapacity.delete({ where: { id: input.id } });
        await audit(tx, {
          userId,
          action: "DELETE",
          resourceType: "INFERENCE_CAPACITY",
          resourceId: input.id,
          before: current,
        });
        return { success: true };
      },
      { isolationLevel: "Serializable" },
    );
  }),

  updateDirectPolicy: protectedProcedure.input(directPolicy).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    return capacityTransaction(
      async (tx) => {
        const candidate = await tx.executionTarget.findUnique({
          where: { id: input.executionTargetId },
          select: { id: true, userId: true },
        });
        if (!candidate || candidate.userId !== userId) return notFound();
        await lockExecutionTargetPolicies(tx, [candidate.id]);
        const target = await tx.executionTarget.findUnique({
          where: { id: input.executionTargetId },
          select: {
            id: true,
            userId: true,
            inferenceCapacityId: true,
            directPriority: true,
            directConcurrencyLimit: true,
            directReservedSlots: true,
            directBorrowPolicy: true,
            directWaitBudgetMs: true,
            directContextCeiling: true,
            directContextMargin: true,
            InferenceCapacity: {
              select: { hardConcurrencyLimit: true, physicalMaxContext: true },
            },
            PoolMembers: {
              select: {
                capacityConcurrencyMode: true,
                capacityConcurrencyLimit: true,
                capacityReservedSlots: true,
                capacityContextCeilingMode: true,
                capacityContextCeiling: true,
                capacityContextMargin: true,
                ModelPool: {
                  select: {
                    capacityConcurrencyLimit: true,
                    capacityReservedSlots: true,
                    capacityContextCeiling: true,
                    capacityContextMargin: true,
                  },
                },
              },
            },
          },
        });
        if (!target || target.userId !== userId) return notFound();
        let hardConcurrencyLimit = target.InferenceCapacity?.hardConcurrencyLimit;
        let physicalMaxContext = target.InferenceCapacity?.physicalMaxContext;
        if (input.inferenceCapacityId) {
          const capacity = await tx.inferenceCapacity.findUnique({
            where: { id: input.inferenceCapacityId },
            select: { userId: true, hardConcurrencyLimit: true, physicalMaxContext: true },
          });
          if (!capacity || capacity.userId !== userId) return notFound();
          hardConcurrencyLimit = capacity.hardConcurrencyLimit;
          physicalMaxContext = capacity.physicalMaxContext;
        } else if (input.inferenceCapacityId === null) {
          hardConcurrencyLimit = null;
          physicalMaxContext = null;
        }
        const nextDirectConcurrency =
          input.directConcurrencyLimit !== undefined
            ? input.directConcurrencyLimit
            : target.directConcurrencyLimit;
        const nextDirectReserved = input.directReservedSlots ?? target.directReservedSlots;
        const nextDirectContextCeiling =
          input.directContextCeiling !== undefined
            ? input.directContextCeiling
            : target.directContextCeiling;
        const nextDirectContextMargin = input.directContextMargin ?? target.directContextMargin;
        assertDirectCapacityPolicy({
          hardLimit: hardConcurrencyLimit,
          concurrencyLimit: nextDirectConcurrency,
          reservedSlots: nextDirectReserved,
          physicalMaxContext,
          contextCeiling: nextDirectContextCeiling,
          contextMargin: nextDirectContextMargin,
        });
        // Attaching a target changes the physical ceiling for every pool that
        // already references it. Validate both explicit member overrides and
        // inherited pool policies before committing the attachment.
        for (const member of target.PoolMembers ?? []) {
          assertEffectiveConcurrencyPolicy({
            hardLimit: hardConcurrencyLimit,
            poolLimit: member.ModelPool.capacityConcurrencyLimit,
            poolReserved: member.ModelPool.capacityReservedSlots,
            memberMode: member.capacityConcurrencyMode,
            memberLimit: member.capacityConcurrencyLimit,
            memberReserved: member.capacityReservedSlots,
          });
          assertEffectiveContextPolicy({
            physicalMaxContext,
            poolCeiling: member.ModelPool.capacityContextCeiling,
            poolMargin: member.ModelPool.capacityContextMargin,
            memberMode: member.capacityContextCeilingMode,
            memberCeiling: member.capacityContextCeiling,
            memberMargin: member.capacityContextMargin,
          });
        }
        const { executionTargetId, ...data } = input;
        const updated = await tx.executionTarget.update({ where: { id: executionTargetId }, data });
        await audit(tx, {
          userId,
          action: "UPDATE_POLICY",
          resourceType: "EXECUTION_TARGET",
          resourceId: executionTargetId,
          before: target,
          after: data,
        });
        return updated;
      },
      { isolationLevel: "Serializable" },
    );
  }),

  updatePoolPolicy: protectedProcedure
    .input(
      z.object({
        modelPoolId: id,
        ...sharedPolicyFields,
        protocolAdaptationEnabled: z.boolean().optional(),
        allowLossyDeveloperRoleCollapse: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      return capacityTransaction(
        async (tx) => {
          const candidate = await tx.modelPool.findUnique({
            where: { id: input.modelPoolId },
            select: {
              userId: true,
              PoolMembers: { select: { executionTargetId: true } },
            },
          });
          if (!candidate || candidate.userId !== userId) return notFound();
          await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.modelPoolId} AND "userId" = ${userId} FOR UPDATE`;
          await lockExecutionTargetPolicies(
            tx,
            candidate.PoolMembers.flatMap((member) =>
              member.executionTargetId ? [member.executionTargetId] : [],
            ),
          );
          const pool = await tx.modelPool.findUnique({
            where: { id: input.modelPoolId },
            select: {
              id: true,
              userId: true,
              capacityPriority: true,
              capacityConcurrencyLimit: true,
              capacityReservedSlots: true,
              capacityBorrowPolicy: true,
              capacityWaitBudgetMs: true,
              capacityContextCeiling: true,
              capacityContextMargin: true,
              protocolAdaptationEnabled: true,
              allowLossyDeveloperRoleCollapse: true,
              PoolMembers: {
                select: {
                  capacityConcurrencyMode: true,
                  capacityConcurrencyLimit: true,
                  capacityReservedSlots: true,
                  capacityContextCeilingMode: true,
                  capacityContextCeiling: true,
                  capacityContextMargin: true,
                  ExecutionTarget: {
                    select: {
                      InferenceCapacity: {
                        select: { hardConcurrencyLimit: true, physicalMaxContext: true },
                      },
                    },
                  },
                },
              },
            },
          });
          if (!pool || pool.userId !== userId) return notFound();
          for (const member of pool.PoolMembers ?? []) {
            assertEffectiveConcurrencyPolicy({
              hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
              poolLimit:
                input.capacityConcurrencyLimit !== undefined
                  ? input.capacityConcurrencyLimit
                  : pool.capacityConcurrencyLimit,
              poolReserved: input.capacityReservedSlots ?? pool.capacityReservedSlots,
              memberMode: member.capacityConcurrencyMode,
              memberLimit: member.capacityConcurrencyLimit,
              memberReserved: member.capacityReservedSlots,
            });
            assertEffectiveContextPolicy({
              physicalMaxContext: member.ExecutionTarget?.InferenceCapacity?.physicalMaxContext,
              poolCeiling:
                input.capacityContextCeiling !== undefined
                  ? input.capacityContextCeiling
                  : pool.capacityContextCeiling,
              poolMargin: input.capacityContextMargin ?? pool.capacityContextMargin,
              memberMode: member.capacityContextCeilingMode,
              memberCeiling: member.capacityContextCeiling,
              memberMargin: member.capacityContextMargin,
            });
          }
          const { modelPoolId, ...data } = input;
          const updated = await tx.modelPool.update({ where: { id: modelPoolId }, data });
          await audit(tx, {
            userId,
            action: "UPDATE_POLICY",
            resourceType: "MODEL_POOL",
            resourceId: modelPoolId,
            before: pool,
            after: data,
          });
          return updated;
        },
        { isolationLevel: "Serializable" },
      );
    }),

  updateMemberPolicy: protectedProcedure.input(memberPolicy).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    const normalizedInput = {
      ...input,
      capacityConcurrencyLimit:
        input.capacityConcurrencyMode !== undefined && input.capacityConcurrencyMode !== "LIMITED"
          ? null
          : input.capacityConcurrencyLimit,
      capacityConcurrencyMode:
        input.capacityConcurrencyMode ??
        (input.capacityConcurrencyLimit !== undefined
          ? input.capacityConcurrencyLimit === null
            ? ("INHERIT" as const)
            : ("LIMITED" as const)
          : undefined),
      capacityWaitBudgetMode:
        input.capacityWaitBudgetMode ??
        (input.capacityWaitBudgetMs !== undefined
          ? input.capacityWaitBudgetMs === null
            ? ("INHERIT" as const)
            : ("LIMITED" as const)
          : undefined),
      capacityWaitBudgetMs:
        input.capacityWaitBudgetMode !== undefined && input.capacityWaitBudgetMode !== "LIMITED"
          ? null
          : input.capacityWaitBudgetMs,
      capacityContextCeilingMode:
        input.capacityContextCeilingMode ??
        (input.capacityContextCeiling !== undefined
          ? input.capacityContextCeiling === null
            ? ("INHERIT" as const)
            : ("LIMITED" as const)
          : undefined),
      capacityContextCeiling:
        input.capacityContextCeilingMode !== undefined &&
        input.capacityContextCeilingMode !== "LIMITED"
          ? null
          : input.capacityContextCeiling,
    };
    return capacityTransaction(
      async (tx) => {
        const candidate = await tx.poolMember.findUnique({
          where: { id: input.poolMemberId },
          select: {
            poolId: true,
            executionTargetId: true,
            ModelPool: { select: { userId: true } },
          },
        });
        if (!candidate || candidate.ModelPool.userId !== userId) return notFound();
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${candidate.poolId} AND "userId" = ${userId} FOR UPDATE`;
        if (candidate.executionTargetId)
          await lockExecutionTargetPolicies(tx, [candidate.executionTargetId]);
        const member = await tx.poolMember.findUnique({
          where: { id: input.poolMemberId },
          select: {
            id: true,
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
            ModelPool: {
              select: {
                userId: true,
                capacityConcurrencyLimit: true,
                capacityReservedSlots: true,
                capacityContextCeiling: true,
                capacityContextMargin: true,
              },
            },
            ExecutionTarget: {
              select: {
                InferenceCapacity: {
                  select: { hardConcurrencyLimit: true, physicalMaxContext: true },
                },
              },
            },
          },
        });
        if (!member || member.ModelPool.userId !== userId) return notFound();
        const nextConcurrencyMode =
          normalizedInput.capacityConcurrencyMode ?? member.capacityConcurrencyMode;
        const nextConcurrency =
          normalizedInput.capacityConcurrencyLimit !== undefined
            ? normalizedInput.capacityConcurrencyLimit
            : member.capacityConcurrencyLimit;
        const nextReserved =
          input.capacityReservedSlots !== undefined
            ? input.capacityReservedSlots
            : member.capacityReservedSlots;
        assertEffectiveConcurrencyPolicy({
          hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
          poolLimit: member.ModelPool.capacityConcurrencyLimit,
          poolReserved: member.ModelPool.capacityReservedSlots,
          memberMode: nextConcurrencyMode,
          memberLimit: nextConcurrency,
          memberReserved: nextReserved,
        });
        const nextContextMode =
          normalizedInput.capacityContextCeilingMode ?? member.capacityContextCeilingMode;
        const nextContextCeiling =
          normalizedInput.capacityContextCeiling !== undefined
            ? normalizedInput.capacityContextCeiling
            : member.capacityContextCeiling;
        const nextContextMargin =
          input.capacityContextMargin !== undefined
            ? input.capacityContextMargin
            : member.capacityContextMargin;
        assertEffectiveContextPolicy({
          physicalMaxContext: member.ExecutionTarget?.InferenceCapacity?.physicalMaxContext,
          poolCeiling: member.ModelPool.capacityContextCeiling,
          poolMargin: member.ModelPool.capacityContextMargin,
          memberMode: nextContextMode,
          memberCeiling: nextContextCeiling,
          memberMargin: nextContextMargin,
        });
        const { poolMemberId, ...data } = normalizedInput;
        const updated = await tx.poolMember.update({ where: { id: poolMemberId }, data });
        await audit(tx, {
          userId,
          action: "UPDATE_POLICY",
          resourceType: "POOL_MEMBER",
          resourceId: poolMemberId,
          before: member,
          after: data,
        });
        return updated;
      },
      { isolationLevel: "Serializable" },
    );
  }),
};
