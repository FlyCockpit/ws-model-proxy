/**
 * Batched class-H writer for node_metrics_minute. Accepted `node.metrics`
 * frames are merged in memory and flushed in sorted key order. Display only.
 * Failed batches are isolated per row and reported with operational counts.
 * No retry contract: increments are additive, so an uncertain commit cannot
 * be retried safely without durable idempotency. Keep at most 2000 pending +
 * 2000 in-flight increments; do not retain an unbounded failed-row queue.
 */
import prisma, { Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const NODE_METRICS_ROLLUP_FLUSH_MIN_INTERVAL_MS = 1000;
export const NODE_METRICS_ROLLUP_MAX_PENDING = 2000;
const MINUTE_MS = 60_000;

export type NodeMetricsRollupSample = {
  ownerUserId: string;
  nodeId: string;
  receivedAt: Date;
  cpuPercent?: number | null;
  memoryAvailableMiB?: number | null;
  memoryTotalMiB?: number | null;
  gpuTemperatureC?: number | null;
  gpuUtilizationPercent?: number | null;
  /** Free VRAM summed over the GPUs that report both used and total. */
  acceleratorFreeMiB?: number | null;
  /** Node metric command values (`node.metrics.custom`), every label set a sample of its name. */
  custom?: ReadonlyArray<{ name: string; value: number }>;
};

/** One custom metric's minute aggregate (the `custom` JSON column, one entry per name). */
export type CustomMetricAggregate = { min: number; sum: number; max: number; samples: number };

/**
 * Names kept per node-minute: what one frame may carry (16 metric commands × 16 values) and the
 * hardening CHECK allows.
 */
export const NODE_METRICS_CUSTOM_MAX_NAMES = 256;
/** Larger magnitudes are dropped so sums stay finite (JSON has no Infinity). */
const CUSTOM_MAX_ABS = 1e15;
const CUSTOM_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

export type NodeMetricsRollupIncrement = {
  bucketStart: Date;
  ownerUserId: string;
  nodeId: string;
  samples: number;
  cpuSamples: number;
  minCpuPercent: number | null;
  sumCpuPercent: number | null;
  maxCpuPercent: number | null;
  memorySamples: number;
  minMemoryAvailableMiB: number | null;
  sumMemoryAvailableMiB: number | null;
  maxMemoryAvailableMiB: number | null;
  minMemoryUsedPercent: number | null;
  sumMemoryUsedPercent: number | null;
  maxMemoryUsedPercent: number | null;
  maxGpuTemperatureC: number | null;
  maxGpuUtilizationPercent: number | null;
  minAcceleratorFreeMiB: number | null;
  custom: Record<string, CustomMetricAggregate>;
};

export function truncateToMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / MINUTE_MS) * MINUTE_MS);
}

function finite(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

function minOpt(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  if (current == null) return next;
  return Math.min(current, next);
}

function maxOpt(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  if (current == null) return next;
  return Math.max(current, next);
}

function addOpt(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  return (current ?? 0) + next;
}

function mergeCustom(
  current: Record<string, CustomMetricAggregate>,
  values: NodeMetricsRollupSample["custom"],
): Record<string, CustomMetricAggregate> {
  if (!values || values.length === 0) return current;
  const next = { ...current };
  for (const { name, value } of values) {
    if (!CUSTOM_NAME.test(name) || !Number.isFinite(value) || Math.abs(value) > CUSTOM_MAX_ABS)
      continue;
    const entry = next[name];
    if (entry) {
      next[name] = {
        min: Math.min(entry.min, value),
        sum: entry.sum + value,
        max: Math.max(entry.max, value),
        samples: entry.samples + 1,
      };
    } else if (Object.keys(next).length < NODE_METRICS_CUSTOM_MAX_NAMES) {
      next[name] = { min: value, sum: value, max: value, samples: 1 };
    }
  }
  return next;
}

function memoryUsedPercent(available: number | null, total: number | null): number | null {
  if (available == null || total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
}

function pendingKey(sample: NodeMetricsRollupSample): string {
  return [
    sample.ownerUserId,
    sample.nodeId,
    String(truncateToMinute(sample.receivedAt).getTime()),
  ].join("\u0000");
}

export function mergeNodeMetricsIncrements(
  current: NodeMetricsRollupIncrement | undefined,
  sample: NodeMetricsRollupSample,
): NodeMetricsRollupIncrement {
  const cpu = finite(sample.cpuPercent);
  const available = finite(sample.memoryAvailableMiB);
  const used = memoryUsedPercent(available, finite(sample.memoryTotalMiB));
  const temp = finite(sample.gpuTemperatureC);
  const util = finite(sample.gpuUtilizationPercent);
  const next: NodeMetricsRollupIncrement = current ?? {
    bucketStart: truncateToMinute(sample.receivedAt),
    ownerUserId: sample.ownerUserId,
    nodeId: sample.nodeId,
    samples: 0,
    cpuSamples: 0,
    minCpuPercent: null,
    sumCpuPercent: null,
    maxCpuPercent: null,
    memorySamples: 0,
    minMemoryAvailableMiB: null,
    sumMemoryAvailableMiB: null,
    maxMemoryAvailableMiB: null,
    minMemoryUsedPercent: null,
    sumMemoryUsedPercent: null,
    maxMemoryUsedPercent: null,
    maxGpuTemperatureC: null,
    maxGpuUtilizationPercent: null,
    minAcceleratorFreeMiB: null,
    custom: {},
  };
  return {
    ...next,
    samples: next.samples + 1,
    cpuSamples: next.cpuSamples + (cpu == null ? 0 : 1),
    minCpuPercent: minOpt(next.minCpuPercent, cpu),
    sumCpuPercent: addOpt(next.sumCpuPercent, cpu),
    maxCpuPercent: maxOpt(next.maxCpuPercent, cpu),
    memorySamples: next.memorySamples + (available == null ? 0 : 1),
    minMemoryAvailableMiB: minOpt(next.minMemoryAvailableMiB, available),
    sumMemoryAvailableMiB: addOpt(next.sumMemoryAvailableMiB, available),
    maxMemoryAvailableMiB: maxOpt(next.maxMemoryAvailableMiB, available),
    minMemoryUsedPercent: minOpt(next.minMemoryUsedPercent, used),
    sumMemoryUsedPercent: addOpt(next.sumMemoryUsedPercent, used),
    maxMemoryUsedPercent: maxOpt(next.maxMemoryUsedPercent, used),
    maxGpuTemperatureC: maxOpt(next.maxGpuTemperatureC, temp),
    maxGpuUtilizationPercent: maxOpt(next.maxGpuUtilizationPercent, util),
    minAcceleratorFreeMiB: minOpt(next.minAcceleratorFreeMiB, finite(sample.acceleratorFreeMiB)),
    custom: mergeCustom(next.custom, sample.custom),
  };
}

export function incrementKeyString(increment: NodeMetricsRollupIncrement): string {
  return [increment.bucketStart.toISOString(), increment.ownerUserId, increment.nodeId].join(
    "\u0000",
  );
}

/**
 * The accelerator minimum, and the custom aggregates merged per name: min/max/sum/samples
 * combine; names already stored win the 16-name cap over new ones.
 */
function mergeAcceleratorAndCustom(): Prisma.Sql {
  return Prisma.sql`"minAcceleratorFreeMiB" = CASE
        WHEN existing."minAcceleratorFreeMiB" IS NULL THEN EXCLUDED."minAcceleratorFreeMiB"
        WHEN EXCLUDED."minAcceleratorFreeMiB" IS NULL THEN existing."minAcceleratorFreeMiB"
        ELSE LEAST(existing."minAcceleratorFreeMiB", EXCLUDED."minAcceleratorFreeMiB") END,
      custom = (
        SELECT COALESCE(jsonb_object_agg(names.name, CASE
          WHEN NOT (existing.custom ? names.name) THEN EXCLUDED.custom -> names.name
          WHEN NOT (EXCLUDED.custom ? names.name) THEN existing.custom -> names.name
          ELSE jsonb_build_object(
            'min', LEAST((existing.custom -> names.name ->> 'min')::float8,
                         (EXCLUDED.custom -> names.name ->> 'min')::float8),
            'sum', (existing.custom -> names.name ->> 'sum')::float8
                   + (EXCLUDED.custom -> names.name ->> 'sum')::float8,
            'max', GREATEST((existing.custom -> names.name ->> 'max')::float8,
                            (EXCLUDED.custom -> names.name ->> 'max')::float8),
            'samples', (existing.custom -> names.name ->> 'samples')::bigint
                       + (EXCLUDED.custom -> names.name ->> 'samples')::bigint) END), '{}'::jsonb)
        FROM (
          SELECT name FROM (
            SELECT name, 0 AS rank FROM jsonb_object_keys(existing.custom) AS name
            UNION ALL
            SELECT name, 1 AS rank FROM jsonb_object_keys(EXCLUDED.custom) AS name
              WHERE NOT (existing.custom ? name)
          ) AS candidates
          ORDER BY rank, name
          LIMIT ${NODE_METRICS_CUSTOM_MAX_NAMES}
        ) AS names
      )`;
}

function upsertSql(increment: NodeMetricsRollupIncrement): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO node_metrics_minute AS existing
      ("bucketStart", "ownerUserId", "nodeId", samples, "cpuSamples",
       "minCpuPercent", "sumCpuPercent", "maxCpuPercent", "memorySamples",
       "minMemoryAvailableMiB", "sumMemoryAvailableMiB", "maxMemoryAvailableMiB",
       "minMemoryUsedPercent", "sumMemoryUsedPercent", "maxMemoryUsedPercent",
       "maxGpuTemperatureC", "maxGpuUtilizationPercent", "minAcceleratorFreeMiB", custom)
    VALUES (${increment.bucketStart}, ${increment.ownerUserId}, ${increment.nodeId},
      ${increment.samples}, ${increment.cpuSamples},
      ${increment.minCpuPercent}, ${increment.sumCpuPercent}, ${increment.maxCpuPercent},
      ${increment.memorySamples}, ${increment.minMemoryAvailableMiB},
      ${increment.sumMemoryAvailableMiB}, ${increment.maxMemoryAvailableMiB},
      ${increment.minMemoryUsedPercent}, ${increment.sumMemoryUsedPercent},
      ${increment.maxMemoryUsedPercent}, ${increment.maxGpuTemperatureC},
      ${increment.maxGpuUtilizationPercent}, ${increment.minAcceleratorFreeMiB},
      ${JSON.stringify(increment.custom)}::jsonb)
    ON CONFLICT ("bucketStart", "ownerUserId", "nodeId")
    DO UPDATE SET
      samples = existing.samples + EXCLUDED.samples,
      "cpuSamples" = existing."cpuSamples" + EXCLUDED."cpuSamples",
      "minCpuPercent" = CASE
        WHEN existing."minCpuPercent" IS NULL THEN EXCLUDED."minCpuPercent"
        WHEN EXCLUDED."minCpuPercent" IS NULL THEN existing."minCpuPercent"
        ELSE LEAST(existing."minCpuPercent", EXCLUDED."minCpuPercent") END,
      "sumCpuPercent" = COALESCE(existing."sumCpuPercent", 0) + COALESCE(EXCLUDED."sumCpuPercent", 0),
      "maxCpuPercent" = CASE
        WHEN existing."maxCpuPercent" IS NULL THEN EXCLUDED."maxCpuPercent"
        WHEN EXCLUDED."maxCpuPercent" IS NULL THEN existing."maxCpuPercent"
        ELSE GREATEST(existing."maxCpuPercent", EXCLUDED."maxCpuPercent") END,
      "memorySamples" = existing."memorySamples" + EXCLUDED."memorySamples",
      "minMemoryAvailableMiB" = CASE
        WHEN existing."minMemoryAvailableMiB" IS NULL THEN EXCLUDED."minMemoryAvailableMiB"
        WHEN EXCLUDED."minMemoryAvailableMiB" IS NULL THEN existing."minMemoryAvailableMiB"
        ELSE LEAST(existing."minMemoryAvailableMiB", EXCLUDED."minMemoryAvailableMiB") END,
      "sumMemoryAvailableMiB" = COALESCE(existing."sumMemoryAvailableMiB", 0)
        + COALESCE(EXCLUDED."sumMemoryAvailableMiB", 0),
      "maxMemoryAvailableMiB" = CASE
        WHEN existing."maxMemoryAvailableMiB" IS NULL THEN EXCLUDED."maxMemoryAvailableMiB"
        WHEN EXCLUDED."maxMemoryAvailableMiB" IS NULL THEN existing."maxMemoryAvailableMiB"
        ELSE GREATEST(existing."maxMemoryAvailableMiB", EXCLUDED."maxMemoryAvailableMiB") END,
      "minMemoryUsedPercent" = CASE
        WHEN existing."minMemoryUsedPercent" IS NULL THEN EXCLUDED."minMemoryUsedPercent"
        WHEN EXCLUDED."minMemoryUsedPercent" IS NULL THEN existing."minMemoryUsedPercent"
        ELSE LEAST(existing."minMemoryUsedPercent", EXCLUDED."minMemoryUsedPercent") END,
      "sumMemoryUsedPercent" = COALESCE(existing."sumMemoryUsedPercent", 0)
        + COALESCE(EXCLUDED."sumMemoryUsedPercent", 0),
      "maxMemoryUsedPercent" = CASE
        WHEN existing."maxMemoryUsedPercent" IS NULL THEN EXCLUDED."maxMemoryUsedPercent"
        WHEN EXCLUDED."maxMemoryUsedPercent" IS NULL THEN existing."maxMemoryUsedPercent"
        ELSE GREATEST(existing."maxMemoryUsedPercent", EXCLUDED."maxMemoryUsedPercent") END,
      "maxGpuTemperatureC" = CASE
        WHEN existing."maxGpuTemperatureC" IS NULL THEN EXCLUDED."maxGpuTemperatureC"
        WHEN EXCLUDED."maxGpuTemperatureC" IS NULL THEN existing."maxGpuTemperatureC"
        ELSE GREATEST(existing."maxGpuTemperatureC", EXCLUDED."maxGpuTemperatureC") END,
      "maxGpuUtilizationPercent" = CASE
        WHEN existing."maxGpuUtilizationPercent" IS NULL THEN EXCLUDED."maxGpuUtilizationPercent"
        WHEN EXCLUDED."maxGpuUtilizationPercent" IS NULL THEN existing."maxGpuUtilizationPercent"
        ELSE GREATEST(existing."maxGpuUtilizationPercent", EXCLUDED."maxGpuUtilizationPercent") END,
      ${mergeAcceleratorAndCustom()},
      "updatedAt" = now()`;
}

function incrementValues(increment: NodeMetricsRollupIncrement): Prisma.Sql {
  return Prisma.sql`(${increment.bucketStart}, ${increment.ownerUserId}, ${increment.nodeId},
    ${increment.samples}, ${increment.cpuSamples},
    ${increment.minCpuPercent}, ${increment.sumCpuPercent}, ${increment.maxCpuPercent},
    ${increment.memorySamples}, ${increment.minMemoryAvailableMiB},
    ${increment.sumMemoryAvailableMiB}, ${increment.maxMemoryAvailableMiB},
    ${increment.minMemoryUsedPercent}, ${increment.sumMemoryUsedPercent},
    ${increment.maxMemoryUsedPercent}, ${increment.maxGpuTemperatureC},
    ${increment.maxGpuUtilizationPercent}, ${increment.minAcceleratorFreeMiB},
    ${JSON.stringify(increment.custom)}::jsonb)`;
}

function upsertManySql(increments: readonly NodeMetricsRollupIncrement[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO node_metrics_minute AS existing
      ("bucketStart", "ownerUserId", "nodeId", samples, "cpuSamples",
       "minCpuPercent", "sumCpuPercent", "maxCpuPercent", "memorySamples",
       "minMemoryAvailableMiB", "sumMemoryAvailableMiB", "maxMemoryAvailableMiB",
       "minMemoryUsedPercent", "sumMemoryUsedPercent", "maxMemoryUsedPercent",
       "maxGpuTemperatureC", "maxGpuUtilizationPercent", "minAcceleratorFreeMiB", custom)
    VALUES ${Prisma.join(increments.map(incrementValues))}
    ON CONFLICT ("bucketStart", "ownerUserId", "nodeId")
    DO UPDATE SET
      samples = existing.samples + EXCLUDED.samples,
      "cpuSamples" = existing."cpuSamples" + EXCLUDED."cpuSamples",
      "minCpuPercent" = CASE
        WHEN existing."minCpuPercent" IS NULL THEN EXCLUDED."minCpuPercent"
        WHEN EXCLUDED."minCpuPercent" IS NULL THEN existing."minCpuPercent"
        ELSE LEAST(existing."minCpuPercent", EXCLUDED."minCpuPercent") END,
      "sumCpuPercent" = COALESCE(existing."sumCpuPercent", 0) + COALESCE(EXCLUDED."sumCpuPercent", 0),
      "maxCpuPercent" = CASE
        WHEN existing."maxCpuPercent" IS NULL THEN EXCLUDED."maxCpuPercent"
        WHEN EXCLUDED."maxCpuPercent" IS NULL THEN existing."maxCpuPercent"
        ELSE GREATEST(existing."maxCpuPercent", EXCLUDED."maxCpuPercent") END,
      "memorySamples" = existing."memorySamples" + EXCLUDED."memorySamples",
      "minMemoryAvailableMiB" = CASE
        WHEN existing."minMemoryAvailableMiB" IS NULL THEN EXCLUDED."minMemoryAvailableMiB"
        WHEN EXCLUDED."minMemoryAvailableMiB" IS NULL THEN existing."minMemoryAvailableMiB"
        ELSE LEAST(existing."minMemoryAvailableMiB", EXCLUDED."minMemoryAvailableMiB") END,
      "sumMemoryAvailableMiB" = COALESCE(existing."sumMemoryAvailableMiB", 0)
        + COALESCE(EXCLUDED."sumMemoryAvailableMiB", 0),
      "maxMemoryAvailableMiB" = CASE
        WHEN existing."maxMemoryAvailableMiB" IS NULL THEN EXCLUDED."maxMemoryAvailableMiB"
        WHEN EXCLUDED."maxMemoryAvailableMiB" IS NULL THEN existing."maxMemoryAvailableMiB"
        ELSE GREATEST(existing."maxMemoryAvailableMiB", EXCLUDED."maxMemoryAvailableMiB") END,
      "minMemoryUsedPercent" = CASE
        WHEN existing."minMemoryUsedPercent" IS NULL THEN EXCLUDED."minMemoryUsedPercent"
        WHEN EXCLUDED."minMemoryUsedPercent" IS NULL THEN existing."minMemoryUsedPercent"
        ELSE LEAST(existing."minMemoryUsedPercent", EXCLUDED."minMemoryUsedPercent") END,
      "sumMemoryUsedPercent" = COALESCE(existing."sumMemoryUsedPercent", 0)
        + COALESCE(EXCLUDED."sumMemoryUsedPercent", 0),
      "maxMemoryUsedPercent" = CASE
        WHEN existing."maxMemoryUsedPercent" IS NULL THEN EXCLUDED."maxMemoryUsedPercent"
        WHEN EXCLUDED."maxMemoryUsedPercent" IS NULL THEN existing."maxMemoryUsedPercent"
        ELSE GREATEST(existing."maxMemoryUsedPercent", EXCLUDED."maxMemoryUsedPercent") END,
      "maxGpuTemperatureC" = CASE
        WHEN existing."maxGpuTemperatureC" IS NULL THEN EXCLUDED."maxGpuTemperatureC"
        WHEN EXCLUDED."maxGpuTemperatureC" IS NULL THEN existing."maxGpuTemperatureC"
        ELSE GREATEST(existing."maxGpuTemperatureC", EXCLUDED."maxGpuTemperatureC") END,
      "maxGpuUtilizationPercent" = CASE
        WHEN existing."maxGpuUtilizationPercent" IS NULL THEN EXCLUDED."maxGpuUtilizationPercent"
        WHEN EXCLUDED."maxGpuUtilizationPercent" IS NULL THEN existing."maxGpuUtilizationPercent"
        ELSE GREATEST(existing."maxGpuUtilizationPercent", EXCLUDED."maxGpuUtilizationPercent") END,
      ${mergeAcceleratorAndCustom()},
      "updatedAt" = now()`;
}

/** Operational counts only; never include telemetry payloads or database errors. */
export class NodeMetricsRollupWriteError extends Error {
  constructor(
    readonly written: number,
    readonly failed: number,
    readonly uncertain = 0,
  ) {
    super("Node metrics rollup write incomplete");
    this.name = "NodeMetricsRollupWriteError";
  }
}

function rejectedStatement(error: unknown): boolean {
  const property = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const meta = property(error, "meta");
  const driverCause = property(property(meta, "driverAdapterError"), "cause");
  // PostgreSQL statement atomicity proves these data/constraint failures made
  // no writes. Connection/unknown errors may have committed: never replay.
  const codes = [
    property(error, "code"),
    property(meta, "code"),
    property(property(error, "cause"), "originalCode"),
    property(driverCause, "originalCode"),
  ];
  return codes.some(
    (code) =>
      typeof code === "string" && ["22003", "22001", "23502", "23503", "23514"].includes(code),
  );
}

export async function writeNodeMetricsIncrements(
  increments: readonly NodeMetricsRollupIncrement[],
  db: { $executeRaw: (query: Prisma.Sql) => Promise<unknown> } = prisma,
): Promise<number> {
  const sorted = [...increments].sort((left, right) => {
    const a = incrementKeyString(left);
    const b = incrementKeyString(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (sorted.length === 0) return 0;
  if (isDbShutdownFenceArmed()) throw new NodeMetricsRollupWriteError(0, sorted.length);
  try {
    await db.$executeRaw(upsertManySql(sorted));
    return sorted.length;
  } catch (error) {
    if (!rejectedStatement(error))
      throw new NodeMetricsRollupWriteError(0, sorted.length, sorted.length);
    /* A proven rejected statement can safely isolate overflowing rows. */
  }
  let written = 0;
  let uncertain = 0;
  for (const increment of sorted) {
    if (isDbShutdownFenceArmed()) break;
    try {
      await db.$executeRaw(upsertSql(increment));
      written += 1;
    } catch (error) {
      if (!rejectedStatement(error)) uncertain += 1;
      /* No retry, even if a connection error hides a committed row. */
    }
  }
  if (written !== sorted.length)
    throw new NodeMetricsRollupWriteError(written, sorted.length - written, uncertain);
  return written;
}

export function createNodeMetricsRollupWriter({
  clock = Date.now,
  write = writeNodeMetricsIncrements,
  shutdown = isDbShutdownFenceArmed,
  log = (counts) => console.error("[node-metrics-rollup] flush incomplete", counts),
}: {
  clock?: () => number;
  write?: (increments: NodeMetricsRollupIncrement[]) => Promise<number>;
  shutdown?: () => boolean;
  log?: (counts: { written: number; failed: number; uncertain?: number }) => void;
} = {}) {
  const pending = new Map<string, NodeMetricsRollupIncrement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let inFlight: Promise<void> | undefined;
  let lastFlush = clock();
  let lastLog = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    // Join the one started write before the server disconnects its DB client.
    return inFlight ?? Promise.resolve();
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
        ? NODE_METRICS_ROLLUP_FLUSH_MIN_INTERVAL_MS
        : Math.max(1, NODE_METRICS_ROLLUP_FLUSH_MIN_INTERVAL_MS - Math.max(0, clock() - lastFlush)),
    );
    timer.unref?.();
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
    writing = true;
    try {
      if (!stopped && !shutdown()) {
        const written = await write(increments);
        if (written !== increments.length)
          throw new NodeMetricsRollupWriteError(written, increments.length - written);
      }
    } catch (error) {
      const failedAt = clock();
      if (failedAt - lastLog >= 60_000) {
        lastLog = failedAt;
        try {
          log(
            error instanceof NodeMetricsRollupWriteError
              ? {
                  written: error.written,
                  failed: error.failed,
                  ...(error.uncertain ? { uncertain: error.uncertain } : {}),
                }
              : { written: 0, failed: increments.length },
          );
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
    const joined = run.finally(() => {
      if (inFlight === joined) inFlight = undefined;
    });
    inFlight = joined;
    await joined;
  };

  const observe = (sample: NodeMetricsRollupSample) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (!sample.ownerUserId || !sample.nodeId || !Number.isFinite(sample.receivedAt.getTime()))
        return;
      const key = pendingKey(sample);
      const current = pending.get(key);
      if (!current && pending.size >= NODE_METRICS_ROLLUP_MAX_PENDING) return;
      pending.set(key, mergeNodeMetricsIncrements(current, sample));
      if (!writing && clock() - lastFlush >= NODE_METRICS_ROLLUP_FLUSH_MIN_INTERVAL_MS) {
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

const writer = createNodeMetricsRollupWriter();
export const observeNodeMetricsRollup = writer.observe;
export const stopNodeMetricsRollup = writer.stop;
export const flushNodeMetricsRollup = writer.flushNow;
