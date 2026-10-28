/**
 * Pure decisions for the wsmp self-update UI (`nodes.agentUpdate.*`). The shapes here are the
 * minimal structural parts of the API views, so these helpers stay testable without the router.
 */

const TERMINAL_PHASES: ReadonlySet<string> = new Set([
  "confirmed",
  "rolled_back",
  "failed",
  "refused",
  "timed_out",
]);

/** Follow an update this often while one is in flight. */
export const AGENT_UPDATE_POLL_MS = 3_000;
/**
 * With nothing in flight, still refresh this often: a node that reconnects, or is upgraded by
 * hand, changes what Update and Update all may do.
 */
export const AGENT_UPDATE_IDLE_POLL_MS = 30_000;

/** Reasons a node gives with `refused` or `failed` (contract §2). Anything else is "other". */
export const AGENT_UPDATE_NODE_REASONS = [
  "not_owner_trust",
  "opted_out",
  "source_build",
  "unsupported_method",
  "busy",
  "signature_mismatch",
  "checksum_mismatch",
  "download_failed",
  "version_mismatch",
  "already_current",
  "in_progress",
  "internal",
] as const;

export const INSTALL_METHODS = [
  "script",
  "script-ps1",
  "homebrew",
  "cargo",
  "binstall",
  "npm",
  "source",
  "unknown",
] as const;

/** Why "Update all" stopped, when the server says; anything else reads as "other". */
export const BATCH_STOP_REASONS = [
  "stopped",
  "refused",
  "failed",
  "rolled_back",
  "timed_out",
  "release_changed",
] as const;

export function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

type LatestLike = { phase: string } | null;
type OverviewLike = {
  nodes: ReadonlyArray<{ latest: LatestLike }>;
  batch: { state: string } | null;
};

/** True while any node's latest update, or the "Update all" batch, can still change. */
export function overviewInFlight(overview: OverviewLike): boolean {
  if (overview.batch?.state === "running") return true;
  return overview.nodes.some((node) => node.latest !== null && !isTerminalPhase(node.latest.phase));
}

/** The overview's refetch interval: fast while something is in flight, slow otherwise. */
export function overviewRefetchInterval(overview: OverviewLike | undefined): number {
  return overview && overviewInFlight(overview) ? AGENT_UPDATE_POLL_MS : AGENT_UPDATE_IDLE_POLL_MS;
}

/** First 7 characters of a 40-hex commit, or null. */
export function shortCommit(commit: string | null | undefined): string | null {
  if (!commit) return null;
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7).toLowerCase() : null;
}

/** Phases an update can be stuck in when the server times it out (`reason` of `timed_out`). */
export const STUCK_PHASES = [
  "requested",
  "waiting_idle",
  "downloading",
  "verifying",
  "armed",
  "swapped",
  "restarting",
] as const;

export function knownOr<T extends string>(
  values: readonly T[],
  value: string | null | undefined,
  fallback: string,
): string {
  return value && (values as readonly string[]).includes(value) ? value : fallback;
}

export type ProgressStep = {
  phase: "requested" | "waiting_idle" | "downloading" | "verifying" | "armed" | "restarting";
  state: "done" | "current" | "upcoming";
};

/**
 * The in-flight steps to show, in order. `swapped` and `restarting` read as one step ("restarting
 * and checking"); Homebrew does its own download and check and has no rollback copy, so it skips
 * `verifying` and `armed`. `waiting_idle` shows only while the node waits.
 */
export function progressSteps(phase: string, homebrew: boolean): ProgressStep[] {
  const order: ProgressStep["phase"][] = [
    "requested",
    ...(phase === "waiting_idle" ? (["waiting_idle"] as const) : []),
    "downloading",
    ...(homebrew ? [] : (["verifying", "armed"] as const)),
    "restarting",
  ];
  const at = phase === "swapped" ? "restarting" : phase;
  const current = (order as readonly string[]).indexOf(at);
  return order.map((step, index) => ({
    phase: step,
    state: current === -1 || index > current ? "upcoming" : index < current ? "done" : "current",
  }));
}

type NodeModeInput = {
  outdated: boolean;
  canUpdate: boolean;
  selfUpdate: { strategies: readonly string[] } | null;
  build: { installMethod: string } | null;
  latest: LatestLike;
};

/**
 * What the action area of a node shows:
 * - `in_flight`: an update runs; only its progress.
 * - `too_old`: the agent cannot update itself at all (no `selfUpdate`); the install command.
 * - `manual`: a source build or a method with no strategy (D8); "Run this on the node".
 * - `current`: nothing to do.
 * - `blocked`: outdated, but the server will not send it now (`blockedReason`).
 * - `ready`: the Update button.
 */
export function nodeUpdateMode(
  view: NodeModeInput,
): "in_flight" | "too_old" | "manual" | "current" | "blocked" | "ready" {
  if (view.latest !== null && !isTerminalPhase(view.latest.phase)) return "in_flight";
  if (view.selfUpdate === null) return view.outdated ? "too_old" : "current";
  if (view.build?.installMethod === "source" || view.selfUpdate.strategies.length === 0)
    return view.outdated ? "manual" : "current";
  if (!view.outdated) return "current";
  return view.canUpdate ? "ready" : "blocked";
}

/** Force is offered only when the platform's instances would stop and something runs. */
export function forceOffered(view: {
  selfUpdate: { instancesSurvive: boolean } | null;
  runningInstances: readonly unknown[];
}): boolean {
  return (
    view.selfUpdate !== null &&
    !view.selfUpdate.instancesSurvive &&
    view.runningInstances.length > 0
  );
}

export type BatchRowStatus =
  | "waiting"
  | "untouched"
  | "updating"
  | "updated"
  | "rolled_back"
  | "failed";

type BatchLike = {
  state: string;
  nodeIds: readonly string[];
  currentNodeId: string | null;
  untouchedNodeIds: readonly string[];
};

/**
 * One row per batch node, in the batch's order (canary first). `untouchedNodeIds` are the nodes
 * passed over at their turn and, once stopped, every node not reached. While it runs, nodes after
 * the current one have not had their turn, so their `latest` (an older update) does not count.
 */
export function batchRows(
  batch: BatchLike,
  latestOf: (nodeId: string) => LatestLike | undefined,
): { nodeId: string; status: BatchRowStatus }[] {
  const untouched = new Set(batch.untouchedNodeIds);
  const currentIndex =
    batch.state === "running" && batch.currentNodeId !== null
      ? batch.nodeIds.indexOf(batch.currentNodeId)
      : -1;
  return batch.nodeIds.map((nodeId, index) => {
    if (untouched.has(nodeId)) return { nodeId, status: "untouched" };
    if (currentIndex !== -1 && index > currentIndex) return { nodeId, status: "waiting" };
    const latest = latestOf(nodeId) ?? null;
    if (!latest) return { nodeId, status: "waiting" };
    return {
      nodeId,
      status: isTerminalPhase(latest.phase) ? phaseStatus(latest.phase) : "updating",
    };
  });
}

function phaseStatus(phase: string): BatchRowStatus {
  if (phase === "confirmed") return "updated";
  if (phase === "rolled_back") return "rolled_back";
  return "failed";
}
