import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { z } from "zod";
import { humanProcedure, protectedProcedure } from "../index";
import { assertEffectiveContextPolicy } from "../lib/capacity-policy-safety";
import { parseModelApiSurface } from "../lib/model-api-surface";
import {
  assertRecommendedSurfaceServable,
  discoveredModelSurfaceCapabilities,
} from "../lib/pool-recommended-surface";
import { invalidatePoolRouting } from "../lib/pool-routing-invalidation";
import { loadPoolSurfaceMembers } from "../lib/pool-surface-members";
import { runSerializableTransaction } from "../lib/serializable-transaction";

const id = z.string().min(1).max(128);
const publicSelect = {
  id: true,
  createdAt: true,
  contributorUserId: true,
  poolOwnerUserId: true,
  poolId: true,
  discoveredModelId: true,
  state: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
} as const;

export const inferenceContributionsRouter = {
  list: protectedProcedure
    .input(z.object({ cursor: id.optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .handler(({ input, context }) =>
      prisma.inferenceContribution.findMany({
        where: {
          OR: [
            { contributorUserId: context.session.user.id },
            { poolOwnerUserId: context.session.user.id },
          ],
        },
        orderBy: { id: "asc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: publicSelect,
      }),
    ),
  offer: humanProcedure
    .input(z.object({ poolId: id, discoveredModelId: id }))
    .handler(({ input, context }) => {
      // Offering lends this user's hardware to another owner's pool, which then
      // receives that pool's prompts: a person's consent, like accepting.
      if (context.services?.deploymentActor)
        throw new ORPCError("FORBIDDEN", {
          message: "Offering inference contributions requires human consent.",
        });
      return runSerializableTransaction(async (tx) => {
        const contributorUserId = context.session.user.id;
        const pool = await tx.modelPool.findUnique({
          where: { id: input.poolId },
          select: { userId: true },
        });
        if (!pool || pool.userId === contributorUserId)
          throw new ORPCError("NOT_FOUND", { message: "Contribution pool not found." });
        await fenceOwners(tx, [contributorUserId, pool.userId]);
        const [model, pending] = await Promise.all([
          tx.discoveredModel.findFirst({
            where: { id: input.discoveredModelId, userId: contributorUserId },
            select: { ExecutionTarget: { select: { inferenceCapacityId: true } } },
          }),
          tx.inferenceContribution.count({
            where: { contributorUserId, state: "PENDING", expiresAt: { gt: new Date() } },
          }),
        ]);
        if (!model?.ExecutionTarget?.inferenceCapacityId)
          throw new ORPCError("BAD_REQUEST", {
            message: "An owned capacity-backed model is required.",
            data: { fields: ["discoveredModelId"] },
          });
        if (pending >= 20)
          throw new ORPCError("TOO_MANY_REQUESTS", {
            message: "Too many pending inference offers.",
          });
        const recent = await tx.inferenceContribution.count({
          where: { contributorUserId, createdAt: { gt: new Date(Date.now() - 60_000) } },
        });
        if (recent >= 10)
          throw new ORPCError("TOO_MANY_REQUESTS", {
            message: "Inference offer rate limit reached.",
          });
        return tx.inferenceContribution.create({
          data: {
            ...input,
            contributorUserId,
            poolOwnerUserId: pool.userId,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
          select: publicSelect,
        });
      });
    }),
  accept: humanProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    if (context.services?.deploymentActor)
      throw new ORPCError("FORBIDDEN", {
        message: "Accepting inference contributions requires human consent.",
      });
    const result = await runSerializableTransaction(async (tx) => {
      const offer = await tx.inferenceContribution.findUnique({ where: { id: input.id } });
      if (!offer || offer.poolOwnerUserId !== context.session.user.id)
        throw new ORPCError("NOT_FOUND", { message: "Inference offer not found." });
      await fenceOwners(tx, [offer.contributorUserId, offer.poolOwnerUserId]);
      const target = await tx.executionTarget.findUnique({
        where: { discoveredModelId: offer.discoveredModelId },
        select: { id: true, inferenceCapacityId: true },
      });
      if (!target?.inferenceCapacityId)
        throw new ORPCError("CONFLICT", { message: "Contributor capacity is unavailable." });
      await acquireFences(tx, [
        fences.capacityPolicy(target.id),
        fences.capacity(target.inferenceCapacityId),
      ]);
      await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${offer.poolId} FOR NO KEY UPDATE`;
      const [pool, model] = await Promise.all([
        tx.modelPool.findUnique({
          where: { id: offer.poolId },
          select: {
            recommendedSurfaceOverride: true,
            protocolAdaptationEnabled: true,
            capacityContextCeiling: true,
            capacityContextMargin: true,
          },
        }),
        tx.discoveredModel.findFirst({
          where: { id: offer.discoveredModelId, userId: offer.contributorUserId },
          select: {
            published: true,
            capabilityOverrideMode: true,
            capabilityOverrideMetadata: true,
            capabilityOverrides: true,
            Endpoint: {
              select: {
                published: true,
                status: true,
                capabilityMetadata: true,
                defaultCapabilities: true,
                CliDevice: { select: { status: true } },
              },
            },
            ExecutionTarget: {
              select: { InferenceCapacity: { select: { physicalMaxContext: true } } },
            },
          },
        }),
      ]);
      if (
        !pool ||
        !model?.published ||
        !model.Endpoint.published ||
        model.Endpoint.status !== "ONLINE" ||
        model.Endpoint.CliDevice.status !== "CONNECTED"
      )
        throw new ORPCError("CONFLICT", {
          message: "Contributor model must be connected and serving.",
        });
      const surfaceMembers = await loadPoolSurfaceMembers(tx, offer.poolId);
      surfaceMembers.push({
        id: offer.discoveredModelId,
        tier: "PRIMARY",
        capabilities: discoveredModelSurfaceCapabilities(model),
      });
      assertRecommendedSurfaceServable({
        override: parseModelApiSurface(pool.recommendedSurfaceOverride),
        members: surfaceMembers,
        adaptationEnabled: pool.protocolAdaptationEnabled,
      });
      assertEffectiveContextPolicy({
        physicalMaxContext: model.ExecutionTarget?.InferenceCapacity?.physicalMaxContext,
        poolCeiling: pool.capacityContextCeiling,
        poolMargin: pool.capacityContextMargin,
      });
      const current = await tx.inferenceContribution.findUnique({ where: { id: offer.id } });
      const contributor = await tx.user.findUnique({
        where: { id: offer.contributorUserId },
        select: { banned: true, banExpires: true, deletionRequestedAt: true },
      });
      if (
        current?.state !== "PENDING" ||
        current.expiresAt <= new Date() ||
        !contributor ||
        userCredentialAccessBlocked(contributor, new Date())
      )
        throw new ORPCError("CONFLICT", { message: "Inference offer is no longer available." });
      await tx.inferenceContribution.update({
        where: { id: offer.id },
        data: { state: "ACTIVE", acceptedAt: new Date() },
      });
      const member = await tx.poolMember.create({
        data: {
          poolId: offer.poolId,
          discoveredModelId: offer.discoveredModelId,
          executionTargetId: target.id,
          inferenceContributionId: offer.id,
          tier: "PRIMARY",
          weight: 1,
        },
        select: { id: true },
      });
      return { poolId: offer.poolId, memberId: member.id };
    });
    await invalidatePoolRouting(context.services, [result.poolId]);
    return result;
  }),
  revoke: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    const result = await runSerializableTransaction(async (tx) => {
      const offer = await tx.inferenceContribution.findUnique({ where: { id: input.id } });
      if (
        !offer ||
        ![offer.contributorUserId, offer.poolOwnerUserId].includes(context.session.user.id)
      )
        throw new ORPCError("NOT_FOUND", { message: "Inference contribution not found." });
      await fenceOwners(tx, [offer.contributorUserId, offer.poolOwnerUserId]);
      const target = await tx.executionTarget.findUnique({
        where: { discoveredModelId: offer.discoveredModelId },
        select: { id: true, inferenceCapacityId: true },
      });
      await acquireFences(
        tx,
        target
          ? [
              fences.capacityPolicy(target.id),
              ...(target.inferenceCapacityId ? [fences.capacity(target.inferenceCapacityId)] : []),
            ]
          : [],
      );
      await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${offer.poolId} FOR NO KEY UPDATE`;
      await tx.inferenceContribution.update({
        where: { id: offer.id },
        data: { state: "REVOKED", revokedAt: new Date() },
      });
      // Keep the old member identity fenced forever; re-offering cannot revive it.
      await tx.poolMember.deleteMany({ where: { inferenceContributionId: offer.id } });
      return { poolId: offer.poolId, revoked: true };
    });
    await invalidatePoolRouting(context.services, [result.poolId]);
    return { revoked: result.revoked };
  }),
};
