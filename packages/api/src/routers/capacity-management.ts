import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";

const id = z.string().min(1);
const priority = z.number().int().min(0).max(31);
const optionalLimit = z.number().int().positive().nullable();
const reservedSlots = z.number().int().min(0);
const waitBudget = z.number().int().min(0).max(600_000).nullable();
const contextMargin = z.number().int().min(0).max(10_000_000);
const borrowPolicy = z.enum(["NEVER", "WHEN_IDLE"]);
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

function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertPolicyWithinHardLimit(input: {
  hardLimit: number | null | undefined;
  concurrencyLimit: number | null | undefined;
  reservedSlots: number | null | undefined;
}) {
  if (input.hardLimit === null || input.hardLimit === undefined) return;
  if (
    input.concurrencyLimit !== null &&
    input.concurrencyLimit !== undefined &&
    input.concurrencyLimit > input.hardLimit
  ) {
    throw new ORPCError("BAD_REQUEST", { message: "Concurrency limit exceeds capacity." });
  }
  if (
    input.reservedSlots !== null &&
    input.reservedSlots !== undefined &&
    input.reservedSlots > input.hardLimit
  ) {
    throw new ORPCError("BAD_REQUEST", { message: "Reserved slots exceed capacity." });
  }
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
    return prisma.$transaction(async (tx) => {
      const created = await tx.inferenceCapacity.create({ data: { userId, ...input } });
      await audit(tx, {
        userId,
        action: "CREATE",
        resourceType: "INFERENCE_CAPACITY",
        resourceId: created.id,
        after: input,
      });
      return created;
    });
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
      return prisma.$transaction(async (tx) => {
        const current = await tx.inferenceCapacity.findUnique({
          where: { id: capacityId },
          include: {
            ExecutionTargets: {
              select: {
                directConcurrencyLimit: true,
                directReservedSlots: true,
                PoolMembers: {
                  select: {
                    capacityConcurrencyLimit: true,
                    capacityReservedSlots: true,
                    ModelPool: {
                      select: {
                        capacityConcurrencyLimit: true,
                        capacityReservedSlots: true,
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
        if (requestedHardLimit !== undefined) {
          for (const target of current.ExecutionTargets ?? []) {
            assertPolicyWithinHardLimit({
              hardLimit: requestedHardLimit,
              concurrencyLimit: target.directConcurrencyLimit,
              reservedSlots: target.directReservedSlots,
            });
            for (const member of target.PoolMembers) {
              assertPolicyWithinHardLimit({
                hardLimit: requestedHardLimit,
                concurrencyLimit:
                  member.capacityConcurrencyLimit ?? member.ModelPool.capacityConcurrencyLimit,
                reservedSlots:
                  member.capacityReservedSlots ?? member.ModelPool.capacityReservedSlots,
              });
            }
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
      });
    }),

  remove: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    return prisma.$transaction(async (tx) => {
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
    });
  }),

  updateDirectPolicy: protectedProcedure.input(directPolicy).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    return prisma.$transaction(async (tx) => {
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
          InferenceCapacity: { select: { hardConcurrencyLimit: true } },
        },
      });
      if (!target || target.userId !== userId) return notFound();
      let hardConcurrencyLimit = target.InferenceCapacity?.hardConcurrencyLimit;
      if (input.inferenceCapacityId) {
        const capacity = await tx.inferenceCapacity.findUnique({
          where: { id: input.inferenceCapacityId },
          select: { userId: true, hardConcurrencyLimit: true },
        });
        if (!capacity || capacity.userId !== userId) return notFound();
        hardConcurrencyLimit = capacity.hardConcurrencyLimit;
      } else if (input.inferenceCapacityId === null) {
        hardConcurrencyLimit = null;
      }
      assertPolicyWithinHardLimit({
        hardLimit: hardConcurrencyLimit,
        concurrencyLimit: input.directConcurrencyLimit ?? target.directConcurrencyLimit,
        reservedSlots: input.directReservedSlots ?? target.directReservedSlots,
      });
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
    });
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
      return prisma.$transaction(async (tx) => {
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
                capacityConcurrencyLimit: true,
                capacityReservedSlots: true,
                ExecutionTarget: {
                  select: { InferenceCapacity: { select: { hardConcurrencyLimit: true } } },
                },
              },
            },
          },
        });
        if (!pool || pool.userId !== userId) return notFound();
        for (const member of pool.PoolMembers ?? []) {
          assertPolicyWithinHardLimit({
            hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
            concurrencyLimit:
              member.capacityConcurrencyLimit ??
              input.capacityConcurrencyLimit ??
              pool.capacityConcurrencyLimit,
            reservedSlots:
              member.capacityReservedSlots ??
              input.capacityReservedSlots ??
              pool.capacityReservedSlots,
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
      });
    }),

  updateMemberPolicy: protectedProcedure
    .input(z.object({ poolMemberId: id, ...sharedPolicyFields }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        const member = await tx.poolMember.findUnique({
          where: { id: input.poolMemberId },
          select: {
            id: true,
            capacityPriority: true,
            capacityConcurrencyLimit: true,
            capacityReservedSlots: true,
            capacityBorrowPolicy: true,
            capacityWaitBudgetMs: true,
            capacityContextCeiling: true,
            capacityContextMargin: true,
            ModelPool: {
              select: {
                userId: true,
                capacityConcurrencyLimit: true,
                capacityReservedSlots: true,
              },
            },
            ExecutionTarget: {
              select: { InferenceCapacity: { select: { hardConcurrencyLimit: true } } },
            },
          },
        });
        if (!member || member.ModelPool.userId !== userId) return notFound();
        const nextConcurrency =
          input.capacityConcurrencyLimit !== undefined
            ? input.capacityConcurrencyLimit
            : member.capacityConcurrencyLimit;
        const nextReserved =
          input.capacityReservedSlots !== undefined
            ? input.capacityReservedSlots
            : member.capacityReservedSlots;
        assertPolicyWithinHardLimit({
          hardLimit: member.ExecutionTarget?.InferenceCapacity?.hardConcurrencyLimit,
          concurrencyLimit: nextConcurrency ?? member.ModelPool.capacityConcurrencyLimit,
          reservedSlots: nextReserved ?? member.ModelPool.capacityReservedSlots,
        });
        const { poolMemberId, ...data } = input;
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
      });
    }),
};
