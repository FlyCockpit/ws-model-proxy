/**
 * Batched class-H writer for node_metrics_minute. Accepted `node.metrics`
 * frames are merged in memory and flushed in sorted key order. Display only.
 */
import prisma, { Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";

export const NODE_METRICS_ROLLUP_FLUSH_MIN_INTERVAL_MS = 1000;
export const NODE_METRICS_ROLLUP_MAX_PENDING = 2000;
const MINUTE_MS = 60_000;

export type NodeMetricsRollupSample = {
  ownerUserId: string;
  cliDeviceId: string;
  receivedAt: Date;
  cpuPercent?: number | null;
  memoryAvailableMiB?: number | null;
  memoryTotalMiB?: number | null;
  gpuTemperatureC?: number | null;
  gpuUtilizationPercent?: number | null;
};

export type NodeMetricsRollupIncrement = {
  bucketStart: Date;
  ownerUserId: string;
  cliDeviceId: string;
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

function memoryUsedPercent(available: number | null, total: number | null): number | null {
  if (available == null || total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
}

function pendingKey(sample: NodeMetricsRollupSample): string {
  return [
    sample.ownerUserId,
    sample.cliDeviceId,
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
    cliDeviceId: sample.cliDeviceId,
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
  };
}

export function incrementKeyString(increment: NodeMetricsRollupIncrement): string {
  return [increment.bucketStart.toISOString(), increment.ownerUserId, increment.cliDeviceId].join(
    "\u0000",
  );
}

function upsertSql(increment: NodeMetricsRollupIncrement): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO node_metrics_minute AS existing
      ("bucketStart", "ownerUserId", "cliDeviceId", samples, "cpuSamples",
       "minCpuPercent", "sumCpuPercent", "maxCpuPercent", "memorySamples",
       "minMemoryAvailableMiB", "sumMemoryAvailableMiB", "maxMemoryAvailableMiB",
       "minMemoryUsedPercent", "sumMemoryUsedPercent", "maxMemoryUsedPercent",
       "maxGpuTemperatureC", "maxGpuUtilizationPercent")
    VALUES (${increment.bucketStart}, ${increment.ownerUserId}, ${increment.cliDeviceId},
      ${increment.samples}, ${increment.cpuSamples},
      ${increment.minCpuPercent}, ${increment.sumCpuPercent}, ${increment.maxCpuPercent},
      ${increment.memorySamples}, ${increment.minMemoryAvailableMiB},
      ${increment.sumMemoryAvailableMiB}, ${increment.maxMemoryAvailableMiB},
      ${increment.minMemoryUsedPercent}, ${increment.sumMemoryUsedPercent},
      ${increment.maxMemoryUsedPercent}, ${increment.maxGpuTemperatureC},
      ${increment.maxGpuUtilizationPercent})
    ON CONFLICT ("bucketStart", "ownerUserId", "cliDeviceId")
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
      "updatedAt" = now()`;
}

function incrementValues(increment: NodeMetricsRollupIncrement): Prisma.Sql {
  return Prisma.sql`(${increment.bucketStart}, ${increment.ownerUserId}, ${increment.cliDeviceId},
    ${increment.samples}, ${increment.cpuSamples},
    ${increment.minCpuPercent}, ${increment.sumCpuPercent}, ${increment.maxCpuPercent},
    ${increment.memorySamples}, ${increment.minMemoryAvailableMiB},
    ${increment.sumMemoryAvailableMiB}, ${increment.maxMemoryAvailableMiB},
    ${increment.minMemoryUsedPercent}, ${increment.sumMemoryUsedPercent},
    ${increment.maxMemoryUsedPercent}, ${increment.maxGpuTemperatureC},
    ${increment.maxGpuUtilizationPercent})`;
}

function upsertManySql(increments: readonly NodeMetricsRollupIncrement[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO node_metrics_minute AS existing
      ("bucketStart", "ownerUserId", "cliDeviceId", samples, "cpuSamples",
       "minCpuPercent", "sumCpuPercent", "maxCpuPercent", "memorySamples",
       "minMemoryAvailableMiB", "sumMemoryAvailableMiB", "maxMemoryAvailableMiB",
       "minMemoryUsedPercent", "sumMemoryUsedPercent", "maxMemoryUsedPercent",
       "maxGpuTemperatureC", "maxGpuUtilizationPercent")
    VALUES ${Prisma.join(increments.map(incrementValues))}
    ON CONFLICT ("bucketStart", "ownerUserId", "cliDeviceId")
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
      "updatedAt" = now()`;
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
  if (isDbShutdownFenceArmed()) return 0;
  try {
    await db.$executeRaw(upsertManySql(sorted));
    return sorted.length;
  } catch {
    /* One overflowing or rejected row must not drop the rest of the flush. */
  }
  let written = 0;
  for (const increment of sorted) {
    if (isDbShutdownFenceArmed()) return written;
    try {
      await db.$executeRaw(upsertSql(increment));
      written += 1;
    } catch {
      /* Isolate L1 row failures. */
    }
  }
  return written;
}

export function createNodeMetricsRollupWriter({
  clock = Date.now,
  write = writeNodeMetricsIncrements,
  shutdown = isDbShutdownFenceArmed,
  log = () => console.error("[node-metrics-rollup] flush failed"),
}: {
  clock?: () => number;
  write?: (increments: NodeMetricsRollupIncrement[]) => Promise<number>;
  shutdown?: () => boolean;
  log?: () => void;
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
      if (!stopped && !shutdown()) await write(increments);
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

  const observe = (sample: NodeMetricsRollupSample) => {
    try {
      if (stopped || shutdown()) {
        stop();
        return;
      }
      if (
        !sample.ownerUserId ||
        !sample.cliDeviceId ||
        !Number.isFinite(sample.receivedAt.getTime())
      )
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
