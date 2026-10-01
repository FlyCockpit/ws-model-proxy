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
  boundedKvEvictionCount,
  KV_EVICTION_DECAY_PER_MS,
  KV_EVICTION_MAX_CUT,
  KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH,
  KV_EVICTION_RECOVERY_MS,
  KV_EVICTION_STEP,
} from "@ws-model-proxy/api/lib/kv-eviction-budget";
import prisma from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import type { AffinityDecision } from "./cache-affinity.js";
import {
  type ProtectionEngineKind,
  protectionKvBudgetTokens,
  protectionWindowSecondsFor,
  type WarmProtectionPolicy,
} from "./warm-protection.js";

export const EVICTION_MISS_FRACTION = 0.05;
export const KV_EVICTION_FLUSH_MIN_INTERVAL_MS = 1000;
export const MAX_PENDING_CAPACITIES = 1024;

/** The sole enforcement point for all six evidence rules. Unknown is not a miss. */
export function qualifiesAsEvictionEvidence({
  policy,
  engineKind,
  kvBudgetTokens,
  ok,
  usage,
  evidence,
  now,
}: {
  policy: WarmProtectionPolicy;
  engineKind: ProtectionEngineKind | null | undefined;
  kvBudgetTokens: number | null | undefined;
  ok: boolean;
  usage: { cacheReadTokens: number | null; promptTokens: number | null };
  evidence: NonNullable<AffinityDecision["prefixEvidence"]>[string] | undefined;
  now: Date;
}): boolean {
  return (
    policy.enabled &&
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
    Math.max(0, now.getTime() - evidence.lastUsedAt) <=
      protectionWindowSecondsFor(policy.windowSeconds, engineKind) * 1000 &&
    evidence.confirmed === true &&
    usage.cacheReadTokens <= EVICTION_MISS_FRACTION * evidence.tokens
  );
}

export type KvEvictionObservation = {
  capacityId: string;
  ownerId: string;
  count: number;
  now: Date;
};

export async function recordKvEvictionObservations(
  { capacityId, ownerId, count, now }: KvEvictionObservation,
  db: Pick<typeof prisma, "$executeRaw"> = prisma,
): Promise<void> {
  const boundedCount = boundedKvEvictionCount(count);
  // Invalid ids/time cannot create a row. No I/O past shutdown.
  if (
    isDbShutdownFenceArmed() ||
    !capacityId ||
    capacityId.length > 128 ||
    !ownerId ||
    !Number.isFinite(now.getTime())
  )
    return;
  const expiresAt = new Date(now.getTime() + KV_EVICTION_RECOVERY_MS);
  await db.$executeRaw`
    INSERT INTO capacity_kv_eviction AS existing
      ("capacityId", "userId", "cutFraction", "observedAt", "expiresAt")
    VALUES (${capacityId}, ${ownerId}, ${boundedCount * KV_EVICTION_STEP}, ${now}, ${expiresAt})
    ON CONFLICT ("capacityId") DO UPDATE SET
      "cutFraction" = LEAST(${KV_EVICTION_MAX_CUT}::double precision,
        GREATEST(0::double precision,
          LEAST(${KV_EVICTION_MAX_CUT}::double precision, GREATEST(0::double precision, existing."cutFraction"))
          - ${KV_EVICTION_DECAY_PER_MS}::double precision * GREATEST(0::double precision,
            EXTRACT(EPOCH FROM (${now}::timestamp - existing."observedAt"))::double precision * 1000))
        + ${boundedCount * KV_EVICTION_STEP}::double precision),
      "observedAt" = GREATEST(existing."observedAt", ${now}),
      "expiresAt" = GREATEST(existing."expiresAt", ${expiresAt})
    WHERE existing."userId" = EXCLUDED."userId"`;
}

type Pending = {
  ownerId: string;
  count: number;
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
        if (entry.count === 0) {
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
    const count = entry.count;
    entry.count = 0;
    entry.lastFlush = now;
    entry.writing = true;
    // Promise boundary also absorbs a synchronously throwing injected writer.
    void Promise.resolve()
      .then(() => {
        if (!stopped && !shutdown())
          return write({ capacityId, ownerId: entry.ownerId, count, now: new Date(now) });
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
  const observe = (capacityId: string, ownerId: string) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (!capacityId || capacityId.length > 128 || !ownerId) return;
      let entry = pending.get(capacityId);
      if (!entry) {
        if (pending.size >= MAX_PENDING_CAPACITIES) return;
        entry = { ownerId, count: 0, lastFlush: Number.NEGATIVE_INFINITY, writing: false };
        pending.set(capacityId, entry);
      }
      if (entry.ownerId !== ownerId) return;
      entry.count = Math.min(KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH, entry.count + 1);
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
