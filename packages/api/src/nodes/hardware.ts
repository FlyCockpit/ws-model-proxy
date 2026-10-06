/**
 * Effective node hardware (spec §3.2): each field from the browser/agent declaration, else the
 * node's own declaration (`config.json` `hardware`, reported in `node.info.declared`), else
 * detection (`node.info`). Pure: the procedures pass the stored JSON columns.
 */
import { z } from "zod";
import type { effectiveHardwareSchema } from "../contracts/nodes";
import {
  type DeclaredHardware,
  declaredHardwareSchema,
  nodeDeclaredHardwareSchema,
} from "../lib/runtime-spec";

type EffectiveHardware = z.infer<typeof effectiveHardwareSchema>;
type Source = "browser" | "node" | "detected";
const GPU_VENDORS = ["nvidia", "amd", "intel", "apple", "other"] as const;
type Vendor = (typeof GPU_VENDORS)[number];

/** Unified-memory nodes keep this much free for the OS (spec §3.2). */
export const UNIFIED_HEADROOM_GB = 2;
/** A `node.metrics` sample older than this is not "live". */
export const LIVE_METRICS_MAX_AGE_MS = 5 * 60_000;

/** The parts of a stored `node.info` the web reads. Unknown fields are ignored. */
const nodeInfoSchema = z.object({
  memoryTotalMiB: z.number().nonnegative().optional(),
  unifiedMemoryMiB: z.number().nonnegative().optional(),
  acceleratorMemoryMiB: z.number().nonnegative().optional(),
  nodeKind: z.enum(["unified", "discrete", "cpu"]).optional(),
  gpus: z
    .array(
      z.object({
        vendor: z.enum(GPU_VENDORS),
        index: z.number().int().min(0),
        name: z.string().optional(),
        vramTotalMiB: z.number().nonnegative().nullable().optional(),
      }),
    )
    .optional(),
  interfaces: z
    .array(
      z.object({
        name: z.string(),
        addresses: z.array(z.string()).optional(),
        linkSpeedMbps: z.number().int().optional(),
        rdma: z.boolean().optional(),
      }),
    )
    .optional(),
  declared: z.unknown().optional(),
});
export type NodeInfoView = z.infer<typeof nodeInfoSchema>;

const nodeMetricsSchema = z.object({
  memory: z.object({ availableMiB: z.number().nonnegative().optional() }).optional(),
  gpus: z
    .array(
      z.object({
        index: z.number().int(),
        vramUsedMiB: z.number().nullable().optional(),
        vramTotalMiB: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

export function parseNodeInfo(value: unknown): NodeInfoView | null {
  const parsed = nodeInfoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The browser/agent declaration (`Node.declaredResources`). */
export function parseDeclared(value: unknown): DeclaredHardware | null {
  const parsed = declaredHardwareSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The node's own declaration (`node.info.declared`, may carry labels). */
function parseNodeDeclared(value: unknown): DeclaredHardware | null {
  const parsed = nodeDeclaredHardwareSchema.safeParse(value);
  if (!parsed.success) return null;
  const { labels: _labels, ...hardware } = parsed.data;
  return hardware;
}

/** GiB with two decimals. */
function gb(mib: number): number {
  return Math.round((mib / 1024) * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function pick<T>(
  browser: T | undefined,
  node: T | undefined,
  detected: T | undefined,
): { value: T | null; source: Source | null } {
  if (browser !== undefined) return { value: browser, source: "browser" };
  if (node !== undefined) return { value: node, source: "node" };
  if (detected !== undefined) return { value: detected, source: "detected" };
  return { value: null, source: null };
}

/** A claim's node memory (GiB) by its `resources` JSON (`runtimeResourceSchema`). */
export function claimMemoryGb(resources: unknown): number {
  if (!resources || typeof resources !== "object") return 0;
  const kind = Reflect.get(resources, "kind");
  const memoryGb = Reflect.get(resources, "memoryGb");
  const ramGb = Reflect.get(resources, "ramGb");
  if (kind === "unified" && typeof memoryGb === "number") return memoryGb;
  if ((kind === "cpu" || kind === "discrete") && typeof ramGb === "number") return ramGb;
  return 0;
}

export type HardwareInput = {
  declaredResources: unknown;
  nodeInfo: unknown;
  nodeMetrics: unknown;
  nodeMetricsAt: Date | null;
  /** `resources` of every HELD / HELD_UNKNOWN claim on the node. */
  heldClaims: readonly unknown[];
  now: Date;
};

export function liveMetrics(
  nodeMetrics: unknown,
  nodeMetricsAt: Date | null,
  now: Date,
): { freeMemoryGb: number | null; freeAcceleratorGb: number | null } {
  if (!nodeMetricsAt || now.getTime() - nodeMetricsAt.getTime() > LIVE_METRICS_MAX_AGE_MS)
    return { freeMemoryGb: null, freeAcceleratorGb: null };
  const parsed = nodeMetricsSchema.safeParse(nodeMetrics);
  if (!parsed.success) return { freeMemoryGb: null, freeAcceleratorGb: null };
  const available = parsed.data.memory?.availableMiB;
  let freeVramMiB: number | null = null;
  for (const gpu of parsed.data.gpus ?? []) {
    if (typeof gpu.vramTotalMiB !== "number" || typeof gpu.vramUsedMiB !== "number") continue;
    freeVramMiB = (freeVramMiB ?? 0) + Math.max(0, gpu.vramTotalMiB - gpu.vramUsedMiB);
  }
  return {
    freeMemoryGb: available === undefined ? null : gb(available),
    freeAcceleratorGb: freeVramMiB === null ? null : gb(freeVramMiB),
  };
}

export function effectiveHardware(input: HardwareInput): EffectiveHardware {
  const browser = parseDeclared(input.declaredResources) ?? {};
  const info = parseNodeInfo(input.nodeInfo);
  const node = parseNodeDeclared(info?.declared) ?? {};

  const detectedMemoryMiB = info?.unifiedMemoryMiB ?? info?.memoryTotalMiB;
  const detectedGpus = info?.gpus ?? [];
  const detectedVramMiB = detectedGpus.reduce((sum, gpu) => sum + (gpu.vramTotalMiB ?? 0), 0);
  const detectedAcceleratorMiB =
    info?.acceleratorMemoryMiB ?? (detectedVramMiB > 0 ? detectedVramMiB : undefined);

  const kind = pick(browser.kind, node.kind, info?.nodeKind);
  const memoryGb = pick(
    browser.memoryGb,
    node.memoryGb,
    detectedMemoryMiB === undefined ? undefined : gb(detectedMemoryMiB),
  );
  const acceleratorMemoryGb = pick(
    browser.acceleratorMemoryGb,
    node.acceleratorMemoryGb,
    detectedAcceleratorMiB === undefined ? undefined : gb(detectedAcceleratorMiB),
  );
  const reservedMemoryGb = pick(browser.reservedMemoryGb, node.reservedMemoryGb, undefined);

  const gpus = new Map<string, EffectiveHardware["gpus"][number]>();
  const reservedVram = (key: string) =>
    browser.reservedVramGb?.[key] ?? node.reservedVramGb?.[key] ?? 0;
  const addGpu = (
    gpu: { vendor: Vendor; index: number; name?: string | null; vramGb: number },
    source: Source,
  ) => {
    const key = `${gpu.vendor}:${gpu.index}`;
    if (gpus.has(key)) return;
    gpus.set(key, {
      key,
      vendor: gpu.vendor,
      index: gpu.index,
      name: gpu.name ?? null,
      vramGb: gpu.vramGb,
      reservedVramGb: reservedVram(key),
      source,
    });
  };
  for (const gpu of browser.gpus ?? []) addGpu(gpu, "browser");
  for (const gpu of node.gpus ?? []) addGpu(gpu, "node");
  for (const gpu of detectedGpus)
    addGpu({ ...gpu, vramGb: gpu.vramTotalMiB == null ? 0 : gb(gpu.vramTotalMiB) }, "detected");

  const headroom = kind.value === "unified" ? UNIFIED_HEADROOM_GB : 0;
  const usableMemoryGb = round(
    Math.max(0, (memoryGb.value ?? 0) - (reservedMemoryGb.value ?? 0) - headroom),
  );
  const reservedNowMemoryGb = round(
    input.heldClaims.reduce<number>((sum, resources) => sum + claimMemoryGb(resources), 0),
  );
  const live = liveMetrics(input.nodeMetrics, input.nodeMetricsAt, input.now);

  return {
    kind,
    memoryGb,
    acceleratorMemoryGb,
    reservedMemoryGb,
    gpus: [...gpus.values()].sort((a, b) => a.key.localeCompare(b.key)),
    usableMemoryGb,
    reservedNowMemoryGb,
    liveFreeMemoryGb: live.freeMemoryGb,
    liveFreeAcceleratorGb: live.freeAcceleratorGb,
  };
}

/** An address on an interface, without its prefix length. */
function bareAddress(address: string): string {
  const slash = address.indexOf("/");
  return slash === -1 ? address : address.slice(0, slash);
}

function ipv4Subnet24(address: string): string | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  return parts.slice(0, 3).join(".");
}

function isSuggestible(address: string): boolean {
  if (address === "127.0.0.1" || address === "::1") return false;
  if (address.startsWith("169.254.") || address.toLowerCase().startsWith("fe80")) return false;
  return !address.startsWith("127.");
}

/** A link this fast (or with RDMA) looks like a fabric. */
export const FABRIC_SUGGESTION_MIN_MBPS = 10_000;

/**
 * Fabric suggestions from `node.info.interfaces`: fast or RDMA links, with the other nodes that
 * have an address in the same IPv4 /24. Suggestions only; a person or agent decides.
 */
export function fabricSuggestions(
  nodeInfo: unknown,
  otherNodes: ReadonlyArray<{ id: string; nodeInfo: unknown }>,
): Array<{ ip: string; linkSpeedMbps: number | null; rdma: boolean; peerNodeIds: string[] }> {
  const info = parseNodeInfo(nodeInfo);
  const peerSubnets = otherNodes.map((other) => {
    const subnets = new Set<string>();
    for (const iface of parseNodeInfo(other.nodeInfo)?.interfaces ?? [])
      for (const address of iface.addresses ?? []) {
        const subnet = ipv4Subnet24(bareAddress(address));
        if (subnet) subnets.add(subnet);
      }
    return { id: other.id, subnets };
  });
  const out: Array<{
    ip: string;
    linkSpeedMbps: number | null;
    rdma: boolean;
    peerNodeIds: string[];
  }> = [];
  for (const iface of info?.interfaces ?? []) {
    const rdma = iface.rdma === true;
    const speed = iface.linkSpeedMbps ?? null;
    if (!rdma && (speed === null || speed < FABRIC_SUGGESTION_MIN_MBPS)) continue;
    for (const raw of iface.addresses ?? []) {
      const ip = bareAddress(raw);
      if (!isSuggestible(ip)) continue;
      const subnet = ipv4Subnet24(ip);
      out.push({
        ip,
        linkSpeedMbps: speed,
        rdma,
        peerNodeIds: subnet
          ? peerSubnets.filter((peer) => peer.subnets.has(subnet)).map((peer) => peer.id)
          : [],
      });
    }
  }
  return out;
}
