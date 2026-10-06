import type prisma from "@ws-model-proxy/db";
import { Prisma } from "@ws-model-proxy/db";
import {
  createStatementBoundedPrismaClient,
  type StatementBoundedPrismaClient,
} from "@ws-model-proxy/db/client-factory";
import { env } from "@ws-model-proxy/env/server";

export const RESIDENCY_REPAIR_PAGE = 256;
type PrismaClient = typeof prisma;
export const RESIDENCY_STATEMENT_MS = 250;
export const RESIDENCY_CHECKOUT_MS = 100;
let owned: StatementBoundedPrismaClient | undefined;
let closed = false;
const pendingResets = new Map<string, number>();
/** Distinct ledger keys held per owner, so one tenant cannot exhaust the ledger. */
const pendingResetKeysByOwner = new Map<string, number>();
const RESET_LEDGER_MAX = 4096;
const RESET_LEDGER_PER_OWNER_MAX = 1024;
/**
 * Only active observations, never retained retries; overflow relinquishes the
 * connection. An owner may hold at most a quarter of the process ledger, so a
 * tenant whose devices keep resetting is refused before others are.
 */
export function beginAffinityReset(cliDeviceId: string, slug: string, ownerUserId: string) {
  const key = `${cliDeviceId}\u0001${slug}`;
  if (!pendingResets.has(key)) {
    if (pendingResets.size >= RESET_LEDGER_MAX) throw new Error("reset observation capacity");
    const ownerKeys = pendingResetKeysByOwner.get(ownerUserId) ?? 0;
    if (ownerKeys >= RESET_LEDGER_PER_OWNER_MAX) throw new Error("reset observation capacity");
    pendingResetKeysByOwner.set(ownerUserId, ownerKeys + 1);
  }
  pendingResets.set(key, (pendingResets.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = pendingResets.get(key) ?? 1;
    if (count > 1) {
      pendingResets.set(key, count - 1);
      return;
    }
    pendingResets.delete(key);
    const ownerKeys = pendingResetKeysByOwner.get(ownerUserId) ?? 1;
    if (ownerKeys <= 1) pendingResetKeysByOwner.delete(ownerUserId);
    else pendingResetKeysByOwner.set(ownerUserId, ownerKeys - 1);
  };
}

/** Aliases of the same physical capacity share the observation fence. */
export function affinityGenerationReadySql(targetId: Prisma.Sql): Prisma.Sql {
  const durable = Prisma.sql`COALESCE(wsmp_affinity_generation_ready(${targetId}), false)`;
  if (!pendingResets.size) return durable;
  return Prisma.sql`${durable} AND NOT EXISTS (
    SELECT 1 FROM execution_target observed
    JOIN discovered_model observed_model ON observed_model.id = observed."discoveredModelId"
    JOIN endpoint observed_endpoint ON observed_endpoint.id = observed_model."endpointId"
    WHERE observed."inferenceCapacityId" = (SELECT "inferenceCapacityId" FROM execution_target WHERE id = ${targetId})
      AND observed_endpoint."cliDeviceId" || chr(1) || observed_endpoint.slug = ANY(${[...pendingResets.keys()]}::text[])
  )`;
}

function client() {
  if (closed) throw new Error("residency client is closed");
  owned ??= createStatementBoundedPrismaClient(env.DATABASE_URL, {
    statementTimeoutMs: RESIDENCY_STATEMENT_MS,
    connectTimeoutMs: RESIDENCY_CHECKOUT_MS,
    applicationName: "wsmp-affinity-residency",
    maxConnections: 2,
    minIdleConnections: 0,
    keepAliveInitialDelayMs: 1000,
  });
  return owned.prisma;
}

export function queryAffinityResidency<T>(
  sql: Prisma.Sql,
  db?: Pick<PrismaClient, "$queryRaw">,
): Promise<T> {
  return (db ?? client()).$queryRaw<T>(sql);
}

/** Capture before dispatch. A read failure disables optional affinity metadata. */
export async function captureAffinityTargetGenerations<T extends { executionTargetId: string }>(
  targets: readonly T[],
  poolId?: string,
): Promise<Array<T & { cacheGeneration: string }>> {
  if (!targets.length) return [];
  try {
    const rows = await queryAffinityResidency<
      Array<{ executionTargetId: string; cacheGeneration: string }>
    >(Prisma.sql`
      SELECT ids.id AS "executionTargetId", CASE WHEN ${affinityGenerationReadySql(Prisma.sql`ids.id`)}
        THEN COALESCE(wsmp_affinity_scope_generation(ids.id, ${poolId ?? null}), '') ELSE 'unknown-observed-reset' END AS "cacheGeneration"
      FROM unnest(${targets.map((t) => t.executionTargetId)}::text[]) ids(id)
      LEFT JOIN cache_affinity_residency b ON b."executionTargetId" = ids.id`);
    const generations = new Map(rows.map((row) => [row.executionTargetId, row.cacheGeneration]));
    return targets.flatMap((target) => {
      const cacheGeneration = generations.get(target.executionTargetId);
      return cacheGeneration === undefined ? [] : [{ ...target, cacheGeneration }];
    });
  } catch {
    return [];
  }
}

export async function reconcileAffinityForCapacities(capacityIds: readonly string[]) {
  if (!capacityIds.length) return;
  await client().$executeRaw`
    INSERT INTO cache_affinity_residency ("executionTargetId", "userId", "cacheGeneration", complete)
    SELECT id, "userId", wsmp_affinity_generation(id), true FROM execution_target
    WHERE "inferenceCapacityId" = ANY(${[...capacityIds]}::text[]) ORDER BY id
    ON CONFLICT ("executionTargetId") DO UPDATE SET
      "cacheGeneration" = EXCLUDED."cacheGeneration", entries = '[]'::jsonb, complete = true,
      revision = cache_affinity_residency.revision + 1,
      "repairEntries" = '[]'::jsonb, "repairCursor" = NULL, "repairAfter" = clock_timestamp()
    WHERE cache_affinity_residency."cacheGeneration" IS DISTINCT FROM EXCLUDED."cacheGeneration"`;
}

/** One durable page, never a history scan on request completion. */
export async function repairAffinityResidencyPage(
  db: Pick<PrismaClient, "$queryRaw" | "$transaction"> = client(),
): Promise<boolean> {
  // Persist the retry delay before attempting the page. A poisoned first bucket
  // cannot monopolize a worker, and a crashed claim becomes eligible again.
  const [claim] = await db.$queryRaw<Array<{ executionTargetId: string; revision: bigint }>>`
    UPDATE cache_affinity_residency SET "repairAfter" = clock_timestamp() + interval '2 seconds'
    WHERE "executionTargetId" = (
      SELECT "executionTargetId" FROM cache_affinity_residency
      WHERE NOT complete AND "repairAfter" <= clock_timestamp()
      ORDER BY "repairAfter", "executionTargetId" LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING "executionTargetId", revision`;
  if (!claim) return false;
  await db.$transaction(
    async (tx) => {
      const [bucket] = await tx.$queryRaw<
        Array<{ userId: string; repairCursor: string | null; cacheGeneration: string }>
      >`
      SELECT "userId", "repairCursor", "cacheGeneration" FROM cache_affinity_residency
      WHERE "executionTargetId" = ${claim.executionTargetId} AND revision = ${claim.revision}
        AND NOT complete FOR UPDATE SKIP LOCKED`;
      if (!bucket) return;
      const [current] = await tx.$queryRaw<Array<{ generation: string }>>`
        SELECT wsmp_affinity_generation(${claim.executionTargetId}) AS generation`;
      if (current?.generation != null && current.generation !== bucket.cacheGeneration) {
        await tx.$executeRaw`UPDATE cache_affinity_residency SET
          "cacheGeneration" = ${current.generation}, entries = '[]'::jsonb, complete = true,
          "repairEntries" = '[]'::jsonb, "repairCursor" = NULL, revision = revision + 1
          WHERE "executionTargetId" = ${claim.executionTargetId}`;
        return;
      }
      const rows = await tx.$queryRaw<
        Array<{ id: string; entry: Prisma.JsonValue; current: boolean }>
      >`
      SELECT id, "cacheGeneration" = wsmp_affinity_scope_generation("executionTargetId", "poolId") AS current,
        jsonb_build_object('id', id, 'expiresAt', "expiresAt", 'sessionId', "sessionId",
        'tokens', "estimatedTokens", 'sharedWithSessionId', "sharedWithSessionId",
        'sharedPrefixTokens', "sharedPrefixTokens", 'cacheGeneration', "cacheGeneration", 'poolId', "poolId") AS entry
      FROM cache_affinity_record
      WHERE "executionTargetId" = ${claim.executionTargetId}
        AND split_part("cacheGeneration", ':pool:', 1) = ${bucket.cacheGeneration}
        AND "prefixDigest" IS NULL AND id > ${bucket.repairCursor ?? ""}
      ORDER BY id LIMIT ${RESIDENCY_REPAIR_PAGE}`;
      const done = rows.length < RESIDENCY_REPAIR_PAGE;
      const entries = JSON.stringify(rows.filter((row) => row.current).map(({ entry }) => entry));
      await tx.$executeRaw`
      UPDATE cache_affinity_residency SET
        entries = CASE WHEN ${done} THEN wsmp_affinity_residency_merge("repairEntries", ${entries}::jsonb, ARRAY[]::text[]) ELSE entries END,
        "repairEntries" = CASE WHEN ${done} THEN '[]'::jsonb ELSE wsmp_affinity_residency_merge("repairEntries", ${entries}::jsonb, ARRAY[]::text[]) END,
        "repairCursor" = ${done ? null : rows.at(-1)!.id}, complete = ${done},
        "repairAfter" = clock_timestamp()
      WHERE "executionTargetId" = ${claim.executionTargetId} AND revision = ${claim.revision}`;
    },
    { maxWait: RESIDENCY_CHECKOUT_MS, timeout: 1500 },
  );
  return true;
}

/** Durable bounded discovery also warms pre-upgrade history without new traffic. */
export async function discoverAffinityResidency(db: Pick<PrismaClient, "$transaction"> = client()) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`INSERT INTO cache_affinity_residency_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
      const [progress] = await tx.$queryRaw<Array<{ cursor: string }>>`
      SELECT cursor FROM cache_affinity_residency_cursor WHERE id = 1 AND "resumeAt" <= clock_timestamp()
      FOR UPDATE SKIP LOCKED`;
      if (!progress) return;
      const targets = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
      SELECT id, "userId" FROM execution_target WHERE id > ${progress.cursor} ORDER BY id LIMIT 32`;
      for (const target of targets)
        await tx.$executeRaw`INSERT INTO cache_affinity_residency ("executionTargetId", "userId", "cacheGeneration")
        VALUES (${target.id}, ${target.userId}, wsmp_affinity_generation(${target.id}))
        ON CONFLICT ("executionTargetId") DO UPDATE SET
          "cacheGeneration" = EXCLUDED."cacheGeneration", entries = '[]'::jsonb,
          complete = cache_affinity_residency."cacheGeneration" IS DISTINCT FROM EXCLUDED."cacheGeneration",
          "repairEntries" = '[]'::jsonb, "repairCursor" = NULL,
          revision = cache_affinity_residency.revision + 1
        WHERE cache_affinity_residency."cacheGeneration" IS DISTINCT FROM EXCLUDED."cacheGeneration"`;
      await tx.$executeRaw`UPDATE cache_affinity_residency_cursor
      SET cursor = ${targets.length === 32 ? targets.at(-1)!.id : ""},
        "resumeAt" = clock_timestamp() + ${targets.length === 32 ? 0 : 60} * interval '1 second'
      WHERE id = 1`;
    },
    { maxWait: RESIDENCY_CHECKOUT_MS, timeout: 1500 },
  );
}

export async function pruneAffinityResidency(db: Pick<PrismaClient, "$executeRaw"> = client()) {
  return db.$executeRaw`
    DELETE FROM cache_affinity_residency WHERE "executionTargetId" IN (
      SELECT b."executionTargetId" FROM cache_affinity_residency b
      WHERE NOT EXISTS (SELECT 1 FROM execution_target t WHERE t.id = b."executionTargetId" AND t."userId" = b."userId")
      LIMIT 64 FOR UPDATE OF b SKIP LOCKED)`;
}

export function startAffinityResidencyRepair() {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await pruneAffinityResidency();
        await discoverAffinityResidency();
      } catch {
        /* A bounded failure is retried next tick. */
      }
      // At most four pages per tick. A busy tenant cannot create an unbounded
      // background loop or prevent shutdown from taking ownership of the pool.
      for (let page = 0; page < 4 && !stopped; page++) {
        try {
          if (!(await repairAffinityResidencyPage())) break;
        } catch {
          break; // The durable claim delay allows a later bucket next tick.
        }
      }
    })().finally(() => {
      running = undefined;
    });
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref?.();
  return async () => {
    stopped = true;
    closed = true;
    clearInterval(timer);
    owned?.quarantine();
    await running;
    await owned?.prisma.$disconnect();
  };
}
