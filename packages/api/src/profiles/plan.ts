/**
 * Profile apply plan (one-click switch, lane B). Pure: the procedure loads the state and this
 * decides what stops, what is kept, what starts where, and why it cannot run.
 *
 * Holds (contract fix): applying sets the profile's hold lines and clears only the holds this
 * profile set on its other nodes. A person's hold (no profile) stays; it refuses an agent's
 * apply (`node_held`) and nothing is placed on it.
 *
 * Starts are placed by the placement planner (`lib/placement.ts`) on the profile's placeable
 * nodes, after this apply's stops (their resources are planned free; their ports stay taken and
 * the new ranks wait for them). A profile apply never preempts beyond its own stops.
 */
import type { z } from "zod";
import type { refusalSchema } from "../contracts/refusals";
import type { previewWarningSchema, startPreviewSchema } from "../contracts/runtimes";
import { compareCodePoints } from "../lib/canonical-json";
import {
  INTERACTIVE_STEPS_SUPPORTED,
  INTERACTIVE_UNSUPPORTED_MESSAGE,
} from "../lib/interactive-steps";
import {
  type PlacementFabric,
  type PlacementFrozenFabric,
  type PlacementGpu,
  type PlacementInstance,
  PlacementPlanner,
} from "../lib/placement";
import { previewFingerprint } from "../lib/preview-fingerprint";
import {
  type NodeHoldState,
  type ProfileHoldLine,
  type ProfileHoldPlan,
  planProfileHolds,
} from "../lib/profile-holds";
import type { RuntimeSpec } from "../lib/runtime-spec";
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
  /** The node's current hold (`holdAt`, `holdProfileId`). */
  hold: NodeHoldState;
  portRange: readonly [number, number];
  /** Version ids the node holds (frozen at Relay only). */
  heldVersionIds: ReadonlySet<string>;
  /**
   * The fabrics the node froze at Relay only (`placementNodeOf(...).frozenFabrics`). Absent or
   * null: not checked (the node refuses a head outside them at dispatch).
   */
  frozenFabrics?: readonly PlacementFrozenFabric[] | "current" | null;
  /** Node memory budget for wsmp (usable, before any claim). */
  memoryGb: number;
  /** Usable VRAM per GPU (reserved taken off), before any claim. */
  gpus: readonly PlacementGpu[];
  liveFreeMemoryGb: number | null;
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
  owned: readonly ProfileHoldLine[];
  nodes: ReadonlyMap<string, PlanNode>;
  items: readonly PlanItem[];
  versions: ReadonlyMap<string, PlanVersion>;
  /** STARTABLE instances with a rank on an owned node. */
  instances: readonly PlanInstance[];
  /**
   * Every instance with a non-released claim on an owned node (any owner, any kind), with all
   * its claims: what the planner subtracts from node budgets.
   */
  claimants: readonly PlacementInstance[];
  /** The caller's id (the planner never preempts here, but owns the accounting). */
  callerId: string;
  fabrics: readonly PlacementFabric[];
  /** `agentRulesApply(auth)`. */
  agentRules: boolean;
};

export type ProfilePlan = {
  preview: StartPreview;
  /** Nodes that get this profile's hold. */
  holdNodeIds: string[];
  /** Nodes whose hold this profile set and now releases. */
  releaseNodeIds: string[];
  /** Per start (same order): the stopping instances its new ranks wait for. */
  blockedBy: string[][];
};

function refusal(reason: Refusal["reason"], subjectId: string | null, message: string): Refusal {
  return { reason, subjectId, message };
}

/**
 * Whether a running instance counts toward a pinned item: same runtime and launched version,
 * and every rank on the item's nodes (or the profile's nodes) without a hold line. The view's
 * `runningNow` and the plan's "kept" use this one rule.
 */
export function instanceServesItem(
  instance: { runtimeId: string; launchVersionId: string; rankNodeIds: readonly string[] },
  item: { runtimeId: string; versionId: string; nodeIds: readonly string[] },
  ownedIds: readonly string[],
  holdLines: ReadonlySet<string>,
): boolean {
  if (instance.runtimeId !== item.runtimeId || instance.launchVersionId !== item.versionId)
    return false;
  if (instance.rankNodeIds.length === 0) return false;
  const allowed = new Set(
    (item.nodeIds.length > 0 ? item.nodeIds : ownedIds).filter((id) => !holdLines.has(id)),
  );
  return instance.rankNodeIds.every((nodeId) => allowed.has(nodeId));
}

/** The hold changes this apply makes, from the nodes' current holds. */
export function profileHoldsFor(
  input: Pick<PlanInput, "profileId" | "owned" | "nodes" | "agentRules">,
): ProfileHoldPlan {
  return planProfileHolds({
    profileId: input.profileId,
    caller: input.agentRules ? "agent" : "person",
    nodes: input.owned,
    current: new Map([...input.nodes.values()].map((node) => [node.id, node.hold] as const)),
  });
}

/** Who holds a node now, as the preview shows it. */
function heldBy(
  profileId: string,
  hold: NodeHoldState | undefined,
): StartPreview["holds"][number]["heldBy"] {
  if (!hold?.holdAt) return null;
  if (hold.holdProfileId === null) return "person";
  return hold.holdProfileId === profileId ? "this_profile" : "other_profile";
}

/** The hold changes a person confirms (sorted by node). Empty when the apply is refused. */
function holdChanges(
  input: Pick<PlanInput, "profileId" | "owned" | "nodes">,
  holds: ProfileHoldPlan,
): StartPreview["holds"] {
  if (!holds.ok) return [];
  const notes = new Map(input.owned.map((line) => [line.nodeId, line.holdNote] as const));
  const changes: StartPreview["holds"] = [
    ...holds.hold.map((line) => ({ nodeId: line.nodeId, change: "hold" as const })),
    ...holds.release.map((nodeId) => ({ nodeId, change: "release" as const })),
    ...holds.keep.map((nodeId) => ({ nodeId, change: "keep" as const })),
  ].map(({ nodeId, change }) => ({
    nodeId,
    change,
    heldBy: heldBy(input.profileId, input.nodes.get(nodeId)?.hold),
    note: change === "hold" ? (notes.get(nodeId) ?? null) : null,
  }));
  return changes.sort((a, b) => compareCodePoints(a.nodeId, b.nodeId));
}

export function profilePlan(input: PlanInput): ProfilePlan {
  const refusals: Refusal[] = [];
  const warnings: Warning[] = [];
  const holdLines = new Set(input.owned.filter((line) => line.hold).map((line) => line.nodeId));
  const ownedIds = input.owned.map((line) => line.nodeId).sort(compareCodePoints);

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
  }

  // ── Holds (the contract's one rule: planProfileHolds) ──
  const holds = profileHoldsFor(input);
  if (!holds.ok)
    for (const nodeId of holds.nodeIds)
      refusals.push(
        refusal(
          "node_held",
          nodeId,
          `Node ${input.nodes.get(nodeId)?.slug ?? nodeId} is held by a person or another profile; agents cannot release it.`,
        ),
      );
  const holdNodeIds = holds.ok ? holds.hold.map((line) => line.nodeId).sort(compareCodePoints) : [];
  const releaseNodeIds = holds.ok ? [...holds.release].sort(compareCodePoints) : [];
  const released = new Set(releaseNodeIds);
  /** Nodes starts may use: owned, no hold line, and not held by anyone after this apply. */
  const placeable = new Set(
    ownedIds.filter(
      (id) => !holdLines.has(id) && (!input.nodes.get(id)?.hold.holdAt || released.has(id)),
    ),
  );

  // ── Keep or stop what runs on the owned nodes ──
  const itemSlots = new Map(input.items.map((item) => [item.id, item.count]));
  const kept: string[] = [];
  const stops: StartPreview["stops"] = [];
  const stopping = new Set<string>();
  const keptPerItem = new Map<string, number>();
  for (const instance of [...input.instances].sort((a, b) => compareCodePoints(a.id, b.id))) {
    if (!instance.desiredRunning) continue;
    const item = input.items.find(
      (candidate) =>
        (itemSlots.get(candidate.id) ?? 0) > 0 &&
        instanceServesItem(instance, candidate, ownedIds, holdLines),
    );
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

  // ── Starts, placed after the stops ──
  const planner = new PlacementPlanner({
    callerId: input.callerId,
    agent: input.agentRules,
    nodes: [...input.nodes.values()].map((node) => ({
      id: node.id,
      slug: node.slug,
      online: node.online,
      trust: node.trust,
      // Holds are planned by this apply: `placeable` already leaves out what stays held.
      held: false,
      labels: node.labels,
      portRange: node.portRange,
      heldVersionIds: node.heldVersionIds,
      frozenFabrics: node.frozenFabrics ?? null,
      memoryGb: node.memoryGb,
      gpus: node.gpus,
      liveFreeMemoryGb: node.liveFreeMemoryGb,
    })),
    instances: input.claimants,
    fabrics: input.fabrics,
    stopping,
  });
  const starts: StartPreview["starts"] = [];
  const blockedBy: string[][] = [];
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
    if (
      launch.commands.some((commands) => Object.values(commands.interactive ?? {}).some(Boolean))
    ) {
      if (!INTERACTIVE_STEPS_SUPPORTED) {
        refusals.push(
          refusal("interactive_needs_person", item.runtimeId, INTERACTIVE_UNSUPPORTED_MESSAGE),
        );
        continue;
      }
      warnings.push({
        code: "interactive_needs_person",
        nodeId: null,
        detail: `${version.runtimeSlug} has a step a person runs in a terminal.`,
      });
    }

    const allowed = new Set(
      (item.nodeIds.length > 0 ? item.nodeIds : [...placeable]).filter((id) => placeable.has(id)),
    );
    const missing = item.count - (keptPerItem.get(item.id) ?? 0);
    for (let n = 0; n < missing; n++) {
      const placed = planner.place({
        runtimeId: item.runtimeId,
        versionId: item.versionId,
        launch,
        allowedNodeIds: allowed,
        // A person may start only what a Relay-only node holds frozen.
        checkFrozen: true,
        preempt: false,
      });
      if (!placed.ok) {
        refusals.push({ ...placed.refusal, subjectId: placed.refusal.subjectId ?? item.runtimeId });
        break;
      }
      starts.push({
        runtimeId: item.runtimeId,
        versionId: item.versionId,
        instanceId: null,
        placements: placed.start.placements,
        fabric: placed.start.fabric,
        distPort: placed.start.distPort,
      });
      blockedBy.push(placed.start.blockedBy);
      warnings.push(...placed.warnings);
      for (const placement of placed.start.placements) {
        const node = input.nodes.get(placement.nodeId);
        if (node?.trust === "FULL" && !node.heldVersionIds.has(version.id))
          warnings.push({
            code: "definition_not_on_node",
            nodeId: node.id,
            detail: `${version.runtimeSlug} is sent to ${node.slug} before it starts.`,
          });
      }
    }
  }

  const sortedKept = kept.sort(compareCodePoints);
  const shown: Omit<StartPreview, "fingerprint"> = {
    starts,
    stops: [...stops].sort((a, b) => compareCodePoints(a.instanceId, b.instanceId)),
    kept: sortedKept,
    holds: holdChanges(input, holds),
    warnings: dedupeWarnings(warnings),
    refusals,
  };
  // The fingerprint covers everything the preview shows, hold changes included.
  return {
    preview: { fingerprint: previewFingerprint(shown), ...shown },
    holdNodeIds,
    releaseNodeIds,
    blockedBy,
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
