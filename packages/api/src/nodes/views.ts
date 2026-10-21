/**
 * Node rows → contract views (`contracts/nodes.ts`). The selects live here so every procedure
 * that answers a summary or a detail loads the same columns.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { z } from "zod";
import type {
  detectedServerSchema,
  nodeDetailSchema,
  nodeFabricViewSchema,
  nodeInstanceRefSchema,
  nodeListRowSchema,
  nodeSummarySchema,
  queuedCommandViewSchema,
} from "../contracts/nodes";
import {
  CURRENT_RESERVATION_WHERE,
  HOLDING_RESERVATION_WHERE,
  RESERVATION_CLAIM_SELECT,
  reservationClaim,
} from "../lib/reservations";
import { nodeFabricsHash, nodeMetricCommandsHash } from "../lib/runtime-launch-hash";
import {
  declaredHardwareSchema,
  nodeFeaturesSchema,
  nodeMetricCommandsSchema,
} from "../lib/runtime-spec";
import { effectiveHardware, fabricSuggestions, liveMetrics } from "./hardware";
import { nodeTrustView } from "./trust";

type NodeSummary = z.infer<typeof nodeSummarySchema>;
type NodeListRow = z.infer<typeof nodeListRowSchema>;
type NodeDetail = z.infer<typeof nodeDetailSchema>;

const HELD_CLAIMS = ["HELD", "HELD_UNKNOWN"] as const;

export const nodeSummarySelect = {
  id: true,
  slug: true,
  name: true,
  connection: true,
  lastHeartbeatAt: true,
  cliVersion: true,
  rejectedProtocolVersion: true,
  trust: true,
  trustChangedAt: true,
  trustLowerRequestedAt: true,
  trustLowerRequestedBy: true,
  userId: true,
  User: { select: { name: true } },
  labels: true,
  declaredResources: true,
  declaredResourcesBy: true,
  nodeInfo: true,
  nodeMetrics: true,
  nodeMetricsAt: true,
  holdAt: true,
  holdNote: true,
  holdProfileId: true,
  removeAfterOfflineMs: true,
  Ranks: {
    where: { claim: { in: [...HELD_CLAIMS] } },
    select: {
      resources: true,
      Instance: { select: { id: true, phase: true, needsOperator: true } },
    },
  },
  // Memory instances hold here without running (`launch.reservations`), while they hold.
  Reservations: { where: HOLDING_RESERVATION_WHERE, select: { resources: true } },
  _count: {
    select: {
      Runtimes: { where: { kind: "ALWAYS_ON" } },
      QueuedCommands: { where: { state: "QUEUED" } },
    },
  },
} satisfies Prisma.NodeSelect;

export type NodeSummaryRow = Prisma.NodeGetPayload<{ select: typeof nodeSummarySelect }>;

const NOT_RUNNING_PHASES = new Set(["STOPPED", "FAILED"]);

/** `resources` of every claim that holds on the node: its ranks' and reservations'. */
function heldClaimsOf(row: Pick<NodeSummaryRow, "Ranks" | "Reservations">): unknown[] {
  return [
    ...row.Ranks.map((rank) => rank.resources),
    // Rows read without the select (older callers' fixtures) have none.
    ...(row.Reservations ?? []).map((reservation) => reservation.resources),
  ];
}

export function toNodeSummary(row: NodeSummaryRow, now: Date): NodeSummary {
  const running = new Set<string>();
  const needsYou = new Set<string>();
  for (const rank of row.Ranks) {
    if (!NOT_RUNNING_PHASES.has(rank.Instance.phase)) running.add(rank.Instance.id);
    if (rank.Instance.needsOperator !== null) needsYou.add(rank.Instance.id);
  }
  const hardware = effectiveHardware({
    declaredResources: row.declaredResources,
    declaredBy: row.declaredResourcesBy,
    nodeInfo: row.nodeInfo,
    nodeMetrics: row.nodeMetrics,
    nodeMetricsAt: row.nodeMetricsAt,
    heldClaims: heldClaimsOf(row),
    now,
  });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    connection: row.connection,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    version: row.cliVersion,
    rejectedProtocolVersion: row.rejectedProtocolVersion,
    trust: nodeTrustView(row),
    labels: row.labels,
    hardwareKind: hardware.kind.value,
    liveFreeMemoryGb: liveMetrics(row.nodeMetrics, row.nodeMetricsAt, now).freeMemoryGb,
    usableMemoryGb: hardware.usableMemoryGb,
    reservedNowMemoryGb: hardware.reservedNowMemoryGb,
    runningInstances: running.size,
    alwaysOnRuntimes: row._count.Runtimes,
    needsYou: needsYou.size + row._count.QueuedCommands,
    hold: row.holdAt
      ? { at: row.holdAt.toISOString(), note: row.holdNote, profileId: row.holdProfileId }
      : null,
    removeAfterOfflineMs:
      row.removeAfterOfflineMs === null ? null : Number(row.removeAfterOfflineMs),
  };
}

export const nodeListSelect = {
  ...nodeSummarySelect,
  hostname: true,
  features: true,
  FabricMembers: {
    select: { ip: true, Fabric: { select: { name: true, _count: { select: { Members: true } } } } },
  },
} satisfies Prisma.NodeSelect;

type NodeListSelected = Prisma.NodeGetPayload<{ select: typeof nodeListSelect }>;

/** A node list row: the summary with hostname, fabrics, GPUs and secret names. */
export function toNodeListRow(row: NodeListSelected, now: Date): NodeListRow {
  const hardware = effectiveHardware({
    declaredResources: row.declaredResources,
    declaredBy: row.declaredResourcesBy,
    nodeInfo: row.nodeInfo,
    nodeMetrics: row.nodeMetrics,
    nodeMetricsAt: row.nodeMetricsAt,
    heldClaims: heldClaimsOf(row),
    now,
  });
  const features = nodeFeaturesSchema.safeParse(row.features);
  return {
    ...toNodeSummary(row, now),
    hostname: row.hostname,
    fabrics: row.FabricMembers.map((member) => ({
      name: member.Fabric.name,
      ip: member.ip,
      peerCount: Math.max(0, member.Fabric._count.Members - 1),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    gpus: hardware.gpus.map((gpu) => ({ vendor: gpu.vendor, name: gpu.name })),
    secretNames: features.success ? features.data.secrets.map((secret) => secret.name) : [],
  };
}

export const nodeDetailSelect = {
  ...nodeSummarySelect,
  hostname: true,
  features: true,
  heldDefinitions: true,
  portStart: true,
  portEnd: true,
  metricCommands: true,
  metricCommandsHash: true,
  heldMetricCommandsHash: true,
  fabricsHash: true,
  heldFabricsHash: true,
  commandMaxMs: true,
  detectedServers: true,
  detectedServersAt: true,
  Ranks: {
    where: {
      OR: [{ claim: { in: [...HELD_CLAIMS] } }, { Instance: { phase: { not: "STOPPED" } } }],
    },
    select: {
      rank: true,
      claim: true,
      resources: true,
      Instance: {
        select: {
          id: true,
          runtimeId: true,
          phase: true,
          needsOperator: true,
          Runtime: { select: { slug: true } },
          _count: { select: { Ranks: true } },
        },
      },
    },
  },
  // Every reservation here that holds or whose instance has not stopped (shown as "reserved by").
  Reservations: {
    where: {
      OR: [HOLDING_RESERVATION_WHERE, { Instance: { phase: { not: "STOPPED" } } }],
    },
    orderBy: { index: "asc" },
    select: {
      index: true,
      resources: true,
      supersededGeneration: true,
      Instance: {
        select: {
          id: true,
          runtimeId: true,
          phase: true,
          needsOperator: true,
          Runtime: { select: { slug: true } },
          ...RESERVATION_CLAIM_SELECT.Instance.select,
          _count: { select: { Reservations: { where: CURRENT_RESERVATION_WHERE } } },
        },
      },
    },
  },
  FabricMembers: {
    select: {
      ip: true,
      Fabric: {
        select: {
          id: true,
          name: true,
          Members: { select: { nodeId: true, ip: true, Node: { select: { slug: true } } } },
        },
      },
    },
  },
  QueuedCommands: {
    where: { state: "QUEUED" },
    orderBy: { createdAt: "desc" },
    take: 50,
  },
} satisfies Prisma.NodeSelect;

export type NodeDetailRow = Prisma.NodeGetPayload<{ select: typeof nodeDetailSelect }>;

/** Extra rows `toNodeDetail` needs besides the node itself. */
export type NodeDetailContext = {
  /** Current version per runtime the node holds a version of. */
  currentVersionByRuntime: ReadonlyMap<string, string | null>;
  /** Always-on runtimes on this node with their address base URL (for detected servers). */
  alwaysOnByBaseUrl: ReadonlyMap<string, string>;
  /** The user's other nodes (fabric suggestions). */
  otherNodes: ReadonlyArray<{ id: string; nodeInfo: unknown }>;
};

const heldDefinitionsSchema = z.array(
  z.object({ runtimeId: z.string(), versionId: z.string(), launchHash: z.string() }),
);

export function parseHeldDefinitions(
  value: unknown,
): Array<{ runtimeId: string; versionId: string; launchHash: string }> {
  const parsed = heldDefinitionsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const ENGINE_WIRE = {
  vllm: "VLLM",
  sglang: "SGLANG",
  llama_cpp: "LLAMA_CPP",
  ollama: "OLLAMA",
  lm_studio: "LM_STUDIO",
  other: "OTHER",
} as const;
const API_WIRE = { openai: "OPENAI", anthropic: "ANTHROPIC" } as const;

const detectedServerWireSchema = z.object({
  baseUrl: z.string(),
  engine: z.enum(["vllm", "sglang", "llama_cpp", "ollama", "lm_studio", "other"]),
  api: z.enum(["openai", "anthropic"]),
  models: z.array(z.string()),
  version: z.string().optional(),
});
const detectedServersColumnSchema = z.union([
  z.array(detectedServerWireSchema),
  z.object({ servers: z.array(detectedServerWireSchema) }).transform((value) => value.servers),
]);

/** `http://127.0.0.1:8000/v1` and `http://127.0.0.1:8000` name the same server. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The servers a node reported (`runtime.detected`), in their wire values; [] when unreadable. */
export function parseDetectedServers(
  value: unknown,
): Array<z.infer<typeof detectedServerWireSchema>> {
  const parsed = detectedServersColumnSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function toDetectedServers(
  value: unknown,
  alwaysOnByBaseUrl: ReadonlyMap<string, string>,
): Array<z.infer<typeof detectedServerSchema>> {
  const parsed = detectedServersColumnSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((server) => ({
    baseUrl: server.baseUrl,
    engine: ENGINE_WIRE[server.engine],
    api: API_WIRE[server.api],
    models: server.models,
    version: server.version ?? null,
    runtimeId: alwaysOnByBaseUrl.get(normalizeBaseUrl(server.baseUrl)) ?? null,
  }));
}

export function toQueuedCommandView(row: {
  id: string;
  nodeId: string;
  command: string;
  note: string | null;
  state: z.infer<typeof queuedCommandViewSchema>["state"];
  agentTokenId: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  outcome: string | null;
}): z.infer<typeof queuedCommandViewSchema> {
  return {
    id: row.id,
    nodeId: row.nodeId,
    command: row.command,
    note: row.note,
    state: row.state,
    agentTokenId: row.agentTokenId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    outcome: row.outcome,
  };
}

/**
 * The server stores null for "no metric commands / fabrics and nothing held"; a node that was
 * sent the empty list reports the empty list's hash. Both mean the same definition.
 */
const EMPTY_METRIC_COMMANDS_HASH = nodeMetricCommandsHash([]);
const EMPTY_FABRICS_HASH = nodeFabricsHash([]);

/** Also "in sync" for a node never synced while the server has nothing to push. */
function hashesInSync(server: string | null, held: string | null, empty: string): boolean {
  return (server ?? empty) === (held ?? empty);
}

export function toNodeDetail(
  row: NodeDetailRow,
  context: NodeDetailContext,
  now: Date,
): NodeDetail {
  const heldRanks = row.Ranks.filter((rank) => rank.claim !== "RELEASED");
  const reservations = (row.Reservations ?? []).map((reservation) => ({
    ...reservation,
    claim: reservationClaim(reservation.Instance.Ranks),
  }));
  const heldReservations = reservations.filter((reservation) => reservation.claim !== "RELEASED");
  const summary = toNodeSummary(
    {
      ...row,
      Ranks: heldRanks.map((rank) => ({ resources: rank.resources, Instance: rank.Instance })),
      Reservations: heldReservations.map((reservation) => ({ resources: reservation.resources })),
    },
    now,
  );
  const features = nodeFeaturesSchema.safeParse(row.features);
  const declared = declaredHardwareSchema.safeParse(row.declaredResources);
  const metricCommands = nodeMetricCommandsSchema.safeParse(row.metricCommands);

  const fabrics: Array<z.infer<typeof nodeFabricViewSchema>> = row.FabricMembers.map((member) => ({
    fabricId: member.Fabric.id,
    name: member.Fabric.name,
    ip: member.ip,
    peers: member.Fabric.Members.filter((peer) => peer.nodeId !== row.id).map((peer) => ({
      nodeId: peer.nodeId,
      slug: peer.Node.slug,
      ip: peer.ip,
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const instances: Array<z.infer<typeof nodeInstanceRefSchema>> = row.Ranks.map((rank) => ({
    instanceId: rank.Instance.id,
    runtimeId: rank.Instance.runtimeId,
    runtimeSlug: rank.Instance.Runtime.slug,
    nodeNumber: rank.rank + 1,
    nodeCount: Math.max(1, rank.Instance._count.Ranks),
    phase: rank.Instance.phase,
    reserved: rank.claim,
    needsOperator: rank.Instance.needsOperator,
    role: "rank" as const,
  }));
  // Memory held here by an instance that runs elsewhere (`launch.reservations`): one entry per
  // instance, its current reservation's when it has one here. A restart's superseded row (the
  // old run's, still counted in `hardware` above) beside the new one is the same instance's hold,
  // not another entry.
  const reservationEntries = new Map<string, (typeof reservations)[number]>();
  for (const reservation of reservations) {
    const seen = reservationEntries.get(reservation.Instance.id);
    if (!seen || (seen.supersededGeneration !== null && reservation.supersededGeneration === null))
      reservationEntries.set(reservation.Instance.id, reservation);
  }
  for (const reservation of reservationEntries.values())
    instances.push({
      instanceId: reservation.Instance.id,
      runtimeId: reservation.Instance.runtimeId,
      runtimeSlug: reservation.Instance.Runtime.slug,
      nodeNumber: reservation.index + 1,
      nodeCount: Math.max(1, reservation.Instance._count.Reservations),
      phase: reservation.Instance.phase,
      reserved: reservation.claim,
      needsOperator: reservation.Instance.needsOperator,
      role: "reservation",
    });

  return {
    ...summary,
    hostname: row.hostname,
    features: features.success ? features.data : null,
    hardware: effectiveHardware({
      declaredResources: row.declaredResources,
      declaredBy: row.declaredResourcesBy,
      nodeInfo: row.nodeInfo,
      nodeMetrics: row.nodeMetrics,
      nodeMetricsAt: row.nodeMetricsAt,
      heldClaims: [
        ...heldRanks.map((rank) => rank.resources),
        ...heldReservations.map((reservation) => reservation.resources),
      ],
      now,
    }),
    declaredHardware: declared.success ? declared.data : null,
    portRange: [row.portStart, row.portEnd],
    metricCommands: metricCommands.success ? metricCommands.data : [],
    metricCommandsInSync: hashesInSync(
      row.metricCommandsHash,
      row.heldMetricCommandsHash,
      EMPTY_METRIC_COMMANDS_HASH,
    ),
    fabrics,
    fabricsInSync: hashesInSync(row.fabricsHash, row.heldFabricsHash, EMPTY_FABRICS_HASH),
    fabricSuggestions: fabricSuggestions(row.nodeInfo, context.otherNodes),
    commandMaxMs: row.commandMaxMs,
    secrets: features.success ? features.data.secrets : [],
    heldDefinitions: parseHeldDefinitions(row.heldDefinitions)
      .filter((held) => /^[0-9a-f]{64}$/.test(held.launchHash))
      .map((held) => ({
        ...held,
        current: context.currentVersionByRuntime.get(held.runtimeId) === held.versionId,
      })),
    instances,
    detectedServers: toDetectedServers(row.detectedServers, context.alwaysOnByBaseUrl),
    detectedAt: row.detectedServersAt?.toISOString() ?? null,
    queuedCommands: row.QueuedCommands.map(toQueuedCommandView),
  };
}
