/**
 * The placement planner (lane F). Pure: callers load nodes, claims, instances and fabrics and
 * this decides where each instance of a start goes, what it must stop to make room, or why it
 * cannot run. Runtime start (`runtimes.start`) and profile apply (`profiles.apply`) both place
 * through it, so a preview, its fingerprint and the applied write agree.
 *
 * Accounting (contract round 3, item 7): a node's budget is its effective hardware (declared >
 * node config > detected, `nodes/hardware.ts`) minus every claim that is not RELEASED
 * (HELD and HELD_UNKNOWN; a stopping instance keeps its claim until the node proves the stop).
 * - Memory: `unified.memoryGb`, `cpu.ramGb` and `discrete.ramGb` count against the node's
 *   usable memory. A service runtime (no served models) claims its declared resources too.
 * - GPUs: a `discrete` rank takes `gpuCount` GPUs (of `vendor`, when set) that each have
 *   `vramGb` free. Claims are replayed in a fixed order with the same best-fit rule, so which
 *   GPU a claim holds is deterministic and freeing it gives back exactly what it took.
 * - Ports: every claim's `port` and `distPort` stay taken until the claim is released, also
 *   for an instance this plan stops (its start queues behind the stop, `blockedBy`).
 * - Stopping: an instance already stopping (desired STOPPED) is planned like one this plan
 *   stops: its HELD claims' memory and GPUs are free, its ports stay taken, and a start on its
 *   nodes waits for it (`blockedBy`, warning `waits_for_stop`). A HELD_UNKNOWN claim is never
 *   freed by a stop (the engine does not wait for it). Nodes free now are preferred.
 *
 * Choice (deterministic): one rank per node within an instance. Without preemption the planner
 * packs best-fit (least memory left over, then least GPU memory, then slug), which keeps whole
 * nodes free for multi-node instances. A multi-node instance stays inside ONE fabric (by name
 * when `launch.fabric` pins one): the smallest fabric that fits wins, then the name
 * (`no_shared_fabric` when no fabric has enough members). The head (rank 0) address and every
 * rank's `fabric_ip` come from that fabric's member IPs. A node set is usable only when every
 * Relay-only rank holds the head address in its frozen copy of that fabric (§4.4, else the node
 * refuses with `definition_frozen`) and one dist port, inside the intersection of the ranks'
 * port ranges, is free on every rank (a rank moves off the common port its own port took);
 * otherwise other sets are tried (`head_not_in_frozen_fabric` / `no_free_ports`, or
 * `fabric_port_ranges_disjoint` when the ranges share no port, when none works).
 *
 * Preemption (only when nothing fits without it, only when the request allows it): the stop
 * set with the least disruption, compared as (contributed instances, instances, ranks, GiB
 * freed, ids). Only the caller's own running STARTABLE instances of another runtime are ever
 * stopped. Agents never stop an instance on a node that is not Full control, one whose served
 * models another user's pool runs (contributed), or one whose stop waits for a person.
 */
import type { RefusalReason } from "../contracts/refusals";
import { compareCodePoints } from "./canonical-json";
import {
  type GpuVendor,
  type RuntimeLaunch,
  type RuntimeResource,
  runtimeResourceSchema,
} from "./runtime-spec";

// ── Inputs ──

export type PlacementGpu = {
  /** `vendor:index`, as `effectiveHardware` names it. */
  key: string;
  vendor: GpuVendor;
  /** Usable VRAM (GiB): the GPU's VRAM minus its reserved VRAM. */
  vramGb: number;
};

/** A fabric as a Relay-only node froze it (`Node.frozenFabrics`, `nodeFabricSetsSchema`). */
export type PlacementFrozenFabric = {
  fabricId: string;
  /** The fabric's name when frozen: a launch that pins a fabric must match it (render.rs). */
  name: string;
  memberIps: readonly string[];
};

export type PlacementNode = {
  id: string;
  slug: string;
  online: boolean;
  /** Effective trust (a pending lower counts as Relay only). */
  trust: "RELAY" | "FULL";
  /** A person's or a profile's hold: nothing is placed here (`node_held`). */
  held: boolean;
  labels: readonly string[];
  portRange: readonly [number, number];
  /** Version ids the node holds (frozen at Relay only). */
  heldVersionIds: ReadonlySet<string>;
  /**
   * The fabrics a Relay-only node checks a multi-node head against: what it froze; `"current"`
   * for a pending lower whose fabric definition is in sync (it will freeze its current
   * memberships, taken from the context's fabrics); null when not checked (Full control, or a
   * pending lower whose fabrics are not in sync).
   */
  frozenFabrics: readonly PlacementFrozenFabric[] | "current" | null;
  /** Usable node memory (GiB) before any claim (`effectiveHardware().usableMemoryGb`). */
  memoryGb: number;
  gpus: readonly PlacementGpu[];
  /** Free memory from a live `node.metrics` sample, or null. Warnings only. */
  liveFreeMemoryGb: number | null;
};

export type PlacementRank = {
  /** Null once the node was deleted (its claim is released then). */
  nodeId: string | null;
  port: number;
  distPort: number | null;
  /** The rank's `resources` JSON (`runtimeResourceSchema`); anything else claims nothing. */
  resources: unknown;
  /** HELD_UNKNOWN (forgotten) claims stay counted: no stop releases them. */
  claim: "HELD" | "HELD_UNKNOWN";
};

export type PlacementInstance = {
  id: string;
  runtimeId: string;
  /** The instance owner (`RuntimeInstance.userId`). */
  ownerId: string;
  /** STARTABLE (an always-on runtime is never stopped by placement). */
  startable: boolean;
  /**
   * `desiredState` RUNNING. One that is not is already stopping: never a preemption candidate,
   * and its HELD claims are planned free (new ranks on its nodes wait for it).
   */
  running: boolean;
  /** Ranks whose claim is not RELEASED. */
  ranks: readonly PlacementRank[];
  /** One of its served models is a member of another user's pool. */
  contributed: boolean;
  /** A stop step runs in an operator terminal and waits for a person. */
  interactiveStop: boolean;
};

export type PlacementFabric = {
  id: string;
  name: string;
  members: ReadonlyArray<{ nodeId: string; ip: string }>;
};

export type PlacementContext = {
  /** The caller's user id: only their own instances may be preempted. */
  callerId: string;
  /** `agentRulesApply(auth)`: Full-control nodes only, stricter preemption. */
  agent: boolean;
  nodes: readonly PlacementNode[];
  instances: readonly PlacementInstance[];
  fabrics: readonly PlacementFabric[];
  /**
   * Instances this operation stops anyway (a profile apply's stops): their resources are
   * planned free, their ports stay taken, and new ranks on their nodes wait for them.
   */
  stopping?: ReadonlySet<string>;
};

type LaunchShape = Pick<RuntimeLaunch, "groupSize" | "resources" | "labels" | "port" | "fabric">;

export type PlacementRequest = {
  runtimeId: string;
  versionId: string;
  launch: LaunchShape;
  /** Exactly these nodes, in rank order (explicit node ids or a restart). */
  nodeIds?: readonly string[];
  /** A restart: the instance's own claims do not count, and it keeps its own ports. */
  restart?: { instanceId: string; ports: readonly number[]; distPort: number | null };
  /** Nodes this request may use (a profile's placeable nodes). Absent: every node. */
  allowedNodeIds?: ReadonlySet<string>;
  /** Refuse a Relay-only node that does not hold this version (`definition_frozen`). */
  checkFrozen: boolean;
  /** May stop instances to make room. */
  preempt: boolean;
};

// ── Outputs ──

export type PlannedPlacement = {
  nodeId: string;
  nodeSlug: string;
  nodeNumber: number;
  port: number;
  /** This node's IP on the instance's fabric (multi-node), else null. */
  fabricIp: string | null;
  resources: Record<string, unknown>;
};

export type PlannedStart = {
  placements: PlannedPlacement[];
  fabric: { fabricId: string; name: string; headAddr: string } | null;
  distPort: number | null;
  /** Instances this plan stops that hold a claim on one of these nodes (start waits). */
  blockedBy: string[];
};

export type PlannedStop = { instanceId: string; runtimeId: string; reason: "preempted" };

export type PlacementRefusal = {
  reason: RefusalReason;
  subjectId: string | null;
  message: string;
};

export type PlacementWarning = {
  code: "low_free_memory" | "interactive_needs_person" | "waits_for_stop";
  nodeId: string | null;
  detail: string;
};

export type PlacementResult =
  | { ok: true; start: PlannedStart; stops: PlannedStop[]; warnings: PlacementWarning[] }
  | { ok: false; refusal: PlacementRefusal };

// ── Resources ──

type Needs = { memoryGb: number; gpuCount: number; vramGb: number; vendor: GpuVendor | null };

const NO_NEEDS: Needs = { memoryGb: 0, gpuCount: 0, vramGb: 0, vendor: null };

/**
 * The GPUs a discrete claim holds, as the planner recorded them in the rank's `resources`
 * (`gpus`: GPU keys). Absent on claims written before lane F.
 */
export function recordedGpuKeys(resources: unknown): string[] | null {
  if (!resources || typeof resources !== "object") return null;
  const gpus = Reflect.get(resources, "gpus");
  if (!Array.isArray(gpus) || !gpus.every((key) => typeof key === "string")) return null;
  return gpus;
}

/** What a rank's resources take from a node. Unparseable JSON takes nothing. */
export function resourceNeeds(resources: unknown): Needs {
  let spec = resources;
  if (resources && typeof resources === "object" && "gpus" in resources) {
    const { gpus: _recorded, ...rest } = resources as Record<string, unknown>;
    spec = rest;
  }
  const parsed = runtimeResourceSchema.safeParse(spec);
  if (!parsed.success) return NO_NEEDS;
  const resource = parsed.data;
  switch (resource.kind) {
    case "none":
      return NO_NEEDS;
    case "unified":
      return { ...NO_NEEDS, memoryGb: resource.memoryGb };
    case "cpu":
      return { ...NO_NEEDS, memoryGb: resource.ramGb };
    case "discrete":
      return {
        memoryGb: resource.ramGb ?? 0,
        gpuCount: resource.gpuCount,
        vramGb: resource.vramGb,
        vendor: resource.vendor ?? null,
      };
  }
}

/** Floating-point slack for GiB comparisons (values carry two decimals). */
const EPSILON = 1e-9;

type GpuBudget = { key: string; vendor: GpuVendor; freeGb: number };

/** Claimed ports, counted: two claims of one port (a restart and a thief) release separately. */
class PortClaims {
  readonly #counts: Map<number, number>;
  constructor(from?: PortClaims) {
    this.#counts = new Map(from ? from.#counts : []);
  }
  has(port: number): boolean {
    return (this.#counts.get(port) ?? 0) > 0;
  }
  add(port: number): void {
    this.#counts.set(port, (this.#counts.get(port) ?? 0) + 1);
  }
  delete(port: number): void {
    const count = (this.#counts.get(port) ?? 0) - 1;
    if (count > 0) this.#counts.set(port, count);
    else this.#counts.delete(port);
  }
}

type Budget = { memoryGb: number; gpus: GpuBudget[]; ports: PortClaims };

function cloneBudget(budget: Budget): Budget {
  return {
    memoryGb: budget.memoryGb,
    gpus: budget.gpus.map((gpu) => ({ ...gpu })),
    ports: new PortClaims(budget.ports),
  };
}

/**
 * The GPUs a rank takes: `gpuCount` GPUs of the vendor with `vramGb` free each, best fit
 * (least free first, then key). Null when they do not exist.
 */
function pickGpus(gpus: readonly GpuBudget[], needs: Needs): string[] | null {
  if (needs.gpuCount === 0) return [];
  const fitting = gpus
    .filter(
      (gpu) =>
        (needs.vendor === null || gpu.vendor === needs.vendor) &&
        gpu.freeGb + EPSILON >= needs.vramGb,
    )
    .sort((a, b) => a.freeGb - b.freeGb || compareCodePoints(a.key, b.key));
  if (fitting.length < needs.gpuCount) return null;
  return fitting.slice(0, needs.gpuCount).map((gpu) => gpu.key);
}

/** Takes (sign 1) or gives back (sign -1) memory and VRAM on these GPUs. */
function apply(budget: Budget, needs: Needs, gpuKeys: readonly string[], sign: 1 | -1): void {
  budget.memoryGb -= sign * needs.memoryGb;
  for (const key of gpuKeys) {
    const gpu = budget.gpus.find((candidate) => candidate.key === key);
    if (gpu) gpu.freeGb -= sign * needs.vramGb;
  }
}

/**
 * The GPUs an existing claim holds: the keys it recorded when they still exist with the vendor
 * it needs, else the best-fit pick, else (an over-committed node) the GPUs with the most free
 * VRAM. Over-commit then shows as negative free VRAM, so nothing more fits there.
 */
function claimGpus(budget: Budget, needs: Needs, resources: unknown): string[] {
  if (needs.gpuCount === 0) return [];
  const recorded = recordedGpuKeys(resources);
  if (
    recorded &&
    recorded.length === needs.gpuCount &&
    new Set(recorded).size === recorded.length &&
    recorded.every((key) =>
      budget.gpus.some(
        (gpu) => gpu.key === key && (needs.vendor === null || gpu.vendor === needs.vendor),
      ),
    )
  )
    return recorded;
  return (
    pickGpus(budget.gpus, needs) ??
    [...budget.gpus]
      .sort((a, b) => b.freeGb - a.freeGb || compareCodePoints(a.key, b.key))
      .slice(0, needs.gpuCount)
      .map((gpu) => gpu.key)
  );
}

/** The lowest free port of the node's range (or the fixed one), or null. */
function freePort(budget: Budget, node: PlacementNode, fixed: number | undefined): number | null {
  if (fixed !== undefined) return budget.ports.has(fixed) ? null : fixed;
  for (let port = node.portRange[0]; port <= node.portRange[1]; port++)
    if (!budget.ports.has(port)) return port;
  return null;
}

type Fit =
  | { ok: true; port: number; gpuKeys: string[]; needs: Needs }
  | { ok: false; reason: "not_enough_memory" | "port_in_use" | "no_free_ports" };

function fit(
  node: PlacementNode,
  budget: Budget,
  resources: unknown,
  fixedPort: number | undefined,
): Fit {
  const needs = resourceNeeds(resources);
  if (needs.memoryGb > budget.memoryGb + EPSILON) return { ok: false, reason: "not_enough_memory" };
  const gpuKeys = pickGpus(budget.gpus, needs);
  if (!gpuKeys) return { ok: false, reason: "not_enough_memory" };
  // Over-committed claims show as negative free VRAM on some GPU: the vendor's total must
  // cover the rank too, so no over-commit is ever placed on top.
  const totalFree = budget.gpus
    .filter((gpu) => needs.vendor === null || gpu.vendor === needs.vendor)
    .reduce((sum, gpu) => sum + gpu.freeGb, 0);
  if (needs.gpuCount > 0 && totalFree + EPSILON < needs.gpuCount * needs.vramGb)
    return { ok: false, reason: "not_enough_memory" };
  const port = freePort(budget, node, fixedPort);
  if (port === null)
    return { ok: false, reason: fixedPort === undefined ? "no_free_ports" : "port_in_use" };
  return { ok: true, port, gpuKeys, needs };
}

// ── Disruption cost ──

/** Contributed instances, instances, ranks, GiB freed, then the ids (lexicographic). */
type Cost = { numbers: [number, number, number, number]; ids: string };

const ZERO_COST: Cost = { numbers: [0, 0, 0, 0], ids: "" };

function compareCost(a: Cost, b: Cost): number {
  for (let index = 0; index < a.numbers.length; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (Math.abs(difference) > EPSILON) return difference;
  }
  return compareCodePoints(a.ids, b.ids);
}

function instanceMemoryGb(instance: PlacementInstance): number {
  return instance.ranks.reduce(
    (sum, rank) => sum + resourceNeeds(rank.resources).memoryGb + gpuGb(rank.resources),
    0,
  );
}

function gpuGb(resources: unknown): number {
  const needs = resourceNeeds(resources);
  return needs.gpuCount * needs.vramGb;
}

function costOf(victims: readonly PlacementInstance[]): Cost {
  if (victims.length === 0) return ZERO_COST;
  return {
    numbers: [
      victims.filter((victim) => victim.contributed).length,
      victims.length,
      victims.reduce((sum, victim) => sum + victim.ranks.length, 0),
      victims.reduce((sum, victim) => sum + instanceMemoryGb(victim), 0),
    ],
    ids: victims
      .map((victim) => victim.id)
      .sort(compareCodePoints)
      .join(","),
  };
}

/** At most this many preemption candidates per node are considered (2^n subsets). */
const MAX_VICTIMS_PER_NODE = 10;

// ── Refusals ──

/** Which reason a refusal names when nodes failed for several: the closest miss first. */
const REASON_ORDER: readonly RefusalReason[] = [
  "not_enough_memory",
  "port_in_use",
  "no_free_ports",
  "node_offline",
  "node_held",
  "definition_frozen",
  "trust_relay",
  "label_mismatch",
  "not_enough_nodes",
];

const MESSAGES: Partial<Record<RefusalReason, string>> = {
  trust_relay:
    "This node is Relay only: agents cannot start or stop runtimes there. A person can do it in the browser.",
  node_offline: "This node is offline.",
  node_held:
    "A person or a profile put this node on hold; nothing is placed there until it is released.",
  label_mismatch: "This node lacks a label the runtime requires.",
  definition_frozen:
    "This node is Relay only and does not hold this version; a person can start only what it holds.",
  no_free_ports: "This node has no free port in its range.",
  port_in_use: "The runtime's port is already claimed on this node.",
  unknown_node: "That node does not exist.",
  invalid_node_count: "Give exactly one node per rank (groupSize).",
  not_enough_nodes: "Not enough eligible nodes are online for this runtime.",
  head_not_in_frozen_fabric:
    "A Relay-only node does not hold the head's address in its frozen copy of this fabric, so it would refuse the start. Raise its trust to Full, or start on nodes whose frozen fabric includes the head.",
};

/** Set-level reasons (a whole node set was found but cannot run), the closest miss first. */
const GROUP_REASONS = [
  "no_free_ports",
  "head_not_in_frozen_fabric",
  "fabric_port_ranges_disjoint",
] as const;
type GroupReason = (typeof GROUP_REASONS)[number];

const GROUP_MESSAGES: Record<GroupReason, string> = {
  no_free_ports:
    "No set of nodes that fits has one dist port free on every node; free a port or widen the nodes' port ranges.",
  head_not_in_frozen_fabric:
    "In every set of nodes that fits, a Relay-only node does not hold the head's address in its frozen copy of the fabric, so it would refuse the start. Raise its trust to Full, or start on nodes whose frozen fabric includes the head.",
  fabric_port_ranges_disjoint:
    "The nodes of every set that fits have port ranges with no port in common, and a multi-node instance needs one dist port on every node. Make the ranges overlap.",
};

/**
 * At most this many other node sets are tried per pass of one `place()` (across every fabric and
 * preemption seed) when the best set cannot run. Each try is one greedy run: groupSize ×
 * candidates fits, each trying up to 2^MAX_VICTIMS_PER_NODE stop sets with preemption.
 */
const MAX_SET_TRIES = 32;

/** Why a whole node set cannot run, and the node it is about (the first refusing node). */
type GroupProblem = { reason: GroupReason; subjectId: string | null; message?: string };

function refusal(reason: RefusalReason, subjectId: string | null, message?: string) {
  return { reason, subjectId, message: message ?? MESSAGES[reason] ?? reason };
}

function gib(value: number): string {
  return `${Math.round(value * 100) / 100} GiB`;
}

// ── The planner ──

type Working = {
  budgets: Map<string, Budget>;
  /** Instances stopped by this request so far (beyond the planner's committed stops). */
  victims: Set<string>;
};

type RankChoice = {
  node: PlacementNode;
  victims: PlacementInstance[];
  port: number;
  gpuKeys: string[];
  needs: Needs;
  /** Memory, then GPU memory left on the node after this rank (best fit). */
  leftover: [number, number];
  /** An instance already stopping holds a claim here: the rank waits for its release. */
  waits: boolean;
};

type InstanceChoice = {
  working: Working;
  ranks: RankChoice[];
  fabric: PlacementFabric | null;
  cost: Cost;
  leftover: number;
};

export class PlacementPlanner {
  readonly #context: PlacementContext;
  readonly #nodes: Map<string, PlacementNode>;
  readonly #instances: Map<string, PlacementInstance>;
  #budgets: Map<string, Budget>;
  /** Which GPUs each claim holds: `instanceId|rankIndex` → GPU keys. */
  readonly #gpuClaims = new Map<string, string[]>();
  /**
   * Every instance planned to stop: the context's, those already stopping (`#draining`) and this
   * planner's preemptions. Their HELD claims are free in the budgets; their ports stay taken.
   */
  readonly #stopping: Set<string>;
  /** Instances already stopping before this plan (desired STOPPED, a claim still HELD). */
  readonly #draining: Set<string>;
  /** Each node's frozen fabrics as checked (`"current"` resolved), or null: not checked. */
  readonly #frozen: Map<string, readonly PlacementFrozenFabric[] | null>;
  /** Alternative node sets still allowed in this pass (`MAX_SET_TRIES`). */
  #setTries = MAX_SET_TRIES;
  readonly #stops: PlannedStop[] = [];

  constructor(context: PlacementContext) {
    this.#context = context;
    this.#nodes = new Map(context.nodes.map((node) => [node.id, node]));
    this.#instances = new Map(context.instances.map((instance) => [instance.id, instance]));
    this.#draining = new Set(
      context.instances
        .filter((instance) => !instance.running && instance.ranks.some(isHeld))
        .map((instance) => instance.id),
    );
    this.#stopping = new Set([...(context.stopping ?? []), ...this.#draining]);
    this.#frozen = new Map(
      context.nodes.map((node) => [
        node.id,
        node.frozenFabrics === "current"
          ? context.fabrics
              .filter((fabric) => fabric.members.some((member) => member.nodeId === node.id))
              .map((fabric) => ({
                fabricId: fabric.id,
                name: fabric.name,
                memberIps: fabric.members.map((member) => member.ip),
              }))
          : node.frozenFabrics,
      ]),
    );
    this.#budgets = new Map(
      context.nodes.map((node) => [
        node.id,
        {
          memoryGb: node.memoryGb,
          gpus: [...node.gpus]
            .sort((a, b) => compareCodePoints(a.key, b.key))
            .map((gpu) => ({ key: gpu.key, vendor: gpu.vendor, freeGb: gpu.vramGb })),
          ports: new PortClaims(),
        },
      ]),
    );
    // Replay every claim in one fixed order (instance id, rank), so GPU picks are stable:
    // claims that recorded their GPUs first, then older claims onto what is left.
    const ordered = [...context.instances].sort((a, b) => compareCodePoints(a.id, b.id));
    for (const recordedPass of [true, false])
      for (const instance of ordered)
        instance.ranks.forEach((rank, index) => {
          if (!rank.nodeId) return;
          if ((recordedGpuKeys(rank.resources) !== null) !== recordedPass) return;
          const budget = this.#budgets.get(rank.nodeId);
          if (!budget) return;
          budget.ports.add(rank.port);
          if (rank.distPort !== null) budget.ports.add(rank.distPort);
          const needs = resourceNeeds(rank.resources);
          const gpuKeys = claimGpus(budget, needs, rank.resources);
          this.#gpuClaims.set(`${instance.id}|${index}`, gpuKeys);
          if (!this.#freedByStop(instance.id, rank)) apply(budget, needs, gpuKeys, 1);
        });
  }

  /** Every instance this planner decided to stop so far (sorted by id). */
  get stops(): PlannedStop[] {
    return [...this.#stops].sort((a, b) => compareCodePoints(a.instanceId, b.instanceId));
  }

  /** Places one instance; on success its claims (and any preemption) are committed. */
  place(request: PlacementRequest): PlacementResult {
    const working: Working = { budgets: this.#cloneBudgets(), victims: new Set() };
    if (request.restart) this.#freeInstance(working, request.restart.instanceId, "restart");

    const chosen = request.nodeIds
      ? this.#placeOnNodes(working, request, request.nodeIds)
      : this.#placeAuto(working, request);
    if ("refusal" in chosen) return { ok: false, refusal: chosen.refusal };
    if (chosen.working.victims.size > 0) this.#pruneVictims(working, request, chosen);

    const { ranks, fabric } = chosen;
    // dist_port: one port free on every rank's node (multi-node only).
    let distPort: number | null = null;
    if (request.launch.groupSize > 1) {
      const plan = this.#distPlan(chosen.working, ranks, request.restart);
      if ("reason" in plan)
        return {
          ok: false,
          refusal: refusal(plan.reason, ranks[0]?.node.id ?? null, plan.message),
        };
      // A rank whose own port is the only common one moves to another of its ports.
      for (const [rank, port] of plan.moves) {
        const budget = chosen.working.budgets.get(rank.node.id);
        budget?.ports.delete(rank.port);
        rank.port = port;
        budget?.ports.add(port);
      }
      distPort = plan.port;
      for (const rank of ranks) chosen.working.budgets.get(rank.node.id)?.ports.add(distPort);
    }

    // Commit.
    this.#budgets = chosen.working.budgets;
    const victimIds = [...chosen.working.victims].sort(compareCodePoints);
    const warnings: PlacementWarning[] = [];
    const stops: PlannedStop[] = [];
    for (const id of victimIds) {
      const victim = this.#instances.get(id);
      if (!victim) continue;
      this.#stopping.add(id);
      const stop = { instanceId: id, runtimeId: victim.runtimeId, reason: "preempted" as const };
      this.#stops.push(stop);
      stops.push(stop);
      if (victim.interactiveStop)
        warnings.push({
          code: "interactive_needs_person",
          nodeId: null,
          detail: "A stopped instance has a stop step a person runs in a terminal.",
        });
    }
    const nodeIds = new Set(ranks.map((rank) => rank.node.id));
    // Never its own id: a restart waiting for itself would never start.
    const blockedBy = [...this.#stopping]
      .filter(
        (id) =>
          id !== request.restart?.instanceId && this.#heldOn(id, (nodeId) => nodeIds.has(nodeId)),
      )
      .sort(compareCodePoints);
    // A restarted instance runs again: later plans no longer wait for it.
    if (request.restart) {
      this.#stopping.delete(request.restart.instanceId);
      this.#draining.delete(request.restart.instanceId);
    }
    for (const rank of ranks) {
      const live = rank.node.liveFreeMemoryGb;
      const on = (nodeId: string) => nodeId === rank.node.id;
      // A node a stop frees reports its memory only after the stop.
      const freed = blockedBy.some((id) => this.#heldOn(id, on));
      // Not this plan's stop, so the preview's stops do not show it: say the start waits.
      if (blockedBy.some((id) => this.#draining.has(id) && this.#heldOn(id, on)))
        warnings.push({
          code: "waits_for_stop",
          nodeId: rank.node.id,
          detail:
            "An instance that is already stopping holds room on this node; this start waits until the node releases it.",
        });
      if (!freed && live !== null && rank.needs.memoryGb > live + EPSILON)
        warnings.push({
          code: "low_free_memory",
          nodeId: rank.node.id,
          // Fixed text: a live number would change the fingerprint with every sample.
          detail: "The node reports less free memory than this rank declares.",
        });
    }
    const memberIp = (nodeId: string) =>
      fabric?.members.find((member) => member.nodeId === nodeId)?.ip ?? null;
    const head = ranks[0];
    return {
      ok: true,
      start: {
        placements: ranks.map((rank, index) => ({
          nodeId: rank.node.id,
          nodeSlug: rank.node.slug,
          nodeNumber: index + 1,
          port: rank.port,
          fabricIp: memberIp(rank.node.id),
          // The GPUs this rank takes are recorded with its claim (`gpus`), so later plans
          // account the same GPUs.
          resources: {
            ...(rankResources(request.launch, index) as Record<string, unknown>),
            ...(rank.gpuKeys.length > 0 ? { gpus: [...rank.gpuKeys] } : {}),
          },
        })),
        fabric:
          fabric && head
            ? { fabricId: fabric.id, name: fabric.name, headAddr: memberIp(head.node.id) ?? "" }
            : null,
        distPort,
        blockedBy,
      },
      stops,
      warnings,
    };
  }

  /**
   * Drops stops the chosen placement does not need: the search may stop an instance whose
   * freed resources end up unused (a seed that only moved the best fit elsewhere). Each victim,
   * most disruptive first, is kept running when the same ranks (nodes, ports) still fit
   * without it. `chosen` is updated in place.
   */
  #pruneVictims(base: Working, request: PlacementRequest, chosen: InstanceChoice): void {
    const victims = [...chosen.working.victims]
      .flatMap((id) => {
        const instance = this.#instances.get(id);
        return instance ? [instance] : [];
      })
      .sort((a, b) => compareCost(costOf([b]), costOf([a])));
    let kept = new Set(chosen.working.victims);
    for (const victim of victims) {
      const without = new Set([...kept].filter((id) => id !== victim.id));
      const replay = this.#replayRanks(base, request, chosen.ranks, without);
      if (!replay) continue;
      kept = without;
      chosen.working = replay.working;
      chosen.ranks = replay.ranks;
    }
    chosen.cost = this.#costOfWorking(chosen.working);
  }

  /** The same ranks (nodes, ports) on `base` with exactly `victims` stopped, or null. */
  #replayRanks(
    base: Working,
    request: PlacementRequest,
    ranks: readonly RankChoice[],
    victims: ReadonlySet<string>,
  ): { working: Working; ranks: RankChoice[] } | null {
    const working: Working = {
      budgets: new Map([...base.budgets].map(([id, budget]) => [id, cloneBudget(budget)])),
      victims: new Set(base.victims),
    };
    for (const id of [...victims].sort(compareCodePoints)) {
      working.victims.add(id);
      this.#freeInstance(working, id, "stop");
    }
    const replayed: RankChoice[] = [];
    for (const [index, rank] of ranks.entries()) {
      const budget = working.budgets.get(rank.node.id);
      if (!budget) return null;
      const fitted = fit(rank.node, budget, rankResources(request.launch, index), rank.port);
      if (!fitted.ok) return null;
      const choice = rankChoice(rank.node, budget, fitted, [], rank.waits);
      apply(budget, choice.needs, choice.gpuKeys, 1);
      budget.ports.add(choice.port);
      replayed.push(choice);
    }
    return { working, ranks: replayed };
  }

  // ── Explicit nodes (nodeIds or a restart) ──

  #placeOnNodes(
    working: Working,
    request: PlacementRequest,
    nodeIds: readonly string[],
  ): InstanceChoice | { refusal: PlacementRefusal } {
    const { launch } = request;
    if (nodeIds.length !== launch.groupSize || new Set(nodeIds).size !== nodeIds.length)
      return { refusal: refusal("invalid_node_count", request.restart?.instanceId ?? null) };
    const nodes: PlacementNode[] = [];
    for (const nodeId of nodeIds) {
      const node = this.#nodes.get(nodeId);
      if (!node) return { refusal: refusal("unknown_node", nodeId) };
      const reason = this.#ineligible(node, request);
      if (reason) return { refusal: refusal(reason, node.id) };
      nodes.push(node);
    }
    let fabric: PlacementFabric | null = null;
    if (launch.groupSize > 1) {
      const sharing = this.#fabricsFor(launch).filter((candidate) =>
        nodes.every((node) => candidate.members.some((member) => member.nodeId === node.id)),
      );
      // The first shared fabric on which every Relay-only rank accepts the head (§4.4).
      fabric = sharing.find((candidate) => !this.#frozenRefuser(nodes, candidate, launch)) ?? null;
      const first = sharing[0];
      if (!fabric && first)
        return {
          refusal: refusal(
            "head_not_in_frozen_fabric",
            this.#frozenRefuser(nodes, first, launch)?.id ?? null,
          ),
        };
      if (!fabric)
        return {
          refusal: refusal(
            "no_shared_fabric",
            nodes[0]?.id ?? null,
            launch.fabric
              ? "These nodes are not all members of the fabric the runtime names."
              : "These nodes share no fabric; a multi-node instance stays inside one.",
          ),
        };
    }
    const ranks: RankChoice[] = [];
    for (const [index, node] of nodes.entries()) {
      // A fixed port of the (new) version wins; otherwise a restart keeps its own port.
      const fixedPort = launch.port?.fixed ?? request.restart?.ports[index];
      const choice = this.#rankOn(working, request, node, index, fixedPort, request.preempt);
      if ("reason" in choice)
        return { refusal: this.#fitRefusal(choice.reason, node, request, index, working) };
      this.#commitRank(working, choice);
      ranks.push(choice);
    }
    return { working, ranks, fabric, cost: this.#costOfWorking(working), leftover: 0 };
  }

  // ── Automatic placement ──

  #placeAuto(
    working: Working,
    request: PlacementRequest,
  ): InstanceChoice | { refusal: PlacementRefusal } {
    const { launch } = request;
    const reasons = new Set<RefusalReason>();
    const nodeReasons = new Map<string, RefusalReason>();
    const eligible: PlacementNode[] = [];
    for (const node of [...this.#nodes.values()].sort((a, b) =>
      compareCodePoints(a.slug, b.slug),
    )) {
      if (request.allowedNodeIds && !request.allowedNodeIds.has(node.id)) continue;
      const reason = this.#ineligible(node, request);
      if (reason) nodeReasons.set(node.id, reason);
      else eligible.push(node);
    }

    // Fit reasons of the last pass explain the refusal (with preemption, what is left after
    // every allowed stop).
    const fitReasons = new Set<RefusalReason>();
    // Whole node sets that fit but cannot run (last pass), which explain a refusal first.
    const groupReasons: GroupReasons = new Map();
    const pass = (
      run: (
        preempt: boolean,
        into: Set<RefusalReason>,
        groups: GroupReasons,
      ) => InstanceChoice | null,
    ) => {
      this.#setTries = MAX_SET_TRIES;
      const plain = run(false, fitReasons, groupReasons);
      if (plain || !request.preempt) return plain;
      fitReasons.clear();
      groupReasons.clear();
      this.#setTries = MAX_SET_TRIES;
      return run(true, fitReasons, groupReasons);
    };

    if (launch.groupSize === 1) {
      for (const reason of nodeReasons.values()) reasons.add(reason);
      const choice = pass((preempt, into, groups) =>
        this.#bestGroup(working, request, eligible, null, preempt, into, groups),
      );
      for (const reason of fitReasons) reasons.add(reason);
      return choice ?? { refusal: this.#autoRefusal(reasons, request, eligible) };
    }

    // Multi-node: one fabric. No fabric with enough members at all → no_shared_fabric.
    const fabrics = this.#fabricsFor(launch).filter((fabric) => this.#withinScope(fabric, request));
    if (!fabrics.some((fabric) => this.#scopedMembers(fabric, request).length >= launch.groupSize))
      return {
        refusal: refusal(
          "no_shared_fabric",
          null,
          launch.fabric
            ? `The fabric this runtime names has fewer than ${launch.groupSize} usable nodes.`
            : `No fabric has ${launch.groupSize} nodes; a multi-node instance stays inside one fabric.`,
        ),
      };
    // Only nodes of these fabrics explain a multi-node refusal.
    for (const [nodeId, reason] of nodeReasons)
      if (fabrics.some((fabric) => fabric.members.some((member) => member.nodeId === nodeId)))
        reasons.add(reason);
    const membersOf = (fabric: PlacementFabric) =>
      eligible.filter((node) => fabric.members.some((member) => member.nodeId === node.id));
    const choice = pass((preempt, into, groups) => {
      let best: InstanceChoice | null = null;
      for (const fabric of fabrics) {
        const members = membersOf(fabric);
        if (members.length < launch.groupSize) continue;
        const candidate = this.#bestGroup(working, request, members, fabric, preempt, into, groups);
        if (candidate && (!best || compareInstanceChoice(candidate, best) < 0)) best = candidate;
      }
      return best;
    });
    if (choice) return choice;
    // Whole node sets fit but none can run: say why (the closest miss first).
    const groupReason = GROUP_REASONS.find((reason) => groupReasons.has(reason));
    if (groupReason)
      return {
        refusal: refusal(
          groupReason,
          groupReasons.get(groupReason)?.subjectId ?? null,
          groupReasons.get(groupReason)?.message ?? GROUP_MESSAGES[groupReason],
        ),
      };
    for (const reason of fitReasons) reasons.add(reason);
    if (!fabrics.some((fabric) => membersOf(fabric).length >= launch.groupSize)) {
      // Fabrics with enough members exist, but too few of them may take a rank.
      const reason = REASON_ORDER.find(
        (candidate) => !FIT_REASONS.has(candidate) && reasons.has(candidate),
      );
      return { refusal: refusal(reason ?? "not_enough_nodes", null) };
    }
    return { refusal: this.#autoRefusal(reasons, request, eligible) };
  }

  /**
   * Chooses one node per rank among `candidates` (greedy by rank, deterministic). With
   * `preempt`, a rank may stop instances; victims already chosen for an earlier rank are free.
   */
  #bestGroup(
    base: Working,
    request: PlacementRequest,
    candidates: readonly PlacementNode[],
    fabric: PlacementFabric | null,
    preempt: boolean,
    reasons: Set<RefusalReason>,
    groupReasons: GroupReasons,
  ): InstanceChoice | null {
    const group = (seed: PlacementInstance | null) =>
      this.#usableGroup(base, request, candidates, fabric, preempt, reasons, groupReasons, seed);
    let best = group(null);
    if (!preempt || request.launch.groupSize === 1) return best;
    // Rank by rank, one single-node victim always looks cheaper than a multi-node one, though
    // stopping that one instance may free several ranks at once. Try each multi-node victim
    // among the candidates as a seed and keep the least disruptive whole plan.
    const candidateIds = new Set(candidates.map((node) => node.id));
    const seeds = [...this.#instances.values()]
      .filter(
        (instance) =>
          !base.victims.has(instance.id) &&
          instance.ranks.filter((rank) => rank.nodeId !== null && candidateIds.has(rank.nodeId))
            .length > 1 &&
          this.#preemptible(instance, request),
      )
      .sort((a, b) => compareCodePoints(a.id, b.id));
    for (const seed of seeds) {
      const choice = group(seed);
      if (choice && (!best || compareInstanceChoice(choice, best) < 0)) best = choice;
    }
    return best;
  }

  /**
   * The greedy node set, or, when that set cannot run (a Relay-only rank would refuse the head,
   * or no dist port is free on every rank), the best usable set found from failed sets by making
   * another member the head or leaving a member out, breadth first (fewest changes), within
   * the pass's `MAX_SET_TRIES` budget.
   */
  #usableGroup(
    base: Working,
    request: PlacementRequest,
    candidates: readonly PlacementNode[],
    fabric: PlacementFabric | null,
    preempt: boolean,
    reasons: Set<RefusalReason>,
    groupReasons: GroupReasons,
    seed: PlacementInstance | null,
  ): InstanceChoice | null {
    const greedy = (
      pool: readonly PlacementNode[],
      head: string | null,
      into: Set<RefusalReason>,
    ) => this.#greedyGroup(base, request, pool, fabric, preempt, into, seed, head);
    const first = greedy(candidates, null, reasons);
    if (!first) return null;
    const problem = this.#groupProblem(first, request);
    if (!problem) return first;
    noteProblem(groupReasons, problem);

    // Fit reasons of the narrower pools would only repeat the first run's.
    const scratch = new Set<RefusalReason>();
    const seen = new Set<string>();
    type Trial = { left: readonly string[]; head: string | null };
    let frontier: Array<Trial & { failed: InstanceChoice }> = [
      { left: [], head: null, failed: first },
    ];
    while (frontier.length > 0 && this.#setTries > 0) {
      const next: typeof frontier = [];
      let best: InstanceChoice | null = null;
      for (const { left, head, failed } of frontier) {
        const trials: Trial[] = [
          // Another member as the head (the frozen rule depends on the head's address).
          ...failed.ranks.slice(1).map((rank) => ({ left, head: rank.node.id })),
          // A member left out (keeping a pinned head unless it is the one left out).
          ...failed.ranks.map((rank) => ({
            left: [...left, rank.node.id].sort(compareCodePoints),
            head: head === rank.node.id ? null : head,
          })),
        ];
        for (const trial of trials) {
          const key = `${trial.left.join(",")}|${trial.head ?? ""}`;
          if (seen.has(key) || this.#setTries <= 0) continue;
          seen.add(key);
          this.#setTries--;
          const pool = candidates.filter((node) => !trial.left.includes(node.id));
          if (pool.length < request.launch.groupSize) continue;
          const choice = greedy(pool, trial.head, scratch);
          if (!choice) continue;
          const reason = this.#groupProblem(choice, request);
          if (reason) {
            noteProblem(groupReasons, reason);
            next.push({ ...trial, failed: choice });
          } else if (!best || compareInstanceChoice(choice, best) < 0) best = choice;
        }
      }
      if (best) return best;
      frontier = next;
    }
    return null;
  }

  /** Why this node set cannot run a multi-node instance, or null. */
  #groupProblem(choice: InstanceChoice, request: PlacementRequest): GroupProblem | null {
    if (request.launch.groupSize <= 1) return null;
    const nodes = choice.ranks.map((rank) => rank.node);
    const refuser = this.#frozenRefuser(nodes, choice.fabric, request.launch);
    if (refuser) return { reason: "head_not_in_frozen_fabric", subjectId: refuser.id };
    const plan = this.#distPlan(choice.working, choice.ranks, request.restart);
    if ("reason" in plan)
      return {
        reason: plan.reason,
        subjectId: choice.ranks[0]?.node.id ?? null,
        ...(plan.message ? { message: plan.message } : {}),
      };
    return null;
  }

  /**
   * The first Relay-only node (in rank order) that would refuse this set's head on `fabric`: its
   * frozen copy of the fabric (same id, and the pinned name when the launch pins one) does not
   * list the head's address (§4.4). Null when every node accepts, or without a fabric.
   */
  #frozenRefuser(
    nodes: readonly PlacementNode[],
    fabric: PlacementFabric | null,
    launch: LaunchShape,
  ): PlacementNode | null {
    const head = nodes[0];
    if (!fabric || !head) return null;
    const headAddr = fabric.members.find((member) => member.nodeId === head.id)?.ip;
    return (
      nodes.find((node) => {
        const frozen = this.#frozen.get(node.id) ?? null;
        return (
          node.trust === "RELAY" &&
          frozen !== null &&
          !frozen.some(
            (set) =>
              set.fabricId === fabric.id &&
              (!launch.fabric || set.name === launch.fabric) &&
              headAddr !== undefined &&
              set.memberIps.includes(headAddr),
          )
        );
      }) ?? null
    );
  }

  #greedyGroup(
    base: Working,
    request: PlacementRequest,
    candidates: readonly PlacementNode[],
    fabric: PlacementFabric | null,
    preempt: boolean,
    reasons: Set<RefusalReason>,
    seed: PlacementInstance | null,
    /** Only this node may take rank 0 (the head), when set. */
    head: string | null = null,
  ): InstanceChoice | null {
    const working: Working = {
      budgets: new Map([...base.budgets].map(([id, budget]) => [id, cloneBudget(budget)])),
      victims: new Set(base.victims),
    };
    if (seed) {
      working.victims.add(seed.id);
      this.#freeInstance(working, seed.id, "stop");
    }
    const used = new Set<string>();
    const ranks: RankChoice[] = [];
    for (let index = 0; index < request.launch.groupSize; index++) {
      let best: RankChoice | null = null;
      for (const node of candidates) {
        if (used.has(node.id) || (index === 0 && head !== null && node.id !== head)) continue;
        const choice = this.#rankOn(
          working,
          request,
          node,
          index,
          request.launch.port?.fixed,
          preempt,
        );
        if ("reason" in choice) {
          reasons.add(choice.reason);
          continue;
        }
        if (!best || compareRank(choice, best) < 0) best = choice;
      }
      if (!best) return null;
      this.#commitRank(working, best);
      used.add(best.node.id);
      ranks.push(best);
    }
    return {
      working,
      ranks,
      fabric,
      cost: this.#costOfWorking(working),
      leftover: ranks.reduce((sum, rank) => sum + rank.leftover[0], 0),
    };
  }

  /** How this rank fits on `node`: as is, or (with `preempt`) after the cheapest stops. */
  #rankOn(
    working: Working,
    request: PlacementRequest,
    node: PlacementNode,
    rank: number,
    fixedPort: number | undefined,
    preempt: boolean,
  ): RankChoice | { reason: "not_enough_memory" | "port_in_use" | "no_free_ports" } {
    const budget = working.budgets.get(node.id);
    if (!budget) return { reason: "not_enough_memory" };
    const resources = rankResources(request.launch, rank);
    const waits = [...this.#draining].some(
      (id) =>
        id !== request.restart?.instanceId && this.#heldOn(id, (nodeId) => nodeId === node.id),
    );
    const plain = fit(node, budget, resources, fixedPort);
    if (plain.ok) return rankChoice(node, budget, plain, [], waits);
    // Ports are not freed by a stop (the claim keeps them until released): no preemption helps.
    if (!preempt || plain.reason !== "not_enough_memory") return { reason: plain.reason };

    const candidates = [...this.#instances.values()]
      .filter(
        (instance) =>
          !working.victims.has(instance.id) &&
          instance.ranks.some((claim) => claim.nodeId === node.id) &&
          this.#preemptible(instance, request),
      )
      .sort((a, b) => compareCost(costOf([a]), costOf([b])))
      .slice(0, MAX_VICTIMS_PER_NODE);
    let best: RankChoice | null = null;
    let bestCost: Cost | null = null;
    // Stops free memory, never ports: a trial that fits memory but not a port says so.
    let reason: "not_enough_memory" | "port_in_use" | "no_free_ports" = "not_enough_memory";
    const total = 1 << candidates.length;
    for (let mask = 1; mask < total; mask++) {
      const victims = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
      const cost = costOf(victims);
      if (bestCost && compareCost(cost, bestCost) >= 0) continue;
      const trial = cloneBudget(budget);
      for (const victim of victims) this.#freeOnNode(trial, victim, node.id);
      const fitted = fit(node, trial, resources, fixedPort);
      if (!fitted.ok) {
        if (fitted.reason !== "not_enough_memory") reason = fitted.reason;
        continue;
      }
      best = rankChoice(node, trial, fitted, victims, waits);
      bestCost = cost;
    }
    return best ?? { reason };
  }

  /** Frees the chosen victims everywhere, then takes the rank's claim. */
  #commitRank(working: Working, choice: RankChoice): void {
    for (const victim of choice.victims) {
      if (working.victims.has(victim.id)) continue;
      working.victims.add(victim.id);
      this.#freeInstance(working, victim.id, "stop");
    }
    const budget = working.budgets.get(choice.node.id);
    if (!budget) return;
    // GPUs again on the freed budget (identical to the trial's pick: same state, same rule).
    const gpuKeys = pickGpus(budget.gpus, choice.needs) ?? choice.gpuKeys;
    choice.gpuKeys = gpuKeys;
    apply(budget, choice.needs, gpuKeys, 1);
    budget.ports.add(choice.port);
  }

  /**
   * Gives back an instance's memory and GPUs in `working`: a stop frees its HELD claims; a
   * restart frees every claim (it retakes HELD_UNKNOWN ones) and its ports. Claims that are
   * free already (`#freedByStop`) are skipped.
   */
  #freeInstance(working: Working, instanceId: string, mode: "stop" | "restart"): void {
    const instance = this.#instances.get(instanceId);
    if (!instance) return;
    instance.ranks.forEach((rank, index) => {
      if (!rank.nodeId) return;
      if (this.#freedByStop(instanceId, rank)) return;
      if (mode === "stop" && !isHeld(rank)) return;
      const budget = working.budgets.get(rank.nodeId);
      if (!budget) return;
      apply(
        budget,
        resourceNeeds(rank.resources),
        this.#gpuClaims.get(`${instanceId}|${index}`) ?? [],
        -1,
      );
    });
    if (mode === "restart") this.#freePorts(working, instance);
  }

  /** Whether this claim is free in the budgets already (a HELD claim of a stopping instance). */
  #freedByStop(instanceId: string, rank: PlacementRank): boolean {
    return this.#stopping.has(instanceId) && isHeld(rank);
  }

  /** Whether the instance has a HELD claim on a node matching `on`. */
  #heldOn(instanceId: string, on: (nodeId: string) => boolean): boolean {
    return !!this.#instances
      .get(instanceId)
      ?.ranks.some((rank) => rank.nodeId !== null && isHeld(rank) && on(rank.nodeId));
  }

  #freePorts(working: Working, instance: PlacementInstance): void {
    for (const rank of instance.ranks) {
      if (!rank.nodeId) continue;
      const budget = working.budgets.get(rank.nodeId);
      if (!budget) continue;
      budget.ports.delete(rank.port);
      if (rank.distPort !== null) budget.ports.delete(rank.distPort);
    }
  }

  #freeOnNode(budget: Budget, instance: PlacementInstance, nodeId: string): void {
    instance.ranks.forEach((rank, index) => {
      if (rank.nodeId !== nodeId || !isHeld(rank)) return;
      apply(
        budget,
        resourceNeeds(rank.resources),
        this.#gpuClaims.get(`${instance.id}|${index}`) ?? [],
        -1,
      );
    });
  }

  #costOfWorking(working: Working): Cost {
    return costOf(
      [...working.victims].flatMap((id) => {
        const instance = this.#instances.get(id);
        return instance ? [instance] : [];
      }),
    );
  }

  /** Whether this request may stop `instance` to make room (the authorization rule). */
  #preemptible(instance: PlacementInstance, request: PlacementRequest): boolean {
    if (this.#stopping.has(instance.id)) return false;
    if (!instance.startable || !instance.running) return false;
    // Owner-only: never another user's instance.
    if (instance.ownerId !== this.#context.callerId) return false;
    if (instance.id === request.restart?.instanceId) return false;
    // Stopping another instance of the same runtime to start this one gains nothing.
    if (instance.runtimeId === request.runtimeId) return false;
    if (instance.ranks.length === 0) return false;
    if (this.#context.agent) {
      // Agents: a stop on a Relay-only node is refused (trust_relay); another user's pool runs
      // on a contributed instance; an interactive stop waits for a person.
      if (instance.contributed || instance.interactiveStop) return false;
      for (const rank of instance.ranks) {
        const node = rank.nodeId ? this.#nodes.get(rank.nodeId) : undefined;
        if (node?.trust !== "FULL") return false;
      }
    }
    return true;
  }

  /**
   * Why this node cannot take a rank of this request, or null. Checked from the most static
   * (labels) to the most transient (online), so across nodes the latest check that failed
   * names the node that came closest (`REASON_ORDER`).
   */
  #ineligible(node: PlacementNode, request: PlacementRequest): RefusalReason | null {
    if (!request.launch.labels.every((label) => node.labels.includes(label)))
      return "label_mismatch";
    if (this.#context.agent && node.trust !== "FULL") return "trust_relay";
    if (
      request.checkFrozen &&
      node.trust === "RELAY" &&
      !node.heldVersionIds.has(request.versionId)
    )
      return "definition_frozen";
    if (node.held) return "node_held";
    if (!node.online) return "node_offline";
    return null;
  }

  #fabricsFor(launch: LaunchShape): PlacementFabric[] {
    return this.#context.fabrics
      .filter((fabric) => !launch.fabric || fabric.name === launch.fabric)
      .sort((a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id));
  }

  #scopedMembers(fabric: PlacementFabric, request: PlacementRequest): string[] {
    return fabric.members
      .map((member) => member.nodeId)
      .filter(
        (nodeId) =>
          this.#nodes.has(nodeId) &&
          (!request.allowedNodeIds || request.allowedNodeIds.has(nodeId)),
      );
  }

  #withinScope(fabric: PlacementFabric, request: PlacementRequest): boolean {
    return this.#scopedMembers(fabric, request).length > 0;
  }

  /**
   * The dist port: one port inside every rank's range (their intersection) free on every
   * rank's node. A port a rank of this instance took for itself may still be used when that
   * rank can move to another free port of its own (ports needing no move first): otherwise a
   * one-port overlap is always lost to the rank's own port. A restart keeps its own ports
   * (none moves) and its own dist port.
   */
  #distPlan(
    working: Working,
    ranks: readonly RankChoice[],
    restart: PlacementRequest["restart"],
  ):
    | { port: number; moves: Array<[RankChoice, number]> }
    | { reason: "no_free_ports" | "fabric_port_ranges_disjoint"; message?: string } {
    const inRange = (rank: RankChoice, port: number) =>
      port >= rank.node.portRange[0] && port <= rank.node.portRange[1];
    const plan = (port: number, allowMoves: boolean) => {
      const moves: Array<[RankChoice, number]> = [];
      for (const rank of ranks) {
        const budget = working.budgets.get(rank.node.id);
        if (!budget || !inRange(rank, port)) return null;
        if (!budget.ports.has(port)) continue;
        if (!allowMoves || rank.port !== port) return null;
        const [start, end] = rank.node.portRange;
        let moved: number | null = null;
        for (let candidate = start; candidate <= end && moved === null; candidate++)
          if (candidate !== port && !budget.ports.has(candidate)) moved = candidate;
        if (moved === null) return null;
        moves.push([rank, moved]);
      }
      return { port, moves };
    };
    const start = Math.max(...ranks.map((rank) => rank.node.portRange[0]));
    const end = Math.min(...ranks.map((rank) => rank.node.portRange[1]));
    if (start > end)
      return {
        reason: "fabric_port_ranges_disjoint",
        message: `The port ranges of ${ranks
          .map((rank) => `${rank.node.slug} (${rank.node.portRange[0]}-${rank.node.portRange[1]})`)
          .join(
            ", ",
          )} have no port in common, and a multi-node instance needs one dist port on every node. Make the ranges overlap.`,
      };
    const own = restart?.distPort ?? null;
    if (own !== null) return plan(own, false) ?? { reason: "no_free_ports" };
    for (const allowMoves of restart ? [false] : [false, true])
      for (let port = start; port <= end; port++) {
        const found = plan(port, allowMoves);
        if (found) return found;
      }
    return { reason: "no_free_ports" };
  }

  #fitRefusal(
    reason: "not_enough_memory" | "port_in_use" | "no_free_ports",
    node: PlacementNode,
    request: PlacementRequest,
    rank: number,
    working: Working,
  ): PlacementRefusal {
    if (reason !== "not_enough_memory") return refusal(reason, node.id);
    const needs = resourceNeeds(rankResources(request.launch, rank));
    const budget = working.budgets.get(node.id);
    return refusal(
      "not_enough_memory",
      node.id,
      `This node has ${gib(Math.max(0, budget?.memoryGb ?? 0))} free for a rank that needs ${gib(needs.memoryGb)}${needs.gpuCount ? ` and ${needs.gpuCount} GPU(s) with ${gib(needs.vramGb)} each` : ""}${request.preempt ? ", even after stopping what may be stopped" : ""}.`,
    );
  }

  #autoRefusal(
    reasons: ReadonlySet<RefusalReason>,
    request: PlacementRequest,
    eligible: readonly PlacementNode[],
  ): PlacementRefusal {
    const { launch } = request;
    if (eligible.length < launch.groupSize) {
      const reason = REASON_ORDER.find((candidate) => reasons.has(candidate));
      return refusal(reason ?? "not_enough_nodes", null);
    }
    const reason = REASON_ORDER.find((candidate) => reasons.has(candidate)) ?? "not_enough_nodes";
    if (reason !== "not_enough_memory") return refusal(reason, null);
    const needs = resourceNeeds(rankResources(launch, 0));
    const most = Math.max(0, ...eligible.map((node) => this.#budgets.get(node.id)?.memoryGb ?? 0));
    return refusal(
      "not_enough_memory",
      null,
      `No ${launch.groupSize > 1 ? "set of eligible nodes in one fabric" : "eligible node"} has room: a rank needs ${gib(needs.memoryGb)}${needs.gpuCount ? ` and ${needs.gpuCount} GPU(s) with ${gib(needs.vramGb)} each` : ""}; the most memory free on one node is ${gib(most)}${request.preempt ? ", even after stopping what may be stopped" : ""}.`,
    );
  }

  #cloneBudgets(): Map<string, Budget> {
    return new Map([...this.#budgets].map(([id, budget]) => [id, cloneBudget(budget)]));
  }
}

function rankResources(launch: LaunchShape, rank: number): RuntimeResource {
  return launch.resources[launch.resources.length === 1 ? 0 : rank] ?? { kind: "none" };
}

function rankChoice(
  node: PlacementNode,
  budget: Budget,
  fitted: Extract<Fit, { ok: true }>,
  victims: PlacementInstance[],
  waits: boolean,
): RankChoice {
  const gpuLeft = budget.gpus
    .filter((gpu) => fitted.gpuKeys.includes(gpu.key))
    .reduce((sum, gpu) => sum + gpu.freeGb - fitted.needs.vramGb, 0);
  return {
    node,
    victims,
    port: fitted.port,
    gpuKeys: fitted.gpuKeys,
    needs: fitted.needs,
    leftover: [budget.memoryGb - fitted.needs.memoryGb, gpuLeft],
    waits,
  };
}

function isHeld(rank: PlacementRank): boolean {
  return rank.claim === "HELD";
}

/** Set-level reasons seen in a pass, each with the subject of the first set that failed so. */
type GroupReasons = Map<GroupReason, { subjectId: string | null; message?: string }>;

function noteProblem(reasons: GroupReasons, problem: GroupProblem): void {
  if (!reasons.has(problem.reason))
    reasons.set(problem.reason, {
      subjectId: problem.subjectId,
      ...(problem.message ? { message: problem.message } : {}),
    });
}

function waitingRanks(choice: InstanceChoice): number {
  return choice.ranks.filter((rank) => rank.waits).length;
}

const FIT_REASONS: ReadonlySet<RefusalReason> = new Set([
  "not_enough_memory",
  "port_in_use",
  "no_free_ports",
]);

/**
 * Fewest stops, then fewest ranks waiting for an instance already stopping, then the smallest
 * fabric, then best fit, then the fabric name.
 */
function compareInstanceChoice(a: InstanceChoice, b: InstanceChoice): number {
  return (
    compareCost(a.cost, b.cost) ||
    waitingRanks(a) - waitingRanks(b) ||
    (a.fabric?.members.length ?? 0) - (b.fabric?.members.length ?? 0) ||
    a.leftover - b.leftover ||
    compareCodePoints(a.fabric?.name ?? "", b.fabric?.name ?? "")
  );
}

/**
 * Fewest stops first, then a node free now over one an instance already stopping frees, then
 * best fit (least memory, then GPU memory left), then slug.
 */
function compareRank(a: RankChoice, b: RankChoice): number {
  return (
    compareCost(costOf(a.victims), costOf(b.victims)) ||
    Number(a.waits) - Number(b.waits) ||
    a.leftover[0] - b.leftover[0] ||
    a.leftover[1] - b.leftover[1] ||
    compareCodePoints(a.node.slug, b.node.slug)
  );
}
