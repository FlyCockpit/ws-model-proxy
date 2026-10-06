/**
 * Profile apply plan (one-click switch, lane B). Pure: the procedure loads the state and this
 * decides what stops, what is kept, what starts where, and why it cannot run.
 *
 * Holds (contract fix): applying sets the profile's hold lines and clears only the holds this
 * profile set on its other nodes. A person's hold (no profile) stays; it refuses an agent's
 * apply (`node_held`) and nothing is placed on it.
 *
 * TODO(lane C): placement here is a preview-grade model (memory budget per node, summed GPU
 * memory, first free port). When the runtime planner lands, starts should be placed by it.
 */
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { refusalSchema } from "../contracts/refusals";
import type { previewWarningSchema, startPreviewSchema } from "../contracts/runtimes";
import { canonicalJson, compareCodePoints } from "../lib/canonical-json";
import type { RuntimeResource, RuntimeSpec } from "../lib/runtime-spec";
import { runtimeSpecWarnings } from "../lib/runtime-spec";

export type StartPreview = z.infer<typeof startPreviewSchema>;
type Refusal = z.infer<typeof refusalSchema>;
type Warning = z.infer<typeof previewWarningSchema>;

export type PlanNode = {
  id: string;
  slug: string;
  online: boolean;
  /** Effective trust (a pending lower counts as Relay only). */
  trust: "RELAY" | "FULL";
  labels: readonly string[];
  hold: { profileId: string | null } | null;
  portRange: readonly [number, number];
  /** Version ids the node holds (frozen at Relay only). */
  heldVersionIds: ReadonlySet<string>;
  /** Node memory budget left for wsmp (usable, before any claim). */
  usableMemoryGb: number;
  /** GPU memory budget left for wsmp (sum over GPUs, reserved taken off). */
  usableGpuGb: number;
  gpuCount: number;
  liveFreeMemoryGb: number | null;
};

export type PlanClaim = {
  instanceId: string;
  nodeId: string;
  port: number;
  distPort: number | null;
  resources: unknown;
};

export type PlanInstance = {
  id: string;
  runtimeId: string;
  launchVersionId: string;
  /** Only RUNNING instances are kept or stopped; others are already going away. */
  desiredRunning: boolean;
  /** Node of each rank (rank order). */
  rankNodeIds: readonly string[];
};

export type PlanItem = {
  id: string;
  position: number;
  runtimeId: string;
  versionId: string;
  count: number;
  nodeIds: readonly string[];
};

export type PlanVersion = {
  id: string;
  runtimeId: string;
  runtimeSlug: string;
  currentVersionId: string | null;
  spec: RuntimeSpec | null;
};

export type PlanInput = {
  profileId: string;
  /** Owned nodes with their hold line (`ProfileNode`). */
  owned: ReadonlyArray<{ nodeId: string; hold: boolean }>;
  nodes: ReadonlyMap<string, PlanNode>;
  items: readonly PlanItem[];
  versions: ReadonlyMap<string, PlanVersion>;
  /** STARTABLE instances with a rank on an owned node. */
  instances: readonly PlanInstance[];
  /** Every non-released claim on the owned nodes (any instance). */
  claims: readonly PlanClaim[];
  fabrics: ReadonlyArray<{ id: string; name: string; nodeIds: readonly string[] }>;
  /** `agentRulesApply(auth)`. */
  agentRules: boolean;
};

export type ProfilePlan = {
  preview: StartPreview;
  /** Nodes that get this profile's hold. */
  holdNodeIds: string[];
  /** Nodes whose hold this profile set and now releases. */
  releaseNodeIds: string[];
};

function refusal(reason: Refusal["reason"], subjectId: string | null, message: string): Refusal {
  return { reason, subjectId, message };
}

function claimNeeds(resources: unknown): { memoryGb: number; gpuGb: number; gpus: number } {
  if (!resources || typeof resources !== "object") return { memoryGb: 0, gpuGb: 0, gpus: 0 };
  const r = resources as Partial<Record<string, unknown>>;
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  switch (r.kind) {
    case "unified":
      return { memoryGb: num(r.memoryGb), gpuGb: 0, gpus: 0 };
    case "cpu":
      return { memoryGb: num(r.ramGb), gpuGb: 0, gpus: 0 };
    case "discrete": {
      const gpus = Math.max(1, num(r.gpuCount));
      return { memoryGb: num(r.ramGb), gpuGb: num(r.vramGb) * gpus, gpus };
    }
    default:
      return { memoryGb: 0, gpuGb: 0, gpus: 0 };
  }
}

type Budget = { memoryGb: number; gpuGb: number; ports: Set<number> };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function profilePlan(input: PlanInput): ProfilePlan {
  const refusals: Refusal[] = [];
  const warnings: Warning[] = [];
  const holdLines = new Set(input.owned.filter((line) => line.hold).map((line) => line.nodeId));
  const ownedIds = input.owned.map((line) => line.nodeId);

  // ── Who may apply ──
  for (const nodeId of ownedIds) {
    const node = input.nodes.get(nodeId);
    if (!node) continue;
    if (input.agentRules && node.trust === "RELAY")
      refusals.push(
        refusal(
          "trust_relay",
          nodeId,
          `Node ${node.slug} is Relay only; agents cannot apply a profile that owns it.`,
        ),
      );
    if (input.agentRules && node.hold && node.hold.profileId === null)
      refusals.push(
        refusal("node_held", nodeId, `A person holds node ${node.slug}; agents cannot apply here.`),
      );
  }

  // ── Holds ──
  const holdNodeIds = ownedIds.filter((id) => holdLines.has(id)).sort(compareCodePoints);
  const releaseNodeIds = ownedIds
    .filter((id) => !holdLines.has(id) && input.nodes.get(id)?.hold?.profileId === input.profileId)
    .sort(compareCodePoints);
  /** Nodes starts may use: owned, no hold line, and not held by anyone else after apply. */
  const placeable = new Set(
    ownedIds.filter((id) => {
      if (holdLines.has(id)) return false;
      const hold = input.nodes.get(id)?.hold;
      return !hold || hold.profileId === input.profileId;
    }),
  );

  // ── Keep or stop what runs on the owned nodes ──
  const itemSlots = new Map(input.items.map((item) => [item.id, item.count]));
  const kept: string[] = [];
  const stops: StartPreview["stops"] = [];
  const stopping = new Set<string>();
  const keptPerItem = new Map<string, number>();
  for (const instance of [...input.instances].sort((a, b) => compareCodePoints(a.id, b.id))) {
    if (!instance.desiredRunning) continue;
    const onHoldLine = instance.rankNodeIds.some((id) => holdLines.has(id));
    const item = onHoldLine
      ? undefined
      : input.items.find((candidate) => {
          if (candidate.runtimeId !== instance.runtimeId) return false;
          if (candidate.versionId !== instance.launchVersionId) return false;
          if ((itemSlots.get(candidate.id) ?? 0) <= 0) return false;
          const allowed = candidate.nodeIds.length > 0 ? new Set(candidate.nodeIds) : null;
          return instance.rankNodeIds.every(
            (nodeId) => !ownedIds.includes(nodeId) || !allowed || allowed.has(nodeId),
          );
        });
    if (item) {
      itemSlots.set(item.id, (itemSlots.get(item.id) ?? 0) - 1);
      keptPerItem.set(item.id, (keptPerItem.get(item.id) ?? 0) + 1);
      kept.push(instance.id);
    } else {
      stops.push({
        instanceId: instance.id,
        runtimeId: instance.runtimeId,
        reason: "profile_owned_node",
      });
      stopping.add(instance.id);
    }
  }

  // ── Budgets after the stops ──
  const budgets = new Map<string, Budget>();
  for (const nodeId of ownedIds) {
    const node = input.nodes.get(nodeId);
    if (!node) continue;
    budgets.set(nodeId, {
      memoryGb: node.usableMemoryGb,
      gpuGb: node.usableGpuGb,
      ports: new Set(),
    });
  }
  for (const claim of input.claims) {
    const budget = budgets.get(claim.nodeId);
    if (!budget) continue;
    // A stopping instance keeps its port until it releases it; its memory is planned free
    // (the start queues behind the stop).
    budget.ports.add(claim.port);
    if (claim.distPort !== null) budget.ports.add(claim.distPort);
    if (stopping.has(claim.instanceId)) continue;
    const needs = claimNeeds(claim.resources);
    budget.memoryGb -= needs.memoryGb;
    budget.gpuGb -= needs.gpuGb;
  }

  // ── Starts ──
  const starts: StartPreview["starts"] = [];
  for (const item of [...input.items].sort((a, b) => a.position - b.position)) {
    const version = input.versions.get(item.versionId);
    const launch = version?.spec?.launch;
    if (!version || !launch) {
      refusals.push(
        refusal("definition_missing", item.runtimeId, "The pinned version cannot be started."),
      );
      continue;
    }
    if (version.currentVersionId !== null && version.currentVersionId !== item.versionId)
      warnings.push({
        code: "pins_outdated",
        nodeId: null,
        detail: `${version.runtimeSlug} has a newer version than the pin.`,
      });
    if (version.spec && runtimeSpecWarnings(version.spec).includes("binds_all_interfaces"))
      warnings.push({
        code: "binds_all_interfaces",
        nodeId: null,
        detail: `${version.runtimeSlug} binds every interface.`,
      });
    if (launch.commands.some((commands) => Object.values(commands.interactive ?? {}).some(Boolean)))
      warnings.push({
        code: "interactive_needs_person",
        nodeId: null,
        detail: `${version.runtimeSlug} has a step a person runs in a terminal.`,
      });

    const missing = item.count - (keptPerItem.get(item.id) ?? 0);
    for (let n = 0; n < missing; n++) {
      const placed = placeOne(input, version, launch, item, placeable, budgets, warnings);
      if ("refusal" in placed) {
        refusals.push(placed.refusal);
        break;
      }
      starts.push({
        runtimeId: item.runtimeId,
        versionId: item.versionId,
        instanceId: null,
        placements: placed.placements,
      });
    }
  }

  const sortedKept = kept.sort(compareCodePoints);
  const fingerprint = sha256(
    canonicalJson({
      profileId: input.profileId,
      holdNodeIds,
      releaseNodeIds,
      starts: starts.map((start) => ({
        runtimeId: start.runtimeId,
        versionId: start.versionId,
        placements: start.placements.map((placement) => [placement.nodeId, placement.port]),
      })),
      stops: stops.map((stop) => stop.instanceId).sort(compareCodePoints),
      kept: sortedKept,
      refusals: refusals.map((entry) => [entry.reason, entry.subjectId]),
    }),
  );

  return {
    preview: {
      fingerprint,
      starts,
      stops,
      kept: sortedKept,
      warnings: dedupeWarnings(warnings),
      refusals,
    },
    holdNodeIds,
    releaseNodeIds,
  };
}

function dedupeWarnings(warnings: Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${warning.nodeId}|${warning.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Placement = StartPreview["starts"][number]["placements"][number];

function rankResources(launch: NonNullable<RuntimeSpec["launch"]>, rank: number): RuntimeResource {
  return launch.resources[launch.resources.length === 1 ? 0 : rank] ?? { kind: "none" };
}

function freePort(budget: Budget, node: PlanNode, fixed: number | undefined): number | null {
  if (fixed !== undefined) return budget.ports.has(fixed) ? null : fixed;
  for (let port = node.portRange[0]; port <= node.portRange[1]; port++)
    if (!budget.ports.has(port)) return port;
  return null;
}

type Fit = { ok: true; port: number } | { ok: false; reason: Refusal["reason"] };

function fits(
  node: PlanNode,
  budget: Budget,
  resources: RuntimeResource,
  fixedPort: number | undefined,
): Fit {
  const needs = claimNeeds(resources);
  if (needs.gpus > node.gpuCount && needs.gpus > 0)
    return { ok: false, reason: "not_enough_memory" };
  if (needs.memoryGb > budget.memoryGb + 1e-9 || needs.gpuGb > budget.gpuGb + 1e-9)
    return { ok: false, reason: "not_enough_memory" };
  const port = freePort(budget, node, fixedPort);
  if (port === null) return { ok: false, reason: fixedPort ? "port_in_use" : "no_free_ports" };
  return { ok: true, port };
}

function take(budget: Budget, resources: RuntimeResource, port: number): void {
  const needs = claimNeeds(resources);
  budget.memoryGb -= needs.memoryGb;
  budget.gpuGb -= needs.gpuGb;
  budget.ports.add(port);
}

const REASON_ORDER: ReadonlyArray<Refusal["reason"]> = [
  "not_enough_memory",
  "port_in_use",
  "no_free_ports",
  "definition_frozen",
  "label_mismatch",
  "node_offline",
  "not_enough_nodes",
];

function placeOne(
  input: PlanInput,
  version: PlanVersion,
  launch: NonNullable<RuntimeSpec["launch"]>,
  item: PlanItem,
  placeable: ReadonlySet<string>,
  budgets: Map<string, Budget>,
  warnings: Warning[],
): { placements: Placement[] } | { refusal: Refusal } {
  const pool = (item.nodeIds.length > 0 ? item.nodeIds : [...placeable]).filter((id) =>
    placeable.has(id),
  );
  const reasons = new Set<Refusal["reason"]>();
  const eligible: PlanNode[] = [];
  for (const nodeId of pool) {
    const node = input.nodes.get(nodeId);
    if (!node) continue;
    if (!node.online) {
      reasons.add("node_offline");
      continue;
    }
    if (!launch.labels.every((label) => node.labels.includes(label))) {
      reasons.add("label_mismatch");
      continue;
    }
    if (node.trust === "RELAY" && !node.heldVersionIds.has(version.id)) {
      // A person may start only what a Relay-only node holds frozen.
      reasons.add("definition_frozen");
      continue;
    }
    if (node.trust === "FULL" && !node.heldVersionIds.has(version.id))
      warnings.push({
        code: "definition_not_on_node",
        nodeId: node.id,
        detail: `${version.runtimeSlug} is sent to ${node.slug} before it starts.`,
      });
    eligible.push(node);
  }

  const fail = (fallback: Refusal["reason"]) => {
    const reason = REASON_ORDER.find((candidate) => reasons.has(candidate)) ?? fallback;
    return {
      refusal: refusal(
        reason,
        item.runtimeId,
        `Cannot place ${version.runtimeSlug} on this profile's nodes (${reason}).`,
      ),
    };
  };

  const byFreeMemory = (a: PlanNode, b: PlanNode) =>
    (budgets.get(b.id)?.memoryGb ?? 0) - (budgets.get(a.id)?.memoryGb ?? 0) ||
    compareCodePoints(a.slug, b.slug);

  if (launch.groupSize === 1) {
    const resources = rankResources(launch, 0);
    for (const node of [...eligible].sort(byFreeMemory)) {
      const budget = budgets.get(node.id);
      if (!budget) continue;
      const fit = fits(node, budget, resources, launch.port?.fixed);
      if (!fit.ok) {
        reasons.add(fit.reason);
        continue;
      }
      take(budget, resources, fit.port);
      lowMemoryWarning(node, resources, warnings);
      return {
        placements: [
          {
            nodeId: node.id,
            nodeSlug: node.slug,
            nodeNumber: 1,
            port: fit.port,
            resources: { ...resources },
          },
        ],
      };
    }
    return fail("not_enough_nodes");
  }

  // Multi-node: every rank inside one fabric (`no_shared_fabric`), the head is rank 0.
  const fabrics = input.fabrics.filter((fabric) => !launch.fabric || fabric.name === launch.fabric);
  let sawEnoughMembers = false;
  for (const fabric of fabrics) {
    const members = eligible.filter((node) => fabric.nodeIds.includes(node.id)).sort(byFreeMemory);
    if (members.length < launch.groupSize) continue;
    sawEnoughMembers = true;
    const trial = new Map(
      members.map((node) => {
        const budget = budgets.get(node.id);
        return [
          node.id,
          budget
            ? { memoryGb: budget.memoryGb, gpuGb: budget.gpuGb, ports: new Set(budget.ports) }
            : null,
        ];
      }),
    );
    const placements: Placement[] = [];
    const used = new Set<string>();
    for (let rank = 0; rank < launch.groupSize; rank++) {
      const resources = rankResources(launch, rank);
      const node = members.find((candidate) => {
        if (used.has(candidate.id)) return false;
        const budget = trial.get(candidate.id);
        if (!budget) return false;
        const fit = fits(candidate, budget, resources, undefined);
        if (!fit.ok) reasons.add(fit.reason);
        return fit.ok;
      });
      const budget = node ? trial.get(node.id) : null;
      if (!node || !budget) break;
      const fit = fits(node, budget, resources, undefined);
      if (!fit.ok) break;
      take(budget, resources, fit.port);
      used.add(node.id);
      placements.push({
        nodeId: node.id,
        nodeSlug: node.slug,
        nodeNumber: rank + 1,
        port: fit.port,
        resources: { ...resources },
      });
    }
    if (placements.length === launch.groupSize) {
      for (const [nodeId, budget] of trial) if (budget) budgets.set(nodeId, budget);
      return { placements };
    }
  }
  if (!sawEnoughMembers) {
    return {
      refusal: refusal(
        "no_shared_fabric",
        item.runtimeId,
        `${version.runtimeSlug} needs ${launch.groupSize} free nodes in one fabric.`,
      ),
    };
  }
  return fail("not_enough_nodes");
}

function lowMemoryWarning(node: PlanNode, resources: RuntimeResource, warnings: Warning[]): void {
  const needs = claimNeeds(resources);
  if (node.liveFreeMemoryGb !== null && needs.memoryGb > node.liveFreeMemoryGb)
    warnings.push({
      code: "low_free_memory",
      nodeId: node.id,
      detail: `${node.slug} reports less free memory than this start declares.`,
    });
}
