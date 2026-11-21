import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { Context } from "../context";
import { hiddenNodeIds, visibleInstancesWhere } from "../lib/agent-hidden-nodes";
import { nodeVisibleToAgent } from "../lib/agent-node-access";
import { notFound } from "../lib/refuse";
import { runtimeSpecSchema } from "../lib/runtime-spec";
import {
  type NodeDetailRow,
  nodeDetailSelect,
  nodeSummarySelect,
  normalizeBaseUrl,
  parseHeldDefinitions,
  toNodeDetail,
  toNodeSummary,
} from "./views";

/** Keep held-resource totals and running/needs-you counts aligned with visible instances. */
export function visibleRankWhere(where: Prisma.InstanceRankWhereInput, hidden: readonly string[]) {
  return hidden.length ? { AND: [where, { Instance: visibleInstancesWhere(hidden) }] } : where;
}
export function visibleReservationWhere(
  where: Prisma.InstanceReservationWhereInput,
  hidden: readonly string[],
) {
  return hidden.length ? { AND: [where, { Instance: visibleInstancesWhere(hidden) }] } : where;
}

export async function loadNodeSummary(
  userId: string,
  nodeId: string,
  now = new Date(),
  auth?: Context["auth"],
) {
  const hidden = auth ? await hiddenNodeIds(prisma, auth) : [];
  const row = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: {
      ...nodeSummarySelect,
      Ranks: {
        ...nodeSummarySelect.Ranks,
        where: visibleRankWhere(nodeSummarySelect.Ranks.where, hidden),
      },
      Reservations: {
        ...nodeSummarySelect.Reservations,
        where: visibleReservationWhere(nodeSummarySelect.Reservations.where, hidden),
      },
    },
  });
  if (!row) throw notFound("That node does not exist.");
  return toNodeSummary(row, now);
}

export async function nodeDetailFromRow(
  userId: string,
  row: NodeDetailRow,
  now = new Date(),
  auth?: Context["auth"],
) {
  const held = parseHeldDefinitions(row.heldDefinitions);
  const runtimeIds = [...new Set(held.map((entry) => entry.runtimeId))];
  const [heldRuntimes, alwaysOn, otherNodes] = await Promise.all([
    runtimeIds.length
      ? prisma.runtime.findMany({
          where: { userId, id: { in: runtimeIds } },
          select: { id: true, currentVersionId: true },
        })
      : Promise.resolve([]),
    prisma.runtime.findMany({
      where: { userId, nodeId: row.id, kind: "ALWAYS_ON" },
      select: { id: true, CurrentVersion: { select: { spec: true } } },
    }),
    prisma.node.findMany({
      where: { userId, id: { not: row.id } },
      select: { id: true, nodeInfo: true },
    }),
  ]);
  const alwaysOnByBaseUrl = new Map<string, string>();
  for (const runtime of alwaysOn) {
    const spec = runtimeSpecSchema.safeParse(runtime.CurrentVersion?.spec);
    const baseUrl = spec.success ? spec.data.address?.baseUrl : undefined;
    if (baseUrl) alwaysOnByBaseUrl.set(normalizeBaseUrl(baseUrl), runtime.id);
  }
  const detail = toNodeDetail(
    row,
    {
      currentVersionByRuntime: new Map(
        heldRuntimes.map((runtime) => [runtime.id, runtime.currentVersionId]),
      ),
      alwaysOnByBaseUrl,
      otherNodes: auth
        ? otherNodes.filter((node) => nodeVisibleToAgent(auth, node.id))
        : otherNodes,
    },
    now,
  );
  return auth
    ? {
        ...detail,
        fabrics: detail.fabrics.map((fabric) => ({
          ...fabric,
          peers: fabric.peers.filter((peer) => nodeVisibleToAgent(auth, peer.nodeId)),
        })),
      }
    : detail;
}

export async function loadNodeDetail(
  userId: string,
  nodeId: string,
  now = new Date(),
  auth?: Context["auth"],
) {
  const hidden = auth ? await hiddenNodeIds(prisma, auth) : [];
  const row = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: {
      ...nodeDetailSelect,
      Ranks: {
        ...nodeDetailSelect.Ranks,
        where: visibleRankWhere(nodeDetailSelect.Ranks.where, hidden),
      },
      Reservations: {
        ...nodeDetailSelect.Reservations,
        where: visibleReservationWhere(nodeDetailSelect.Reservations.where, hidden),
      },
    },
  });
  if (!row) throw notFound("That node does not exist.");
  return nodeDetailFromRow(userId, row, now, auth);
}
