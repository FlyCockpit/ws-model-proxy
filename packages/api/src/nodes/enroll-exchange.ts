/**
 * `POST /api/node/enroll` (contracts/http.ts): a node exchanges a pre-approved enrollment code
 * and its identity public key for its one node credential. Minting the code was the person's
 * approval; the exchange creates (or, with a Replace code, takes over) the node and binds the
 * credential to the identity key that the relay hello later proves.
 *
 * - The code is found by its purpose digest; an unknown, revoked, expired or used-up code is
 *   refused by name (the caller already holds the code, so the name leaks nothing new).
 * - A new slug creates the node with the code's labels and temporary-node policy. An existing
 *   slug is taken over only when its active credential is bound to the same identity key (the
 *   same machine logging in again); otherwise `slug_taken`.
 * - A Replace code moves the named node to this identity after `replaceConfirmed`, revoking its
 *   old credential; a Relay-only node stays Relay only (`trustLowerPending`).
 * - Everything is one transaction under the owner fence (node is a fenced graph table); the
 *   code takes exactly one use (`node_enrollment_code_use`) and the use is recorded.
 *
 * Rate limits (per IP before any lookup, per code owner after) are the caller's (apps/server).
 */
import prisma from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  generateProductCredentialSecret,
} from "@ws-model-proxy/db/node-security";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { z } from "zod";
import type { nodeEnrollRequestSchema, nodeEnrollResponseSchema } from "../contracts/http";
import { graphWrite } from "../lib/graph-write";
import { isUniqueViolation } from "../lib/refuse";

export type NodeEnrollRequest = z.infer<typeof nodeEnrollRequestSchema>;
export type NodeEnrollResponse = z.infer<typeof nodeEnrollResponseSchema>;
type Refusal = Extract<NodeEnrollResponse, { ok: false }>;

/** What the server needs after the commit (close revoked sessions, charge the owner limit). */
export type NodeEnrollOutcome = {
  response: NodeEnrollResponse;
  /** The code owner, once the code was found (for the per-user limit). */
  ownerUserId: string | null;
  /** Credentials this exchange revoked (their relay sessions must close). */
  revokedCredentialIds: string[];
};

class EnrollRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error);
  }
}

function refused(error: Refusal["error"], extra: Partial<Refusal> = {}): Refusal {
  return { ok: false, error, ...extra };
}

/** The code's state now, or the refusal for it. */
function codeRefusal(
  code: { revokedAt: Date | null; expiresAt: Date; usedCount: number; maxUses: number },
  now: Date,
): Refusal | null {
  if (code.revokedAt) return refused("revoked");
  if (code.expiresAt.getTime() <= now.getTime()) return refused("expired");
  if (code.usedCount >= code.maxUses) return refused("used");
  return null;
}

/** Looks the code up and refuses an unusable one before any write (no owner limit charged). */
export async function findEnrollmentCodeOwner(
  code: string,
  now: Date = new Date(),
): Promise<{ ownerUserId: string } | { refusal: Refusal }> {
  const row = await prisma.nodeEnrollmentCode.findUnique({
    where: { codeDigest: credentialDigest("enrollmentCode", code) },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      usedCount: true,
      maxUses: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  if (!row || userCredentialAccessBlocked(row.User, now))
    return { refusal: refused("invalid_code") };
  const state = codeRefusal(row, now);
  return state ? { refusal: state } : { ownerUserId: row.userId };
}

export async function exchangeEnrollmentCode(
  request: NodeEnrollRequest,
  now: Date = new Date(),
): Promise<NodeEnrollOutcome> {
  const found = await findEnrollmentCodeOwner(request.code, now);
  if ("refusal" in found)
    return { response: found.refusal, ownerUserId: null, revokedCredentialIds: [] };
  const userId = found.ownerUserId;
  const secret = generateProductCredentialSecret("nodeCredential");
  try {
    const result = await graphWrite([userId], async (tx) => {
      // The code row under lock: two exchanges of the last use serialize here.
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM node_enrollment_code
         WHERE "codeDigest" = ${credentialDigest("enrollmentCode", request.code)}
           AND "userId" = ${userId}
         FOR UPDATE`;
      if (!locked) throw new EnrollRefused(refused("invalid_code"));
      const code = await tx.nodeEnrollmentCode.findUniqueOrThrow({
        where: { id: locked.id },
        select: {
          id: true,
          revokedAt: true,
          expiresAt: true,
          usedCount: true,
          maxUses: true,
          labels: true,
          removeAfterOfflineMs: true,
          ReplaceNode: { select: { id: true, slug: true, trust: true } },
        },
      });
      const state = codeRefusal(code, now);
      if (state) throw new EnrollRefused(state);

      let nodeId: string;
      let slug: string;
      let replaced: { slug: string } | null = null;
      let trustLowerPending = false;
      if (code.ReplaceNode) {
        if (!request.replaceConfirmed)
          throw new EnrollRefused(
            refused("replace_confirmation_required", {
              replaces: { slug: code.ReplaceNode.slug },
            }),
          );
        nodeId = code.ReplaceNode.id;
        slug = code.ReplaceNode.slug;
        replaced = { slug };
        trustLowerPending = code.ReplaceNode.trust === "RELAY";
        if (request.hostname !== undefined)
          await tx.node.update({ where: { id: nodeId }, data: { hostname: request.hostname } });
      } else {
        const existing = await tx.node.findUnique({
          where: { userId_slug: { userId, slug: request.slug } },
          select: {
            id: true,
            Credentials: {
              where: { revokedAt: null },
              select: { identityPublicKey: true },
            },
          },
        });
        if (existing) {
          // The same machine logging in again keeps its node; any other key is refused.
          const sameKey = existing.Credentials.some(
            (credential) => credential.identityPublicKey === request.identityPublicKey,
          );
          if (!sameKey) throw new EnrollRefused(refused("slug_taken"));
          nodeId = existing.id;
        } else {
          const created = await tx.node.create({
            data: {
              userId,
              slug: request.slug,
              hostname: request.hostname ?? null,
              labels: code.labels,
              removeAfterOfflineMs: code.removeAfterOfflineMs,
            },
            select: { id: true },
          });
          nodeId = created.id;
        }
        slug = request.slug;
      }

      // One active credential per node (`node_credential_one_active`): revoke the old one.
      const previous = await tx.nodeCredential.findMany({
        where: { nodeId, revokedAt: null },
        select: { id: true },
      });
      if (previous.length > 0)
        await tx.nodeCredential.updateMany({
          where: { id: { in: previous.map((row) => row.id) }, revokedAt: null },
          data: { revokedAt: now },
        });
      await tx.nodeCredential.create({
        data: {
          userId,
          nodeId,
          lookupPrefix: credentialLookupPrefix(secret),
          secretDigest: credentialDigest("nodeCredential", secret),
          identityPublicKey: request.identityPublicKey,
        },
        select: { id: true },
      });
      await tx.nodeEnrollmentCode.update({
        where: { id: code.id },
        data: { usedCount: { increment: 1 }, lastUsedAt: now },
        select: { id: true },
      });
      await tx.nodeEnrollmentUse.create({
        data: { userId, codeId: code.id, nodeId },
        select: { id: true },
      });
      return {
        nodeId,
        slug,
        replaced,
        trustLowerPending,
        revokedCredentialIds: previous.map((row) => row.id),
      };
    });
    return {
      response: {
        ok: true,
        nodeId: result.nodeId,
        slug: result.slug,
        credential: secret,
        replaced: result.replaced,
        trustLowerPending: result.trustLowerPending,
      },
      ownerUserId: userId,
      revokedCredentialIds: result.revokedCredentialIds,
    };
  } catch (error) {
    if (error instanceof EnrollRefused)
      return { response: error.refusal, ownerUserId: userId, revokedCredentialIds: [] };
    // A concurrent exchange created the same slug first (unique `(userId, slug)`).
    if (isUniqueViolation(error))
      return { response: refused("slug_taken"), ownerUserId: userId, revokedCredentialIds: [] };
    throw error;
  }
}
