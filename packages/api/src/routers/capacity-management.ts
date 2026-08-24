import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
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

  create: protectedProcedure.input(z.object(capacityFields)).handler(async ({ input, context }) => {
    enabled();
    if (
      input.hardConcurrencyLimit !== null &&
      input.hardConcurrencyLimit !== undefined &&
      input.hardConcurrencyLimit < 1
    )
      throw new ORPCError("BAD_REQUEST");
    return prisma.inferenceCapacity.create({
      data: { userId: context.session.user.id, ...input },
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
      const current = await prisma.inferenceCapacity.findUnique({
        where: { id: capacityId },
        select: { userId: true },
      });
      if (!current || current.userId !== context.session.user.id) return notFound();
      return prisma.inferenceCapacity.update({ where: { id: capacityId }, data });
    }),

  remove: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    enabled();
    const current = await prisma.inferenceCapacity.findUnique({
      where: { id: input.id },
      select: { userId: true, _count: { select: { ExecutionTargets: true } } },
    });
    if (!current || current.userId !== context.session.user.id) return notFound();
    if (current._count.ExecutionTargets > 0) {
      throw new ORPCError("CONFLICT", { message: "Capacity is still attached." });
    }
    await prisma.inferenceCapacity.delete({ where: { id: input.id } });
    return { success: true };
  }),

  updateDirectPolicy: protectedProcedure.input(directPolicy).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    const target = await prisma.executionTarget.findUnique({
      where: { id: input.executionTargetId },
      select: { userId: true },
    });
    if (!target || target.userId !== userId) return notFound();
    if (input.inferenceCapacityId) {
      const capacity = await prisma.inferenceCapacity.findUnique({
        where: { id: input.inferenceCapacityId },
        select: { userId: true, hardConcurrencyLimit: true },
      });
      if (!capacity || capacity.userId !== userId) return notFound();
      if (
        input.directReservedSlots !== undefined &&
        capacity.hardConcurrencyLimit !== null &&
        input.directReservedSlots > capacity.hardConcurrencyLimit
      ) {
        throw new ORPCError("BAD_REQUEST", { message: "Reserved slots exceed capacity." });
      }
    }
    const { executionTargetId, ...data } = input;
    return prisma.executionTarget.update({ where: { id: executionTargetId }, data });
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
      const pool = await prisma.modelPool.findUnique({
        where: { id: input.modelPoolId },
        select: { userId: true },
      });
      if (!pool || pool.userId !== context.session.user.id) return notFound();
      const { modelPoolId, ...data } = input;
      return prisma.modelPool.update({ where: { id: modelPoolId }, data });
    }),

  updateMemberPolicy: protectedProcedure
    .input(z.object({ poolMemberId: id, ...sharedPolicyFields }))
    .handler(async ({ input, context }) => {
      enabled();
      const member = await prisma.poolMember.findUnique({
        where: { id: input.poolMemberId },
        select: { ModelPool: { select: { userId: true } } },
      });
      if (!member || member.ModelPool.userId !== context.session.user.id) return notFound();
      const { poolMemberId, ...data } = input;
      return prisma.poolMember.update({ where: { id: poolMemberId }, data });
    }),
};
