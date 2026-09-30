import { ORPCError } from "@orpc/server";
import { poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import prisma from "@ws-model-proxy/db";
import { fenceOwners } from "@ws-model-proxy/db/capacity-lock-order";
import { poolOwnerActive } from "@ws-model-proxy/db/user-deletion-access";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  effectiveProviderEgress,
  externalFallbackMemberWhere,
  poolProviderDisclosure,
} from "../lib/effective-provider-egress";
import {
  assertExternalAfterWaitWithinBudget,
  assertPoolFallbackEnableable,
  assertProviderEgressReleaseGate,
  poolFallbackChangeSource,
  poolFallbackSettingsSelect,
  recordPoolFallbackAudit,
} from "../lib/pool-fallback-settings";
import { runSerializableTransaction } from "../lib/serializable-transaction";

const id = z.string().min(1).max(255);

function missing(): ORPCError<"NOT_FOUND", unknown> {
  return new ORPCError("NOT_FOUND", { message: "Model pool not found." });
}

/**
 * The owner's view: the pool's fallback switches, the external members in
 * fallback order (with owner-private account labels), and the aggregate
 * own-key request count. The same data as the dashboard pool and providers
 * pages; no credential material, prices or requester identities.
 */
async function ownerView(poolId: string, userId: string) {
  const pool = await prisma.modelPool.findFirst({
    where: { id: poolId, userId },
    select: {
      id: true,
      slug: true,
      ...poolFallbackSettingsSelect,
      externalEquivalentModel: true,
      User: { select: { slug: true } },
      PoolMembers: {
        where: externalFallbackMemberWhere,
        orderBy: [{ publicOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          tier: true,
          publicOrder: true,
          ExecutionTarget: {
            select: {
              ProviderModel: {
                select: {
                  id: true,
                  upstreamModelId: true,
                  enabled: true,
                  deletedAt: true,
                  ProviderAccount: {
                    select: {
                      id: true,
                      label: true,
                      providerType: true,
                      enabled: true,
                      deletedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!pool) return null;
  const ownKeyRequestCount = await prisma.relayRequest.count({
    where: { requestedModelPoolId: pool.id, fallbackRoute: "own-key", status: "SUCCEEDED" },
  });
  return {
    role: "owner" as const,
    poolId: pool.id,
    modelId: poolModelId({ userSlug: pool.User.slug, poolSlug: pool.slug }),
    providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
    fallbackEnabled: pool.fallbackEnabled,
    fallbackForGrantees: pool.fallbackForGrantees,
    externalAfterWaitMs: pool.externalAfterWaitMs,
    externalEquivalentModel: pool.externalEquivalentModel,
    effectiveProviderEgress:
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED &&
      effectiveProviderEgress({
        fallbackEnabled: pool.fallbackEnabled,
        externalMemberCount: pool.PoolMembers.length,
      }),
    /** External (provider) members in the order fallback tries them. */
    members: pool.PoolMembers.map((member) => {
      const model = member.ExecutionTarget?.ProviderModel;
      const account = model?.ProviderAccount;
      return {
        memberId: member.id,
        publicOrder: member.publicOrder,
        providerModelId: model?.id ?? null,
        upstreamModelId: model?.upstreamModelId ?? null,
        providerType: account?.providerType ?? null,
        providerAccountLabel: account?.label ?? null,
        enabled: Boolean(
          model?.enabled && !model.deletedAt && account?.enabled && !account.deletedAt,
        ),
      };
    }),
    /** Successful own-key requests on this pool: a count only, no identities. */
    ownKeyRequestCount,
  };
}

/**
 * A grantee's view of a pool shared with them: whether the owner-paid pool
 * fallback is available to them (provider TYPES only, never the owner's
 * account labels or members, decision #59), and their own-key route.
 */
async function granteeView(poolId: string, userId: string) {
  const grant = await prisma.poolGrant.findFirst({
    where: { poolId, granteeUserId: userId, ModelPool: { userId: { not: userId } } },
    select: {
      ModelPool: {
        select: {
          id: true,
          slug: true,
          fallbackEnabled: true,
          fallbackForGrantees: true,
          externalEquivalentModel: true,
          User: {
            select: { slug: true, banned: true, banExpires: true, deletionRequestedAt: true },
          },
          PoolMembers: {
            where: externalFallbackMemberWhere,
            select: {
              tier: true,
              ExecutionTarget: {
                select: {
                  ProviderModel: {
                    select: { ProviderAccount: { select: { providerType: true } } },
                  },
                },
              },
            },
          },
        },
      },
      FallbackPreferences: {
        where: { userId },
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
                  providerType: true,
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
  });
  // #76: a pool whose owner is banned or deletion-marked is unavailable to
  // everyone; a grantee sees it as not found, like a missing grant.
  if (!grant || !poolOwnerActive(grant.ModelPool.User, new Date())) return null;
  const pool = grant.ModelPool;
  const disclosure = poolProviderDisclosure({
    isOwner: false,
    hasLiveGrant: true,
    providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
    fallbackEnabled: pool.fallbackEnabled,
    fallbackForGrantees: pool.fallbackForGrantees,
    members: pool.PoolMembers.map((member) => ({
      tier: member.tier,
      providerType: member.ExecutionTarget?.ProviderModel?.ProviderAccount.providerType,
    })),
  });
  const preference = grant.FallbackPreferences[0];
  const model = preference?.ProviderModel;
  const account = model?.ProviderAccount;
  const tokens = await prisma.modelApiToken.findMany({
    where: {
      userId,
      revokedAt: null,
      allowExternal: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: {
      scopeMode: true,
      AllowlistEntries: {
        where: { includeExternal: true, modelPoolId: pool.id },
        select: { modelPoolId: true },
      },
    },
  });
  return {
    role: "grantee" as const,
    poolId: pool.id,
    modelId: poolModelId({ userSlug: pool.User.slug, poolSlug: pool.slug }),
    providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
    externalEquivalentModel: pool.externalEquivalentModel,
    /** The owner pays for your `:external` requests through the pool's providers. */
    poolFallback: {
      available: disclosure.effectiveProviderEgress,
      providerTypes: disclosure.providerTypes,
    },
    /** Your own provider key for this pool (you pay). */
    ownKey: {
      configured: Boolean(preference),
      providerModelId: preference?.providerModelId ?? null,
      upstreamModelId: model?.upstreamModelId ?? null,
      providerType: account?.providerType ?? null,
      protocolAdaptationEnabled: preference?.protocolAdaptationEnabled ?? false,
      ready: Boolean(
        env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED &&
          pool.externalEquivalentModel &&
          model?.enabled &&
          !model.deletedAt &&
          account?.enabled &&
          !account.deletedAt &&
          account.CurrentCredential?.status === "ACTIVE",
      ),
    },
    /** Some live API token of yours may send `:external` to this pool. */
    tokenAllowed: tokens.some(
      (token) => token.scopeMode === "ALL_VISIBLE" || token.AllowlistEntries.length > 0,
    ),
  };
}

/**
 * Pool external-fallback settings as their own procedures (issue #67). They
 * back the `forwarder_pool_fallback_get` / `_update` MCP tools; the dashboard
 * keeps using the pool procedures, which share the same checks and audit.
 */
export const poolFallbackRouter = {
  get: protectedProcedure.input(z.object({ poolId: id })).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const view =
      (await ownerView(input.poolId, userId)) ?? (await granteeView(input.poolId, userId));
    if (!view) throw missing();
    return view;
  }),

  /**
   * Owner-only write of `fallbackEnabled`, `fallbackForGrantees` and
   * `externalAfterWaitMs`. Same rules as the dashboard pool update: turning
   * fallback on needs the deployment switch and an audited protection policy
   * on every external member; a new external wait must fit the local wait
   * budget. Every effective change writes a POOL_FALLBACK_UPDATED audit event.
   */
  update: protectedProcedure
    .input(
      z
        .object({
          poolId: id,
          fallbackEnabled: z.boolean().optional(),
          fallbackForGrantees: z.boolean().optional(),
          externalAfterWaitMs: z.number().int().min(0).max(600_000).optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.fallbackEnabled !== undefined ||
            value.fallbackForGrantees !== undefined ||
            value.externalAfterWaitMs !== undefined,
          {
            message:
              "Set at least one of fallbackEnabled, fallbackForGrantees, externalAfterWaitMs.",
          },
        ),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const existing = await prisma.modelPool.findFirst({
        where: { id: input.poolId, userId },
        select: { id: true, capacityWaitBudgetMs: true, externalAfterWaitMs: true },
      });
      if (!existing) throw missing();
      if (input.fallbackEnabled === true) assertProviderEgressReleaseGate();
      assertExternalAfterWaitWithinBudget({
        externalAfterWaitMs: input.externalAfterWaitMs,
        currentExternalAfterWaitMs: existing.externalAfterWaitMs,
        capacityWaitBudgetMs: existing.capacityWaitBudgetMs,
      });
      if (input.fallbackEnabled === true) await assertPoolFallbackEnableable(existing.id, userId);
      const result = await runSerializableTransaction(async (tx) => {
        // Writer class M (@ws-model-proxy/db/capacity-lock-order): the owner
        // fence first, then the pool row, as in updateModelPool.
        await fenceOwners(tx, [userId]);
        await tx.$queryRaw`SELECT id FROM model_pool WHERE id = ${existing.id} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        const before = await tx.modelPool.findFirst({
          where: { id: existing.id, userId },
          select: poolFallbackSettingsSelect,
        });
        if (!before) throw missing();
        const after = await tx.modelPool.update({
          where: { id: existing.id },
          data: {
            ...(input.fallbackEnabled !== undefined
              ? { fallbackEnabled: input.fallbackEnabled }
              : {}),
            ...(input.fallbackForGrantees !== undefined
              ? { fallbackForGrantees: input.fallbackForGrantees }
              : {}),
            ...(input.externalAfterWaitMs !== undefined
              ? { externalAfterWaitMs: input.externalAfterWaitMs }
              : {}),
          },
          select: poolFallbackSettingsSelect,
        });
        const audited = await recordPoolFallbackAudit(tx, {
          userId,
          poolId: existing.id,
          before,
          after,
          source: poolFallbackChangeSource(context),
        });
        return { ...after, changed: audited };
      });
      return { poolId: existing.id, ...result };
    }),
};
