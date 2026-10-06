/**
 * Reads what the placement planner (`lib/placement.ts`) needs for one user: their nodes with
 * effective hardware, every claim that is not RELEASED on those nodes (whoever's instance it
 * is), and their fabrics. Plain reads; callers run it inside their transaction.
 */

import { effectiveHardware, liveMetrics } from "../nodes/hardware";
import { nodeTrustView } from "../nodes/trust";
import { parseHeldDefinitions } from "../nodes/views";
import type {
  PlacementContext,
  PlacementFabric,
  PlacementFrozenFabric,
  PlacementInstance,
  PlacementNode,
} from "./placement";
import { nodeFabricsHash } from "./runtime-launch-hash";
import { nodeFabricSetsSchema, runtimeSpecSchema } from "./runtime-spec";
import type { Tx } from "./runtime-store";

export const PLACEMENT_NODE_SELECT = {
  id: true,
  slug: true,
  connection: true,
  trust: true,
  trustChangedAt: true,
  trustLowerRequestedAt: true,
  labels: true,
  holdAt: true,
  portStart: true,
  portEnd: true,
  heldDefinitions: true,
  frozenFabrics: true,
  fabricsHash: true,
  heldFabricsHash: true,
  declaredResources: true,
  nodeInfo: true,
  nodeMetrics: true,
  nodeMetricsAt: true,
} as const;

export type PlacementNodeRow = {
  id: string;
  slug: string;
  connection: "ONLINE" | "OFFLINE";
  trust: "RELAY" | "FULL" | null;
  trustChangedAt: Date | null;
  trustLowerRequestedAt: Date | null;
  labels: string[];
  holdAt: Date | null;
  portStart: number;
  portEnd: number;
  heldDefinitions: unknown;
  frozenFabrics: unknown;
  fabricsHash: string | null;
  heldFabricsHash: string | null;
  declaredResources: unknown;
  nodeInfo: unknown;
  nodeMetrics: unknown;
  nodeMetricsAt: Date | null;
};

const EMPTY_FABRICS_HASH = nodeFabricsHash([]);

/**
 * The fabrics a Relay-only node checks a multi-node head against. A node reporting RELAY: what
 * it froze (`[{ fabricId, name, selfIp, memberIps }]`); an unreadable value freezes nothing, so
 * a multi-node start there is refused, as the node would refuse it. A pending lower whose fabric
 * definition is in sync (`heldFabricsHash` matches `fabricsHash`): `"current"`, the memberships
 * it will freeze. Otherwise null (not checked).
 */
function frozenFabricsOf(row: PlacementNodeRow): PlacementFrozenFabric[] | "current" | null {
  if (row.trust === "RELAY") {
    const parsed = nodeFabricSetsSchema.safeParse(row.frozenFabrics ?? []);
    if (!parsed.success) return [];
    return parsed.data.map((fabric) => ({
      fabricId: fabric.fabricId,
      name: fabric.name,
      memberIps: fabric.memberIps,
    }));
  }
  const lowerPending = row.trustLowerRequestedAt !== null;
  const inSync =
    (row.fabricsHash ?? EMPTY_FABRICS_HASH) === (row.heldFabricsHash ?? EMPTY_FABRICS_HASH);
  return lowerPending && inSync ? "current" : null;
}

/** A node row as the planner sees it: usable memory and per-GPU usable VRAM, before claims. */
export function placementNodeOf(row: PlacementNodeRow, now: Date): PlacementNode {
  const hardware = effectiveHardware({
    declaredResources: row.declaredResources,
    nodeInfo: row.nodeInfo,
    nodeMetrics: row.nodeMetrics,
    nodeMetricsAt: row.nodeMetricsAt,
    heldClaims: [],
    now,
  });
  return {
    id: row.id,
    slug: row.slug,
    online: row.connection === "ONLINE",
    trust: nodeTrustView(row).effective,
    held: row.holdAt !== null,
    labels: row.labels,
    portRange: [row.portStart, row.portEnd],
    heldVersionIds: new Set(parseHeldDefinitions(row.heldDefinitions).map((d) => d.versionId)),
    frozenFabrics: frozenFabricsOf(row),
    memoryGb: hardware.usableMemoryGb,
    gpus: hardware.gpus.map((gpu) => ({
      key: gpu.key,
      vendor: gpu.vendor,
      vramGb: Math.max(0, gpu.vramGb - gpu.reservedVramGb),
    })),
    liveFreeMemoryGb: liveMetrics(row.nodeMetrics, row.nodeMetricsAt, now).freeMemoryGb,
  };
}

/** Whether a stored launch has a stop step a person runs in an operator terminal. */
function hasInteractiveStop(spec: unknown): boolean {
  const parsed = runtimeSpecSchema.safeParse(spec);
  if (!parsed.success) return false;
  return (parsed.data.launch?.commands ?? []).some((commands) => !!commands.interactive?.stop);
}

/** Instances holding a claim (not RELEASED) on one of these nodes, with all their claims. */
export async function loadPlacementInstances(
  db: Tx,
  nodeIds: readonly string[],
): Promise<PlacementInstance[]> {
  if (nodeIds.length === 0) return [];
  const rows = await db.runtimeInstance.findMany({
    where: { Ranks: { some: { nodeId: { in: [...nodeIds] }, claim: { not: "RELEASED" } } } },
    select: {
      id: true,
      userId: true,
      runtimeId: true,
      desiredState: true,
      Runtime: {
        select: {
          kind: true,
          // A member another user's pool holds through a share ("contributed").
          Models: {
            where: { Members: { some: { shareId: { not: null } } } },
            select: { id: true },
            take: 1,
          },
        },
      },
      LaunchVersion: { select: { spec: true } },
      Ranks: {
        where: { claim: { not: "RELEASED" } },
        orderBy: { rank: "asc" },
        select: { nodeId: true, port: true, distPort: true, resources: true, claim: true },
      },
    },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    runtimeId: row.runtimeId,
    ownerId: row.userId,
    startable: row.Runtime.kind === "STARTABLE",
    running: row.desiredState === "RUNNING",
    ranks: row.Ranks.map((rank) => ({
      nodeId: rank.nodeId,
      port: rank.port,
      distPort: rank.distPort,
      resources: rank.resources,
      // RELEASED claims are not loaded.
      claim: rank.claim === "HELD_UNKNOWN" ? ("HELD_UNKNOWN" as const) : ("HELD" as const),
    })),
    contributed: row.Runtime.Models.length > 0,
    interactiveStop: hasInteractiveStop(row.LaunchVersion.spec),
  }));
}

export async function loadPlacementFabrics(db: Tx, userId: string): Promise<PlacementFabric[]> {
  const rows = await db.fabric.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, Members: { select: { nodeId: true, ip: true } } },
  });
  return rows.map((row) => ({ id: row.id, name: row.name, members: row.Members }));
}

/** Everything the planner needs for a start by `userId` on any of their nodes. */
export async function loadPlacementContext(
  db: Tx,
  input: { userId: string; agent: boolean; now?: Date },
): Promise<PlacementContext> {
  const now = input.now ?? new Date();
  const nodes = await db.node.findMany({
    where: { userId: input.userId },
    select: PLACEMENT_NODE_SELECT,
    orderBy: { slug: "asc" },
  });
  const [instances, fabrics] = await Promise.all([
    loadPlacementInstances(
      db,
      nodes.map((row) => row.id),
    ),
    loadPlacementFabrics(db, input.userId),
  ]);
  return {
    callerId: input.userId,
    agent: input.agent,
    nodes: nodes.map((row) => placementNodeOf(row, now)),
    instances,
    fabrics,
  };
}
