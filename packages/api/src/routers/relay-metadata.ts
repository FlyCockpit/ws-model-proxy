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
          requestedExecutionTargetId: true,
          selectedExecutionTargetId: true,
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
          operation: true,
          requestBytes: true,
          responseBytes: true,
          attemptCount: true,
          affinityOutcome: true,
          affinityScore: true,
          affinityPrefixDepth: true,
          affinityReason: true,
          requestedSurface: true,
          selectedNativeSurface: true,
          adapterMode: true,
          adapterVersion: true,
          selectedPoolMemberId: true,
          selectedPoolMemberTier: true,
          localAttemptId: true,
          firstClientByteAt: true,
          streamCommitted: true,
          admissionAttemptId: true,
          admissionFencingToken: true,
          admissionWaitDurationMs: true,
          admissionTerminalState: true,
          contextTokenCount: true,
          contextCountMethod: true,
          contextCountConfidence: true,
          contextCountExact: true,
          contextSafetyMargin: true,
          admissionLeaseId: true,
          admissionCapacityId: true,
          admissionReservationClass: true,
          admissionBorrowed: true,
          publicEgress: true,
          publicOverflowReason: true,
          providerAttemptId: true,
          providerFencingToken: true,
          ExecutionEvents: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              createdAt: true,
              attemptId: true,
              eventType: true,
              requestedSurface: true,
              nativeSurface: true,
              adapterMode: true,
              adapterVersion: true,
              poolId: true,
              poolMemberId: true,
              executionTargetId: true,
              memberTier: true,
              contextCountMethod: true,
              contextCountConfidence: true,
              contextTokens: true,
              admissionAttemptId: true,
              admissionLeaseId: true,
              admissionFencingToken: true,
              waitDurationMs: true,
              streamCommitted: true,
              terminalState: true,
              httpStatusCode: true,
              upstreamStatusCode: true,
              errorClass: true,
              promptTokens: true,
              completionTokens: true,
              totalTokens: true,
              usageSource: true,
            },
          },
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
        requestedExecutionTargetId: row.requestedExecutionTargetId,
        selectedExecutionTargetId: row.selectedExecutionTargetId,
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
        operation: row.operation,
        requestBytes: row.requestBytes === null ? null : Number(row.requestBytes),
        responseBytes: row.responseBytes === null ? null : Number(row.responseBytes),
        attemptCount: row.attemptCount,
        affinityOutcome: row.affinityOutcome,
        affinityScore: row.affinityScore,
        affinityPrefixDepth: row.affinityPrefixDepth,
        affinityReason: row.affinityReason,
        requestedSurface: row.requestedSurface,
        selectedNativeSurface: row.selectedNativeSurface,
        adapterMode: row.adapterMode,
        adapterVersion: row.adapterVersion,
        selectedPoolMemberId: row.selectedPoolMemberId,
        selectedPoolMemberTier: row.selectedPoolMemberTier,
        localAttemptId: row.localAttemptId,
        firstClientByteAt: row.firstClientByteAt,
        streamCommitted: row.streamCommitted,
        admissionAttemptId: row.admissionAttemptId,
        admissionFencingToken:
          row.admissionFencingToken === null ? null : row.admissionFencingToken.toString(),
        admissionWaitDurationMs: row.admissionWaitDurationMs,
        admissionTerminalState: row.admissionTerminalState,
        contextTokenCount: row.contextTokenCount,
        contextCountMethod: row.contextCountMethod,
        contextCountConfidence: row.contextCountConfidence,
        contextCountExact: row.contextCountExact,
        contextSafetyMargin: row.contextSafetyMargin,
        admissionLeaseId: row.admissionLeaseId,
        admissionCapacityId: row.admissionCapacityId,
        admissionReservationClass: row.admissionReservationClass,
        admissionBorrowed: row.admissionBorrowed,
        publicEgress: row.publicEgress,
        publicOverflowReason: row.publicOverflowReason,
        providerAttemptId: row.providerAttemptId,
        providerFencingToken:
          row.providerFencingToken === null ? null : row.providerFencingToken.toString(),
        executionEvents: row.ExecutionEvents.map((event) => ({
          ...event,
          admissionFencingToken:
            event.admissionFencingToken === null ? null : event.admissionFencingToken.toString(),
        })),
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
