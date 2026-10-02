/**
 * Pure shaping of persisted engine-load minutes into Overview 24h/7d series.
 * Occupancy is carried for display and is never a FULL or eviction input.
 */
import type { OverviewWindow } from "./overview-metrics";

export type EngineLoadMinuteRow = {
  bucketStart: Date | string;
  capacityId: string;
  maxRunning: number;
  maxWaiting: number | null;
  maxKvUsage: number | null;
  maxKvOccupancy: number | null;
};

export type EngineLoadOverviewPoint = {
  start: string;
  running: number | null;
  waiting: number | null;
  kvUsage: number | null;
  kvOccupancy: number | null;
  gap: boolean;
};

function maxOpt(current: number | null, next: number | null | undefined): number | null {
  if (next == null || !Number.isFinite(next)) return current;
  if (current == null) return next;
  return Math.max(current, next);
}

export function shapeEngineLoadOverview({
  rows,
  capacityIds,
  window,
}: {
  rows: readonly EngineLoadMinuteRow[];
  capacityIds: readonly string[];
  window: OverviewWindow;
}): EngineLoadOverviewPoint[] {
  const wanted = new Set(capacityIds);
  const buckets = new Map<
    number,
    {
      running: number | null;
      waiting: number | null;
      kvUsage: number | null;
      kvOccupancy: number | null;
    }
  >();
  for (const row of rows) {
    if (!wanted.has(row.capacityId)) continue;
    const startMs = new Date(row.bucketStart).getTime();
    if (startMs < window.start.getTime() || startMs >= window.end.getTime()) continue;
    const bucket =
      window.start.getTime() +
      Math.floor((startMs - window.start.getTime()) / window.bucketMs) * window.bucketMs;
    const current = buckets.get(bucket) ?? {
      running: null,
      waiting: null,
      kvUsage: null,
      kvOccupancy: null,
    };
    buckets.set(bucket, {
      running: maxOpt(current.running, row.maxRunning),
      waiting: maxOpt(current.waiting, row.maxWaiting),
      kvUsage: maxOpt(current.kvUsage, row.maxKvUsage),
      kvOccupancy: maxOpt(current.kvOccupancy, row.maxKvOccupancy),
    });
  }
  const points: EngineLoadOverviewPoint[] = [];
  for (let index = 0; index < window.bucketCount; index += 1) {
    const startMs = window.start.getTime() + index * window.bucketMs;
    const value = buckets.get(startMs);
    points.push({
      start: new Date(startMs).toISOString(),
      running: value?.running ?? null,
      waiting: value?.waiting ?? null,
      kvUsage: value?.kvUsage ?? null,
      kvOccupancy: value?.kvOccupancy ?? null,
      gap: value === undefined,
    });
  }
  return points;
}
