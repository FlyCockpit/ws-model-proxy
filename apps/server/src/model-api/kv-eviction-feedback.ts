/**
 * Prefix-attributed eviction feedback, never endpoint cumulative counters (they
 * include bypass traffic). Only a ranked, digest-proven LIVE TIP continuation
 * has a structurally proven footprint in one ranking SQL snapshot: live-tip
 * ownership and the node's own size are read with the same digest/session hint's
 * age and confirmation. Only identifiable tip writes set the node's size;
 * overflow-only hint refreshes cannot change it. Implicit
 * identical tips may lose one observation when the resolver's session differs
 * from the last hint writer; that session's identifiable write restores evidence.
 * Later unrelated writes do not change that snapshot claim. Client-id-only
 * matches and bound Responses parents are not a source.
 *
 * Disposable H-class state: one owner-guarded atomic upsert, no transaction,
 * graph write, capacity lock or fence lock. Application clock skew is bounded
 * by clamping elapsed time and GREATEST timestamps. The pure budget module is
 * the SQL specification. Pending capacities are capped at 1024: new keys beyond
 * that bound are dropped, as are failed flushes (no unbounded retries).
 */
import {
  boundedKvEvictionSessions,
  KV_EVICTION_DECAY_PER_MS,
  KV_EVICTION_MAX_CUT,
  KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH,
  KV_EVICTION_MISS_RATIO,
  KV_EVICTION_RECOVERY_MS,
  KV_EVICTION_SESSION_CAP,
  KV_EVICTION_STEP,
  type KvEvictionContinuationKind,
} from "@ws-model-proxy/api/lib/kv-eviction-budget";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import type { AffinityDecision } from "./cache-affinity.js";
import { resetAffinityForCapacities } from "./cache-affinity-generation.js";
import { queryAffinityResidency } from "./cache-affinity-residency.js";
import {
  type ProtectionEngineKind,
  protectionKvBudgetTokens,
  protectionWindowSecondsFor,
  type WarmProtectionPolicy,
} from "./warm-protection.js";

export const EVICTION_MISS_FRACTION = 0.05;
export const KV_EVICTION_FLUSH_MIN_INTERVAL_MS = 1000;
export const MAX_PENDING_CAPACITIES = 1024;

function isQualifyingContinuation({
  policy,
  engineKind,
  kvBudgetTokens,
  ok,
  usage,
  evidence,
  now,
  resetAtMs,
}: {
  policy: WarmProtectionPolicy;
  engineKind: ProtectionEngineKind | null | undefined;
  kvBudgetTokens: number | null | undefined;
  ok: boolean;
  usage: { cacheReadTokens: number | null; promptTokens: number | null };
  evidence: NonNullable<AffinityDecision["prefixEvidence"]>[string] | undefined;
  now: Date;
  resetAtMs?: number | null;
}): boolean {
  return (
    policy.enabled &&
    (policy.evictionFeedbackEnabled ?? true) &&
    protectionKvBudgetTokens(engineKind, kvBudgetTokens) !== null &&
    ok &&
    usage.cacheReadTokens !== null &&
    Number.isFinite(usage.cacheReadTokens) &&
    usage.cacheReadTokens >= 0 &&
    usage.promptTokens !== null &&
    Number.isFinite(usage.promptTokens) &&
    usage.promptTokens >= policy.minTokens &&
    evidence !== undefined &&
    Number.isFinite(evidence.tokens) &&
    evidence.tokens >= policy.minTokens &&
    Number.isFinite(evidence.lastUsedAt) &&
    (resetAtMs == null || evidence.lastUsedAt >= resetAtMs) &&
    Math.max(0, now.getTime() - evidence.lastUsedAt) <=
      protectionWindowSecondsFor(policy.windowSeconds, engineKind) * 1000 &&
    evidence.confirmed === true
  );
}

/**
 * Classifies a live-tip continuation. The miss denominator is the reusable
 * prompt prefix (`usage.promptTokens`), not prompt+completion.
 */
export function evictionContinuationKind(
  input: Parameters<typeof isQualifyingContinuation>[0],
): KvEvictionContinuationKind | null {
  if (!isQualifyingContinuation(input)) return null;
  const prompt = input.usage.promptTokens!;
  const cacheRead = input.usage.cacheReadTokens!;
  return cacheRead <= EVICTION_MISS_FRACTION * prompt ? "miss" : "hit";
}

/** The sole enforcement point for a miss. Unknown is not a miss. */
export function qualifiesAsEvictionEvidence(
  input: Parameters<typeof isQualifyingContinuation>[0],
): boolean {
  return evictionContinuationKind(input) === "miss";
}

export type KvEvictionObservation = {
  capacityId: string;
  ownerId: string;
  sessionIds: readonly string[];
  now: Date;
  kind?: KvEvictionContinuationKind;
};

export const MAX_RESET_CAPACITIES = 1024;

/**
 * Fixed-size generation ledger, with a conservative frontier for pruned keys.
 * Request generations are scalar values: no registration, timers, references
 * or release paths can leak when a stream hangs/cancels/retries. Never expire
 * the frontier by time: a very old active request must remain fenced forever.
 * At extreme churn, old unrelated evidence can be discarded, never revived.
 */
export function createKvEvictionResetLedger() {
  const resetAtByCapacity = new Map<string, { ms: number; generation: number }>();
  let generation = 0;
  let prunedThrough = 0;
  let prunedResetMs = Number.NEGATIVE_INFINITY;
  const snapshot = () => generation;
  const resetMs = (capacityId: string, requestGeneration = generation): number | undefined => {
    const retained = resetAtByCapacity.get(capacityId);
    if (requestGeneration < prunedThrough || (retained && retained.generation > requestGeneration))
      return Number.POSITIVE_INFINITY;
    const ms = Math.max(retained?.ms ?? Number.NEGATIVE_INFINITY, prunedResetMs);
    return ms === Number.NEGATIVE_INFINITY ? undefined : ms;
  };
  const note = (capacityIds: readonly string[], now: Date) => {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) return;
    for (const capacityId of capacityIds) {
      if (!capacityId || capacityId.length > 128) continue;
      // Move updated keys to the end, keeping the map in generation order.
      const previous = resetAtByCapacity.get(capacityId);
      resetAtByCapacity.delete(capacityId);
      resetAtByCapacity.set(capacityId, {
        ms: Math.max(ms, previous?.ms ?? prunedResetMs),
        generation: ++generation,
      });
      if (resetAtByCapacity.size > MAX_RESET_CAPACITIES) {
        const oldest = resetAtByCapacity.entries().next().value;
        if (oldest) {
          resetAtByCapacity.delete(oldest[0]);
          prunedThrough = Math.max(prunedThrough, oldest[1].generation);
          prunedResetMs = Math.max(prunedResetMs, oldest[1].ms);
        }
      }
    }
  };
  return { snapshot, resetMs, note, size: () => resetAtByCapacity.size };
}

const resets = createKvEvictionResetLedger();
export const kvEvictionResetGeneration = resets.snapshot;
export const kvEvictionResetMs = resets.resetMs;
export const noteKvEvictionReset = resets.note;

async function resetKvEvictionCapacities(
  where: Prisma.InferenceCapacityWhereInput,
  now: Date,
  db: Pick<typeof prisma, "inferenceCapacity" | "capacityKvEviction">,
): Promise<void> {
  if (isDbShutdownFenceArmed()) return;
  const rows = await db.inferenceCapacity.findMany({ where, select: { id: true } });
  const ids = rows.map((row) => row.id);
  noteKvEvictionReset(ids, now);
  if (ids.length === 0) return;
  await resetAffinityForCapacities(ids);
  await db.capacityKvEviction.deleteMany({ where: { capacityId: { in: ids } } }).catch(() => {});
}

export async function resetKvEvictionForEndpoint(
  cliDeviceId: string,
  endpointSlug: string,
  now: Date = new Date(),
  db: Pick<typeof prisma, "inferenceCapacity" | "capacityKvEviction"> = prisma,
): Promise<void> {
  if (!cliDeviceId || !endpointSlug || cliDeviceId.length > 128 || endpointSlug.length > 63) return;
  if (db === prisma) {
    const rows = await queryAffinityResidency<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT t."inferenceCapacityId" AS id FROM endpoint e
      JOIN discovered_model m ON m."endpointId" = e.id
      JOIN execution_target t ON t."discoveredModelId" = m.id
      WHERE e."cliDeviceId" = ${cliDeviceId} AND e.slug = ${endpointSlug}
        AND t."inferenceCapacityId" IS NOT NULL`);
    const ids = rows.map((row) => row.id);
    noteKvEvictionReset(ids, now);
    await resetAffinityForCapacities(ids);
    await queryAffinityResidency(Prisma.sql`DELETE FROM capacity_kv_eviction
      WHERE "capacityId" = ANY(${ids}::text[]) RETURNING "capacityId"`).catch(() => {});
    return;
  }
  await resetKvEvictionCapacities(
    {
      ExecutionTargets: {
        some: { DiscoveredModel: { Endpoint: { cliDeviceId, slug: endpointSlug } } },
      },
    },
    now,
    db,
  );
}

export async function recordKvEvictionObservations(
  { capacityId, ownerId, sessionIds, now, kind = "miss" }: KvEvictionObservation,
  db: Pick<typeof prisma, "$executeRaw"> = prisma,
): Promise<void> {
  const sessions = boundedKvEvictionSessions(sessionIds);
  if (
    isDbShutdownFenceArmed() ||
    !capacityId ||
    capacityId.length > 128 ||
    !ownerId ||
    !Number.isFinite(now.getTime()) ||
    sessions.length === 0
  )
    return;
  for (const sessionId of sessions) {
    if (isDbShutdownFenceArmed()) return;
    await upsertKvEvictionSession({ capacityId, ownerId, sessionId, now, kind }, db);
  }
}

async function upsertKvEvictionSession(
  {
    capacityId,
    ownerId,
    sessionId,
    now,
    kind,
  }: {
    capacityId: string;
    ownerId: string;
    sessionId: string;
    now: Date;
    kind: KvEvictionContinuationKind;
  },
  db: Pick<typeof prisma, "$executeRaw">,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + KV_EVICTION_RECOVERY_MS);
  const missInc = kind === "miss" ? 1 : 0;
  const liveCutSql = Prisma.sql`GREATEST(0::double precision,
                LEAST(${KV_EVICTION_MAX_CUT}::double precision, GREATEST(0::double precision, existing."cutFraction"))
                - ${KV_EVICTION_DECAY_PER_MS}::double precision * GREATEST(0::double precision,
                  EXTRACT(EPOCH FROM (${now}::timestamp - existing."observedAt"))::double precision * 1000))`;
  const elapsedSql = Prisma.sql`EXTRACT(EPOCH FROM (${now}::timestamp - existing."observedAt"))::double precision * 1000`;
  const newMissSql = Prisma.sql`(existing."missCount" + ${missInc})`;
  const newContSql = Prisma.sql`(existing."continuationCount" + 1)`;
  const shouldStepSql = Prisma.sql`${missInc} = 1
            AND ${newMissSql} >= 2
            AND ${newContSql} > 0
            AND (${newMissSql})::double precision / (${newContSql})::double precision
              >= ${KV_EVICTION_MISS_RATIO}::double precision`;
  const recoveredSql = Prisma.sql`existing."cutFraction" > 0
            AND (${liveCutSql} <= 0 OR ${elapsedSql} >= ${KV_EVICTION_RECOVERY_MS}::double precision)`;
  const newLifetimeSql = Prisma.sql`existing."expiresAt" <= ${now}::timestamp OR (${recoveredSql})`;
  const nextCutSql = Prisma.sql`LEAST(${KV_EVICTION_MAX_CUT}::double precision,
        CASE
          WHEN ${liveCutSql} > 0
            AND ${elapsedSql} < ${KV_EVICTION_RECOVERY_MS}::double precision
            THEN ${liveCutSql} + ${KV_EVICTION_STEP}::double precision
          WHEN existing."cutFraction" > 0 THEN 0::double precision
          ELSE ${KV_EVICTION_STEP}::double precision
        END)`;
  await db.$executeRaw`
    INSERT INTO capacity_kv_eviction AS existing
      ("capacityId", "userId", "cutFraction", "observedAt", "expiresAt",
       "sessionIds", "missCount", "continuationCount")
    VALUES (
      ${capacityId}, ${ownerId}, 0, ${now}, ${expiresAt},
      ARRAY[${sessionId}::text], ${missInc}, 1)
    ON CONFLICT ("capacityId") DO UPDATE SET
      "sessionIds" = CASE
        WHEN ${newLifetimeSql} THEN ARRAY[${sessionId}::text]
        ELSE existing."sessionIds" || ${sessionId}::text
      END,
      "missCount" = CASE
        WHEN ${newLifetimeSql} THEN ${missInc}
        ELSE ${newMissSql}
      END,
      "continuationCount" = CASE
        WHEN ${newLifetimeSql} THEN 1
        ELSE ${newContSql}
      END,
      "cutFraction" = CASE
        WHEN ${newLifetimeSql} THEN 0::double precision
        WHEN ${shouldStepSql} THEN ${nextCutSql}
        ELSE existing."cutFraction"
      END,
      "observedAt" = CASE
        WHEN ${newLifetimeSql} THEN ${now}
        WHEN ${shouldStepSql} THEN GREATEST(existing."observedAt", ${now})
        ELSE existing."observedAt"
      END,
      "expiresAt" = GREATEST(existing."expiresAt", ${expiresAt})
    WHERE existing."userId" = EXCLUDED."userId"
      AND (
        ${newLifetimeSql}
        OR (
          NOT (${sessionId}::text = ANY (existing."sessionIds"))
          AND cardinality(existing."sessionIds") < ${KV_EVICTION_SESSION_CAP}
        )
      )`;
}

type Pending = {
  ownerId: string;
  items: { sessionId: string; kind: KvEvictionContinuationKind }[];
  lastFlush: number;
  timer?: ReturnType<typeof setTimeout>;
  writing: boolean;
};

/** Injectable clock/writer/fence for deterministic tests without a real DB. */
export function createKvEvictionFeedback({
  clock = Date.now,
  write = recordKvEvictionObservations,
  shutdown = isDbShutdownFenceArmed,
  log = () => console.error("[kv-eviction] feedback flush failed"),
}: {
  clock?: () => number;
  write?: (observation: KvEvictionObservation) => Promise<void>;
  shutdown?: () => boolean;
  log?: () => void;
} = {}) {
  const pending = new Map<string, Pending>();
  let stopped = false;
  let lastLog = Number.NEGATIVE_INFINITY;
  const stop = () => {
    stopped = true;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  };
  const schedule = (capacityId: string, entry: Pending) => {
    if (entry.timer !== undefined || stopped) return;
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        if (stopped || shutdown()) {
          stop();
          return;
        }
        if (entry.writing) {
          schedule(capacityId, entry);
          return;
        }
        if (entry.items.length === 0) {
          pending.delete(capacityId);
          return;
        }
        flush(capacityId, entry);
      },
      entry.writing
        ? KV_EVICTION_FLUSH_MIN_INTERVAL_MS
        : Math.max(1, KV_EVICTION_FLUSH_MIN_INTERVAL_MS - Math.max(0, clock() - entry.lastFlush)),
    );
    entry.timer.unref?.();
  };
  const flush = (capacityId: string, entry: Pending) => {
    if (stopped || shutdown()) {
      stop();
      return;
    }
    const now = clock();
    const items = entry.items;
    entry.items = [];
    entry.lastFlush = now;
    entry.writing = true;
    // Promise boundary also absorbs a synchronously throwing injected writer.
    void Promise.resolve()
      .then(async () => {
        if (stopped || shutdown()) return;
        for (const item of items) {
          await write({
            capacityId,
            ownerId: entry.ownerId,
            sessionIds: [item.sessionId],
            now: new Date(now),
            kind: item.kind,
          });
        }
      })
      .catch(() => {
        const failedAt = clock();
        if (failedAt - lastLog >= 60_000) {
          lastLog = failedAt;
          try {
            log();
          } catch {
            /* Logging must not escape the request path. */
          }
        }
      })
      .finally(() => {
        entry.writing = false;
      });
    schedule(capacityId, entry);
  };
  const observe = (
    capacityId: string,
    ownerId: string,
    sessionId: string,
    kind: KvEvictionContinuationKind = "miss",
  ) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (
        !capacityId ||
        capacityId.length > 128 ||
        !ownerId ||
        !sessionId ||
        sessionId.length > 128
      )
        return;
      let entry = pending.get(capacityId);
      if (!entry) {
        if (pending.size >= MAX_PENDING_CAPACITIES) return;
        entry = { ownerId, items: [], lastFlush: Number.NEGATIVE_INFINITY, writing: false };
        pending.set(capacityId, entry);
      }
      if (entry.ownerId !== ownerId) return;
      if (
        !entry.items.some((item) => item.sessionId === sessionId) &&
        entry.items.length < KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH
      )
        entry.items.push({ sessionId, kind });
      if (entry.items.length === 0) return;
      if (!entry.writing && clock() - entry.lastFlush >= KV_EVICTION_FLUSH_MIN_INTERVAL_MS) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        flush(capacityId, entry);
      } else schedule(capacityId, entry);
    } catch {
      /* Disposable optimization: observe never throws. */
    }
  };
  return { observe, stop };
}

const feedback = createKvEvictionFeedback();
export const observeKvEviction = feedback.observe;
export const stopKvEvictionFeedback = feedback.stop;
