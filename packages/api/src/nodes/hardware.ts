/**
 * Effective node hardware (spec §3.2): each field from the browser/agent declaration, else the
 * node's own declaration (`node.info.declared`; the 0.4.0 node never sends one), else
 * detection (`node.info`). Pure: the procedures pass the stored JSON columns.
 */
import { z } from "zod";
import type { effectiveHardwareSchema } from "../contracts/nodes";
import { isFabricIp } from "../lib/ip-literal";
import {
  type DeclaredHardware,
  declaredHardwareSchema,
  nodeDeclaredHardwareSchema,
} from "../lib/runtime-spec";

type EffectiveHardware = z.infer<typeof effectiveHardwareSchema>;
/** `browser`: a person declared it; `agent`: an agent did (node_update). */
type Source = "browser" | "agent" | "node" | "detected";
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
        /** Integrated GPU sharing system memory (GB10, Thor, an AMD APU). */
        apu: z.boolean().optional(),
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
  declaredSource: "browser" | "agent",
  browser: T | undefined,
  node: T | undefined,
  detected: T | undefined,
): { value: T | null; source: Source | null } {
  if (browser !== undefined) return { value: browser, source: declaredSource };
  if (node !== undefined) return { value: node, source: "node" };
  if (detected !== undefined) return { value: detected, source: "detected" };
  return { value: null, source: null };
}

/**
 * A claim's node memory (GiB) by its `resources` JSON (`runtimeResourceSchema`). VRAM a discrete
 * claim takes on a unified GPU (`unifiedGpuKeys`; the claim's recorded `gpus`, else any when
 * every GPU of the node is unified) is node memory too.
 */
export function claimMemoryGb(
  resources: unknown,
  unifiedGpuKeys: ReadonlySet<string>,
  allUnified: boolean,
): number {
  if (!resources || typeof resources !== "object") return 0;
  const kind = Reflect.get(resources, "kind");
  const memoryGb = Reflect.get(resources, "memoryGb");
  const ramGb = Reflect.get(resources, "ramGb");
  if (kind === "unified" && typeof memoryGb === "number") return memoryGb;
  if (kind === "cpu" && typeof ramGb === "number") return ramGb;
  if (kind !== "discrete") return 0;
  const ram = typeof ramGb === "number" ? ramGb : 0;
  const vramGb = Reflect.get(resources, "vramGb");
  const gpuCount = Reflect.get(resources, "gpuCount");
  if (typeof vramGb !== "number" || typeof gpuCount !== "number") return ram;
  const recorded = Reflect.get(resources, "gpus");
  const shared = Array.isArray(recorded)
    ? recorded.filter((key) => typeof key === "string" && unifiedGpuKeys.has(key)).length
    : allUnified
      ? gpuCount
      : 0;
  return ram + shared * vramGb;
}

export type HardwareInput = {
  declaredResources: unknown;
  /** Who declared `declaredResources` (`Node.declaredResourcesBy`); null or absent: a person. */
  declaredBy?: "USER" | "AGENT" | "SYSTEM" | null;
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
  const declaredSource = input.declaredBy === "AGENT" ? "agent" : "browser";
  const info = parseNodeInfo(input.nodeInfo);
  const node = parseNodeDeclared(info?.declared) ?? {};

  const detectedMemoryMiB = info?.unifiedMemoryMiB ?? info?.memoryTotalMiB;
  const detectedGpus = info?.gpus ?? [];
  const detectedVramMiB = detectedGpus.reduce(
    (sum, gpu) => sum + (gpu.apu === true ? 0 : (gpu.vramTotalMiB ?? 0)),
    0,
  );
  const detectedAcceleratorMiB =
    info?.acceleratorMemoryMiB ?? (detectedVramMiB > 0 ? detectedVramMiB : undefined);

  const kind = pick(declaredSource, browser.kind, node.kind, info?.nodeKind);
  const memoryGb = pick(
    declaredSource,
    browser.memoryGb,
    node.memoryGb,
    detectedMemoryMiB === undefined ? undefined : gb(detectedMemoryMiB),
  );
  const acceleratorMemoryGb = pick(
    declaredSource,
    browser.acceleratorMemoryGb,
    node.acceleratorMemoryGb,
    detectedAcceleratorMiB === undefined ? undefined : gb(detectedAcceleratorMiB),
  );
  const reservedMemoryGb = pick(
    declaredSource,
    browser.reservedMemoryGb,
    node.reservedMemoryGb,
    undefined,
  );

  const gpus = new Map<string, EffectiveHardware["gpus"][number]>();
  const reservedVram = (key: string) =>
    browser.reservedVramGb?.[key] ?? node.reservedVramGb?.[key] ?? 0;
  const addGpu = (
    gpu: { vendor: Vendor; index: number; name?: string | null; vramGb: number | null },
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
      unified: gpu.vramGb === null,
      reservedVramGb: reservedVram(key),
      source,
    });
  };
  // A declared unified GPU (`unified: true`, no `vramGb`) is shared like a detected one.
  const declaredGpu = (gpu: NonNullable<DeclaredHardware["gpus"]>[number]) => ({
    ...gpu,
    vramGb: gpu.unified === true ? null : (gpu.vramGb ?? 0),
  });
  for (const gpu of browser.gpus ?? []) addGpu(declaredGpu(gpu), declaredSource);
  for (const gpu of node.gpus ?? []) addGpu(declaredGpu(gpu), "node");
  // An integrated GPU (or one without VRAM of its own on a unified node: GB10 reports `[N/A]`)
  // shares system memory: no VRAM figure, placement counts it against node memory.
  for (const gpu of detectedGpus) {
    const shared = gpu.apu === true || (gpu.vramTotalMiB == null && kind.value === "unified");
    const vramGb = shared ? null : gpu.vramTotalMiB == null ? 0 : gb(gpu.vramTotalMiB);
    addGpu({ ...gpu, vramGb }, "detected");
  }

  const sortedGpus = [...gpus.values()].sort((a, b) => a.key.localeCompare(b.key));
  const unifiedKeys = new Set(sortedGpus.filter((gpu) => gpu.unified).map((gpu) => gpu.key));
  const allUnified = sortedGpus.length > 0 && unifiedKeys.size === sortedGpus.length;
  const headroom = kind.value === "unified" ? UNIFIED_HEADROOM_GB : 0;
  // VRAM reserved on a unified GPU is system memory.
  const reservedSharedGb = sortedGpus
    .filter((gpu) => gpu.unified)
    .reduce((sum, gpu) => sum + gpu.reservedVramGb, 0);
  const usableMemoryGb = round(
    Math.max(
      0,
      (memoryGb.value ?? 0) - (reservedMemoryGb.value ?? 0) - reservedSharedGb - headroom,
    ),
  );
  const reservedNowMemoryGb = round(
    input.heldClaims.reduce<number>(
      (sum, resources) => sum + claimMemoryGb(resources, unifiedKeys, allUnified),
      0,
    ),
  );
  const live = liveMetrics(input.nodeMetrics, input.nodeMetricsAt, input.now);

  return {
    kind,
    memoryGb,
    acceleratorMemoryGb,
    reservedMemoryGb,
    gpus: sortedGpus,
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

/** Only addresses a fabric membership would accept, and not link-local. */
function isSuggestible(address: string): boolean {
  if (!isFabricIp(address)) return false;
  return !address.startsWith("169.254.") && !address.toLowerCase().startsWith("fe80");
}

/** A link this fast (or with RDMA) looks like a fabric. */
export const FABRIC_SUGGESTION_MIN_MBPS = 10_000;

type InfoInterface = NonNullable<NodeInfoView["interfaces"]>[number];

/** ≥ 10 GbE or RDMA. */
function isFabricLink(iface: InfoInterface): boolean {
  return (
    iface.rdma === true ||
    (iface.linkSpeedMbps !== undefined && iface.linkSpeedMbps >= FABRIC_SUGGESTION_MIN_MBPS)
  );
}

/**
 * Fabric suggestions from `node.info.interfaces`: fast or RDMA links, with the other nodes that
 * have a fast or RDMA link with an address in the same IPv4 /24 (a peer on the plain LAN of
 * that subnet is not one). RDMA links come first, and RDMA peers first within a link.
 * Suggestions only; a person or agent decides.
 */
export function fabricSuggestions(
  nodeInfo: unknown,
  otherNodes: ReadonlyArray<{ id: string; nodeInfo: unknown }>,
): Array<{ ip: string; linkSpeedMbps: number | null; rdma: boolean; peerNodeIds: string[] }> {
  const info = parseNodeInfo(nodeInfo);
  /** Per peer: subnet → whether its link there is RDMA (true wins). */
  const peerSubnets = otherNodes.map((other) => {
    const subnets = new Map<string, boolean>();
    for (const iface of parseNodeInfo(other.nodeInfo)?.interfaces ?? []) {
      if (!isFabricLink(iface)) continue;
      for (const address of iface.addresses ?? []) {
        const subnet = ipv4Subnet24(bareAddress(address));
        if (subnet) subnets.set(subnet, subnets.get(subnet) === true || iface.rdma === true);
      }
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
    if (!isFabricLink(iface)) continue;
    const rdma = iface.rdma === true;
    const speed = iface.linkSpeedMbps ?? null;
    for (const raw of iface.addresses ?? []) {
      const ip = bareAddress(raw);
      if (!isSuggestible(ip)) continue;
      const subnet = ipv4Subnet24(ip);
      const peerNodeIds = subnet
        ? peerSubnets
            .filter((peer) => peer.subnets.has(subnet))
            // Stable: RDMA peers first, otherwise in the given order.
            .sort((x, y) => Number(y.subnets.get(subnet)) - Number(x.subnets.get(subnet)))
            .map((peer) => peer.id)
        : [];
      out.push({ ip, linkSpeedMbps: speed, rdma, peerNodeIds });
    }
  }
  // Stable: RDMA links first, then faster links, otherwise in interface order.
  return out.sort(
    (a, b) => Number(b.rdma) - Number(a.rdma) || (b.linkSpeedMbps ?? 0) - (a.linkSpeedMbps ?? 0),
  );
}
