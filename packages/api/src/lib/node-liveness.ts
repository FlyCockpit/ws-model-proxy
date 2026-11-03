import type { Prisma } from "@ws-model-proxy/db";

/**
 * Whether a node is reachable now, from its durable row (any replica's sessions), not from one
 * process's session map. The one judgement every reader shares (the lifecycle engine, the stop
 * evidence, routing, placement, operator commands, the overview).
 *
 * - `online`: connected, and its heartbeat is fresh (or none was recorded yet: the hello itself
 *   wrote the row).
 * - `stale`: the row still says ONLINE but no heartbeat landed for {@link NODE_HEARTBEAT_STALE_MS}.
 *   A server process that stopped abruptly never writes the disconnect, so no session holds the
 *   node any more: it is gone since its last heartbeat.
 * - `offline`: the disconnect was written (since it, when recorded).
 *
 * Readers that must not act on a node nobody can reach treat `stale` like `offline`
 * ({@link nodeIsLive}, {@link liveNodeWhere}).
 */
export type NodeLiveness =
  | { state: "online" }
  | { state: "stale"; since: Date }
  | { state: "offline"; since: Date | null };

/** A node session sends a heartbeat at least this often; older means the node is gone. */
export const NODE_HEARTBEAT_STALE_MS = 3 * 60_000;

export type NodeLivenessRow = {
  connection: "ONLINE" | "OFFLINE";
  lastHeartbeatAt: Date | null;
  lastDisconnectedAt?: Date | null;
};

function staleCutoff(now: Date): Date {
  return new Date(now.getTime() - NODE_HEARTBEAT_STALE_MS);
}

export function nodeLiveness(node: NodeLivenessRow, now: Date): NodeLiveness {
  if (node.connection !== "ONLINE")
    return { state: "offline", since: node.lastDisconnectedAt ?? null };
  if (node.lastHeartbeatAt && node.lastHeartbeatAt.getTime() < staleCutoff(now).getTime())
    return { state: "stale", since: node.lastHeartbeatAt };
  return { state: "online" };
}

/** Reachable now: connected with a fresh heartbeat. A missing row is not. */
export function nodeIsLive(node: NodeLivenessRow | null | undefined, now: Date): boolean {
  return !!node && nodeLiveness(node, now).state === "online";
}

/**
 * Since when the node has been unreachable, or null while it is live: an OFFLINE row since its
 * disconnect (the epoch when none was recorded: as long ago as can be), a stale one since its
 * last heartbeat.
 */
export function nodeUnreachableSince(node: NodeLivenessRow, now: Date): Date | null {
  const liveness = nodeLiveness(node, now);
  if (liveness.state === "online") return null;
  return liveness.since ?? new Date(0);
}

/**
 * The SQL form of {@link nodeIsLive}: the same rows, as a `where` (indexable on `connection`;
 * the heartbeat bound is a range on the same row).
 */
export function liveNodeWhere(now: Date): Prisma.NodeWhereInput {
  return {
    connection: "ONLINE",
    OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { gte: staleCutoff(now) } }],
  };
}
