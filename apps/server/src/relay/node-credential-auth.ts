/**
 * Authenticates a node's relay websocket: `Authorization: Bearer wsmp_node_…`, the one node
 * credential type (minted only by an enrollment-code exchange, lane A1). The credential is
 * found by its lookup prefix and checked against the stored purpose HMAC in constant time;
 * a revoked credential, a missing node or a blocked owner (ban, pending deletion) is refused.
 * The identity it returns is what every later relay write is scoped to.
 */
import { timingSafeEqual } from "node:crypto";
import prisma from "@ws-model-proxy/db";
import {
  credentialDigest,
  credentialLookupPrefix,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/node-security";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";

/** The node a relay socket authenticated as. */
export type NodeIdentity = {
  /** The NodeCredential row. */
  credentialId: string;
  userId: string;
  nodeId: string;
  /** The identity key the credential is bound to; hello must present the same one. */
  identityPublicKey: string;
};

const SECRET_PATTERN = /^wsmp_node_[A-Za-z0-9_-]{43}$/;

function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateNodeCredential(
  secret: string,
  now: Date = new Date(),
): Promise<NodeIdentity | null> {
  if (!secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.nodeCredential)) return null;
  if (!SECRET_PATTERN.test(secret)) return null;
  const credential = await prisma.nodeCredential.findUnique({
    where: { lookupPrefix: credentialLookupPrefix(secret) },
    select: {
      id: true,
      userId: true,
      nodeId: true,
      secretDigest: true,
      identityPublicKey: true,
      revokedAt: true,
      User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
    },
  });
  if (!credential || credential.revokedAt !== null) return null;
  if (!digestsEqual(credential.secretDigest, credentialDigest("nodeCredential", secret))) {
    return null;
  }
  if (userCredentialAccessBlocked(credential.User, now)) return null;
  return {
    credentialId: credential.id,
    userId: credential.userId,
    nodeId: credential.nodeId,
    identityPublicKey: credential.identityPublicKey,
  };
}
