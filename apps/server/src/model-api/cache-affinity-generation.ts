import { randomUUID } from "node:crypto";
import { Prisma } from "@ws-model-proxy/db";
import {
  queryAffinityResidency,
  reconcileAffinityForCapacities,
} from "./cache-affinity-residency.js";

/** The instance a node names by `handle` (handles are unique per owner). */
function instanceByHandleSql(nodeId: string, handle: string): Prisma.Sql {
  return Prisma.sql`SELECT i.id FROM runtime_instance i JOIN node n ON n."userId" = i."userId"
    WHERE n.id = ${nodeId} AND i.handle = ${handle}`;
}

/** The last durably consumed load epoch of an instance, or null when none was ever recorded. */
export async function readAffinityCounterEpoch(nodeId: string, handle: string) {
  const rows = await queryAffinityResidency<Array<{ epoch: number | null }>>(
    Prisma.sql`SELECT "loadCounterEpoch" AS epoch FROM runtime_instance
      WHERE id = (${instanceByHandleSql(nodeId, handle)})`,
  );
  return rows[0]?.epoch ?? null;
}

/** Single bounded graph-status write, never inside a projection/source transaction. */
export async function persistAffinityCounterEpoch(nodeId: string, handle: string, epoch: number) {
  await queryAffinityResidency(Prisma.sql`UPDATE runtime_instance SET "loadCounterEpoch" = ${epoch}
    WHERE id = (${instanceByHandleSql(nodeId, handle)}) RETURNING id`);
}

/** Durable intent commits before attempting contended optional publication. */
export async function resetAffinityForCapacities(capacityIds: readonly string[]) {
  if (!capacityIds.length) return;
  await queryAffinityResidency(Prisma.sql`UPDATE runtime_instance SET "cacheGeneration" = ${randomUUID()}
    WHERE id = ANY(${[...capacityIds]}::text[]) RETURNING id`);
  await reconcileAffinityForCapacities(capacityIds).catch(() => {
    // Readers use committed authority. Fresh publication or bounded discovery
    // materializes the empty incarnation after optional bucket contention.
  });
}
