import type { PrismaClient } from "../prisma/generated/client";

/**
 * Batched requester rollup detach matching `detach_usage_rollup_requester` in
 * schema-hardening.sql (minute before hour, sentinel `''`, owner FK preserved).
 */
export async function drainRequesterUsageRollupsBatch(
  db: Pick<PrismaClient, "$queryRaw">,
  requesterUserId: string,
  limit: number,
): Promise<number> {
  const batch = Math.max(1, Math.trunc(limit));
  const minuteRows = (await db.$queryRaw`
    WITH moved AS (
      DELETE FROM usage_rollup_minute
       WHERE ctid IN (
         SELECT ctid FROM usage_rollup_minute
          WHERE "requesterUserId" = ${requesterUserId}
          LIMIT ${batch}
            FOR UPDATE SKIP LOCKED)
       RETURNING *
    ),
    ins AS (
    INSERT INTO usage_rollup_minute AS target (
      "bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", source, "updatedAt", "requests", "successes", "errors", "cancels", "retries", "usageKnownRequests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheKnownRequests", "cacheKnownInputTokens", "durationCount", "durationSumMs", "ttftCount", "ttftSumMs",
      "latencyHistogram", "ttftHistogram"
    )
    SELECT "bucketStart", "ownerUserId", '', "poolId", "poolMemberId",
      "executionTargetId", source, now(), "requests", "successes", "errors", "cancels", "retries", "usageKnownRequests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheKnownRequests", "cacheKnownInputTokens", "durationCount", "durationSumMs", "ttftCount", "ttftSumMs",
      "latencyHistogram", "ttftHistogram"
      FROM moved
     WHERE "ownerUserId" <> ${requesterUserId}
     ORDER BY "bucketStart", "ownerUserId" COLLATE "C", "poolId" COLLATE "C",
       "poolMemberId" COLLATE "C", "executionTargetId" COLLATE "C", source::text COLLATE "C"
    ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", source)
    DO UPDATE SET
        "requests" = target."requests" + EXCLUDED."requests",
        "successes" = target."successes" + EXCLUDED."successes",
        "errors" = target."errors" + EXCLUDED."errors",
        "cancels" = target."cancels" + EXCLUDED."cancels",
        "retries" = target."retries" + EXCLUDED."retries",
        "usageKnownRequests" = target."usageKnownRequests" + EXCLUDED."usageKnownRequests",
        "inputTokens" = target."inputTokens" + EXCLUDED."inputTokens",
        "outputTokens" = target."outputTokens" + EXCLUDED."outputTokens",
        "cacheReadTokens" = target."cacheReadTokens" + EXCLUDED."cacheReadTokens",
        "cacheWriteTokens" = target."cacheWriteTokens" + EXCLUDED."cacheWriteTokens",
        "cacheKnownRequests" = target."cacheKnownRequests" + EXCLUDED."cacheKnownRequests",
        "cacheKnownInputTokens" = target."cacheKnownInputTokens" + EXCLUDED."cacheKnownInputTokens",
        "durationCount" = target."durationCount" + EXCLUDED."durationCount",
        "durationSumMs" = target."durationSumMs" + EXCLUDED."durationSumMs",
        "ttftCount" = target."ttftCount" + EXCLUDED."ttftCount",
        "ttftSumMs" = target."ttftSumMs" + EXCLUDED."ttftSumMs",
        "latencyHistogram" = ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(target."latencyHistogram", EXCLUDED."latencyHistogram") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i),
        "ttftHistogram" = ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(target."ttftHistogram", EXCLUDED."ttftHistogram") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i),
        "updatedAt" = now()
    )
    SELECT count(*)::bigint AS deleted FROM moved`) as [{ deleted: bigint }];

  const hourRows = (await db.$queryRaw`
    WITH moved AS (
      DELETE FROM usage_rollup_hour
       WHERE ctid IN (
         SELECT ctid FROM usage_rollup_hour
          WHERE "requesterUserId" = ${requesterUserId}
          LIMIT ${batch}
            FOR UPDATE SKIP LOCKED)
       RETURNING *
    ),
    ins AS (
    INSERT INTO usage_rollup_hour AS target (
      "bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", source, "updatedAt", "requests", "successes", "errors", "cancels", "retries", "usageKnownRequests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheKnownRequests", "cacheKnownInputTokens", "durationCount", "durationSumMs", "ttftCount", "ttftSumMs",
      "latencyHistogram", "ttftHistogram"
    )
    SELECT "bucketStart", "ownerUserId", '', "poolId", "poolMemberId",
      "executionTargetId", source, now(), "requests", "successes", "errors", "cancels", "retries", "usageKnownRequests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheKnownRequests", "cacheKnownInputTokens", "durationCount", "durationSumMs", "ttftCount", "ttftSumMs",
      "latencyHistogram", "ttftHistogram"
      FROM moved
     WHERE "ownerUserId" <> ${requesterUserId}
     ORDER BY "bucketStart", "ownerUserId" COLLATE "C", "poolId" COLLATE "C",
       "poolMemberId" COLLATE "C", "executionTargetId" COLLATE "C", source::text COLLATE "C"
    ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", source)
    DO UPDATE SET
        "requests" = target."requests" + EXCLUDED."requests",
        "successes" = target."successes" + EXCLUDED."successes",
        "errors" = target."errors" + EXCLUDED."errors",
        "cancels" = target."cancels" + EXCLUDED."cancels",
        "retries" = target."retries" + EXCLUDED."retries",
        "usageKnownRequests" = target."usageKnownRequests" + EXCLUDED."usageKnownRequests",
        "inputTokens" = target."inputTokens" + EXCLUDED."inputTokens",
        "outputTokens" = target."outputTokens" + EXCLUDED."outputTokens",
        "cacheReadTokens" = target."cacheReadTokens" + EXCLUDED."cacheReadTokens",
        "cacheWriteTokens" = target."cacheWriteTokens" + EXCLUDED."cacheWriteTokens",
        "cacheKnownRequests" = target."cacheKnownRequests" + EXCLUDED."cacheKnownRequests",
        "cacheKnownInputTokens" = target."cacheKnownInputTokens" + EXCLUDED."cacheKnownInputTokens",
        "durationCount" = target."durationCount" + EXCLUDED."durationCount",
        "durationSumMs" = target."durationSumMs" + EXCLUDED."durationSumMs",
        "ttftCount" = target."ttftCount" + EXCLUDED."ttftCount",
        "ttftSumMs" = target."ttftSumMs" + EXCLUDED."ttftSumMs",
        "latencyHistogram" = ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(target."latencyHistogram", EXCLUDED."latencyHistogram") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i),
        "ttftHistogram" = ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(target."ttftHistogram", EXCLUDED."ttftHistogram") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i),
        "updatedAt" = now()
    )
    SELECT count(*)::bigint AS deleted FROM moved`) as [{ deleted: bigint }];

  return Number(minuteRows[0]?.deleted ?? 0) + Number(hourRows[0]?.deleted ?? 0);
}
