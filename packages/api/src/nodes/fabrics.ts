/**
 * Fabrics (owner decision round 3): a node's memberships are part of its definition. Every
 * change recomputes `Node.fabricsHash` for each node whose fabric sets changed (the node itself
 * and every other member of a fabric it joined or left), so the relay can push them.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { compareCodePoints } from "../lib/canonical-json";
import { refuse, refuseAbout } from "../lib/refuse";
import { nodeFabricsHash } from "../lib/runtime-launch-hash";
import type { NodeFabricSets } from "../lib/runtime-spec";

type Tx = Prisma.TransactionClient;

type MembershipRow = {
  nodeId: string;
  ip: string;
  fabricId: string;
  Fabric: { name: string; Members: ReadonlyArray<{ ip: string }> };
};

/** The fabric part of one node's definition, as `runtime.define` carries it. */
export function nodeFabricSets(memberships: readonly MembershipRow[]): NodeFabricSets {
  return memberships
    .map((member) => ({
      fabricId: member.fabricId,
      name: member.Fabric.name,
      selfIp: member.ip,
      memberIps: member.Fabric.Members.map((peer) => peer.ip).sort(compareCodePoints),
    }))
    .sort((a, b) => compareCodePoints(a.fabricId, b.fabricId));
}

/** Recompute and store `fabricsHash` for these nodes (one owner). */
export async function refreshFabricsHashes(
  tx: Tx,
  userId: string,
  nodeIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) return;
  const memberships = await tx.fabricMember.findMany({
    where: { userId, nodeId: { in: ids } },
    select: {
      nodeId: true,
      ip: true,
      fabricId: true,
      Fabric: { select: { name: true, Members: { select: { ip: true } } } },
    },
  });
  const held = await tx.node.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, heldFabricsHash: true },
  });
  const heldById = new Map(held.map((node) => [node.id, node.heldFabricsHash]));
  for (const nodeId of ids) {
    const sets = nodeFabricSets(memberships.filter((member) => member.nodeId === nodeId));
    // Like metric commands: no fabrics and nothing held is "nothing to push" (null).
    const fabricsHash =
      sets.length === 0 && (heldById.get(nodeId) ?? null) === null ? null : nodeFabricsHash(sets);
    await tx.node.updateMany({ where: { id: nodeId, userId }, data: { fabricsHash } });
  }
}

/** Every node that is a member of these fabrics. */
export async function fabricMemberNodeIds(
  tx: Tx,
  userId: string,
  fabricIds: readonly string[],
): Promise<string[]> {
  if (fabricIds.length === 0) return [];
  const rows = await tx.fabricMember.findMany({
    where: { userId, fabricId: { in: [...fabricIds] } },
    select: { nodeId: true },
  });
  return [...new Set(rows.map((row) => row.nodeId))];
}

/**
 * Replace one node's memberships with `wanted` (a new name creates the fabric). Returns every
 * node whose fabric sets changed. A duplicate address inside a fabric fails on the unique index
 * (the caller maps it).
 */
export async function replaceNodeFabrics(
  tx: Tx,
  userId: string,
  nodeId: string,
  wanted: ReadonlyArray<{ name: string; ip: string }>,
): Promise<string[]> {
  const current = await tx.fabricMember.findMany({
    where: { userId, nodeId },
    select: { id: true, fabricId: true, ip: true, Fabric: { select: { name: true } } },
  });
  const wantedByName = new Map(wanted.map((entry) => [entry.name, entry.ip]));
  const touchedFabrics = new Set<string>();

  // A live multi-node instance on a fabric pins this node's address there (fabric_in_use; the
  // `fabric_member_in_use` trigger enforces the same in the database).
  const changing = current.filter((member) => wantedByName.get(member.Fabric.name) !== member.ip);
  if (changing.length > 0) {
    const inUse = await tx.runtimeInstance.findFirst({
      where: {
        userId,
        fabricId: { in: changing.map((member) => member.fabricId) },
        Ranks: { some: { nodeId, claim: { not: "RELEASED" } } },
      },
      select: { fabricId: true },
    });
    if (inUse?.fabricId)
      throw refuseAbout(
        "fabric_in_use",
        inUse.fabricId,
        "A running multi-node instance uses this node's address on that fabric. Stop it first.",
      );
  }

  for (const member of current) {
    const ip = wantedByName.get(member.Fabric.name);
    if (ip === undefined) {
      await tx.fabricMember.delete({ where: { id: member.id } });
      touchedFabrics.add(member.fabricId);
    } else if (ip !== member.ip) {
      await tx.fabricMember.update({ where: { id: member.id }, data: { ip } });
      touchedFabrics.add(member.fabricId);
    }
  }
  const currentNames = new Set(current.map((member) => member.Fabric.name));
  for (const entry of wanted) {
    if (currentNames.has(entry.name)) continue;
    const fabric = await tx.fabric.upsert({
      where: { userId_name: { userId, name: entry.name } },
      create: { userId, name: entry.name },
      update: {},
      select: { id: true },
    });
    await tx.fabricMember.create({
      data: { userId, fabricId: fabric.id, nodeId, ip: entry.ip },
    });
    touchedFabrics.add(fabric.id);
  }
  if (touchedFabrics.size === 0) return [];
  const affected = await fabricMemberNodeIds(tx, userId, [...touchedFabrics]);
  return [...new Set([nodeId, ...affected])];
}

/** The `fabric_member_in_use` trigger (SQLSTATE WMPP1), read by code or its message tag. */
export function isFabricMemberInUse(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"])
      if (Reflect.get(candidate, key) === "WMPP1") return true;
    const message = Reflect.get(candidate, "message");
    if (typeof message === "string" && message.includes("fabric_member_in_use")) return true;
    for (const key of ["meta", "cause", "driverAdapterError"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

/** Maps the database's fabric refusal to the contract's. */
export function fabricInUseRefusal() {
  return refuse(
    "fabric_in_use",
    "A running multi-node instance uses this fabric address. Stop it first.",
  );
}
