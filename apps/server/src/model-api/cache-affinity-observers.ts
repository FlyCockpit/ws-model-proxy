import { randomUUID } from "node:crypto";
import { Prisma } from "@ws-model-proxy/db";
import { resetAffinityForCapacities } from "./cache-affinity-generation.js";
import { queryAffinityResidency } from "./cache-affinity-residency.js";

/** Database-clock confidence bound, independent of observer process survival. */
export const AFFINITY_OBSERVER_LEASE_MS = 2000;
type Observation = {
  capacityId: string;
  cliDeviceId: string;
  endpointSlug: string;
  version: string;
};

/** Pending receipt commits before attempting the independently contended authority. */
export async function observeAffinityReset({
  cliDeviceId,
  slugs,
  connectionGeneration,
  managerId,
}: {
  cliDeviceId: string;
  slugs: readonly string[];
  connectionGeneration: number;
  managerId: string;
}): Promise<Observation[]> {
  if (!slugs.length) return [];
  return queryAffinityResidency<Observation[]>(Prisma.sql`
    INSERT INTO cache_affinity_observer
      ("capacityId", "cliDeviceId", "endpointSlug", "userId", "managerId",
       "connectionGeneration", version, "validUntil", pending, retired)
    SELECT DISTINCT t."inferenceCapacityId", e."cliDeviceId", e.slug, t."userId", ${managerId},
      ${connectionGeneration}::integer, ${randomUUID()}, clock_timestamp() + interval '2 seconds', true, false
    FROM endpoint e JOIN discovered_model m ON m."endpointId" = e.id
    JOIN execution_target t ON t."discoveredModelId" = m.id
    JOIN cli_device d ON d.id = e."cliDeviceId"
    WHERE e."cliDeviceId" = ${cliDeviceId} AND e.slug = ANY(${[...slugs]}::text[])
      AND d."connectionGeneration" = ${connectionGeneration}
      AND t."inferenceCapacityId" IS NOT NULL
    ON CONFLICT ("capacityId", "cliDeviceId", "endpointSlug") DO UPDATE SET
      "managerId" = EXCLUDED."managerId", "connectionGeneration" = EXCLUDED."connectionGeneration",
      version = EXCLUDED.version, pending = true, retired = false, "retryAfter" = clock_timestamp()
    WHERE cache_affinity_observer."connectionGeneration" <= EXCLUDED."connectionGeneration"
    RETURNING "capacityId", "cliDeviceId", "endpointSlug", version`);
}

export async function acknowledgeAffinityObservations(rows: readonly Observation[]) {
  if (!rows.length) return;
  await queryAffinityResidency(Prisma.sql`
    UPDATE cache_affinity_observer o SET pending = false, retired = false,
      "validUntil" = clock_timestamp() + interval '2 seconds'
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      r("capacityId" text, "cliDeviceId" text, "endpointSlug" text, version text)
    WHERE (o."capacityId", o."cliDeviceId", o."endpointSlug", o.version) =
      (r."capacityId", r."cliDeviceId", r."endpointSlug", r.version)
    RETURNING o."capacityId"`);
}

/** Registration is a conservative boundary for every alias of the physical cache. */
export async function registerAffinityObservers(args: Parameters<typeof observeAffinityReset>[0]) {
  const rows = await observeAffinityReset(args);
  await resetAffinityForCapacities([...new Set(rows.map((row) => row.capacityId))]);
  await acknowledgeAffinityObservations(rows);
}

/** Never revive expired confidence without first advancing physical generation. */
export async function discoverAffinityObservers(
  managerId: string,
  activeDevices: readonly string[],
  pendingEndpoints: readonly string[],
) {
  if (!activeDevices.length) return;
  const missing = await queryAffinityResidency<
    Array<{ cliDeviceId: string; slug: string; connectionGeneration: number }>
  >(Prisma.sql`
    SELECT DISTINCT e."cliDeviceId", e.slug, d."connectionGeneration"
    FROM cli_device d JOIN endpoint e ON e."cliDeviceId" = d.id
    JOIN discovered_model m ON m."endpointId" = e.id
    JOIN execution_target t ON t."discoveredModelId" = m.id
    LEFT JOIN cache_affinity_observer o ON o."capacityId" = t."inferenceCapacityId"
      AND o."cliDeviceId" = d.id AND o."endpointSlug" = e.slug
    WHERE d.id = ANY(${[...activeDevices]}::text[]) AND d.status = 'CONNECTED'
      AND t."inferenceCapacityId" IS NOT NULL
      AND NOT (d.id || chr(1) || e.slug = ANY(${[...pendingEndpoints]}::text[]))
      AND (o."capacityId" IS NULL OR o."connectionGeneration" < d."connectionGeneration"
        OR (o."managerId" = ${managerId} AND o.retired))
    LIMIT 1`);
  for (const row of missing) {
    await registerAffinityObservers({
      cliDeviceId: row.cliDeviceId,
      slugs: [row.slug],
      connectionGeneration: row.connectionGeneration,
      managerId,
    });
  }
}

/** Lease renewal never waits for physical-authority recovery or graph discovery. */
export async function renewAffinityObservers(
  managerId: string,
  activeDevices: readonly string[],
  pendingEndpoints: readonly string[],
) {
  if (!activeDevices.length) return;
  await queryAffinityResidency(Prisma.sql`
    UPDATE cache_affinity_observer o SET "validUntil" = clock_timestamp() + interval '2 seconds'
    WHERE o.ctid = ANY(ARRAY(SELECT o.ctid FROM cache_affinity_observer o
      WHERE o."managerId" = ${managerId} AND NOT o.pending AND NOT o.retired
      AND o."validUntil" > clock_timestamp()
      AND o."cliDeviceId" = ANY(${[...activeDevices]}::text[])
      AND NOT (o."cliDeviceId" || chr(1) || o."endpointSlug" = ANY(${[...pendingEndpoints]}::text[]))
      AND EXISTS (SELECT 1 FROM cli_device d WHERE d.id = o."cliDeviceId"
        AND d."connectionGeneration" = o."connectionGeneration" AND d.status = 'CONNECTED')
      ORDER BY o."validUntil" LIMIT 4096 FOR UPDATE SKIP LOCKED))
    RETURNING o."capacityId"`);
}

/** Any replica can retire uncertainty after a durable physical fence, even after a crash. */
export async function recoverAffinityObservers() {
  const rows = await queryAffinityResidency<Array<Observation & { expired: boolean }>>(Prisma.sql`
    UPDATE cache_affinity_observer SET "retryAfter" = clock_timestamp() + interval '2 seconds'
    WHERE ctid = ANY(ARRAY(SELECT ctid FROM cache_affinity_observer
      WHERE NOT retired AND "retryAfter" <= clock_timestamp()
        AND (pending OR "validUntil" <= clock_timestamp())
      ORDER BY "retryAfter", "capacityId", "cliDeviceId", "endpointSlug" LIMIT 4 FOR UPDATE SKIP LOCKED))
    RETURNING "capacityId", "cliDeviceId", "endpointSlug", version,
      "validUntil" <= clock_timestamp() AS expired`);
  for (const row of rows) {
    try {
      await resetAffinityForCapacities([row.capacityId]);
      await queryAffinityResidency(Prisma.sql`
        UPDATE cache_affinity_observer SET pending = false,
          retired = ${row.expired} OR "validUntil" <= clock_timestamp()
        WHERE ("capacityId", "cliDeviceId", "endpointSlug", version) =
          (${row.capacityId}, ${row.cliDeviceId}, ${row.endpointSlug}, ${row.version})
        RETURNING "capacityId"`);
    } catch {
      // Expiry/pending remains visible to every reader, irrespective of this worker.
    }
  }
}
