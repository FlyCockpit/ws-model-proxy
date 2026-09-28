import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";

const id = z.string().min(1).max(255);
/** Human-only consent. Every query is scoped to the signed-in requester. */
export const poolFallbackPreferencesRouter = {
  ownerAggregate: protectedProcedure
    .input(z.object({ poolId: id }))
    .handler(async ({ context, input }) => {
      const pool = await prisma.modelPool.findFirst({
        where: { id: input.poolId, userId: context.session.user.id },
        select: { id: true },
      });
      if (!pool) throw new ORPCError("NOT_FOUND");
      // Count only: no requester identities, target ids, prices or provider data.
      return {
        count: await prisma.relayRequest.count({
          where: { requestedModelPoolId: pool.id, fallbackRoute: "own-key", status: "SUCCEEDED" },
        }),
      };
    }),
  list: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const grants = await prisma.poolGrant.findMany({
      where: { granteeUserId: userId, ModelPool: { userId: { not: userId } } },
      select: {
        id: true,
        ModelPool: {
          select: {
            id: true,
            name: true,
            slug: true,
            externalEquivalentModel: true,
            User: { select: { slug: true } },
          },
        },
        FallbackPreferences: {
          select: {
            providerModelId: true,
            protocolAdaptationEnabled: true,
            ProviderModel: {
              select: {
                enabled: true,
                deletedAt: true,
                upstreamModelId: true,
                ProviderAccount: {
                  select: {
                    enabled: true,
                    deletedAt: true,
                    CurrentCredential: { select: { status: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    const tokens = await prisma.modelApiToken.findMany({
      where: {
        userId,
        revokedAt: null,
        allowExternal: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        scopeMode: true,
        AllowlistEntries: { where: { includeExternal: true }, select: { modelPoolId: true } },
      },
    });
    return {
      enabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
      pools: grants.map(({ ModelPool: pool, FallbackPreferences }) => {
        const preference = FallbackPreferences[0];
        const model = preference?.ProviderModel;
        const account = model?.ProviderAccount;
        return {
          id: pool.id,
          name: pool.name,
          modelId: `${pool.User.slug}/${pool.slug}`,
          externalEquivalentModel: pool.externalEquivalentModel,
          providerModelId: preference?.providerModelId ?? null,
          protocolAdaptationEnabled: preference?.protocolAdaptationEnabled ?? false,
          upstreamModelId: model?.upstreamModelId ?? null,
          ready: Boolean(
            model?.enabled &&
              !model.deletedAt &&
              account?.enabled &&
              !account.deletedAt &&
              account.CurrentCredential?.status === "ACTIVE",
          ),
          tokenAllowed: tokens.some(
            (token) =>
              token.scopeMode === "ALL_VISIBLE" ||
              token.AllowlistEntries.some((entry) => entry.modelPoolId === pool.id),
          ),
        };
      }),
    };
  }),
  set: protectedProcedure
    .input(
      z.object({
        poolId: id,
        providerModelId: id,
        protocolAdaptationEnabled: z.boolean().default(false),
      }),
    )
    .handler(async ({ context, input }) => {
      if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
        throw new ORPCError("FORBIDDEN", { message: "External providers are disabled." });
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        // Same parent order as the send claim; no lock on the requester user row.
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${input.poolId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM pool_grant WHERE "poolId" = ${input.poolId} AND "granteeUserId" = ${userId} FOR SHARE`;
        const grant = await tx.poolGrant.findFirst({
          where: {
            poolId: input.poolId,
            granteeUserId: userId,
            ModelPool: { userId: { not: userId }, externalEquivalentModel: { not: null } },
          },
          select: { id: true },
        });
        if (!grant) throw new ORPCError("NOT_FOUND");
        const model = await tx.providerModel.findFirst({
          where: { id: input.providerModelId, userId },
          select: { providerAccountId: true },
        });
        if (!model) throw new ORPCError("NOT_FOUND");
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${model.providerAccountId} AND "userId" = ${userId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.providerModelId} AND "userId" = ${userId} FOR SHARE`;
        const ready = await tx.providerModel.findFirst({
          where: {
            id: input.providerModelId,
            userId,
            enabled: true,
            deletedAt: null,
            ExecutionTarget: { inferenceCapacityId: { not: null } },
            ProviderAccount: {
              userId,
              enabled: true,
              deletedAt: null,
              CurrentCredential: { status: "ACTIVE" },
            },
          },
          select: { id: true },
        });
        if (!ready)
          throw new ORPCError("PRECONDITION_FAILED", {
            message: "Enable the provider account, key and model first.",
          });
        return tx.poolFallbackPreference.upsert({
          where: { poolId_userId: { poolId: input.poolId, userId } },
          create: { ...input, userId, poolGrantId: grant.id },
          update: {
            providerModelId: input.providerModelId,
            protocolAdaptationEnabled: input.protocolAdaptationEnabled,
            poolGrantId: grant.id,
          },
          select: { providerModelId: true },
        });
      });
    }),
  clear: protectedProcedure.input(z.object({ poolId: id })).handler(async ({ context, input }) => {
    await prisma.poolFallbackPreference.deleteMany({
      where: { poolId: input.poolId, userId: context.session.user.id },
    });
    return { cleared: true };
  }),
};
