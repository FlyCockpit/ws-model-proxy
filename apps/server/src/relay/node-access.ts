/**
 * The shared admission of everything an agent asks a node to do: commands (lane D3) and node
 * file tools. One read (`readNodeAgentAccess`), one synchronous verdict (`judgeNodeAgentAccess`),
 * one revoke sweep (`revokeOpenNodeAgentAccess`). Callers keep the "no await between the verdict
 * and the dispatch" ordering described on `Admission`.
 *
 * 0.4.0 rule (spec §6.3): an agent may act on a node only with a FULL agent token and only
 * while the node is at Full control, both as stored (a person's pending lowering counts as
 * Relay) and as the live session reports it. There are no per-node agent grants any more.
 */
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { nodeOwnerMatches } from "./node-owner.js";
import { relaySessionManager } from "./session-manager.js";

export type NodeAgentCapability = "command" | "file_read" | "file_write";

export type NodeAccessRefusal =
  /** Values of `REFUSAL_REASONS` (packages/api/src/contracts/refusals.ts). */
  | "trust_relay"
  | "node_offline"
  | "upgrade_wsmp"
  | "unknown_node"
  /** The agent token was revoked, expired or narrowed, or its owner is blocked. */
  | "token_inactive"
  /** File capabilities only: the node serves no file roots. */
  | "no_roots";

type OwnerState = {
  banned: boolean | null;
  banExpires: Date | null;
  deletionRequestedAt: Date | null;
};

/**
 * One request between its first await and the moment its record is registered (or it is
 * refused). The revoke sweep only sees records that exist, so it also marks the open
 * admissions of the token; the request then refuses. Together with the live token read this
 * orders every revoke against a start:
 * - committed before the read: the read sees it and the start refuses;
 * - swept while the admission is open: the mark refuses the start;
 * - swept later: the record exists by then (closing the admission, registering the record and
 *   sending the frame happen in one synchronous step) and the sweep ends it like any other.
 * The owner read (ban, ban expiry, deletion marker) is issued last, so its verdict is taken
 * without an await after the token check. A deletion mark committed after it closes the node
 * socket synchronously (`closeSessionsForUser`), so the start finds the node offline; a ban
 * runs the per-user sweep ({@link revokeOpenNodeAgentAccessForUser}).
 * In memory, single process: the relay sockets and the sweeps live here.
 */
type Admission = { tokenId: string; userId: string; revoked: boolean };
const openAdmissions = new Set<Admission>();

/** Mark every admission still reading for `tokenId`: its request refuses. */
export function revokeOpenNodeAgentAccess(tokenId: string): void {
  for (const admission of openAdmissions) {
    if (admission.tokenId === tokenId) admission.revoked = true;
  }
}

/** Mark every admission still reading for `userId` (a ban): its request refuses. */
export function revokeOpenNodeAgentAccessForUser(userId: string): void {
  for (const admission of openAdmissions) {
    if (admission.userId === userId) admission.revoked = true;
  }
}

/** Test only: admissions still open (a leak check). */
export function openNodeAgentAccessCountForTests(): number {
  return openAdmissions.size;
}

/** Test isolation. */
export function resetNodeAgentAccessForTests(): void {
  openAdmissions.clear();
}

export type LiveAgentToken = { name: string; expiresAt: Date | null };

type AccessNode = {
  id: string;
  userId: string;
  slug: string;
  trust: "RELAY" | "FULL" | null;
  trustLowerRequestedAt: Date | null;
  rejectedProtocolVersion: string | null;
};

export type NodeAgentAccessInput = {
  userId: string;
  /** The agent token id, or the OAuth grant id when `credentialKind` is "oauth_grant". */
  tokenId: string;
  /** Which credential `tokenId` names (default: an agent token). */
  credentialKind?: "agent_token" | "oauth_grant";
  /** The expiry the caller's credential was admitted with. */
  expiresAt: Date | null;
  nodeId: string;
};

export type NodeAgentAccessReads = {
  input: NodeAgentAccessInput;
  admission: Admission;
  node: AccessNode | null;
  token: LiveAgentToken | null;
  owner: OwnerState | null;
};

/**
 * The caller's credential if it is still live and FULL: an agent token (not revoked, not
 * expired) or an OAuth grant (not revoked; its access tokens expire on their own and the MCP
 * layer checks them per request).
 */
async function readLiveCredential(
  input: NodeAgentAccessInput,
  now: Date,
): Promise<LiveAgentToken | null> {
  if (input.credentialKind === "oauth_grant") {
    const grant = await prisma.mcpGrant.findFirst({
      where: { id: input.tokenId, userId: input.userId, level: "FULL", revokedAt: null },
      select: { clientId: true },
    });
    return grant ? { name: grant.clientId, expiresAt: null } : null;
  }
  return prisma.agentToken.findFirst({
    where: {
      id: input.tokenId,
      userId: input.userId,
      level: "FULL",
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { name: true, expiresAt: true },
  });
}

/**
 * Open the admission, read the node and live token together, then the owner last. The
 * admission stays OPEN when this returns, so a revoke landing before the caller resumes still
 * marks it. `judgeNodeAgentAccess` closes it synchronously; a caller that never judges must
 * call `closeNodeAgentAccess`.
 */
export async function readNodeAgentAccess(
  input: NodeAgentAccessInput,
): Promise<NodeAgentAccessReads> {
  const admission: Admission = { tokenId: input.tokenId, userId: input.userId, revoked: false };
  openAdmissions.add(admission);
  try {
    const now = new Date();
    const [node, token] = await Promise.all([
      prisma.node.findUnique({
        where: { id: input.nodeId },
        select: {
          id: true,
          userId: true,
          slug: true,
          trust: true,
          trustLowerRequestedAt: true,
          rejectedProtocolVersion: true,
        },
      }),
      readLiveCredential(input, now),
    ]);
    const owner = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { banned: true, banExpires: true, deletionRequestedAt: true },
    });
    return { input, admission, node, token, owner };
  } catch (error) {
    openAdmissions.delete(admission);
    throw error;
  }
}

/** Close an admission that will not be judged. */
export function closeNodeAgentAccess(reads: NodeAgentAccessReads): void {
  openAdmissions.delete(reads.admission);
}

export type NodeAgentAccessVerdict =
  | { ok: true; token: LiveAgentToken; node: AccessNode; fileRoots: string[] | null }
  | {
      ok: false;
      error: NodeAccessRefusal;
      /** With `upgrade_wsmp`: the relay protocol the refused node spoke. */
      rejectedProtocolVersion?: string;
    };

function tokenLive(reads: NodeAgentAccessReads): reads is NodeAgentAccessReads & {
  token: LiveAgentToken;
} {
  const { admission, token, input } = reads;
  if (admission.revoked || token === null) return false;
  const now = Date.now();
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) return false;
  return input.expiresAt === null || input.expiresAt.getTime() > now;
}

/**
 * The synchronous verdict: token, node ownership, owner state, stored trust, then the live
 * session (connected, Full control, file roots). The caller checks its limits and input and
 * registers the record in the same synchronous step; nothing may await in between.
 */
export function judgeNodeAgentAccess(
  reads: NodeAgentAccessReads,
  capability: NodeAgentCapability,
): NodeAgentAccessVerdict {
  const { input, admission, node, owner } = reads;
  // Closing and judging are one synchronous step: no revoke can slip between them.
  openAdmissions.delete(admission);
  if (!tokenLive(reads)) return { ok: false, error: "token_inactive" };
  if (!node || node.userId !== input.userId) return { ok: false, error: "unknown_node" };
  if (owner === null || userCredentialAccessBlocked(owner, new Date())) {
    return { ok: false, error: "token_inactive" };
  }
  if (node.trust !== "FULL" || node.trustLowerRequestedAt !== null) {
    return { ok: false, error: "trust_relay" };
  }
  const live = relaySessionManager.getLiveNodeState(input.nodeId);
  if (!live) {
    return node.rejectedProtocolVersion
      ? {
          ok: false,
          error: "upgrade_wsmp",
          rejectedProtocolVersion: node.rejectedProtocolVersion,
        }
      : { ok: false, error: "node_offline" };
  }
  // The live session must be the caller's too (the stored row was checked above).
  if (!nodeOwnerMatches(live, input.userId, capability === "command" ? "command" : "file_op"))
    return { ok: false, error: "node_offline" };
  if (live.trust !== "full") return { ok: false, error: "trust_relay" };
  if (capability === "command") {
    return { ok: true, token: reads.token, node, fileRoots: null };
  }
  const roots = live.features.files.roots;
  if (roots === null || roots.length === 0) return { ok: false, error: "no_roots" };
  return { ok: true, token: reads.token, node, fileRoots: roots };
}
