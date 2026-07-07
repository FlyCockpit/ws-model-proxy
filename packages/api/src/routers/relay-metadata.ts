import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import { adminProcedure, protectedProcedure } from "../index";

const deleteOwnInput = z
  .object({
    ids: z.array(z.string().min(1)).max(500).default([]),
    createdAfter: z.date().optional(),
    createdBefore: z.date().optional(),
  })
  .refine((input) => input.ids.length > 0 || input.createdBefore || input.createdAfter, {
    message: "Provide ids, createdBefore, or createdAfter.",
  });

const pruneInput = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    createdBefore: z.date().optional(),
    createdAfter: z.date().optional(),
  })
  .refine((input) => input.ownerUserId || input.createdBefore || input.createdAfter, {
    message: "Provide ownerUserId, createdBefore, or createdAfter.",
  });

export const relayMetadataRouter = {
  listOwn: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          createdAfter: z.date().optional(),
          createdBefore: z.date().optional(),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const rows = await prisma.relayRequest.findMany({
        where: {
          userId: context.session.user.id,
          ...(input?.createdBefore || input?.createdAfter
            ? {
                createdAt: {
                  ...(input.createdBefore ? { lt: input.createdBefore } : {}),
                  ...(input.createdAfter ? { gte: input.createdAfter } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 50,
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          modelApiTokenId: true,
          modelApiTokenLookupPrefix: true,
          requestedDiscoveredModelId: true,
          requestedModelPoolId: true,
          selectedDiscoveredModelId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          httpStatusCode: true,
          upstreamStatusCode: true,
          errorClass: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        modelApiTokenId: row.modelApiTokenId,
        modelApiTokenLookupPrefix: row.modelApiTokenLookupPrefix,
        requestedDiscoveredModelId: row.requestedDiscoveredModelId,
        requestedModelPoolId: row.requestedModelPoolId,
        selectedDiscoveredModelId: row.selectedDiscoveredModelId,
        status: String(row.status),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        durationMs: row.durationMs,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        httpStatusCode: row.httpStatusCode,
        upstreamStatusCode: row.upstreamStatusCode,
        errorClass: row.errorClass,
      }));
    }),

  deleteOwn: protectedProcedure.input(deleteOwnInput).handler(async ({ input, context }) => {
    if (input.createdBefore && input.createdAfter && input.createdAfter >= input.createdBefore) {
      throw new ORPCError("BAD_REQUEST", {
        message: "createdAfter must be earlier than createdBefore.",
      });
    }

    const result = await prisma.relayRequest.deleteMany({
      where: {
        userId: context.session.user.id,
        ...(input.ids.length > 0 ? { id: { in: input.ids } } : {}),
        ...(input.createdBefore || input.createdAfter
          ? {
              createdAt: {
                ...(input.createdBefore ? { lt: input.createdBefore } : {}),
                ...(input.createdAfter ? { gte: input.createdAfter } : {}),
              },
            }
          : {}),
      },
    });
    return { deletedCount: result.count };
  }),

  prune: adminProcedure.input(pruneInput).handler(async ({ input }) => {
    if (input.createdBefore && input.createdAfter && input.createdAfter >= input.createdBefore) {
      throw new ORPCError("BAD_REQUEST", {
        message: "createdAfter must be earlier than createdBefore.",
      });
    }

    const result = await prisma.relayRequest.deleteMany({
      where: {
        ...(input.ownerUserId ? { userId: input.ownerUserId } : {}),
        ...(input.createdBefore || input.createdAfter
          ? {
              createdAt: {
                ...(input.createdBefore ? { lt: input.createdBefore } : {}),
                ...(input.createdAfter ? { gte: input.createdAfter } : {}),
              },
            }
          : {}),
      },
    });
    return { deletedCount: result.count };
  }),
};
