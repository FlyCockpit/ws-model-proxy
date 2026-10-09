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

import { REALTIME_TRANSCRIPTION_OPERATION } from "@ws-model-proxy/api/lib/transcription-profile";
import {
  addHistograms,
  emptyLatencyHistogram,
  latencyBucketIndex,
} from "@ws-model-proxy/config/usage-metrics";
import { Prisma } from "@ws-model-proxy/db";
import {
  USAGE_ROLLUP_COUNTERS,
  USAGE_ROLLUP_DIMENSIONS,
  USAGE_ROLLUP_HISTOGRAMS,
} from "@ws-model-proxy/db/usage-rollup-requester-drain";

export const relayRollupSelect = {
  id: true,
  userId: true,
  route: true,
  external: true,
  rejection: true,
  status: true,
  source: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  firstClientByteAt: true,
  queueWaitMs: true,
  poolId: true,
  runtimeModelId: true,
  selectedTargetId: true,
  selectedInstanceId: true,
  selectedVersionId: true,
  selectedNodeId: true,
  selectedProviderModelId: true,
  attemptCount: true,
  promptTokens: true,
  completionTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  usageKnown: true,
  affinityOutcome: true,
  operation: true,
  audioInputMs: true,
  contextTokenCount: true,
  // Durable resource owner (database-derived at insert; survives pool deletion).
  resourceOwnerUserId: true,
} satisfies Prisma.RelayRequestSelect;

export type RelayRollupRow = Prisma.RelayRequestGetPayload<{ select: typeof relayRollupSelect }>;

export type RelayRequestSourceValue = RelayRollupRow["source"];

/**
 * Rollup key. Two user columns:
 *  - `ownerUserId`: own-key uses the requester (empty pool/member keys).
 *    Otherwise the RESOURCE owner - the requested pool's owner for pool
 *    traffic, else the execution target's owner for direct traffic, else
 *    (nothing resolved) the requester. Owners see every requester's traffic
 *    on what they own. Rollups are hot-path history with no foreign key
 *    (@ws-model-proxy/db/capacity-lock-order): deleting the owner removes the
 *    history of their resources through the user-deletion drain and the
 *    history purge sweeper. The owner comes from the request's durable
 *    `resourceOwnerUserId`; an increment whose owner no longer exists is
 *    skipped (rollupUpsertSql), as the owner's deletion would have removed it.
 *  - `requesterUserId`: the RelayRequest owner (API token / chat-test /
 *    MCP user). When the requester is deleted, their rows are merged into the
 *    '' sentinel requester, so owners keep the traffic in their history (the
 *    user-deletion drain and the purge sweeper,
 *    @ws-model-proxy/db/usage-rollup-requester-drain). Grantees read only rows
 *    where they are the requester of a pool they do not own.
 */
export type UsageRollupKey = {
  bucketStart: Date;
  ownerUserId: string;
  requesterUserId: string;
  /** '' sentinels for what a request did not touch (the rollup tables have a real PK). */
  poolId: string;
  runtimeId: string;
  versionId: string;
  nodeId: string;
  instanceId: string;
  runtimeModelId: string;
  providerModelId: string;
  source: RelayRequestSourceValue;
};

/** Counters stored as BIGINT (token and millisecond sums); every other counter is INT. */
export const BIG_ROLLUP_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheKnownInputTokens",
  "continuationInputTokens",
  "continuationCacheReadTokens",
  "durationSumMs",
  "ttftSumMs",
  "queueWaitSumMs",
  "generationTokens",
  "generationMs",
  "prefillTokens",
  "prefillMs",
  "audioInputMs",
] as const satisfies readonly (typeof USAGE_ROLLUP_COUNTERS)[number][];
type BigCounter = (typeof BIG_ROLLUP_COUNTERS)[number];
type Counter = (typeof USAGE_ROLLUP_COUNTERS)[number];
type Histogram = (typeof USAGE_ROLLUP_HISTOGRAMS)[number];

/** Counters of one rollup row (spec B5 keys: instance, served model, prefill/decode, queue wait). */
export type UsageRollupCounters = { [K in Exclude<Counter, BigCounter>]: number } & {
  [K in BigCounter]: bigint;
} & { [K in Histogram]: number[] };

/** The operation of a live transcription session row (shared with the admin summary). */
export { REALTIME_TRANSCRIPTION_OPERATION };

export type UsageRollupIncrement = UsageRollupKey & UsageRollupCounters;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Routed onto a known session (not first-turn / no-match / spilled). */
export function isMatchedAffinityOutcome(value: string | null | undefined): boolean {
  return value === "PREDICTED_MATCH" || value === "HOLDER_WAITED";
}

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
  // Only measured durations feed latency: crash repair and the abandoned reaper leave
  // durationMs null. A live transcription session's wall time (up to 30 min) is not request
  // latency: it is kept on the row, and its audio is counted instead.
  const realtime = row.operation === REALTIME_TRANSCRIPTION_OPERATION;
  const durationMs = realtime ? null : row.durationMs;
  const ttftMs =
    row.firstClientByteAt === null
      ? null
      : Math.max(0, row.firstClientByteAt.getTime() - row.startedAt.getTime());
  const latencyHistogram = emptyLatencyHistogram();
  if (durationMs !== null) latencyHistogram[latencyBucketIndex(durationMs)]! += 1;
  const ttftHistogram = emptyLatencyHistogram();
  if (ttftMs !== null) ttftHistogram[latencyBucketIndex(ttftMs)]! += 1;
  const queueWaitHistogram = emptyLatencyHistogram();
  if (row.queueWaitMs !== null) queueWaitHistogram[latencyBucketIndex(row.queueWaitMs)]! += 1;
  const cacheKnown = row.usageKnown && row.cacheReadTokens !== null;
  const continuation = cacheKnown && isMatchedAffinityOutcome(row.affinityOutcome);
  const ownKey = row.route === "own_key";
  const outputTokens = row.usageKnown ? (row.completionTokens ?? 0) : 0;
  // Decode throughput: output tokens over first-byte → complete; prefill: context tokens
  // over (TTFT − queue wait). Only when every term is known.
  const generationMs =
    !realtime && row.firstClientByteAt !== null && row.completedAt !== null
      ? Math.max(0, row.completedAt.getTime() - row.firstClientByteAt.getTime())
      : null;
  const prefillMs =
    ttftMs !== null && row.queueWaitMs !== null ? Math.max(0, ttftMs - row.queueWaitMs) : null;
  const rejected = row.rejection ?? "";
  return {
    bucketStart: truncateToMinute(completedAt),
    ownerUserId: resourceOwnerUserId(row),
    requesterUserId: row.userId,
    poolId: ownKey ? "" : (row.poolId ?? ""),
    // B5 fills the runtime from the instance; the version carries it until then.
    runtimeId: "",
    versionId: row.selectedVersionId ?? "",
    nodeId: row.selectedNodeId ?? "",
    instanceId: row.selectedInstanceId ?? "",
    runtimeModelId: row.runtimeModelId ?? "",
    providerModelId: row.selectedProviderModelId ?? "",
    source: row.source,
    requests: 1,
    successes: row.status === "SUCCEEDED" ? 1 : 0,
    errors: row.status === "FAILED" ? 1 : 0,
    cancels: row.status === "CANCELED" ? 1 : 0,
    retries: Math.max(0, row.attemptCount - 1),
    cloudRequests: row.external ? 1 : 0,
    rejectedCapacity: rejected.startsWith("capacity") ? 1 : 0,
    rejectedContext: rejected.startsWith("context") ? 1 : 0,
    rejectedSpend: rejected.startsWith("spend") ? 1 : 0,
    rejectedOther:
      rejected !== "" &&
      !rejected.startsWith("capacity") &&
      !rejected.startsWith("context") &&
      !rejected.startsWith("spend")
        ? 1
        : 0,
    usageKnownRequests: row.usageKnown ? 1 : 0,
    inputTokens: BigInt(row.usageKnown ? (row.promptTokens ?? 0) : 0),
    outputTokens: BigInt(outputTokens),
    cacheReadTokens: BigInt(cacheKnown ? (row.cacheReadTokens ?? 0) : 0),
    cacheWriteTokens: BigInt(row.usageKnown ? (row.cacheWriteTokens ?? 0) : 0),
    cacheKnownRequests: cacheKnown ? 1 : 0,
    cacheKnownInputTokens: BigInt(cacheKnown ? (row.promptTokens ?? 0) : 0),
    continuationRequests: continuation ? 1 : 0,
    continuationInputTokens: BigInt(continuation ? (row.promptTokens ?? 0) : 0),
    continuationCacheReadTokens: BigInt(continuation ? (row.cacheReadTokens ?? 0) : 0),
    durationCount: durationMs === null ? 0 : 1,
    durationSumMs: BigInt(durationMs ?? 0),
    latencyHistogram,
    ttftCount: ttftMs === null ? 0 : 1,
    ttftSumMs: BigInt(ttftMs ?? 0),
    ttftHistogram,
    queueWaitCount: row.queueWaitMs === null ? 0 : 1,
    queueWaitSumMs: BigInt(row.queueWaitMs ?? 0),
    queueWaitHistogram,
    generationTokens: BigInt(generationMs === null ? 0 : outputTokens),
    generationMs: BigInt(generationMs === null || outputTokens === 0 ? 0 : generationMs),
    prefillTokens: BigInt(prefillMs === null ? 0 : (row.contextTokenCount ?? 0)),
    prefillMs: BigInt(prefillMs === null || !row.contextTokenCount ? 0 : prefillMs),
    audioInputMs: BigInt(row.audioInputMs ?? 0),
  };
}

/**
 * See UsageRollupKey: own-key requester, else the durable resource owner the
 * database recorded at insert (the pool owner even after the pool is deleted;
 * schema-hardening.sql derives it for every row), else the requester.
 */
export function resourceOwnerUserId(row: RelayRollupRow): string {
  if (row.route === "own_key") return row.userId;
  return row.resourceOwnerUserId ?? row.userId;
}

export function rollupKeyString(key: UsageRollupKey): string {
  return [
    key.bucketStart.toISOString(),
    key.ownerUserId,
    key.requesterUserId,
    ...USAGE_ROLLUP_DIMENSIONS.map((dimension) => key[dimension]),
    key.source,
  ].join("\u0000");
}

export function addRollupCounters<T extends UsageRollupCounters>(
  target: T,
  add: UsageRollupCounters,
): T {
  for (const counter of USAGE_ROLLUP_COUNTERS) {
    const current = target[counter];
    const delta = add[counter];
    if (typeof current === "bigint" && typeof delta === "bigint")
      Object.assign(target, { [counter]: current + delta });
    else if (typeof current === "number" && typeof delta === "number")
      Object.assign(target, { [counter]: current + delta });
  }
  for (const histogram of USAGE_ROLLUP_HISTOGRAMS)
    target[histogram] = addHistograms(target[histogram], add[histogram]);
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
        queueWaitHistogram: [...increment.queueWaitHistogram],
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

/** One idempotent-per-call additive upsert for a merged increment. */
export function rollupUpsertSql(
  table: UsageRollupTable,
  increment: UsageRollupIncrement,
): Prisma.Sql {
  const tableSql = Prisma.raw(table);
  const updates = Prisma.join(
    [
      ...USAGE_ROLLUP_COUNTERS.map((column) => additive(table, column)),
      ...USAGE_ROLLUP_HISTOGRAMS.map(
        (column) => Prisma.sql`${Prisma.raw(`"${column}"`)} = ${histogramMerge(table, column)}`,
      ),
      Prisma.raw(`"updatedAt" = now()`),
    ],
    ", ",
  );
  const columns = Prisma.raw(
    [
      "bucketStart",
      "ownerUserId",
      "requesterUserId",
      ...USAGE_ROLLUP_DIMENSIONS,
      "source",
      "updatedAt",
      ...USAGE_ROLLUP_COUNTERS,
      ...USAGE_ROLLUP_HISTOGRAMS,
    ]
      .map((column) => `"${column}"`)
      .join(", "),
  );
  const values = Prisma.join(
    [
      Prisma.sql`${increment.bucketStart}`,
      Prisma.sql`${increment.ownerUserId}`,
      Prisma.sql`${increment.requesterUserId}`,
      ...USAGE_ROLLUP_DIMENSIONS.map((dimension) => Prisma.sql`${increment[dimension]}`),
      Prisma.sql`${increment.source}::"RequestSource"`,
      Prisma.sql`now()`,
      ...USAGE_ROLLUP_COUNTERS.map((counter) => Prisma.sql`${increment[counter]}`),
      ...USAGE_ROLLUP_HISTOGRAMS.map((histogram) => Prisma.sql`${increment[histogram]}::integer[]`),
    ],
    ", ",
  );
  const conflict = Prisma.raw(
    ["bucketStart", "ownerUserId", "requesterUserId", ...USAGE_ROLLUP_DIMENSIONS, "source"]
      .map((column) => `"${column}"`)
      .join(", "),
  );
  return Prisma.sql`
    INSERT INTO ${tableSql} (${columns})
    SELECT ${values}
    -- The owner key is a durable plain id (relay_request.resourceOwnerUserId): a deleted
    -- owner's history is gone, so its late increment is skipped.
    WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ${increment.ownerUserId})
    ON CONFLICT (${conflict})
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
