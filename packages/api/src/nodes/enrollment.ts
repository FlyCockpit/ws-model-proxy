/**
 * Enrollment codes (owner decision round 3: multi-use, labels, temporary) and node credentials.
 * Minting a code is the person's approval of the nodes that use it (human only); the exchange
 * itself is plain HTTP in `apps/server` (`POST /api/node/enroll`).
 */
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { credentialDigest } from "@ws-model-proxy/db/node-security";
import { env } from "@ws-model-proxy/env/server";
import type { z } from "zod";
import { contractProcedure } from "../contract-procedure";
import type { enrollmentCodeViewSchema } from "../contracts/nodes";
import { nodesContract as c } from "../contracts/nodes";
import { isConstraintViolation, notFound, refuse } from "../lib/refuse";
import {
  enrollmentCodePrefix,
  enrollmentInstallCommand,
  generateEnrollmentCode,
} from "./enrollment-code";

const HOUR_MS = 3_600_000;
/** Codes still usable, plus codes used or revoked this recently, are listed. */
export const RECENT_CODE_MS = 24 * HOUR_MS;
/** Live (unexpired, unrevoked, not used up) codes one person may hold at once. */
export const MAX_LIVE_CODES = 20;

const codeSelect = {
  id: true,
  codePrefix: true,
  createdAt: true,
  expiresAt: true,
  suggestedSlug: true,
  replaceNodeId: true,
  maxUses: true,
  usedCount: true,
  lastUsedAt: true,
  labels: true,
  removeAfterOfflineMs: true,
  revokedAt: true,
  Uses: {
    orderBy: { usedAt: "desc" },
    take: 50,
    select: { nodeId: true, usedAt: true, Node: { select: { slug: true } } },
  },
} as const;

type CodeRow = {
  id: string;
  codePrefix: string;
  createdAt: Date;
  expiresAt: Date;
  suggestedSlug: string | null;
  replaceNodeId: string | null;
  maxUses: number;
  usedCount: number;
  lastUsedAt: Date | null;
  labels: string[];
  removeAfterOfflineMs: number | null;
  revokedAt: Date | null;
  Uses: Array<{ nodeId: string | null; usedAt: Date; Node: { slug: string } | null }>;
};

export function toEnrollmentCodeView(row: CodeRow): z.infer<typeof enrollmentCodeViewSchema> {
  return {
    id: row.id,
    codePrefix: row.codePrefix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    suggestedSlug: row.suggestedSlug,
    replaceNodeId: row.replaceNodeId,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    labels: row.labels,
    removeAfterOfflineMs: row.removeAfterOfflineMs,
    enrolled: row.Uses.map((use) => ({
      nodeId: use.nodeId,
      slug: use.Node?.slug ?? null,
      usedAt: use.usedAt.toISOString(),
    })),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** A concurrent Replace code for the same node trips `node_enrollment_replace_shape`. */
async function mintCode<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isConstraintViolation(error))
      throw new ORPCError("CONFLICT", {
        message: "Another enrollment code was created for this node at the same time. Try again.",
      });
    throw error;
  }
}

function liveCodeWhere(userId: string, now: Date) {
  return { userId, revokedAt: null, expiresAt: { gt: now } };
}

export const enrollmentProcedures = {
  list: contractProcedure(c.enrollmentCodes.list).handler(async ({ context }) => {
    const now = new Date();
    const recent = new Date(now.getTime() - RECENT_CODE_MS);
    const rows = await prisma.nodeEnrollmentCode.findMany({
      where: {
        userId: context.session.user.id,
        OR: [
          { expiresAt: { gt: now } },
          { lastUsedAt: { gt: recent } },
          { createdAt: { gt: recent } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: codeSelect,
    });
    return { codes: rows.map(toEnrollmentCodeView) };
  }),

  create: contractProcedure(c.enrollmentCodes.create).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const now = new Date();
    const secret = generateEnrollmentCode();
    const row = await mintCode(async () =>
      prisma.$transaction(async (tx) => {
        if (input.replaceNodeId) {
          const node = await tx.node.findFirst({
            where: { id: input.replaceNodeId, userId },
            select: { id: true },
          });
          if (!node) throw notFound("Node");
          // At most one live Replace code per node (`node_enrollment_replace_shape`): a new one
          // supersedes the previous.
          await tx.nodeEnrollmentCode.updateMany({
            where: { ...liveCodeWhere(userId, now), replaceNodeId: node.id, usedCount: 0 },
            data: { revokedAt: now },
          });
        }
        const live = await tx.nodeEnrollmentCode.findMany({
          where: liveCodeWhere(userId, now),
          select: { usedCount: true, maxUses: true },
        });
        if (live.filter((code) => code.usedCount < code.maxUses).length >= MAX_LIVE_CODES)
          throw refuse(
            "rate_limited",
            `At most ${MAX_LIVE_CODES} enrollment codes can be live at once. Revoke one first.`,
            "TOO_MANY_REQUESTS",
          );
        return tx.nodeEnrollmentCode.create({
          data: {
            userId,
            codePrefix: enrollmentCodePrefix(secret),
            codeDigest: credentialDigest("enrollmentCode", secret),
            expiresAt: new Date(now.getTime() + input.ttlHours * HOUR_MS),
            suggestedSlug: input.suggestedSlug ?? null,
            replaceNodeId: input.replaceNodeId ?? null,
            maxUses: input.maxUses,
            labels: input.labels ?? [],
            removeAfterOfflineMs: input.removeAfterOfflineMs ?? null,
          },
          select: codeSelect,
        });
      }),
    );
    return {
      code: toEnrollmentCodeView(row),
      secret,
      installCommand: enrollmentInstallCommand(env.BETTER_AUTH_URL, secret),
    };
  }),

  revoke: contractProcedure(c.enrollmentCodes.revoke).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const code = await prisma.nodeEnrollmentCode.findFirst({
      where: { id: input.codeId, userId },
      select: { id: true, revokedAt: true },
    });
    if (!code) throw notFound("Enrollment code");
    if (code.revokedAt === null)
      await prisma.nodeEnrollmentCode.updateMany({
        where: { id: code.id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    return { ok: true as const };
  }),
};

export const credentialProcedures = {
  list: contractProcedure(c.credentials.list).handler(async ({ context, input }) => {
    const rows = await prisma.nodeCredential.findMany({
      where: {
        userId: context.session.user.id,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        nodeId: true,
        createdAt: true,
        lastUsedAt: true,
        lastRefusedAt: true,
        lastRefusedReason: true,
        revokedAt: true,
      },
    });
    return {
      credentials: rows.map((row) => ({
        id: row.id,
        nodeId: row.nodeId,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastRefusedAt: row.lastRefusedAt?.toISOString() ?? null,
        lastRefusedReason: row.lastRefusedReason,
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
    };
  }),

  revoke: contractProcedure(c.credentials.revoke).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const credential = await prisma.nodeCredential.findFirst({
      where: { id: input.credentialId, userId },
      select: { id: true, nodeId: true, revokedAt: true },
    });
    if (!credential) throw notFound("Node credential");
    if (credential.revokedAt === null) {
      await prisma.nodeCredential.updateMany({
        where: { id: credential.id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const disconnect = context.services?.nodes?.disconnect;
      if (disconnect) {
        try {
          await disconnect(credential.nodeId, "credential_revoked");
        } catch {
          // The relay re-checks the credential on its next use.
        }
      }
    }
    return { ok: true as const };
  }),
};
