/**
 * The nodes an instance occupies: its ranks' nodes and its reservations' nodes
 * (`launch.reservations`, `lib/reservations.ts`). Every check about where an instance runs or
 * holds memory reads them through here, so a check cannot count ranks and forget reservations
 * again (placement, `placement-load.ts`, is the reference: it counts both).
 *
 * Two scopes:
 * - `holding`: what holds a node now (memory, authorization, what a stop acts on): every rank
 *   whose claim is not RELEASED, and every reservation row, superseded ones included (a
 *   replaced run may still use them), while one of the instance's ranks holds.
 * - `current`: the current plan (what an instance is meant to run on: profile matching,
 *   views): every rank, and the reservation rows of the current plan (`supersededGeneration`
 *   null).
 */
import type { Prisma } from "@ws-model-proxy/db";
import { effectiveTrust, type NodeTrustColumns } from "../nodes/trust";
import { physicalLaunch } from "./instance-run";
import { type ClaimStateValue, reservationClaim } from "./reservations";
import { stepIntentSchema } from "./step-intent";

/** What the trust and naming checks read of an occupied node. */
export const OCCUPANCY_NODE_SELECT = {
  id: true,
  slug: true,
  trust: true,
  trustLowerRequestedAt: true,
} as const satisfies Prisma.NodeSelect;

/** Ranks and every reservation row (superseded included), with their nodes. */
export const OCCUPANCY_SELECT = {
  Ranks: {
    orderBy: { rank: "asc" },
    select: { rank: true, nodeId: true, claim: true, Node: { select: OCCUPANCY_NODE_SELECT } },
  },
  Reservations: {
    orderBy: { index: "asc" },
    select: {
      index: true,
      nodeId: true,
      supersededGeneration: true,
      Node: { select: OCCUPANCY_NODE_SELECT },
    },
  },
} as const satisfies Prisma.RuntimeInstanceSelect;

export type OccupancyNode = Pick<NodeTrustColumns, "trust" | "trustLowerRequestedAt"> & {
  id: string;
};

export type OccupancyRank<N extends OccupancyNode = OccupancyNode> = {
  rank: number;
  nodeId: string | null;
  claim: ClaimStateValue;
  Node: N | null;
};

export type OccupancyReservation<N extends OccupancyNode = OccupancyNode> = {
  index: number;
  nodeId: string | null;
  supersededGeneration: number | null;
  Node: N | null;
};

export type OccupancyRow<N extends OccupancyNode = OccupancyNode> = {
  Ranks: ReadonlyArray<OccupancyRank<N>>;
  Reservations: ReadonlyArray<OccupancyReservation<N>>;
};

export type OccupiedNode<N extends OccupancyNode = OccupancyNode> = {
  /** Null after the node was deleted. */
  nodeId: string | null;
  role: "rank" | "reservation";
  /** The rank number, or the reservation's index. */
  position: number;
  /** A rank, or a reservation row of the current plan (not superseded). */
  current: boolean;
  node: N | null;
};

export type OccupancyScope = "holding" | "current";

/**
 * Instances occupying one of these nodes now (`holding`): a rank claim there that is not
 * RELEASED, or a reservation row there while one of the instance's ranks holds.
 */
export function occupiesNodesWhere(nodeIds: readonly string[]): Prisma.RuntimeInstanceWhereInput {
  return {
    OR: [
      { Ranks: { some: { nodeId: { in: [...nodeIds] }, claim: { not: "RELEASED" } } } },
      {
        Reservations: { some: { nodeId: { in: [...nodeIds] } } },
        Ranks: { some: { claim: { not: "RELEASED" } } },
      },
    ],
  };
}

/**
 * Instances planned on one of these nodes (`current`): a rank there (any claim), or a reservation
 * row of the current plan there.
 */
export function placedOnNodesWhere(nodeIds: readonly string[]): Prisma.RuntimeInstanceWhereInput {
  return {
    OR: [
      { Ranks: { some: { nodeId: { in: [...nodeIds] } } } },
      { Reservations: { some: { nodeId: { in: [...nodeIds] }, supersededGeneration: null } } },
    ],
  };
}

/** The nodes an instance occupies in `scope`, ranks first (rank order), then reservations. */
export function occupiedNodes<N extends OccupancyNode>(
  row: OccupancyRow<N>,
  scope: OccupancyScope,
): OccupiedNode<N>[] {
  const ranks = row.Ranks.filter((rank) => scope === "current" || rank.claim !== "RELEASED").map(
    (rank): OccupiedNode<N> => ({
      nodeId: rank.nodeId,
      role: "rank",
      position: rank.rank,
      current: true,
      node: rank.Node,
    }),
  );
  const reservations =
    scope === "holding"
      ? reservationClaim(row.Ranks) === "RELEASED"
        ? []
        : row.Reservations
      : row.Reservations.filter((reservation) => reservation.supersededGeneration === null);
  return [
    ...ranks,
    ...reservations.map(
      (reservation): OccupiedNode<N> => ({
        nodeId: reservation.nodeId,
        role: "reservation",
        position: reservation.index,
        current: reservation.supersededGeneration === null,
        node: reservation.Node,
      }),
    ),
  ];
}

/** Ids of the nodes an instance occupies in `scope` (deleted nodes left out, no repeats). */
export function occupiedNodeIds(row: OccupancyRow, scope: OccupancyScope): string[] {
  return [
    ...new Set(occupiedNodes(row, scope).flatMap((entry) => (entry.nodeId ? [entry.nodeId] : []))),
  ];
}

/**
 * Agents act only where every node the action reaches is at Full control (owner decision): the
 * first node that is not, or null. It reads every rank the row carries (callers select which
 * ranks an action reaches) and the reservation rows in `reservations` scope: `holding` (the
 * default: what a restart, stop or release acts on, superseded rows included while a rank
 * holds) or `current` (a start of the current plan). A pending lowering counts as Relay only,
 * and a deleted node (no row) as not Full: a person decides there.
 */
export function agentBlockedNode(
  row: OccupancyRow,
  reservations: OccupancyScope = "holding",
  /** Nodes a launch that may still run names (`launchCleanupNodes`): its stop acts there too. */
  cleanup: readonly OccupiedNode[] = [],
): OccupiedNode | null {
  const ranks = row.Ranks.map(
    (rank): OccupiedNode => ({
      nodeId: rank.nodeId,
      role: "rank",
      position: rank.rank,
      current: true,
      node: rank.Node,
    }),
  );
  const reserved = occupiedNodes(row, reservations).filter((entry) => entry.role === "reservation");
  return (
    [...ranks, ...reserved, ...cleanup].find(
      (entry) => entry.node === null || effectiveTrust(entry.node) !== "FULL",
    ) ?? null
  );
}

/**
 * The reservation nodes named by each rank's launch that may still run (`physicalLaunch`: not
 * proven stopped): its stop and status probes name them (the job's `reservations`, which its
 * commands are told), also once the rows that held them are gone (a claim released without
 * proof keeps its launch, not its rows). An agent's action that stops, probes or restarts the
 * instance reaches them, so `agentBlockedNode` checks them too (owner decision). Owner-scoped;
 * a node no longer there counts as deleted (null). One lookup per rank.
 */
export async function launchCleanupNodes(
  db: Prisma.TransactionClient,
  userId: string,
  instance: { id: string; Ranks: ReadonlyArray<{ rank: number }> },
): Promise<OccupiedNode[]> {
  const named = new Map<string, number>();
  for (const rank of instance.Ranks) {
    const stored = await physicalLaunch(db, instance.id, rank.rank);
    const intent = stepIntentSchema.safeParse(stored?.intent ?? null);
    if (!intent.success) continue;
    for (const reservation of intent.data.reservations ?? [])
      named.set(reservation.nodeId, reservation.index);
  }
  if (named.size === 0) return [];
  const nodes =
    (await db.node.findMany({
      where: { id: { in: [...named.keys()] }, userId },
      select: OCCUPANCY_NODE_SELECT,
    })) ?? [];
  return [...named].map(([nodeId, index]) => ({
    nodeId,
    role: "reservation",
    position: index,
    current: false,
    node: nodes.find((node) => node.id === nodeId) ?? null,
  }));
}

/** `agentBlockedNode` (holding scope) with the nodes the instance's live launches name. */
export async function agentBlockedNodeWithCleanup(
  db: Prisma.TransactionClient,
  userId: string,
  row: OccupancyRow & { id: string },
): Promise<OccupiedNode | null> {
  return agentBlockedNode(row, "holding", await launchCleanupNodes(db, userId, row));
}

/** The reservation rows of the current plan (not a replaced run's superseded ones). */
export function currentReservations<R extends { supersededGeneration: number | null }>(
  rows: readonly R[],
): R[] {
  return rows.filter((row) => row.supersededGeneration === null);
}
