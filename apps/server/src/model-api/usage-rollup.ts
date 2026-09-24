/**
 * Exactly-once usage rollup increments for dashboard metrics.
 *
 * Invariant: a RelayRequest contributes to `usage_rollup_minute` exactly once,
 * in the SAME transaction as its PENDING -> SUCCEEDED/FAILED/CANCELED
 * transition, and only when that transaction performed the transition. The
 * status guard (`status = PENDING`) is the claim: a duplicate finalization,
 * a retry, or crash repair racing a normal completion observes a non-PENDING
 * row (row lock + re-check under READ COMMITTED) and writes nothing. A crash
 * before commit rolls back both the transition and the increment, and the
 * request stays PENDING for crash repair, which uses the same helper.
 *
 * Prompt-free: only ids, enum source, counts, token integers and timings.
 */

import {
  addHistograms,
  emptyLatencyHistogram,
  latencyBucketIndex,
} from "@ws-model-proxy/config/usage-metrics";
import { Prisma } from "@ws-model-proxy/db";

export const relayRollupSelect = {
  id: true,
  userId: true,
  status: true,
  source: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  firstClientByteAt: true,
  requestedModelPoolId: true,
  selectedPoolMemberId: true,
  requestedExecutionTargetId: true,
  selectedExecutionTargetId: true,
  attemptCount: true,
  promptTokens: true,
  completionTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  usageKnown: true,
  // Resource owners, for the rollup's owner key (see resourceOwnerUserId).
  RequestedModelPool: { select: { userId: true } },
  SelectedExecutionTarget: { select: { userId: true } },
  RequestedExecutionTarget: { select: { userId: true } },
} satisfies Prisma.RelayRequestSelect;

export type RelayRollupRow = Prisma.RelayRequestGetPayload<{ select: typeof relayRollupSelect }>;

export type RelayRequestSourceValue = RelayRollupRow["source"];

/**
 * Rollup key. Two user columns:
 *  - `ownerUserId`: the RESOURCE owner - the requested pool's owner for pool
 *    traffic, else the execution target's owner for direct traffic, else
 *    (nothing resolved) the requester. Owners see every requester's traffic
 *    on what they own. FK to user, ON DELETE CASCADE: deleting the owner
 *    removes the history of their resources.
 *  - `requesterUserId`: the RelayRequest owner (API token / chat-test /
 *    MCP user). Not a foreign key: when the requester is deleted, a database
 *    trigger merges their rows into the '' sentinel requester, so owners keep
 *    the traffic in their history (schema-hardening.sql,
 *    usage_rollup_detach_requester). Grantees read only rows where they are
 *    the requester of a pool they do not own.
 */
export type UsageRollupKey = {
  bucketStart: Date;
  ownerUserId: string;
  requesterUserId: string;
  poolId: string;
  poolMemberId: string;
  executionTargetId: string;
  source: RelayRequestSourceValue;
};

export type UsageRollupCounters = {
  requests: number;
  successes: number;
  errors: number;
  cancels: number;
  retries: number;
  usageKnownRequests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  cacheKnownRequests: number;
  cacheKnownInputTokens: bigint;
  durationCount: number;
  durationSumMs: bigint;
  latencyHistogram: number[];
  ttftCount: number;
  ttftSumMs: bigint;
  ttftHistogram: number[];
};

export type UsageRollupIncrement = UsageRollupKey & UsageRollupCounters;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function truncateToMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function truncateToHour(value: Date): Date {
  return new Date(Math.floor(value.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Builds the single increment for one terminal request row, or null when the
 * row is not terminal (defensive: callers only pass rows they transitioned).
 * Optional identities map to the '' sentinel so the composite key merges.
 */
export function rollupIncrementForRequest(
  row: RelayRollupRow,
  now: Date = new Date(),
): UsageRollupIncrement | null {
  if (row.status !== "SUCCEEDED" && row.status !== "FAILED" && row.status !== "CANCELED")
    return null;
  const completedAt = row.completedAt ?? now;
  // Only measured durations feed latency: crash repair and the abandoned
  // reaper leave durationMs null because the real end time is unknown.
  const durationMs = row.durationMs;
  const ttftMs =
    row.firstClientByteAt === null
      ? null
      : Math.max(0, row.firstClientByteAt.getTime() - row.startedAt.getTime());
  const latencyHistogram = emptyLatencyHistogram();
  if (durationMs !== null) latencyHistogram[latencyBucketIndex(durationMs)]! += 1;
  const ttftHistogram = emptyLatencyHistogram();
  if (ttftMs !== null) ttftHistogram[latencyBucketIndex(ttftMs)]! += 1;
  const cacheKnown = row.usageKnown && row.cacheReadTokens !== null;
  return {
    bucketStart: truncateToMinute(completedAt),
    ownerUserId: resourceOwnerUserId(row),
    requesterUserId: row.userId,
    poolId: row.requestedModelPoolId ?? "",
    poolMemberId: row.selectedPoolMemberId ?? "",
    executionTargetId: row.selectedExecutionTargetId ?? row.requestedExecutionTargetId ?? "",
    source: row.source,
    requests: 1,
    successes: row.status === "SUCCEEDED" ? 1 : 0,
    errors: row.status === "FAILED" ? 1 : 0,
    cancels: row.status === "CANCELED" ? 1 : 0,
    retries: Math.max(0, row.attemptCount - 1),
    usageKnownRequests: row.usageKnown ? 1 : 0,
    inputTokens: BigInt(row.usageKnown ? (row.promptTokens ?? 0) : 0),
    outputTokens: BigInt(row.usageKnown ? (row.completionTokens ?? 0) : 0),
    cacheReadTokens: BigInt(cacheKnown ? (row.cacheReadTokens ?? 0) : 0),
    cacheWriteTokens: BigInt(row.usageKnown ? (row.cacheWriteTokens ?? 0) : 0),
    cacheKnownRequests: cacheKnown ? 1 : 0,
    cacheKnownInputTokens: BigInt(cacheKnown ? (row.promptTokens ?? 0) : 0),
    durationCount: durationMs === null ? 0 : 1,
    durationSumMs: BigInt(durationMs ?? 0),
    latencyHistogram,
    ttftCount: ttftMs === null ? 0 : 1,
    ttftSumMs: BigInt(ttftMs ?? 0),
    ttftHistogram,
  };
}

/** See UsageRollupKey: pool owner, else target owner, else the requester. */
export function resourceOwnerUserId(row: RelayRollupRow): string {
  if (row.requestedModelPoolId && row.RequestedModelPool) return row.RequestedModelPool.userId;
  if (!row.requestedModelPoolId) {
    const target = row.selectedExecutionTargetId
      ? row.SelectedExecutionTarget
      : row.requestedExecutionTargetId
        ? row.RequestedExecutionTarget
        : null;
    if (target) return target.userId;
  }
  return row.userId;
}

export function rollupKeyString(key: UsageRollupKey): string {
  return [
    key.bucketStart.toISOString(),
    key.ownerUserId,
    key.requesterUserId,
    key.poolId,
    key.poolMemberId,
    key.executionTargetId,
    key.source,
  ].join("\u0000");
}

export function addRollupCounters<T extends UsageRollupCounters>(
  target: T,
  add: UsageRollupCounters,
): T {
  target.requests += add.requests;
  target.successes += add.successes;
  target.errors += add.errors;
  target.cancels += add.cancels;
  target.retries += add.retries;
  target.usageKnownRequests += add.usageKnownRequests;
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cacheReadTokens += add.cacheReadTokens;
  target.cacheWriteTokens += add.cacheWriteTokens;
  target.cacheKnownRequests += add.cacheKnownRequests;
  target.cacheKnownInputTokens += add.cacheKnownInputTokens;
  target.durationCount += add.durationCount;
  target.durationSumMs += add.durationSumMs;
  target.latencyHistogram = addHistograms(target.latencyHistogram, add.latencyHistogram);
  target.ttftCount += add.ttftCount;
  target.ttftSumMs += add.ttftSumMs;
  target.ttftHistogram = addHistograms(target.ttftHistogram, add.ttftHistogram);
  return target;
}

/**
 * Groups increments by composite key. A single INSERT ... ON CONFLICT cannot
 * touch the same target row twice, and one statement per key keeps the
 * write count bounded by distinct keys rather than requests.
 */
export function mergeRollupIncrements(
  increments: readonly UsageRollupIncrement[],
): UsageRollupIncrement[] {
  const merged = new Map<string, UsageRollupIncrement>();
  for (const increment of increments) {
    const key = rollupKeyString(increment);
    const existing = merged.get(key);
    if (existing) addRollupCounters(existing, increment);
    else
      merged.set(key, {
        ...increment,
        latencyHistogram: [...increment.latencyHistogram],
        ttftHistogram: [...increment.ttftHistogram],
      });
  }
  return [...merged.values()];
}

export type UsageRollupTable = "usage_rollup_minute" | "usage_rollup_hour";

type RawExecutor = Pick<Prisma.TransactionClient, "$executeRaw">;

function histogramMerge(table: UsageRollupTable, column: string): Prisma.Sql {
  // Element-wise sum; unnest pads the shorter array with NULLs.
  return Prisma.raw(
    `ARRAY(SELECT COALESCE(h.a, 0) + COALESCE(h.b, 0) FROM unnest(${table}."${column}", EXCLUDED."${column}") WITH ORDINALITY AS h(a, b, i) ORDER BY h.i)`,
  );
}

function additive(table: UsageRollupTable, column: string): Prisma.Sql {
  return Prisma.raw(`"${column}" = ${table}."${column}" + EXCLUDED."${column}"`);
}

const ADDITIVE_COLUMNS = [
  "requests",
  "successes",
  "errors",
  "cancels",
  "retries",
  "usageKnownRequests",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheKnownRequests",
  "cacheKnownInputTokens",
  "durationCount",
  "durationSumMs",
  "ttftCount",
  "ttftSumMs",
] as const;

/** One idempotent-per-call additive upsert for a merged increment. */
export function rollupUpsertSql(
  table: UsageRollupTable,
  increment: UsageRollupIncrement,
): Prisma.Sql {
  const tableSql = Prisma.raw(table);
  const updates = Prisma.join(
    [
      ...ADDITIVE_COLUMNS.map((column) => additive(table, column)),
      Prisma.sql`"latencyHistogram" = ${histogramMerge(table, "latencyHistogram")}`,
      Prisma.sql`"ttftHistogram" = ${histogramMerge(table, "ttftHistogram")}`,
      Prisma.raw(`"updatedAt" = now()`),
    ],
    ", ",
  );
  return Prisma.sql`
    INSERT INTO ${tableSql} (
      "bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", "source", "updatedAt",
      "requests", "successes", "errors", "cancels", "retries", "usageKnownRequests",
      "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
      "cacheKnownRequests", "cacheKnownInputTokens", "durationCount", "durationSumMs",
      "latencyHistogram", "ttftCount", "ttftSumMs", "ttftHistogram"
    ) VALUES (
      ${increment.bucketStart}, ${increment.ownerUserId}, ${increment.requesterUserId},
      ${increment.poolId}, ${increment.poolMemberId},
      ${increment.executionTargetId}, ${increment.source}::"RelayRequestSource", now(),
      ${increment.requests}, ${increment.successes}, ${increment.errors}, ${increment.cancels},
      ${increment.retries}, ${increment.usageKnownRequests},
      ${increment.inputTokens}, ${increment.outputTokens}, ${increment.cacheReadTokens},
      ${increment.cacheWriteTokens}, ${increment.cacheKnownRequests},
      ${increment.cacheKnownInputTokens}, ${increment.durationCount}, ${increment.durationSumMs},
      ${increment.latencyHistogram}::integer[], ${increment.ttftCount}, ${increment.ttftSumMs},
      ${increment.ttftHistogram}::integer[]
    )
    ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId",
      "executionTargetId", "source")
    DO UPDATE SET ${updates}`;
}

export async function writeRollupIncrements(
  tx: RawExecutor,
  table: UsageRollupTable,
  increments: readonly UsageRollupIncrement[],
): Promise<number> {
  const merged = mergeRollupIncrements(increments);
  // Deterministic key order gives concurrent writers one lock order.
  // Code-point comparison (not localeCompare): independent of ICU/collation,
  // so every replica derives the same order.
  merged.sort((left, right) => {
    const a = rollupKeyString(left);
    const b = rollupKeyString(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const increment of merged) await tx.$executeRaw(rollupUpsertSql(table, increment));
  return merged.length;
}

/** Records the minute rollup for rows this transaction just transitioned. */
export async function recordRelayRequestRollups(
  tx: RawExecutor,
  rows: readonly RelayRollupRow[],
  now: Date = new Date(),
): Promise<number> {
  const increments = rows
    .map((row) => rollupIncrementForRequest(row, now))
    .filter((increment): increment is UsageRollupIncrement => increment !== null);
  if (increments.length === 0) return 0;
  return writeRollupIncrements(tx, "usage_rollup_minute", increments);
}

type TransitionedRowsClient = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  relayRequest: Pick<Prisma.TransactionClient["relayRequest"], "findMany">;
};

/**
 * For callers that transition with a status-guarded `updateMany`
 * (crash repair, abandoned-request reaper): record rollups for exactly the
 * ids whose guarded transition this transaction performed. The caller MUST
 * pass only ids whose `updateMany` reported count 1 in this transaction; the
 * row lock taken by that update keeps the read consistent.
 */
export async function recordRollupsForTransitionedRequests(
  tx: TransitionedRowsClient,
  relayRequestIds: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (relayRequestIds.length === 0) return 0;
  const rows =
    (await tx.relayRequest.findMany({
      where: { id: { in: [...relayRequestIds] }, status: { not: "PENDING" } },
      select: relayRollupSelect,
    })) ?? [];
  return recordRelayRequestRollups(tx, rows.filter(isRollupRow), now);
}

type TerminalTransitionClient = Pick<Prisma.TransactionClient, "$executeRaw"> & {
  relayRequest: Pick<Prisma.TransactionClient["relayRequest"], "update">;
};

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/**
 * THE terminal transition for a RelayRequest. Applies `data` only while the
 * row is still PENDING and, when it did, records the rollup increment in the
 * same transaction. Returns false when another finalizer already won.
 *
 * Callers must run this inside `prisma.$transaction` so the transition and
 * the increment commit or roll back together.
 */
export async function transitionRelayRequestTerminal(
  tx: TerminalTransitionClient,
  relayRequestId: string,
  data: Prisma.RelayRequestUncheckedUpdateInput & {
    status: "SUCCEEDED" | "FAILED" | "CANCELED";
  },
  now: Date = new Date(),
): Promise<boolean> {
  let row: RelayRollupRow;
  try {
    row = await tx.relayRequest.update({
      where: { id: relayRequestId, status: "PENDING" },
      data,
      select: relayRollupSelect,
    });
  } catch (error) {
    if (isRecordNotFound(error)) return false;
    throw error;
  }
  await recordRelayRequestRollups(tx, isRollupRow(row) ? [row] : [], now);
  return true;
}

/**
 * Guards against partial selections (e.g. a client extension or mocked
 * delegate returning only `{ id }`): a row without the rollup facts is never
 * guessed into a counter.
 */
function isRollupRow(row: Partial<RelayRollupRow> | null | undefined): row is RelayRollupRow {
  return (
    !!row &&
    typeof row.userId === "string" &&
    typeof row.status === "string" &&
    typeof row.source === "string" &&
    row.startedAt instanceof Date &&
    typeof row.attemptCount === "number"
  );
}
