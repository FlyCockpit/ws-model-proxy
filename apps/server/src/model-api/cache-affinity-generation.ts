import { randomUUID } from "node:crypto";
import { Prisma } from "@ws-model-proxy/db";
import {
  queryAffinityResidency,
  reconcileAffinityForCapacities,
} from "./cache-affinity-residency.js";

/** The last durably consumed load epoch of an endpoint, or null when none was ever recorded. */
export async function readAffinityCounterEpoch(cliDeviceId: string, slug: string) {
  const rows = await queryAffinityResidency<Array<{ epoch: number | null }>>(
    Prisma.sql`SELECT "loadCounterEpoch" AS epoch FROM endpoint WHERE "cliDeviceId" = ${cliDeviceId} AND slug = ${slug}`,
  );
  return rows[0]?.epoch ?? null;
}

/** Single bounded graph-status write, never inside a projection/source transaction. */
export async function persistAffinityCounterEpoch(
  cliDeviceId: string,
  slug: string,
  epoch: number,
) {
  await queryAffinityResidency(Prisma.sql`UPDATE endpoint SET "loadCounterEpoch" = ${epoch}
    WHERE "cliDeviceId" = ${cliDeviceId} AND slug = ${slug} RETURNING id`);
}

/** Durable intent commits before attempting contended optional publication. */
export async function resetAffinityForCapacities(capacityIds: readonly string[]) {
  if (!capacityIds.length) return;
  await queryAffinityResidency(Prisma.sql`UPDATE inference_capacity SET "cacheGeneration" = ${randomUUID()}
    WHERE id = ANY(${[...capacityIds]}::text[]) RETURNING id`);
  await reconcileAffinityForCapacities(capacityIds).catch(() => {
    // Readers use committed authority. Fresh publication or bounded discovery
    // materializes the empty incarnation after optional bucket contention.
  });
}
