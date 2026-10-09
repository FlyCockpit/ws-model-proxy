import type { PrismaClient } from "../prisma/generated/client";

/** The rollup key after `bucketStart`, `ownerUserId` and `requesterUserId` (sorted merge order). */
export const USAGE_ROLLUP_DIMENSIONS = [
  "poolId",
  "runtimeId",
  "versionId",
  "nodeId",
  "instanceId",
  "runtimeModelId",
  "providerModelId",
] as const;

/** Additive counters of a rollup row. */
export const USAGE_ROLLUP_COUNTERS = [
  "requests",
  "successes",
  "errors",
  "cancels",
  "retries",
  "cloudRequests",
  "rejectedCapacity",
  "rejectedContext",
  "rejectedSpend",
  "rejectedOther",
  "usageKnownRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheKnownRequests",
  "cacheKnownInputTokens",
  "continuationRequests",
  "continuationInputTokens",
  "continuationCacheReadTokens",
  "durationCount",
  "durationSumMs",
  "ttftCount",
  "ttftSumMs",
  "queueWaitCount",
  "queueWaitSumMs",
  "generationTokens",
  "generationMs",
  "prefillTokens",
  "prefillMs",
  "audioInputMs",
] as const;

/** Fixed-bound histograms, added bucket by bucket. */
export const USAGE_ROLLUP_HISTOGRAMS = [
  "latencyHistogram",
  "ttftHistogram",
  "queueWaitHistogram",
] as const;

const quoted = (columns: readonly string[]) => columns.map((column) => `"${column}"`).join(", ");

function mergeSql(table: "usage_rollup_minute" | "usage_rollup_hour"): string {
  const dimensions = quoted(USAGE_ROLLUP_DIMENSIONS);
  const counters = quoted(USAGE_ROLLUP_COUNTERS);
  const histograms = quoted(USAGE_ROLLUP_HISTOGRAMS);
  const sums = USAGE_ROLLUP_COUNTERS.map(
    (column) => `"${column}" = target."${column}" + EXCLUDED."${column}"`,
  );
  const histogramSums = USAGE_ROLLUP_HISTOGRAMS.map(
    (column) =>
      `"${column}" = ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(target."${column}", EXCLUDED."${column}") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i)`,
  );
  const order = USAGE_ROLLUP_DIMENSIONS.map((column) => `"${column}" COLLATE "C"`).join(", ");
  return `
    INSERT INTO ${table} AS target (
      "bucketStart", "ownerUserId", "requesterUserId", ${dimensions}, source, "updatedAt",
      ${counters}, ${histograms})
    SELECT "bucketStart", "ownerUserId", '', ${dimensions}, source, now(),
      ${counters}, ${histograms}
      FROM moved
     WHERE "ownerUserId" <> $1
     ORDER BY "bucketStart", "ownerUserId" COLLATE "C", ${order}, source::text COLLATE "C"
    ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", ${dimensions}, source)
    DO UPDATE SET ${[...sums, ...histogramSums, `"updatedAt" = now()`].join(",\n      ")}`;
}

const MINUTE_MERGE = mergeSql("usage_rollup_minute");
const HOUR_MERGE = mergeSql("usage_rollup_hour");

async function drainTable(
  db: Pick<PrismaClient, "$queryRawUnsafe">,
  table: "usage_rollup_minute" | "usage_rollup_hour",
  merge: string,
  requesterUserId: string,
  batch: number,
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ deleted: bigint }>>(
    `WITH moved AS (
       DELETE FROM ${table}
        WHERE ctid IN (
          SELECT ctid FROM ${table}
           WHERE "requesterUserId" = $1
           LIMIT $2
             FOR UPDATE SKIP LOCKED)
        RETURNING *
     ),
     ins AS (${merge})
     SELECT count(*)::bigint AS deleted FROM moved`,
    requesterUserId,
    batch,
  );
  return Number(rows[0]?.deleted ?? 0);
}

/**
 * Batched requester rollup merge: moves a deleted requester's rows onto the sentinel
 * requester `''` (minute before hour), keeping each owner's totals. Runs in the user drain
 * and the deleted-user purge (./parent-deletion.ts, ./hot-path-sweeps.ts); rollups carry no
 * foreign key (DL-1 writer class H), so nothing merges them at the user delete itself.
 * Upserts go in rollup key order so concurrent merges cannot deadlock. The SQL text is built
 * only from the column constants above; the ids are bound parameters.
 */
export async function drainRequesterUsageRollupsBatch(
  db: Pick<PrismaClient, "$queryRawUnsafe">,
  requesterUserId: string,
  limit: number,
): Promise<number> {
  const batch = Math.max(1, Math.trunc(limit));
  const minute = await drainTable(db, "usage_rollup_minute", MINUTE_MERGE, requesterUserId, batch);
  const hour = await drainTable(db, "usage_rollup_hour", HOUR_MERGE, requesterUserId, batch);
  return minute + hour;
}
