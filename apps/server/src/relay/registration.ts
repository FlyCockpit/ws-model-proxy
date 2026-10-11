/**
 * Durable node connection state for relay 3.0 (spec §3.1, §4.2): the hello registration, the
 * heartbeat, `node.state`, and the disconnect. Every write is fenced by the node's
 * `connectionGeneration` (+1 per accepted hello), so a stale session's heartbeat or
 * disconnect can never overwrite a successor, in this process or another replica.
 *
 * These are status columns of `node` (connection, heartbeat, versions, trust as reported,
 * features, held state), which the graph-write fence leaves unfenced (§2.14): each write is
 * one statement on one row. The disconnect (connection OFFLINE plus the node's targets'
 * circuit) is `disconnectNodeAtGeneration` in `@ws-model-proxy/api/lib/pool-routing`. Runtime inventory → runtimes/models/instances/targets is lane A2
 * and arrives through the session manager's node frame handlers.
 */
import type { NodeFeatures } from "@ws-model-proxy/api/lib/runtime-spec";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import type { HeldDefinition, NodeTrustWire } from "./frames.js";
import type { NodeIdentity } from "./node-credential-auth.js";

export class RelayRegistrationError extends Error {
  constructor(
    message: string,
    public readonly code: "access_denied" | "protocol_error" | "identity_mismatch",
  ) {
    super(message);
    this.name = "RelayRegistrationError";
  }
}

/** A reported hostname is display-only: control/format characters stripped, bounded. */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;
const HOSTNAME_MAX_LENGTH = 253;

export function normalizeReportedHostname(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.replace(INVISIBLE_CHARACTERS, "").trim();
  if (clean.length === 0) return null;
  return Array.from(clean).slice(0, HOSTNAME_MAX_LENGTH).join("");
}

export function trustToDb(value: NodeTrustWire): "FULL" | "RELAY" {
  return value === "full" ? "FULL" : "RELAY";
}

/**
 * The lower-request columns after the node reports `reported` (was `stored`). The node
 * confirming a person's lowering ends the request but keeps who lowered it (the trust card's
 * "changed by"); any other trust change was made on the node, so it clears who.
 */
export function trustLowerColumns(
  stored: "FULL" | "RELAY" | null,
  reported: "FULL" | "RELAY",
  lowerPending: boolean,
): { trustLowerRequestedAt?: null; trustLowerRequestedBy?: null } {
  // While a person's lowering is pending, who asked stays (a first hello may still say FULL).
  if (lowerPending) return reported === "RELAY" ? { trustLowerRequestedAt: null } : {};
  if (stored !== reported) return { trustLowerRequestedBy: null };
  return {};
}

export type NodeHelloFacts = {
  slug: string;
  hostname?: string;
  version?: string;
  identityPublicKey: string;
  trust: NodeTrustWire;
  features: NodeFeatures;
  definitions: HeldDefinition[];
  heldMetricCommandsHash: string | null;
  heldFabricsHash: string | null;
};

export type NodeRegistration = {
  nodeId: string;
  userId: string;
  slug: string;
  connectionGeneration: number;
  /** As the server applies it: RELAY while a person's lowering is pending. */
  effectiveTrust: NodeTrustWire;
  /** A person lowered trust and the node still reports Full control: send `trust.lower`. */
  trustLowerPending: boolean;
  /** When the pending lowering was requested (the `trust.lower` frame carries it). */
  trustLowerRequestedAt: Date | null;
};

/**
 * Registers an accepted hello: checks the credential, its identity key and the node slug,
 * then marks the node ONLINE under a new connection generation and stores what the node
 * reported. Throws {@link RelayRegistrationError} for a refusal.
 */
export async function registerNodeHello(input: {
  identity: NodeIdentity;
  hello: NodeHelloFacts;
  protocolVersion: string;
  now?: Date;
}): Promise<NodeRegistration> {
  const { identity, hello } = input;
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const credential = await tx.nodeCredential.findUnique({
      where: { id: identity.credentialId },
      select: {
        revokedAt: true,
        identityPublicKey: true,
        User: { select: { banned: true, banExpires: true, deletionRequestedAt: true } },
        Node: {
          select: {
            id: true,
            userId: true,
            slug: true,
            trust: true,
            trustLowerRequestedAt: true,
          },
        },
      },
    });
    if (!credential || credential.revokedAt !== null) {
      throw new RelayRegistrationError("The node credential was revoked.", "access_denied");
    }
    if (userCredentialAccessBlocked(credential.User, now)) {
      throw new RelayRegistrationError("The node's owner is not active.", "access_denied");
    }
    const node = credential.Node;
    if (node.id !== identity.nodeId || node.userId !== identity.userId) {
      throw new RelayRegistrationError("The node credential was rebound.", "access_denied");
    }
    if (credential.identityPublicKey !== hello.identityPublicKey) {
      throw new RelayRegistrationError(
        "This copy of wsmp has another identity key than the one enrolled. Enroll it again with a new code.",
        "identity_mismatch",
      );
    }
    if (node.slug !== hello.slug) {
      throw new RelayRegistrationError(
        `This node is enrolled as ${node.slug}. Set that name in wsmp or enroll it again.`,
        "identity_mismatch",
      );
    }
    const reportedTrust = trustToDb(hello.trust);
    const lowerPending = node.trustLowerRequestedAt !== null;
    const data: Prisma.NodeUpdateInput = {
      connection: "ONLINE",
      connectionGeneration: { increment: 1 },
      lastConnectedAt: now,
      lastHeartbeatAt: now,
      cliVersion: hello.version ?? null,
      protocolVersion: input.protocolVersion,
      hostname: normalizeReportedHostname(hello.hostname),
      // An accepted hello ends any "upgrade wsmp" state.
      rejectedProtocolVersion: null,
      rejectedCliVersion: null,
      rejectedAt: null,
      trust: reportedTrust,
      ...(node.trust !== reportedTrust ? { trustChangedAt: now } : {}),
      ...trustLowerColumns(node.trust, reportedTrust, lowerPending),
      features: hello.features as Prisma.InputJsonValue,
      featuresAt: now,
      heldDefinitions: hello.definitions as Prisma.InputJsonValue,
      heldMetricCommandsHash: hello.heldMetricCommandsHash,
      heldFabricsHash: hello.heldFabricsHash,
    };
    const updated = await tx.node.update({
      where: { id: node.id },
      data,
      select: { connectionGeneration: true },
    });
    await tx.nodeCredential.update({
      where: { id: identity.credentialId },
      data: { lastUsedAt: now },
    });
    const trustLowerPending = lowerPending && reportedTrust === "FULL";
    return {
      nodeId: node.id,
      userId: node.userId,
      slug: node.slug,
      connectionGeneration: updated.connectionGeneration,
      effectiveTrust: trustLowerPending ? "relay" : hello.trust,
      trustLowerPending,
      trustLowerRequestedAt: trustLowerPending ? node.trustLowerRequestedAt : null,
    };
  });
}

function generationFence(generation: number | null): number | null {
  return generation !== null && Number.isInteger(generation) && generation >= 1 ? generation : null;
}

/** Refreshes the heartbeat while the node row still describes this connection. */
export async function writeNodeHeartbeat(
  nodeId: string,
  generation: number | null,
  now: Date,
): Promise<void> {
  const fence = generationFence(generation);
  if (fence === null) return;
  await prisma.node.updateMany({
    where: { id: nodeId, connectionGeneration: fence, connection: "ONLINE" },
    data: { lastHeartbeatAt: now },
  });
}

/**
 * `node.state`: the node's trust and features changed (a `wsmp trust` change, a lowering it
 * applied, hot reload). Returns whether a pending lowering is still unconfirmed.
 */
export async function writeNodeState(input: {
  nodeId: string;
  generation: number | null;
  trust: NodeTrustWire;
  features: NodeFeatures;
  now: Date;
}): Promise<{ trustLowerPending: boolean } | null> {
  const fence = generationFence(input.generation);
  if (fence === null) return null;
  const node = await prisma.node.findUnique({
    where: { id: input.nodeId },
    select: { trust: true, trustLowerRequestedAt: true, connectionGeneration: true },
  });
  if (!node || node.connectionGeneration !== fence) return null;
  const reportedTrust = trustToDb(input.trust);
  const lowerPending = node.trustLowerRequestedAt !== null;
  await prisma.node.updateMany({
    where: { id: input.nodeId, connectionGeneration: fence, connection: "ONLINE" },
    data: {
      trust: reportedTrust,
      ...(node.trust !== reportedTrust ? { trustChangedAt: input.now } : {}),
      ...trustLowerColumns(node.trust, reportedTrust, lowerPending),
      features: input.features as Prisma.InputJsonValue,
      featuresAt: input.now,
    },
  });
  return { trustLowerPending: lowerPending && reportedTrust === "FULL" };
}

/** Remembers an identity-key refusal on the credential (the node page shows it). */
export async function recordNodeIdentityRefusal(
  identity: NodeIdentity,
  reason: string,
  now: Date,
): Promise<void> {
  await prisma.nodeCredential.updateMany({
    where: { id: identity.credentialId },
    data: { lastRefusedAt: now, lastRefusedReason: reason },
  });
}

/** Remembers why a node's hello was refused for its protocol ("upgrade wsmp"). */
export async function recordRejectedNodeHello(
  identity: NodeIdentity,
  rejected: { protocolVersion: string | null; cliVersion: string | null },
  now: Date,
): Promise<void> {
  await prisma.node.updateMany({
    where: { id: identity.nodeId, userId: identity.userId },
    data: {
      rejectedProtocolVersion: rejected.protocolVersion,
      rejectedCliVersion: rejected.cliVersion,
      rejectedAt: now,
    },
  });
}

/** `node.info` (once a connection) and the latest `node.metrics` sample (at most once a minute). */
export async function writeNodeTelemetry(
  nodeId: string,
  data:
    | { nodeInfo: Prisma.InputJsonValue; nodeInfoAt: Date }
    | { nodeMetrics: Prisma.InputJsonValue; nodeMetricsAt: Date },
  condition: Prisma.NodeWhereInput = {},
): Promise<void> {
  await prisma.node.updateMany({ where: { ...condition, id: nodeId }, data });
}
