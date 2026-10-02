/**
 * Batched class-H writer for engine_load_rollup_minute. Accepted
 * `endpoint.load` frames are merged in memory and flushed in sorted key
 * order. Occupancy is stored for display and never used as FULL or eviction
 * evidence. Samples without a capacity are dropped at flush.
 */
import prisma, { Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const ENGINE_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS = 1000;
export const ENGINE_LOAD_ROLLUP_MAX_PENDING = 2000;
const MINUTE_MS = 60_000;
const CAPACITY_CACHE_MS = 30_000;

export type EngineLoadRollupSample = {
  ownerUserId: string;
  cliDeviceId: string;
  endpointSlug: string;
  modelSlug: string | null;
  receivedAt: Date;
  running: number;
  waiting?: number;
  kvUsage?: number;
  kvOccupancy?: number;
  slotsBusy?: number;
  prefixCacheHitsDelta?: number;
  prefixCacheQueriesDelta?: number;
  source?: string;
};

export type EngineLoadRollupIncrement = {
  bucketStart: Date;
  ownerUserId: string;
  capacityId: string;
  endpointSlug: string;
  modelSlug: string;
  cliDeviceId: string;
  samples: number;
  maxRunning: number;
  maxWaiting: number | null;
  maxKvUsage: number | null;
  maxKvOccupancy: number | null;
  maxSlotsBusy: number | null;
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

function pendingKey(sample: EngineLoadRollupSample): string {
  return [
    sample.ownerUserId,
    sample.cliDeviceId,
    sample.endpointSlug,
    sample.modelSlug ?? "",
    String(truncateToMinute(sample.receivedAt).getTime()),
  ].join("\u0000");
}

export function mergeEngineLoadIncrements(
  current: EngineLoadRollupIncrement | undefined,
  sample: EngineLoadRollupSample,
  capacityId: string,
): EngineLoadRollupIncrement {
  const next: EngineLoadRollupIncrement = current ?? {
    bucketStart: truncateToMinute(sample.receivedAt),
    ownerUserId: sample.ownerUserId,
    capacityId,
    endpointSlug: sample.endpointSlug,
    modelSlug: sample.modelSlug ?? "",
    cliDeviceId: sample.cliDeviceId,
    samples: 0,
    maxRunning: 0,
    maxWaiting: null,
    maxKvUsage: null,
    maxKvOccupancy: null,
    maxSlotsBusy: null,
    prefixCacheHits: 0,
    prefixCacheQueries: 0,
    lastSource: null,
  };
  return {
    ...next,
    samples: next.samples + 1,
    maxRunning: Math.max(next.maxRunning, sample.running),
    maxWaiting: maxOpt(next.maxWaiting, sample.waiting),
    maxKvUsage: maxOpt(next.maxKvUsage, sample.kvUsage),
    maxKvOccupancy: maxOpt(next.maxKvOccupancy, sample.kvOccupancy),
    maxSlotsBusy: maxOpt(next.maxSlotsBusy, sample.slotsBusy),
    prefixCacheHits: next.prefixCacheHits + Math.max(0, sample.prefixCacheHitsDelta ?? 0),
    prefixCacheQueries: next.prefixCacheQueries + Math.max(0, sample.prefixCacheQueriesDelta ?? 0),
    lastSource: sample.source ?? next.lastSource,
  };
}

export function incrementKeyString(increment: EngineLoadRollupIncrement): string {
  return [
    increment.bucketStart.toISOString(),
    increment.ownerUserId,
    increment.capacityId,
    increment.endpointSlug,
    increment.modelSlug,
  ].join("\u0000");
}

function upsertSql(increment: EngineLoadRollupIncrement): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO engine_load_rollup_minute AS existing
      ("bucketStart", "ownerUserId", "capacityId", "endpointSlug", "modelSlug", "cliDeviceId",
       samples, "maxRunning", "maxWaiting", "maxKvUsage", "maxKvOccupancy", "maxSlotsBusy",
       "prefixCacheHits", "prefixCacheQueries", "lastSource")
    VALUES (${increment.bucketStart}, ${increment.ownerUserId}, ${increment.capacityId},
      ${increment.endpointSlug}, ${increment.modelSlug}, ${increment.cliDeviceId},
      ${increment.samples}, ${increment.maxRunning}, ${increment.maxWaiting},
      ${increment.maxKvUsage}, ${increment.maxKvOccupancy}, ${increment.maxSlotsBusy},
      ${increment.prefixCacheHits}, ${increment.prefixCacheQueries}, ${increment.lastSource})
    ON CONFLICT ("bucketStart", "ownerUserId", "capacityId", "endpointSlug", "modelSlug")
    DO UPDATE SET
      samples = existing.samples + EXCLUDED.samples,
      "maxRunning" = GREATEST(existing."maxRunning", EXCLUDED."maxRunning"),
      "maxWaiting" = CASE
        WHEN existing."maxWaiting" IS NULL THEN EXCLUDED."maxWaiting"
        WHEN EXCLUDED."maxWaiting" IS NULL THEN existing."maxWaiting"
        ELSE GREATEST(existing."maxWaiting", EXCLUDED."maxWaiting") END,
      "maxKvUsage" = CASE
        WHEN existing."maxKvUsage" IS NULL THEN EXCLUDED."maxKvUsage"
        WHEN EXCLUDED."maxKvUsage" IS NULL THEN existing."maxKvUsage"
        ELSE GREATEST(existing."maxKvUsage", EXCLUDED."maxKvUsage") END,
      "maxKvOccupancy" = CASE
        WHEN existing."maxKvOccupancy" IS NULL THEN EXCLUDED."maxKvOccupancy"
        WHEN EXCLUDED."maxKvOccupancy" IS NULL THEN existing."maxKvOccupancy"
        ELSE GREATEST(existing."maxKvOccupancy", EXCLUDED."maxKvOccupancy") END,
      "maxSlotsBusy" = CASE
        WHEN existing."maxSlotsBusy" IS NULL THEN EXCLUDED."maxSlotsBusy"
        WHEN EXCLUDED."maxSlotsBusy" IS NULL THEN existing."maxSlotsBusy"
        ELSE GREATEST(existing."maxSlotsBusy", EXCLUDED."maxSlotsBusy") END,
      "prefixCacheHits" = existing."prefixCacheHits" + EXCLUDED."prefixCacheHits",
      "prefixCacheQueries" = existing."prefixCacheQueries" + EXCLUDED."prefixCacheQueries",
      "lastSource" = COALESCE(EXCLUDED."lastSource", existing."lastSource"),
      "cliDeviceId" = EXCLUDED."cliDeviceId",
      "updatedAt" = now()`;
}

type CapacityRow = { capacityId: string; endpointSlug: string; modelSlug: string };
type CapacityCache = { at: number; rows: CapacityRow[] };

export async function writeEngineLoadIncrements(
  increments: readonly EngineLoadRollupIncrement[],
  db: Pick<typeof prisma, "$executeRaw"> = prisma,
): Promise<number> {
  const sorted = [...increments].sort((left, right) => {
    const a = incrementKeyString(left);
    const b = incrementKeyString(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const increment of sorted) {
    if (isDbShutdownFenceArmed()) return 0;
    await db.$executeRaw(upsertSql(increment));
  }
  return sorted.length;
}

export function createEngineLoadRollupWriter({
  clock = Date.now,
  write = writeEngineLoadIncrements,
  resolveCapacities = defaultResolveCapacities,
  shutdown = isDbShutdownFenceArmed,
  log = () => console.error("[engine-load-rollup] flush failed"),
}: {
  clock?: () => number;
  write?: (increments: EngineLoadRollupIncrement[]) => Promise<number>;
  resolveCapacities?: (ownerUserId: string, cliDeviceId: string) => Promise<CapacityRow[]>;
  shutdown?: () => boolean;
  log?: () => void;
} = {}) {
  const pending = new Map<string, EngineLoadRollupSample[]>();
  const capacityCache = new Map<string, CapacityCache>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let inFlight: Promise<void> | undefined;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let lastLog = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    capacityCache.clear();
  };

  const schedule = () => {
    if (timer !== undefined || stopped || pending.size === 0) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (stopped || shutdown()) {
          stop();
          return;
        }
        if (writing) {
          schedule();
          return;
        }
        void flush();
      },
      writing
        ? ENGINE_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS
        : Math.max(1, ENGINE_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS - Math.max(0, clock() - lastFlush)),
    );
    timer.unref?.();
  };

  const runFlush = async () => {
    if (stopped || shutdown()) {
      stop();
      return;
    }
    const batches = [...pending.entries()];
    pending.clear();
    lastFlush = clock();
    if (batches.length === 0) return;
    writing = true;
    try {
      const increments: EngineLoadRollupIncrement[] = [];
      const grouped = new Map<string, EngineLoadRollupSample[]>();
      for (const [, samples] of batches) {
        const first = samples[0];
        if (!first) continue;
        const groupKey = `${first.ownerUserId}\u0000${first.cliDeviceId}`;
        grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), ...samples]);
      }
      for (const [groupKey, samples] of grouped) {
        const [ownerUserId = "", cliDeviceId = ""] = groupKey.split("\u0000");
        const cached = capacityCache.get(cliDeviceId);
        const rows =
          cached && clock() - cached.at < CAPACITY_CACHE_MS
            ? cached.rows
            : await resolveCapacities(ownerUserId, cliDeviceId);
        if (!cached || clock() - cached.at >= CAPACITY_CACHE_MS)
          capacityCache.set(cliDeviceId, { at: clock(), rows });
        const byEndpoint = new Map(
          rows.map((row) => [`${row.endpointSlug}\u0000${row.modelSlug}`, row.capacityId]),
        );
        const merged = new Map<string, EngineLoadRollupIncrement>();
        for (const sample of samples) {
          const capacityId = byEndpoint.get(
            `${sample.endpointSlug}\u0000${sample.modelSlug ?? ""}`,
          );
          if (!capacityId) continue;
          const key = `${capacityId}\u0000${pendingKey(sample)}`;
          merged.set(key, mergeEngineLoadIncrements(merged.get(key), sample, capacityId));
        }
        increments.push(...merged.values());
      }
      if (increments.length > 0 && !stopped && !shutdown()) await write(increments);
    } catch {
      const failedAt = clock();
      if (failedAt - lastLog >= 60_000) {
        lastLog = failedAt;
        try {
          log();
        } catch {
          /* Logging must not escape the request path. */
        }
      }
    } finally {
      writing = false;
      schedule();
    }
  };

  const flush = async () => {
    if (inFlight) {
      await inFlight;
      if (pending.size === 0 || stopped) return;
    }
    const run = runFlush();
    inFlight = run.finally(() => {
      if (inFlight === run) inFlight = undefined;
    });
    await inFlight;
  };

  const observe = (sample: EngineLoadRollupSample) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (
        !sample.ownerUserId ||
        !sample.cliDeviceId ||
        !sample.endpointSlug ||
        !Number.isFinite(sample.receivedAt.getTime()) ||
        !Number.isFinite(sample.running)
      )
        return;
      const key = pendingKey(sample);
      let bucket = pending.get(key);
      if (!bucket) {
        if (pending.size >= ENGINE_LOAD_ROLLUP_MAX_PENDING) return;
        bucket = [];
        pending.set(key, bucket);
      }
      bucket.push(sample);
      if (!writing && clock() - lastFlush >= ENGINE_LOAD_ROLLUP_FLUSH_MIN_INTERVAL_MS) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        void flush();
      } else schedule();
    } catch {
      /* Disposable optimization: observe never throws. */
    }
  };

  return { observe, stop, flushNow: flush };
}

async function defaultResolveCapacities(
  ownerUserId: string,
  cliDeviceId: string,
): Promise<CapacityRow[]> {
  const targets = await prisma.executionTarget.findMany({
    where: {
      userId: ownerUserId,
      inferenceCapacityId: { not: null },
      DiscoveredModel: { Endpoint: { cliDeviceId } },
    },
    select: {
      inferenceCapacityId: true,
      DiscoveredModel: { select: { slug: true, Endpoint: { select: { slug: true } } } },
    },
  });
  return targets.flatMap((target) => {
    if (!target.inferenceCapacityId || !target.DiscoveredModel) return [];
    return [
      {
        capacityId: target.inferenceCapacityId,
        endpointSlug: target.DiscoveredModel.Endpoint.slug,
        modelSlug: target.DiscoveredModel.slug ?? "",
      },
    ];
  });
}

const writer = createEngineLoadRollupWriter();
export const observeEngineLoadRollup = writer.observe;
export const stopEngineLoadRollup = writer.stop;
