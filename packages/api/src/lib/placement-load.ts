/**
 * Reads what the placement planner (`lib/placement.ts`) needs for one user: their nodes with
 * effective hardware, every claim that is not RELEASED on those nodes (whoever's instance it
 * is), and their fabrics. Plain reads; callers run it inside their transaction.
 */

import { effectiveHardware, liveMetrics } from "../nodes/hardware";
import { effectiveTrust } from "../nodes/trust";
import { parseHeldDefinitions } from "../nodes/views";
import { occupiesNodesWhere } from "./instance-occupancy";
import { physicalLaunchIntents } from "./instance-run";
import { requiredDefinitionsByNode } from "./node-definitions";
import type {
  PlacementContext,
  PlacementFabric,
  PlacementFrozenFabric,
  PlacementInstance,
  PlacementNode,
} from "./placement";
import { reservationClaim } from "./reservations";
import { nodeFabricsHash } from "./runtime-launch-hash";
import { nodeFabricSetsSchema, runtimeSpecSchema } from "./runtime-spec";
import type { Tx } from "./runtime-store";
import { stepIntentSchema } from "./step-intent";

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

/**
 * A node row as the planner sees it: usable memory and per-GPU usable VRAM, before claims
 * (`heldClaims: []` on purpose: the planner replays every claim itself, `loadPlacementInstances`),
 * and the definitions it requires now (`requiredDefinitionsByNode`, read under the owner fence).
 */
export function placementNodeOf(
  row: PlacementNodeRow,
  now: Date,
  requiredVersionIds: ReadonlySet<string>,
): PlacementNode {
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
    trust: effectiveTrust(row),
    held: row.holdAt !== null,
    labels: row.labels,
    portRange: [row.portStart, row.portEnd],
    heldVersionIds: new Set(parseHeldDefinitions(row.heldDefinitions).map((d) => d.versionId)),
    requiredVersionIds,
    frozenFabrics: frozenFabricsOf(row),
    memoryGb: hardware.usableMemoryGb,
    // A unified GPU's VRAM is the node's usable memory (system memory minus reserved).
    gpus: hardware.gpus.map((gpu) => ({
      key: gpu.key,
      vendor: gpu.vendor,
      vramGb: gpu.vramGb === null ? 0 : Math.max(0, gpu.vramGb - gpu.reservedVramGb),
      unified: gpu.unified,
    })),
    liveFreeMemoryGb: liveMetrics(row.nodeMetrics, row.nodeMetricsAt, now).freeMemoryGb,
  };
}

/**
 * Whether a stored launch's stop of `rank` is a step a person runs in an operator terminal (a
 * rank's commands, or the first when the launch has one for every rank, as steps read them);
 * null when the spec is unreadable.
 */
function stopsInteractively(spec: unknown, rank: number): boolean | null {
  const parsed = runtimeSpecSchema.safeParse(spec);
  if (!parsed.success || !parsed.data.launch) return null;
  const commands = parsed.data.launch.commands[rank] ?? parsed.data.launch.commands[0];
  return commands?.interactive?.stop === true;
}

/**
 * Per instance, per rank, the spec of the launch that may still run there when it is not the
 * current version's (`launchesThatMayRun`): a stop of that rank runs that launch's stop command.
 */
type LaunchedSpecs = ReadonlyMap<string, ReadonlyMap<number, unknown>>;

/**
 * Instances holding a claim (not RELEASED) on one of these nodes, with all their claims: their
 * ranks' and, while a rank holds, their reservations' (`launch.reservations`, no port). A
 * replaced run's claims that still hold (a rank's `prev*`, a superseded reservation row) come
 * as `previous` claims: the planner overlaps them with the instance's current claims on the
 * same node (`claim-overlap.ts`).
 */
export async function loadPlacementInstances(
  db: Tx,
  nodeIds: readonly string[],
  launched?: LaunchedSpecs,
): Promise<PlacementInstance[]> {
  if (nodeIds.length === 0) return [];
  const rows = await db.runtimeInstance.findMany({
    // A rank claim there, or a reservation there while one of the instance's ranks holds.
    where: occupiesNodesWhere(nodeIds),
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
        select: {
          rank: true,
          nodeId: true,
          port: true,
          distPort: true,
          resources: true,
          claim: true,
          prevResources: true,
          prevPort: true,
          prevDistPort: true,
        },
      },
      Reservations: {
        orderBy: { index: "asc" },
        select: { nodeId: true, resources: true, supersededGeneration: true },
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
    ranks: [
      ...row.Ranks.flatMap((rank) => {
        // RELEASED claims are not loaded.
        const claim = rank.claim === "HELD_UNKNOWN" ? ("HELD_UNKNOWN" as const) : ("HELD" as const);
        const current = {
          nodeId: rank.nodeId,
          port: rank.port,
          distPort: rank.distPort,
          resources: rank.resources,
          claim,
        };
        // Rows read without the select (older callers' fixtures) have no previous claim.
        if (rank.prevPort === null || rank.prevPort === undefined) return [current];
        return [
          current,
          {
            nodeId: rank.nodeId,
            port: rank.prevPort,
            distPort: rank.prevDistPort ?? null,
            resources: rank.prevResources,
            claim,
            previous: true,
          },
        ];
      }),
      // Only RELEASED-free ranks were loaded: without one, the reservations do not hold.
      ...(row.Ranks.length === 0
        ? []
        : // Rows read without the select (older callers' fixtures) have none.
          (row.Reservations ?? []).map((reservation) => {
            const claim = reservationClaim(row.Ranks);
            return {
              nodeId: reservation.nodeId,
              port: 0,
              distPort: null,
              resources: reservation.resources,
              claim: claim === "HELD_UNKNOWN" ? ("HELD_UNKNOWN" as const) : ("HELD" as const),
              reservation: true,
              ...(reservation.supersededGeneration === null ||
              reservation.supersededGeneration === undefined
                ? {}
                : { previous: true }),
            };
          })),
    ],
    contributed: row.Runtime.Models.length > 0,
    // A held rank's stop runs the stop of the launch that may still run there (an earlier
    // version's, `physicalLaunch`), else the current version's; an unreadable earlier version
    // falls back to the current one, as the stop step does.
    interactiveStop: row.Ranks.some((rank) => {
      const earlier = launched?.get(row.id)?.get(rank.rank);
      const fromEarlier = earlier === undefined ? null : stopsInteractively(earlier, rank.rank);
      return fromEarlier ?? stopsInteractively(row.LaunchVersion.spec, rank.rank) ?? false;
    }),
  }));
}

/**
 * The launches of `userId`'s instances with a rank on these nodes that may still run
 * (`physicalLaunchIntents`): per instance, the reservation nodes they name
 * (`launchCleanupNodes` for one instance), and per rank the spec of a launch of another version
 * than the instance's current one (owner-scoped; absent when unreadable).
 */
async function launchesThatMayRun(
  db: Tx,
  userId: string,
  nodeIds: readonly string[],
): Promise<{ cleanup: Map<string, Set<string>>; specs: LaunchedSpecs }> {
  const cleanup = new Map<string, Set<string>>();
  const versionOf = new Map<string, Map<number, string>>();
  for (const launch of await physicalLaunchIntents(db, { userId, nodeIds })) {
    const intent = stepIntentSchema.safeParse(launch.intent);
    if (!intent.success) continue;
    const ranks = versionOf.get(launch.instanceId) ?? new Map<number, string>();
    ranks.set(launch.rank, intent.data.launchVersionId);
    versionOf.set(launch.instanceId, ranks);
    for (const reservation of intent.data.reservations ?? []) {
      const named = cleanup.get(launch.instanceId) ?? new Set<string>();
      named.add(reservation.nodeId);
      cleanup.set(launch.instanceId, named);
    }
  }
  const versionIds = [...new Set([...versionOf.values()].flatMap((ranks) => [...ranks.values()]))];
  const versions =
    versionIds.length === 0
      ? []
      : await db.runtimeVersion.findMany({
          where: { id: { in: versionIds }, Runtime: { userId } },
          select: { id: true, spec: true },
        });
  const specOf = new Map(versions.map((version) => [version.id, version.spec as unknown]));
  const specs = new Map<string, Map<number, unknown>>();
  for (const [instanceId, ranks] of versionOf) {
    const byRank = new Map<number, unknown>();
    for (const [rank, versionId] of ranks)
      if (specOf.has(versionId)) byRank.set(rank, specOf.get(versionId));
    specs.set(instanceId, byRank);
  }
  return { cleanup, specs };
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
  const nodeIds = nodes.map((row) => row.id);
  // A victim's stop runs the stops of its launches that may still run, and reaches the nodes
  // they name: an agent preempts only where every one is at Full control and none waits for a
  // person (batched, owner-scoped queries).
  const launched = await launchesThatMayRun(db, input.userId, nodeIds);
  const [loaded, fabrics, required] = await Promise.all([
    loadPlacementInstances(db, nodeIds, launched.specs),
    loadPlacementFabrics(db, input.userId),
    requiredDefinitionsByNode(db, { userId: input.userId, nodeIds }),
  ]);
  const instances = loaded.map((instance) => ({
    ...instance,
    cleanupNodeIds: [...(launched.cleanup.get(instance.id) ?? [])],
  }));
  return {
    callerId: input.userId,
    agent: input.agent,
    nodes: nodes.map((row) => placementNodeOf(row, now, required.get(row.id) ?? new Set())),
    instances,
    fabrics,
  };
}
