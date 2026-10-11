import { randomUUID } from "node:crypto";
import { Prisma } from "@ws-model-proxy/db";
import { resetAffinityForCapacities } from "./cache-affinity-generation.js";
import { queryAffinityResidency } from "./cache-affinity-residency.js";

// Observer leases last two seconds on the database clock (`interval '2 seconds'` below): a
// confidence bound independent of observer process survival. capacityId = the runtime
// instance; a node names it by its handle.
type Observation = {
  capacityId: string;
  nodeId: string;
  instanceHandle: string;
  version: string;
};

/** Instances whose head is `node` (the always-on runtime's node, or a held rank 0). */
function headedByNodeSql(node: Prisma.Sql, instance: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(EXISTS (SELECT 1 FROM runtime r WHERE r.id = ${instance}."runtimeId" AND r."nodeId" = ${node}.id)
    OR EXISTS (SELECT 1 FROM instance_rank k WHERE k."instanceId" = ${instance}.id
      AND k."nodeId" = ${node}.id AND k.rank = 0 AND k.claim = 'HELD'))`;
}

/** Pending receipt commits before attempting the independently contended authority. */
export async function observeAffinityReset({
  nodeId,
  handles,
  connectionGeneration,
  managerId,
}: {
  nodeId: string;
  handles: readonly string[];
  connectionGeneration: number;
  managerId: string;
}): Promise<Observation[]> {
  if (!handles.length) return [];
  return queryAffinityResidency<Observation[]>(Prisma.sql`
    INSERT INTO cache_affinity_observer
      ("capacityId", "nodeId", "instanceHandle", "userId", "managerId",
       "connectionGeneration", version, "validUntil", pending, retired)
    SELECT DISTINCT i.id, n.id, i.handle, i."userId", ${managerId},
      ${connectionGeneration}::integer, ${randomUUID()}, clock_timestamp() + interval '2 seconds', true, false
    FROM node n JOIN runtime_instance i ON i."userId" = n."userId"
    WHERE n.id = ${nodeId} AND i.handle = ANY(${[...handles]}::text[])
      AND n."connectionGeneration" = ${connectionGeneration}
      AND ${headedByNodeSql(Prisma.sql`n`, Prisma.sql`i`)}
    ON CONFLICT ("capacityId", "nodeId", "instanceHandle") DO UPDATE SET
      "managerId" = EXCLUDED."managerId", "connectionGeneration" = EXCLUDED."connectionGeneration",
      version = EXCLUDED.version, pending = true, retired = false, "retryAfter" = clock_timestamp()
    WHERE cache_affinity_observer."connectionGeneration" <= EXCLUDED."connectionGeneration"
    RETURNING "capacityId", "nodeId", "instanceHandle", version`);
}

export async function acknowledgeAffinityObservations(rows: readonly Observation[]) {
  if (!rows.length) return;
  await queryAffinityResidency(Prisma.sql`
    UPDATE cache_affinity_observer o SET pending = false, retired = false,
      "validUntil" = clock_timestamp() + interval '2 seconds'
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      r("capacityId" text, "nodeId" text, "instanceHandle" text, version text)
    WHERE (o."capacityId", o."nodeId", o."instanceHandle", o.version) =
      (r."capacityId", r."nodeId", r."instanceHandle", r.version)
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
  activeNodes: readonly string[],
  pendingInstances: readonly string[],
) {
  if (!activeNodes.length) return;
  const missing = await queryAffinityResidency<
    Array<{ nodeId: string; handle: string; connectionGeneration: number }>
  >(Prisma.sql`
    SELECT DISTINCT n.id AS "nodeId", i.handle, n."connectionGeneration"
    FROM node n JOIN runtime_instance i ON i."userId" = n."userId"
    LEFT JOIN cache_affinity_observer o ON o."capacityId" = i.id
      AND o."nodeId" = n.id AND o."instanceHandle" = i.handle
    WHERE n.id = ANY(${[...activeNodes]}::text[]) AND n.connection = 'ONLINE'
      AND ${headedByNodeSql(Prisma.sql`n`, Prisma.sql`i`)}
      AND NOT (n.id || chr(1) || i.handle = ANY(${[...pendingInstances]}::text[]))
      AND (o."capacityId" IS NULL OR o."connectionGeneration" < n."connectionGeneration"
        OR (o."managerId" = ${managerId} AND o.retired))
    LIMIT 1`);
  for (const row of missing) {
    await registerAffinityObservers({
      nodeId: row.nodeId,
      handles: [row.handle],
      connectionGeneration: row.connectionGeneration,
      managerId,
    });
  }
}

/** Lease renewal never waits for physical-authority recovery or graph discovery. */
export async function renewAffinityObservers(
  managerId: string,
  activeNodes: readonly string[],
  pendingInstances: readonly string[],
) {
  if (!activeNodes.length) return;
  await queryAffinityResidency(Prisma.sql`
    UPDATE cache_affinity_observer o SET "validUntil" = clock_timestamp() + interval '2 seconds'
    WHERE o.ctid = ANY(ARRAY(SELECT o.ctid FROM cache_affinity_observer o
      WHERE o."managerId" = ${managerId} AND NOT o.pending AND NOT o.retired
      AND o."validUntil" > clock_timestamp()
      AND o."nodeId" = ANY(${[...activeNodes]}::text[])
      AND NOT (o."nodeId" || chr(1) || o."instanceHandle" = ANY(${[...pendingInstances]}::text[]))
      AND EXISTS (SELECT 1 FROM node n WHERE n.id = o."nodeId"
        AND n."connectionGeneration" = o."connectionGeneration" AND n.connection = 'ONLINE')
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
      ORDER BY "retryAfter", "capacityId", "nodeId", "instanceHandle" LIMIT 4 FOR UPDATE SKIP LOCKED))
    RETURNING "capacityId", "nodeId", "instanceHandle", version,
      "validUntil" <= clock_timestamp() AS expired`);
  for (const row of rows) {
    try {
      await resetAffinityForCapacities([row.capacityId]);
      await queryAffinityResidency(Prisma.sql`
        UPDATE cache_affinity_observer SET pending = false,
          retired = ${row.expired} OR "validUntil" <= clock_timestamp()
        WHERE ("capacityId", "nodeId", "instanceHandle", version) =
          (${row.capacityId}, ${row.nodeId}, ${row.instanceHandle}, ${row.version})
        RETURNING "capacityId"`);
    } catch {
      // Expiry/pending remains visible to every reader, irrespective of this worker.
    }
  }
}
