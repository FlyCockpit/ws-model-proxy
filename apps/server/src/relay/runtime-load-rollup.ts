/**
 * Batched class-H writer for `runtime_load_minute` (was engine_load_rollup_minute): accepted
 * `runtime.load` frames, already resolved to their instance by the session manager, are
 * merged in memory per (minute, owner, instance) and flushed in sorted key order, one
 * statement per row. Occupancy is stored for display only. The metrics query (lane B5) reads
 * the minutes; there is no other history.
 */
import prisma, { Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const RUNTIME_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS = 1000;
export const RUNTIME_LOAD_ROLLUP_MAX_PENDING = 2000;
/** Postgres `int4` ceiling so a busy prefix-cache counter cannot fail the flush. */
export const RUNTIME_LOAD_ROLLUP_INT4_MAX = 2_147_483_647;
const MINUTE_MS = 60_000;

function addInt4(current: number, delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) return current;
  return Math.min(RUNTIME_LOAD_ROLLUP_INT4_MAX, current + delta);
}

export type RuntimeLoadSample = {
  ownerUserId: string;
  instanceId: string;
  runtimeId: string;
  versionId: string;
  nodeId: string;
  receivedAt: Date;
  running: number;
  waiting?: number;
  kvUsage?: number;
  kvOccupancy?: number;
  slotsBusy?: number;
  prefixCacheHitsDelta?: number;
  prefixCacheQueriesDelta?: number;
  /** The engine-load gate judged the instance FULL for this sample. */
  full?: boolean;
  source?: string;
};

export type RuntimeLoadIncrement = {
  bucketStart: Date;
  ownerUserId: string;
  instanceId: string;
  runtimeId: string;
  versionId: string;
  nodeId: string;
  samples: number;
  maxRunning: number;
  kvSamples: number;
  maxWaiting: number | null;
  sumKvUsage: number | null;
  maxKvUsage: number | null;
  maxKvOccupancy: number | null;
  maxSlotsBusy: number | null;
  fullSamples: number;
  prefixCacheHits: number;
  prefixCacheQueries: number;
  lastSource: string | null;
};

export function truncateToMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / MINUTE_MS) * MINUTE_MS);
}

function maxOpt(current: number | null, next: number | null | undefined): number | null {
  if (next == null || !Number.isFinite(next)) return current;
  if (current == null) return next;
  return Math.max(current, next);
}

export function runtimeLoadKey(sample: {
  ownerUserId: string;
  instanceId: string;
  receivedAt?: Date;
  bucketStart?: Date;
}): string {
  const bucket = sample.bucketStart ?? truncateToMinute(sample.receivedAt ?? new Date(0));
  return [bucket.toISOString(), sample.ownerUserId, sample.instanceId].join("\u0000");
}

export function mergeRuntimeLoad(
  current: RuntimeLoadIncrement | undefined,
  sample: RuntimeLoadSample,
): RuntimeLoadIncrement {
  const next: RuntimeLoadIncrement = current ?? {
    bucketStart: truncateToMinute(sample.receivedAt),
    ownerUserId: sample.ownerUserId,
    instanceId: sample.instanceId,
    runtimeId: sample.runtimeId,
    versionId: sample.versionId,
    nodeId: sample.nodeId,
    samples: 0,
    maxRunning: 0,
    kvSamples: 0,
    maxWaiting: null,
    sumKvUsage: null,
    maxKvUsage: null,
    maxKvOccupancy: null,
    maxSlotsBusy: null,
    fullSamples: 0,
    prefixCacheHits: 0,
    prefixCacheQueries: 0,
    lastSource: null,
  };
  const kv = sample.kvUsage != null && Number.isFinite(sample.kvUsage) ? sample.kvUsage : null;
  return {
    ...next,
    // The latest sample names the version the instance runs now (live adoption).
    versionId: sample.versionId,
    nodeId: sample.nodeId,
    samples: next.samples + 1,
    maxRunning: Math.max(next.maxRunning, sample.running),
    kvSamples: next.kvSamples + (kv === null ? 0 : 1),
    maxWaiting: maxOpt(next.maxWaiting, sample.waiting),
    sumKvUsage: kv === null ? next.sumKvUsage : (next.sumKvUsage ?? 0) + kv,
    maxKvUsage: maxOpt(next.maxKvUsage, kv),
    maxKvOccupancy: maxOpt(next.maxKvOccupancy, sample.kvOccupancy),
    maxSlotsBusy: maxOpt(next.maxSlotsBusy, sample.slotsBusy),
    fullSamples: next.fullSamples + (sample.full ? 1 : 0),
    prefixCacheHits: addInt4(next.prefixCacheHits, sample.prefixCacheHitsDelta ?? 0),
    prefixCacheQueries: addInt4(next.prefixCacheQueries, sample.prefixCacheQueriesDelta ?? 0),
    lastSource: sample.source ?? next.lastSource,
  };
}

function nullableMax(column: string): Prisma.Sql {
  const name = Prisma.raw(`"${column}"`);
  return Prisma.sql`${name} = CASE
        WHEN existing.${name} IS NULL THEN EXCLUDED.${name}
        WHEN EXCLUDED.${name} IS NULL THEN existing.${name}
        ELSE GREATEST(existing.${name}, EXCLUDED.${name}) END`;
}

function upsertSql(increment: RuntimeLoadIncrement): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO runtime_load_minute AS existing
      ("bucketStart", "ownerUserId", "instanceId", "runtimeId", "versionId", "nodeId",
       samples, "maxRunning", "kvSamples", "maxWaiting", "sumKvUsage", "maxKvUsage",
       "maxKvOccupancy", "maxSlotsBusy", "fullSamples", "prefixCacheHits",
       "prefixCacheQueries", "lastSource")
    VALUES (${increment.bucketStart}, ${increment.ownerUserId}, ${increment.instanceId},
      ${increment.runtimeId}, ${increment.versionId}, ${increment.nodeId},
      ${increment.samples}, ${increment.maxRunning}, ${increment.kvSamples},
      ${increment.maxWaiting}, ${increment.sumKvUsage}, ${increment.maxKvUsage},
      ${increment.maxKvOccupancy}, ${increment.maxSlotsBusy}, ${increment.fullSamples},
      ${increment.prefixCacheHits}, ${increment.prefixCacheQueries}, ${increment.lastSource})
    ON CONFLICT ("bucketStart", "ownerUserId", "instanceId")
    DO UPDATE SET
      samples = existing.samples + EXCLUDED.samples,
      "maxRunning" = GREATEST(existing."maxRunning", EXCLUDED."maxRunning"),
      "kvSamples" = existing."kvSamples" + EXCLUDED."kvSamples",
      ${nullableMax("maxWaiting")},
      "sumKvUsage" = CASE
        WHEN existing."sumKvUsage" IS NULL THEN EXCLUDED."sumKvUsage"
        WHEN EXCLUDED."sumKvUsage" IS NULL THEN existing."sumKvUsage"
        ELSE existing."sumKvUsage" + EXCLUDED."sumKvUsage" END,
      ${nullableMax("maxKvUsage")},
      ${nullableMax("maxKvOccupancy")},
      ${nullableMax("maxSlotsBusy")},
      "fullSamples" = existing."fullSamples" + EXCLUDED."fullSamples",
      "prefixCacheHits" = LEAST(${RUNTIME_LOAD_ROLLUP_INT4_MAX}, existing."prefixCacheHits" + EXCLUDED."prefixCacheHits"),
      "prefixCacheQueries" = LEAST(${RUNTIME_LOAD_ROLLUP_INT4_MAX}, existing."prefixCacheQueries" + EXCLUDED."prefixCacheQueries"),
      "lastSource" = COALESCE(EXCLUDED."lastSource", existing."lastSource"),
      "versionId" = EXCLUDED."versionId",
      "nodeId" = EXCLUDED."nodeId",
      "updatedAt" = now()`;
}

export async function writeRuntimeLoadIncrements(
  increments: readonly RuntimeLoadIncrement[],
  db: { $executeRaw: (query: Prisma.Sql) => Promise<unknown> } = prisma,
): Promise<number> {
  const sorted = [...increments].sort((left, right) => {
    const a = runtimeLoadKey(left);
    const b = runtimeLoadKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  let written = 0;
  for (const increment of sorted) {
    if (isDbShutdownFenceArmed()) return written;
    try {
      await db.$executeRaw(upsertSql(increment));
      written += 1;
    } catch {
      /* One rejected row must not drop the rest of the flush. */
    }
  }
  return written;
}

export function createRuntimeLoadRollupWriter({
  clock = Date.now,
  write = writeRuntimeLoadIncrements,
  shutdown = isDbShutdownFenceArmed,
  log = (counts) => console.error("[runtime-load-rollup] flush failed", counts ?? {}),
}: {
  clock?: () => number;
  write?: (increments: RuntimeLoadIncrement[]) => Promise<number>;
  shutdown?: () => boolean;
  /** Called at most once a minute; `counts` when rows were rejected individually. */
  log?: (counts?: { written: number; failed: number }) => void;
} = {}) {
  const pending = new Map<string, RuntimeLoadIncrement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let lastLog = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
  };

  const runFlush = async () => {
    if (stopped || shutdown()) {
      stop();
      return;
    }
    const increments = [...pending.values()];
    pending.clear();
    lastFlush = clock();
    if (increments.length === 0) return;
    const written = await write(increments).catch(() => 0);
    if (written !== increments.length && !shutdown()) {
      const now = clock();
      if (now - lastLog >= 60_000) {
        lastLog = now;
        try {
          log({ written, failed: increments.length - written });
        } catch {
          /* Logging must not escape the relay path. */
        }
      }
    }
  };

  const flush = async () => {
    while (inFlight) await inFlight;
    const run = runFlush();
    inFlight = run.finally(() => {
      inFlight = undefined;
      if (pending.size > 0) schedule();
    });
    await inFlight;
  };

  function schedule() {
    if (timer !== undefined || stopped || pending.size === 0) return;
    const wait = Math.max(1, RUNTIME_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS - (clock() - lastFlush));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, wait);
    timer.unref?.();
  }

  const observe = (sample: RuntimeLoadSample) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (
        !sample.ownerUserId ||
        !sample.instanceId ||
        !Number.isFinite(sample.receivedAt.getTime()) ||
        !Number.isFinite(sample.running)
      )
        return;
      const key = runtimeLoadKey(sample);
      const current = pending.get(key);
      if (!current && pending.size >= RUNTIME_LOAD_ROLLUP_MAX_PENDING) return;
      pending.set(key, mergeRuntimeLoad(current, sample));
      schedule();
    } catch {
      /* Disposable optimization: observe never throws. */
    }
  };

  return { observe, stop, flushNow: flush };
}

const writer = createRuntimeLoadRollupWriter();
export const observeRuntimeLoadRollup = writer.observe;
export const stopRuntimeLoadRollup = writer.stop;
export const flushRuntimeLoadRollup = writer.flushNow;
