import prisma from "@ws-model-proxy/db";
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

export async function loadNodeSummary(userId: string, nodeId: string, now = new Date()) {
  const row = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: nodeSummarySelect,
  });
  if (!row) throw notFound("Node");
  return toNodeSummary(row, now);
}

export async function nodeDetailFromRow(userId: string, row: NodeDetailRow, now = new Date()) {
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
  return toNodeDetail(
    row,
    {
      currentVersionByRuntime: new Map(
        heldRuntimes.map((runtime) => [runtime.id, runtime.currentVersionId]),
      ),
      alwaysOnByBaseUrl,
      otherNodes,
    },
    now,
  );
}

export async function loadNodeDetail(userId: string, nodeId: string, now = new Date()) {
  const row = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: nodeDetailSelect,
  });
  if (!row) throw notFound("Node");
  return nodeDetailFromRow(userId, row, now);
}
