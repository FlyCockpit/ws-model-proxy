/**
 * Live engine load the relay holds in memory (`runtime.load` frames), as the runtime and pool
 * views read it. Only the server process holding a node's relay session knows its load: an
 * instance missing from the reader's answer is unknown (null in the views), never idle (0).
 */

/** One instance's freshest engine load; a field is null when the engine did not report it. */
export type InstanceLiveLoad = {
  running: number | null;
  waiting: number | null;
  /** KV cache usage, 0..1. */
  kvUsage: number | null;
  /** When the relay received the reading. */
  at: Date;
};

/**
 * Reads the fresh live load of the given instances: an in-memory lookup, no I/O. The caller
 * passes only instance ids it already read under its own access checks.
 */
export type LiveLoadReader = (
  instanceIds: readonly string[],
) => ReadonlyMap<string, InstanceLiveLoad>;

export const NO_LIVE_LOAD: ReadonlyMap<string, InstanceLiveLoad> = new Map();

/** The reader's answer, or nothing known when it is absent or fails (views degrade to null). */
export function readLiveLoad(
  reader: LiveLoadReader | undefined,
  instanceIds: readonly string[],
): ReadonlyMap<string, InstanceLiveLoad> {
  if (!reader || instanceIds.length === 0) return NO_LIVE_LOAD;
  try {
    return reader(instanceIds);
  } catch {
    return NO_LIVE_LOAD;
  }
}

/** A relay reading as the session holds it (`runtime.load`, resolved to its instance). */
export type InstanceLoadReading = {
  instanceId: string;
  /** Null: the reading covers the whole engine; else one model it serves. */
  modelSlug: string | null;
  running: number;
  waiting?: number;
  kvUsage?: number;
  receivedAt: Date;
};

function sumKnown(values: ReadonlyArray<number | undefined>): number | null {
  let sum: number | null = null;
  for (const value of values) if (value !== undefined) sum = (sum ?? 0) + value;
  return sum;
}

/**
 * Each wanted instance's load from fresh readings (older than `staleAfterMs`: unknown). An
 * engine-wide reading speaks for the instance; otherwise its per-model readings add up (KV is
 * the fullest model's).
 */
export function aggregateInstanceLoad(
  readings: Iterable<InstanceLoadReading>,
  instanceIds: ReadonlySet<string>,
  nowMs: number,
  staleAfterMs: number,
): Map<string, InstanceLiveLoad> {
  const byInstance = new Map<string, InstanceLoadReading[]>();
  for (const reading of readings) {
    if (!instanceIds.has(reading.instanceId)) continue;
    if (nowMs - reading.receivedAt.getTime() > staleAfterMs) continue;
    const list = byInstance.get(reading.instanceId) ?? [];
    list.push(reading);
    byInstance.set(reading.instanceId, list);
  }
  const result = new Map<string, InstanceLiveLoad>();
  for (const [instanceId, list] of byInstance) {
    const engineWide = list.filter((reading) => reading.modelSlug === null);
    const freshest = engineWide.reduce<InstanceLoadReading | null>(
      (best, reading) =>
        best && best.receivedAt.getTime() >= reading.receivedAt.getTime() ? best : reading,
      null,
    );
    const used = freshest ? [freshest] : list;
    const kv = used.flatMap((reading) => (reading.kvUsage === undefined ? [] : [reading.kvUsage]));
    result.set(instanceId, {
      running: sumKnown(used.map((reading) => reading.running)),
      waiting: sumKnown(used.map((reading) => reading.waiting)),
      kvUsage: kv.length > 0 ? Math.max(...kv) : null,
      at: new Date(Math.max(...used.map((reading) => reading.receivedAt.getTime()))),
    });
  }
  return result;
}
