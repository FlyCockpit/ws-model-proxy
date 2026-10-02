/**
 * CLI node inventory derived from `node.info` / `node.metrics`: label
 * suggestions, usable memory/VRAM/RAM budgets, and health warnings. Label and
 * budget writes are human-only; this module is read-side shaping plus
 * validators the dashboard mutations share.
 */

import { z } from "zod";
import { parseNodeMetricsSample } from "./metric-routing";

export const NODE_KINDS = ["unified", "discrete", "cpu"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const NODE_LABELS_MAX = 32;
/** Total minus this many GB becomes the default unified/RAM budget. */
export const NODE_MEMORY_RESERVE_GB = 2;
/** Total minus this many GB becomes the default per-GPU VRAM budget. */
export const NODE_GPU_VRAM_RESERVE_GB = 0.5;
export const NODE_BUDGET_MAX_GB = 1_000_000;

/** Trim and turn a single comma decimal (`1,5`) into a dot decimal (`1.5`). */
export function normalizeDecimalInput(raw: string): string {
  const trimmed = raw.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1 || trimmed.includes(".") || trimmed.indexOf(",", comma + 1) !== -1) {
    return trimmed;
  }
  return `${trimmed.slice(0, comma)}.${trimmed.slice(comma + 1)}`;
}
const GPU_INDEX_KEY = /^index:(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;
const GPU_UUID_KEY = /^[A-Za-z0-9_.:@-]{1,128}$/;

function isGpuBudgetKey(key: string): boolean {
  if (key.startsWith("index:")) return GPU_INDEX_KEY.test(key);
  return GPU_UUID_KEY.test(key);
}

export const nodeLabelSchema = z
  .string()
  .regex(NODE_LABEL_PATTERN, { message: "Use lowercase kebab-case labels (a-z, 0-9, hyphen)." });

export const nodeLabelsSchema = z
  .array(nodeLabelSchema)
  .max(NODE_LABELS_MAX)
  .superRefine((labels, context) => {
    const seen = new Set<string>();
    for (const [index, label] of labels.entries()) {
      if (seen.has(label)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Labels must be unique.",
        });
      }
      seen.add(label);
    }
  });

const budgetGbSchema = z.number().finite().min(0).max(NODE_BUDGET_MAX_GB);

export const usableVramGbSchema = z
  .record(z.string(), budgetGbSchema)
  .superRefine((map, context) => {
    for (const key of Object.keys(map)) {
      if (!isGpuBudgetKey(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "VRAM budgets are keyed by GPU UUID or index:N.",
        });
      }
    }
  });

export const nodeUsableBudgetsInputSchema = z
  .object({
    usableMemoryGb: budgetGbSchema.nullable().optional(),
    usableRamGb: budgetGbSchema.nullable().optional(),
    usableVramGb: usableVramGbSchema.nullable().optional(),
  })
  .strict();

export type NodeGpuInfoView = {
  index: number;
  name?: string;
  uuid?: string;
  driverVersion?: string;
  vramTotalMiB?: number | null;
};

export type NodeInfoView = {
  nodeKind?: NodeKind;
  unifiedMemory?: boolean;
  memoryTotalMiB?: number;
  cpu?: { model?: string; cores?: number };
  os?: { name?: string; version?: string; kernel?: string; arch?: string };
  gpus?: NodeGpuInfoView[];
  interfaces?: Array<{
    name: string;
    mtu?: number;
    linkSpeedMbps?: number;
    addresses?: string[];
  }>;
};

const optionalFinite = z.number().finite().nullable().optional();
const nodeInfoViewSchema = z
  .object({
    nodeKind: z.enum(NODE_KINDS).optional(),
    unifiedMemory: z.boolean().optional(),
    memoryTotalMiB: optionalFinite,
    cpu: z
      .object({
        model: z.string().optional(),
        cores: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
    os: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
        kernel: z.string().optional(),
        arch: z.string().optional(),
      })
      .passthrough()
      .optional(),
    gpus: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(255),
            name: z.string().optional(),
            uuid: z.string().optional(),
            driverVersion: z.string().optional(),
            vramTotalMiB: optionalFinite,
          })
          .passthrough(),
      )
      .optional(),
    interfaces: z
      .array(
        z
          .object({
            name: z.string(),
            mtu: z.number().int().optional(),
            linkSpeedMbps: z.number().int().optional(),
            addresses: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function parseNodeInfo(value: unknown): NodeInfoView | null {
  const parsed = nodeInfoViewSchema.safeParse(value);
  if (!parsed.success) return null;
  const memoryTotalMiB =
    parsed.data.memoryTotalMiB == null ? undefined : parsed.data.memoryTotalMiB;
  return { ...parsed.data, memoryTotalMiB };
}

export function gpuBudgetKey(gpu: Pick<NodeGpuInfoView, "index" | "uuid">): string {
  const uuid = gpu.uuid?.trim();
  if (uuid && GPU_UUID_KEY.test(uuid)) return uuid;
  return `index:${gpu.index}`;
}

/** Lowercase unique labels, longest 32, in the order first seen. */
export function normalizeNodeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (!NODE_LABEL_PATTERN.test(label) || seen.has(label)) continue;
    seen.add(label);
    next.push(label);
    if (next.length >= NODE_LABELS_MAX) break;
  }
  return next;
}

/** Selectors are "has all of these" sets. No negation. */
export function nodeHasAllLabels(
  deviceLabels: readonly string[],
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const have = new Set(deviceLabels);
  return required.every((label) => have.has(label));
}

function blobOf(info: NodeInfoView): string {
  const gpuNames = (info.gpus ?? []).map((gpu) => gpu.name ?? "");
  return [info.os?.name ?? "", info.os?.arch ?? "", info.cpu?.model ?? "", ...gpuNames]
    .join(" ")
    .toLowerCase();
}

/**
 * Hardware fingerprints suggested on the first `node.info`. The user accepts
 * or edits them in the dashboard; this never writes `CliDevice.labels`.
 */
export function suggestNodeLabels(info: NodeInfoView): string[] {
  const labels = new Set<string>();
  const kind = info.nodeKind;
  const unified = info.unifiedMemory === true || kind === "unified";
  if (unified) labels.add("unified-memory");
  const blob = blobOf(info);

  const dgxSpark = /\bgb10\b|dgx[\s-]?spark|nvidia spark/.test(blob);
  const strixHalo = /strix[\s-]?halo|ryzen ai max|gfx1151/.test(blob);
  if (dgxSpark) labels.add("dgx-spark");
  if (strixHalo) labels.add("strix-halo");
  if (/rtx[\s-]?3090/.test(blob)) labels.add("rtx-3090");
  if (/rtx[\s-]?3060/.test(blob)) labels.add("rtx-3060");
  if (/gtx[\s-]?1080/.test(blob)) labels.add("gtx-1080");
  if (!dgxSpark && !strixHalo) {
    if (/apple[\s-]?m4|\bm4 (pro|max|ultra)\b/.test(blob)) labels.add("apple-m4");
    else if (/apple[\s-]?m3|\bm3 (pro|max|ultra)\b/.test(blob)) labels.add("apple-m3");
    else if (/apple[\s-]?m2|\bm2 (pro|max|ultra)\b/.test(blob)) labels.add("apple-m2");
    else if (/apple[\s-]?m1|\bm1 (pro|max|ultra)\b/.test(blob)) labels.add("apple-m1");
    else if (unified && /darwin|macos|mac os/.test((info.os?.name ?? "").toLowerCase())) {
      labels.add("apple-silicon");
    }
  }

  const memoryGb = mibToGb(info.memoryTotalMiB);
  if (memoryGb !== null && memoryGb <= 16) labels.add("low-power");
  else if (kind === "cpu" && memoryGb !== null && memoryGb <= 32) labels.add("low-power");

  return [...labels].sort();
}

function mibToGb(mib: number | null | undefined): number | null {
  if (mib == null || !Number.isFinite(mib) || mib < 0) return null;
  return mib / 1024;
}

function roundBudgetGb(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function defaultFromTotalMiB(
  totalMiB: number | null | undefined,
  reserveGb: number,
): number | null {
  const totalGb = mibToGb(totalMiB);
  if (totalGb === null) return null;
  return roundBudgetGb(Math.max(0, totalGb - reserveGb));
}

export type UsableVramGbMap = Record<string, number>;

export function parseUsableVramGb(value: unknown): UsableVramGbMap | null {
  if (value == null) return null;
  const parsed = usableVramGbSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type NodeUsableBudgets = {
  usableMemoryGb: number | null;
  usableRamGb: number | null;
  usableVramGb: UsableVramGbMap;
  usableMemoryGbDefault: boolean;
  usableRamGbDefault: boolean;
  usableVramGbDefaults: Record<string, boolean>;
};

export function defaultUsableVramGb(info: NodeInfoView): UsableVramGbMap {
  const map: UsableVramGbMap = {};
  for (const gpu of info.gpus ?? []) {
    const budget = defaultFromTotalMiB(gpu.vramTotalMiB ?? null, NODE_GPU_VRAM_RESERVE_GB);
    if (budget === null) continue;
    map[gpuBudgetKey(gpu)] = budget;
  }
  return map;
}

export function resolveUsableBudgets(
  info: NodeInfoView | null,
  stored: {
    usableMemoryGb?: number | null;
    usableRamGb?: number | null;
    usableVramGb?: unknown;
  },
): NodeUsableBudgets {
  const kind = info?.nodeKind;
  const memoryDefault = defaultFromTotalMiB(info?.memoryTotalMiB, NODE_MEMORY_RESERVE_GB);
  const storedVram = parseUsableVramGb(stored.usableVramGb);
  const vramDefaults = info ? defaultUsableVramGb(info) : {};
  const usableVramGb: UsableVramGbMap = { ...vramDefaults };
  const usableVramGbDefaults: Record<string, boolean> = {};
  for (const key of Object.keys(vramDefaults)) usableVramGbDefaults[key] = true;
  if (storedVram) {
    for (const [key, value] of Object.entries(storedVram)) {
      usableVramGb[key] = value;
      usableVramGbDefaults[key] = false;
    }
  }

  const storedMemory = stored.usableMemoryGb;
  const storedRam = stored.usableRamGb;
  const usableMemoryGb =
    kind === "discrete" || kind === "cpu"
      ? null
      : storedMemory != null
        ? storedMemory
        : memoryDefault;
  const usableRamGb = kind === "unified" ? null : storedRam != null ? storedRam : memoryDefault;

  return {
    usableMemoryGb,
    usableRamGb,
    usableVramGb,
    usableMemoryGbDefault: kind !== "discrete" && kind !== "cpu" && storedMemory == null,
    usableRamGbDefault: kind !== "unified" && storedRam == null,
    usableVramGbDefaults,
  };
}

export const NODE_HEALTH_WARNING_CODES = [
  "pressure",
  "thermal",
  "driver_skew",
  "mtu",
  "disk",
  "missing_model_path",
] as const;
export type NodeHealthWarningCode = (typeof NODE_HEALTH_WARNING_CODES)[number];

export type NodeHealthWarning = {
  code: NodeHealthWarningCode;
  /** Display only; never a preflight gate. */
  severity: "warning";
};

const MEMORY_PRESSURE_AVAILABLE_MIB = 2048;
const MEMORY_PRESSURE_RATIO = 0.1;
const GPU_THERMAL_C = 85;
const DISK_LOW_MIB = 5 * 1024;
const FABRIC_MTU = 9000;
const FABRIC_SPEED_MBPS = 25_000;
const FABRIC_NAME = /^(mlx|ib|bond)/i;

function maxDefined(values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    max = max == null ? value : Math.max(max, value);
  }
  return max;
}

export function nodeHealthWarnings(
  info: NodeInfoView | null,
  metrics: unknown,
): NodeHealthWarning[] {
  const warnings: NodeHealthWarning[] = [];
  const sample = parseNodeMetricsSample(metrics);
  const available = sample?.memory?.availableMiB ?? null;
  const total = sample?.memory?.totalMiB ?? info?.memoryTotalMiB ?? null;
  if (
    (available != null && available < MEMORY_PRESSURE_AVAILABLE_MIB) ||
    (available != null && total != null && total > 0 && available / total < MEMORY_PRESSURE_RATIO)
  ) {
    warnings.push({ code: "pressure", severity: "warning" });
  }

  const gpuTemps = (sample?.gpus ?? []).map((gpu) => gpu.temperatureC);
  const hottest = maxDefined(gpuTemps);
  if (hottest != null && hottest >= GPU_THERMAL_C) {
    warnings.push({ code: "thermal", severity: "warning" });
  }

  const drivers = [
    ...new Set(
      (info?.gpus ?? [])
        .map((gpu) => gpu.driverVersion?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (drivers.length > 1) warnings.push({ code: "driver_skew", severity: "warning" });

  const fabric = (info?.interfaces ?? []).filter((iface) => {
    const speed = iface.linkSpeedMbps;
    return FABRIC_NAME.test(iface.name) || (speed != null && speed >= FABRIC_SPEED_MBPS);
  });
  if (fabric.some((iface) => iface.mtu != null && iface.mtu !== FABRIC_MTU)) {
    warnings.push({ code: "mtu", severity: "warning" });
  }

  const disks = sample?.disks ?? [];
  if (disks.some((disk) => disk.freeMiB != null && disk.freeMiB < DISK_LOW_MIB)) {
    warnings.push({ code: "disk", severity: "warning" });
  }
  if (
    disks.some(
      (disk) =>
        disk.mount !== "/" &&
        (disk.totalMiB == null || disk.totalMiB === 0) &&
        (disk.freeMiB == null || disk.freeMiB === 0),
    )
  ) {
    warnings.push({ code: "missing_model_path", severity: "warning" });
  }

  return warnings;
}

export type NodeCardGpu = {
  index: number;
  name: string | null;
  uuid: string | null;
  driverVersion: string | null;
  vramTotalGb: number | null;
  usableVramGb: number | null;
  usableVramGbDefault: boolean;
  vramUsedGb: number | null;
  temperatureC: number | null;
  utilizationPercent: number | null;
};

export type NodeCardSnapshot = {
  kind: NodeKind | null;
  unifiedMemory: boolean;
  memoryTotalGb: number | null;
  memoryAvailableGb: number | null;
  cpuPercent: number | null;
  gpus: NodeCardGpu[];
  labels: string[];
  suggestedLabels: string[];
  usableMemoryGb: number | null;
  usableRamGb: number | null;
  usableMemoryGbDefault: boolean;
  usableRamGbDefault: boolean;
  warnings: NodeHealthWarning[];
};

export function buildNodeCardSnapshot(input: {
  nodeInfo: unknown;
  nodeMetrics: unknown;
  labels: readonly string[] | null | undefined;
  usableMemoryGb?: number | null;
  usableRamGb?: number | null;
  usableVramGb?: unknown;
}): NodeCardSnapshot {
  const info = parseNodeInfo(input.nodeInfo);
  const sample = parseNodeMetricsSample(input.nodeMetrics);
  const labels = normalizeNodeLabels(input.labels ?? []);
  const suggestedLabels = info ? suggestNodeLabels(info) : [];
  const budgets = resolveUsableBudgets(info, {
    usableMemoryGb: input.usableMemoryGb,
    usableRamGb: input.usableRamGb,
    usableVramGb: input.usableVramGb,
  });
  const metricsByIndex = new Map((sample?.gpus ?? []).map((gpu) => [gpu.index, gpu]));
  const gpus: NodeCardGpu[] = (info?.gpus ?? []).map((gpu) => {
    const key = gpuBudgetKey(gpu);
    const live = metricsByIndex.get(gpu.index);
    return {
      index: gpu.index,
      name: gpu.name ?? null,
      uuid: gpu.uuid ?? null,
      driverVersion: gpu.driverVersion ?? null,
      vramTotalGb: mibToGb(gpu.vramTotalMiB ?? live?.vramTotalMiB ?? null),
      usableVramGb: budgets.usableVramGb[key] ?? null,
      usableVramGbDefault: budgets.usableVramGbDefaults[key] ?? true,
      vramUsedGb: mibToGb(live?.vramUsedMiB ?? null),
      temperatureC: live?.temperatureC ?? null,
      utilizationPercent: live?.utilizationPercent ?? null,
    };
  });
  return {
    kind: info?.nodeKind ?? null,
    unifiedMemory: info?.unifiedMemory === true || info?.nodeKind === "unified",
    memoryTotalGb: mibToGb(sample?.memory?.totalMiB ?? info?.memoryTotalMiB ?? null),
    memoryAvailableGb: mibToGb(sample?.memory?.availableMiB ?? null),
    cpuPercent: sample?.cpu?.usagePercent ?? null,
    gpus,
    labels,
    suggestedLabels,
    usableMemoryGb: budgets.usableMemoryGb,
    usableRamGb: budgets.usableRamGb,
    usableMemoryGbDefault: budgets.usableMemoryGbDefault,
    usableRamGbDefault: budgets.usableRamGbDefault,
    warnings: nodeHealthWarnings(info, input.nodeMetrics),
  };
}

export type NodeMetricsMinutePoint = {
  start: string;
  samples: number;
  minCpuPercent: number | null;
  avgCpuPercent: number | null;
  maxCpuPercent: number | null;
  minMemoryAvailableMiB: number | null;
  avgMemoryAvailableMiB: number | null;
  maxMemoryAvailableMiB: number | null;
  minMemoryUsedPercent: number | null;
  avgMemoryUsedPercent: number | null;
  maxMemoryUsedPercent: number | null;
  maxGpuTemperatureC: number | null;
  maxGpuUtilizationPercent: number | null;
};

function avg(sum: number | null | undefined, count: number): number | null {
  if (sum == null || count <= 0 || !Number.isFinite(sum)) return null;
  return sum / count;
}

export function shapeNodeMetricsMinute(row: {
  bucketStart: Date | string;
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
}): NodeMetricsMinutePoint {
  const start = row.bucketStart instanceof Date ? row.bucketStart.toISOString() : row.bucketStart;
  return {
    start,
    samples: row.samples,
    minCpuPercent: row.minCpuPercent,
    avgCpuPercent: avg(row.sumCpuPercent, row.cpuSamples),
    maxCpuPercent: row.maxCpuPercent,
    minMemoryAvailableMiB: row.minMemoryAvailableMiB,
    avgMemoryAvailableMiB: avg(row.sumMemoryAvailableMiB, row.memorySamples),
    maxMemoryAvailableMiB: row.maxMemoryAvailableMiB,
    minMemoryUsedPercent: row.minMemoryUsedPercent,
    avgMemoryUsedPercent: avg(row.sumMemoryUsedPercent, row.memorySamples),
    maxMemoryUsedPercent: row.maxMemoryUsedPercent,
    maxGpuTemperatureC: row.maxGpuTemperatureC,
    maxGpuUtilizationPercent: row.maxGpuUtilizationPercent,
  };
}
