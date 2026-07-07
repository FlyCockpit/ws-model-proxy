import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
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
  lookupPrefix: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  AllowlistEntries: {
    select: {
      target: true,
      discoveredModelId: true,
      modelPoolId: true,
    },
  },
} as const;

type TokenListRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  name: string;
  scopeMode: string;
  lookupPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  AllowlistEntries: {
    target: string;
    discoveredModelId: string | null;
    modelPoolId: string | null;
  }[];
};

function serializeToken(row: TokenListRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    scopeMode: String(row.scopeMode),
    lookupPrefix: row.lookupPrefix,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    allowlist: {
      directModelCount: row.AllowlistEntries.filter(
        (entry) => entry.target === "DIRECT_MODEL" && entry.discoveredModelId,
      ).length,
      modelPoolCount: row.AllowlistEntries.filter(
        (entry) => entry.target === "MODEL_POOL" && entry.modelPoolId,
      ).length,
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
      const rows = (await prisma.modelApiToken.findMany({
        where: {
          userId: context.session.user.id,
          ...(includeRevoked ? {} : { revokedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: tokenSelection,
      })) as TokenListRow[];

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
      const created = (await prisma.modelApiToken.create({
        data: {
          userId: context.session.user.id,
          name: input.name,
          scopeMode: input.scopeMode,
          lookupPrefix: credentialLookupPrefix(rawSecret),
          secretDigest: digestModelApiTokenSecret(rawSecret),
          expiresAt: input.expiresAt ?? null,
          AllowlistEntries: {
            create: [
              ...allowlistTargets.directModels.map((model) => ({
                target: "DIRECT_MODEL" as const,
                discoveredModelId: model.id,
              })),
              ...allowlistTargets.modelPools.map((pool) => ({
                target: "MODEL_POOL" as const,
                modelPoolId: pool.id,
              })),
            ],
          },
        },
        select: tokenSelection,
      })) as TokenListRow;

      return {
        token: serializeToken(created),
        secret: rawSecret,
      };
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
      const updated = (await prisma.modelApiToken.update({
        where: { id: input.id },
        data: { revokedAt },
        select: tokenSelection,
      })) as TokenListRow;

      return serializeToken(updated);
    }),
};
