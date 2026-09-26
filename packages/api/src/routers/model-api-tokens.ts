import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import {
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/forwarder-security";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  digestModelApiTokenSecret,
  listVisibleModelTargetsForUser,
  modelApiTokenScopeModes,
  resolveAllowlistedModelTargets,
  type VisibleModelTargets,
} from "../lib/model-api-token-access";
import { buildModelApiTokenAllowlistEntries } from "../lib/model-api-token-allowlist";

const tokenNameSchema = z.string().trim().min(1).max(120);
const modelIdSchema = z.string().trim().min(1).max(512);
const scopeModeSchema = z.enum(modelApiTokenScopeModes);

const tokenSelection = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  name: true,
  scopeMode: true,
  allowExternal: true,
  lookupPrefix: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  AllowlistEntries: {
    select: {
      target: true,
      discoveredModelId: true,
      ExecutionTarget: { select: { discoveredModelId: true } },
      modelPoolId: true,
      includeExternal: true,
    },
  },
} satisfies Prisma.ModelApiTokenSelect;

type TokenListRow = Prisma.ModelApiTokenGetPayload<{ select: typeof tokenSelection }>;

function serializeToken(row: TokenListRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    scopeMode: String(row.scopeMode),
    /** Human-set consent for `owner/pool:external`; false means private only. */
    allowExternal: row.allowExternal,
    lookupPrefix: row.lookupPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    allowlist: {
      directModelCount: row.AllowlistEntries.filter(
        (entry) =>
          entry.target === "DIRECT_MODEL" &&
          Boolean(entry.ExecutionTarget?.discoveredModelId ?? entry.discoveredModelId),
      ).length,
      modelPoolCount: row.AllowlistEntries.filter(
        (entry) => entry.target === "MODEL_POOL" && entry.modelPoolId,
      ).length,
      modelPoolIds: row.AllowlistEntries.flatMap((entry) =>
        entry.target === "MODEL_POOL" && entry.modelPoolId ? [entry.modelPoolId] : [],
      ),
      /** Allowlisted pools whose `:external` variant this token may use. */
      externalModelPoolIds: row.AllowlistEntries.flatMap((entry) =>
        entry.target === "MODEL_POOL" && entry.modelPoolId && entry.includeExternal
          ? [entry.modelPoolId]
          : [],
      ),
    },
  };
}

function serializeTargets(targets: VisibleModelTargets) {
  return {
    directModels: targets.directModels.map((model) => ({
      target: model.target,
      id: model.modelId,
      upstreamModelId: model.upstreamModelId,
      ownerUserId: model.ownerUserId,
      ownerUserSlug: model.ownerUserSlug,
      endpointId: model.endpointId,
      endpointSlug: model.endpointSlug,
      cliDeviceSlug: model.cliDeviceSlug,
    })),
    modelPools: targets.modelPools.map((pool) => ({
      target: pool.target,
      id: pool.modelId,
      name: pool.name,
      description: pool.description,
      fallbackEnabled: pool.fallbackEnabled,
      fallbackForGrantees: pool.fallbackForGrantees,
      effectiveProviderEgress: pool.effectiveProviderEgress,
      providerAccountLabels: pool.providerAccountLabels,
      ownerUserId: pool.ownerUserId,
      ownerUserSlug: pool.ownerUserSlug,
      poolSlug: pool.poolSlug,
    })),
  };
}

async function resolveScopePreview({
  userId,
  scopeMode,
  modelIds,
}: {
  userId: string;
  scopeMode: "ALL_VISIBLE" | "ALLOWLIST";
  modelIds: string[];
}): Promise<VisibleModelTargets> {
  if (scopeMode === "ALL_VISIBLE") {
    if (modelIds.length > 0) {
      throw new ORPCError("BAD_REQUEST", {
        message: "ALL_VISIBLE tokens cannot also define an allowlist.",
      });
    }
    return listVisibleModelTargetsForUser(userId);
  }

  return resolveAllowlistedModelTargets({ userId, modelIds });
}

export const modelApiTokensRouter = {
  list: protectedProcedure
    .input(
      z
        .object({
          includeRevoked: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const includeRevoked = input?.includeRevoked ?? false;
      const limit = input?.limit ?? 50;
      const rows = await prisma.modelApiToken.findMany({
        where: {
          userId: context.session.user.id,
          ...(includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: tokenSelection,
      });

      return rows.map(serializeToken);
    }),

  preview: protectedProcedure
    .input(
      z.object({
        scopeMode: scopeModeSchema,
        modelIds: z.array(modelIdSchema).max(200).default([]),
      }),
    )
    .handler(async ({ input, context }) => {
      const targets = await resolveScopePreview({
        userId: context.session.user.id,
        scopeMode: input.scopeMode,
        modelIds: input.modelIds,
      });
      return serializeTargets(targets);
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: tokenNameSchema,
        scopeMode: scopeModeSchema,
        modelIds: z.array(modelIdSchema).max(200).default([]),
        expiresAt: z.date().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const targets = await resolveScopePreview({
        userId: context.session.user.id,
        scopeMode: input.scopeMode,
        modelIds: input.modelIds,
      });
      const allowlistTargets =
        input.scopeMode === "ALLOWLIST" ? targets : { directModels: [], modelPools: [] };
      const rawSecret = generateProductCredentialSecret("modelApiToken");
      const created = await prisma.modelApiToken.create({
        data: {
          userId: context.session.user.id,
          name: input.name,
          scopeMode: input.scopeMode,
          lookupPrefix: credentialLookupPrefix(rawSecret),
          secretDigest: digestModelApiTokenSecret(rawSecret),
          expiresAt: input.expiresAt ?? null,
          AllowlistEntries: {
            create: buildModelApiTokenAllowlistEntries(allowlistTargets),
          },
        },
        select: tokenSelection,
      });

      return {
        token: serializeToken(created),
        secret: rawSecret,
      };
    }),

  /**
   * Human-only (excluded from MCP): whether this token may use
   * `owner/pool:external`. ALL_VISIBLE tokens are all-or-nothing; ALLOWLIST
   * tokens also choose which allowlisted pools include external providers.
   * An agent must never be able to raise its own egress permission.
   */
  updateExternalAccess: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        allowExternal: z.boolean(),
        /** ALLOWLIST tokens only: allowlisted pool ids that include external providers. */
        externalModelPoolIds: z.array(z.string().min(1)).max(200).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        // Canonical consent-row order (see lockExternalSendConsent): the token
        // row before its allowlist entries. The E0 send-claim transaction holds
        // token then entry FOR SHARE; taking the entries first here would let
        // the two wait on each other. The lock is scoped to the caller's own
        // token (`userId` never changes), so no caller can lock, and so stall,
        // another user's token row.
        await tx.$queryRaw`SELECT id FROM model_api_token WHERE id = ${input.id} AND "userId" = ${userId} FOR NO KEY UPDATE`;
        const existing = await tx.modelApiToken.findUnique({
          where: { id: input.id, userId },
          select: {
            id: true,
            userId: true,
            revokedAt: true,
            scopeMode: true,
            AllowlistEntries: {
              where: { target: "MODEL_POOL", modelPoolId: { not: null } },
              select: { id: true, modelPoolId: true },
            },
          },
        });
        if (!existing || existing.userId !== userId || existing.revokedAt) {
          throw new ORPCError("NOT_FOUND", { message: "Model API token not found." });
        }
        if (input.externalModelPoolIds !== undefined) {
          if (existing.scopeMode !== "ALLOWLIST" && input.externalModelPoolIds.length > 0)
            throw new ORPCError("BAD_REQUEST", {
              message:
                "All-visible tokens allow external providers for every pool or none; per-pool choices need an allowlist token.",
            });
          const allowlisted = new Set(existing.AllowlistEntries.map((entry) => entry.modelPoolId));
          if (input.externalModelPoolIds.some((poolId) => !allowlisted.has(poolId)))
            throw new ORPCError("BAD_REQUEST", {
              message: "External access can only include pools on this token's allowlist.",
            });
          const included = new Set(input.externalModelPoolIds);
          for (const entry of existing.AllowlistEntries) {
            await tx.modelApiTokenAllowlistEntry.update({
              where: { id: entry.id },
              data: {
                includeExternal: entry.modelPoolId !== null && included.has(entry.modelPoolId),
              },
            });
          }
        }
        const updated = await tx.modelApiToken.update({
          where: { id: existing.id },
          data: { allowExternal: input.allowExternal },
          select: tokenSelection,
        });
        return serializeToken(updated);
      });
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const existing = await prisma.modelApiToken.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, revokedAt: true },
      });

      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Model API token not found." });
      }

      const revokedAt = existing.revokedAt ?? new Date();
      const updated = await prisma.modelApiToken.update({
        where: { id: input.id },
        data: { revokedAt },
        select: tokenSelection,
      });

      return serializeToken(updated);
    }),
};
