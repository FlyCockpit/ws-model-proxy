/**
 * In-memory engine-load history: 10 s buckets for 30 minutes per
 * (cliDeviceId, endpointSlug, modelSlug). Lives on the session manager so a
 * reconnect does not wipe it. Caps bound memory; buckets older than the
 * window are pruned. Occupancy is stored for display and never used as FULL
 * or eviction evidence.
 */
export const ENGINE_LOAD_HISTORY_BUCKET_MS = 10_000;
export const ENGINE_LOAD_HISTORY_POINTS = 180;
export const ENGINE_LOAD_HISTORY_WINDOW_MS =
  ENGINE_LOAD_HISTORY_POINTS * ENGINE_LOAD_HISTORY_BUCKET_MS;
export const ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE = 64;
export const ENGINE_LOAD_HISTORY_MAX_KEYS = 2_000;

export type EngineLoadHistorySample = {
  running: number;
  waiting?: number;
  kvUsage?: number;
  kvOccupancy?: number;
  slotsBusy?: number;
  prefixCacheHitsDelta?: number;
  prefixCacheQueriesDelta?: number;
  source?: string;
  receivedAt: Date;
};

export type EngineLoadHistoryBucket = {
  startMs: number;
  running: number;
  waiting: number | null;
  kvUsage: number | null;
  kvOccupancy: number | null;
  slotsBusy: number | null;
  prefixCacheHits: number;
  prefixCacheQueries: number;
  source: string | null;
};

export type EngineLoadHistoryPoint = {
  start: Date;
  running: number | null;
  waiting: number | null;
  kvUsage: number | null;
  kvOccupancy: number | null;
  slotsBusy: number | null;
  prefixCacheHits: number;
  prefixCacheQueries: number;
  source: string | null;
  gap: boolean;
};

export type EngineLoadHistoryKey = {
  cliDeviceId: string;
  endpointSlug: string;
  modelSlug: string | null;
};

type Ring = {
  cliDeviceId: string;
  buckets: Map<number, EngineLoadHistoryBucket>;
  lastMs: number;
};

export function historyKey(
  cliDeviceId: string,
  endpointSlug: string,
  modelSlug: string | null,
): string {
  return `${cliDeviceId}\u0000${endpointSlug}\u0000${modelSlug ?? ""}`;
}

export function bucketStartMs(tsMs: number): number {
  return Math.floor(tsMs / ENGINE_LOAD_HISTORY_BUCKET_MS) * ENGINE_LOAD_HISTORY_BUCKET_MS;
}

export function windowStartMs(nowMs: number): number {
  return bucketStartMs(nowMs) - (ENGINE_LOAD_HISTORY_POINTS - 1) * ENGINE_LOAD_HISTORY_BUCKET_MS;
}

function maxOpt(current: number | null, next: number | undefined): number | null {
  if (typeof next !== "number" || !Number.isFinite(next)) return current;
  return current === null ? next : Math.max(current, next);
}

export function mergeSampleIntoBucket(
  existing: EngineLoadHistoryBucket | undefined,
  sample: EngineLoadHistorySample,
): EngineLoadHistoryBucket {
  const startMs = bucketStartMs(sample.receivedAt.getTime());
  return {
    startMs,
    running: existing ? Math.max(existing.running, sample.running) : sample.running,
    waiting: maxOpt(existing?.waiting ?? null, sample.waiting),
    kvUsage: maxOpt(existing?.kvUsage ?? null, sample.kvUsage),
    kvOccupancy: maxOpt(existing?.kvOccupancy ?? null, sample.kvOccupancy),
    slotsBusy: maxOpt(existing?.slotsBusy ?? null, sample.slotsBusy),
    prefixCacheHits: (existing?.prefixCacheHits ?? 0) + (sample.prefixCacheHitsDelta ?? 0),
    prefixCacheQueries: (existing?.prefixCacheQueries ?? 0) + (sample.prefixCacheQueriesDelta ?? 0),
    source: sample.source ?? existing?.source ?? null,
  };
}

export function expandHistorySeries(
  buckets: Iterable<EngineLoadHistoryBucket>,
  now: Date,
): EngineLoadHistoryPoint[] {
  const windowStart = windowStartMs(now.getTime());
  const end = bucketStartMs(now.getTime());
  const byStart = new Map<number, EngineLoadHistoryBucket>();
  for (const bucket of buckets) {
    if (bucket.startMs >= windowStart && bucket.startMs <= end) byStart.set(bucket.startMs, bucket);
  }
  const points: EngineLoadHistoryPoint[] = [];
  for (let startMs = windowStart; startMs <= end; startMs += ENGINE_LOAD_HISTORY_BUCKET_MS) {
    const bucket = byStart.get(startMs);
    if (!bucket) {
      points.push({
        start: new Date(startMs),
        running: null,
        waiting: null,
        kvUsage: null,
        kvOccupancy: null,
        slotsBusy: null,
        prefixCacheHits: 0,
        prefixCacheQueries: 0,
        source: null,
        gap: true,
      });
      continue;
    }
    points.push({
      start: new Date(startMs),
      running: bucket.running,
      waiting: bucket.waiting,
      kvUsage: bucket.kvUsage,
      kvOccupancy: bucket.kvOccupancy,
      slotsBusy: bucket.slotsBusy,
      prefixCacheHits: bucket.prefixCacheHits,
      prefixCacheQueries: bucket.prefixCacheQueries,
      source: bucket.source,
      gap: false,
    });
  }
  return points;
}

export class EngineLoadHistoryStore {
  private rings = new Map<string, Ring>();
  private keysByDevice = new Map<string, Set<string>>();

  get size(): number {
    return this.rings.size;
  }

  deviceKeyCount(cliDeviceId: string): number {
    return this.keysByDevice.get(cliDeviceId)?.size ?? 0;
  }

  record(
    cliDeviceId: string,
    endpointSlug: string,
    modelSlug: string | null,
    sample: EngineLoadHistorySample,
  ): boolean {
    const key = historyKey(cliDeviceId, endpointSlug, modelSlug);
    const existing = this.rings.get(key);
    if (!existing) {
      if (
        (this.keysByDevice.get(cliDeviceId)?.size ?? 0) >= ENGINE_LOAD_HISTORY_MAX_KEYS_PER_DEVICE
      ) {
        return false;
      }
      if (this.rings.size >= ENGINE_LOAD_HISTORY_MAX_KEYS) return false;
    }
    const receivedMs = sample.receivedAt.getTime();
    this.pruneRing(existing, receivedMs);
    const startMs = bucketStartMs(receivedMs);
    const bucket = mergeSampleIntoBucket(existing?.buckets.get(startMs), sample);
    if (!existing) {
      const buckets = new Map<number, EngineLoadHistoryBucket>([[startMs, bucket]]);
      this.rings.set(key, { cliDeviceId, buckets, lastMs: receivedMs });
      const set = this.keysByDevice.get(cliDeviceId) ?? new Set<string>();
      set.add(key);
      this.keysByDevice.set(cliDeviceId, set);
      return true;
    }
    existing.buckets.set(startMs, bucket);
    existing.lastMs = Math.max(existing.lastMs, receivedMs);
    return true;
  }

  series(
    cliDeviceId: string,
    endpointSlug: string,
    modelSlug: string | null,
    now: Date,
  ): EngineLoadHistoryPoint[] {
    const ring = this.rings.get(historyKey(cliDeviceId, endpointSlug, modelSlug));
    this.pruneRing(ring, now.getTime());
    if (ring && ring.buckets.size === 0) {
      this.drop(historyKey(cliDeviceId, endpointSlug, modelSlug), cliDeviceId);
    }
    return expandHistorySeries(ring?.buckets.values() ?? [], now);
  }

  snapshot(
    keys: readonly EngineLoadHistoryKey[],
    now: Date,
  ): Array<EngineLoadHistoryKey & { series: EngineLoadHistoryPoint[] }> {
    return keys.map((key) => ({
      ...key,
      series: this.series(key.cliDeviceId, key.endpointSlug, key.modelSlug, now),
    }));
  }

  prune(now: Date): void {
    for (const [key, ring] of [...this.rings]) {
      this.pruneRing(ring, now.getTime());
      if (ring.buckets.size === 0) this.drop(key, ring.cliDeviceId);
    }
  }

  private pruneRing(ring: Ring | undefined, nowMs: number): void {
    if (!ring) return;
    const windowStart = windowStartMs(nowMs);
    for (const startMs of [...ring.buckets.keys()]) {
      if (startMs < windowStart) ring.buckets.delete(startMs);
    }
  }

  private drop(key: string, cliDeviceId: string): void {
    this.rings.delete(key);
    const set = this.keysByDevice.get(cliDeviceId);
    set?.delete(key);
    if (set && set.size === 0) this.keysByDevice.delete(cliDeviceId);
  }
}
