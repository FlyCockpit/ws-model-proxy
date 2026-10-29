/**
 * `wsmp` self-update, server side (plan `self-update-plan.md`, D4/D7/D8): who may update which
 * node, starting an update (`agent.update`), the node's progress reports, the server deadline
 * (`timed_out`) and the "Update all" batch driver. Everything is driven from the database
 * (`node_agent_update`, `node_agent_update_batch`), so a server restart loses nothing: the
 * server's tick (`apps/server/src/relay/agent-updates.ts`) calls {@link expireAgentUpdates} and
 * {@link advanceAgentUpdateBatches} again.
 *
 * The relay is injected ({@link AgentUpdatePort}): the API package never imports the server.
 */
import { createHash, randomBytes } from "node:crypto";
import prisma from "@ws-model-proxy/db";
import type { RefusalReason } from "../contracts/refusals";
import { effectiveTrust } from "../nodes/trust";
import {
  AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
  AGENT_UPDATE_TERMINAL_PHASES,
  type AgentUpdateFrame,
  type AgentUpdateNodePhase,
  type AgentUpdatePhase,
  type AgentUpdateReason,
  type NodeBuild,
  nodeBuildSchema,
  nodeEnvironmentSchema,
} from "./agent-update-wire";
import { isUniqueViolation } from "./refuse";
import {
  AGENT_UPDATE_STRATEGIES,
  type AgentUpdateStrategy,
  type NodeSelfUpdate,
  nodeFeaturesSchema,
  nodeSelfUpdateSchema,
} from "./runtime-spec";

// ── The relay port ──

/** What the server would install: its release manifest (cached), or why there is none. */
export type AgentUpdateRelease =
  | {
      kind: "release";
      version: string;
      commit: string | null;
      releaseUrl: string;
      artifacts: Readonly<Record<string, { url: string; sha256: string }>>;
    }
  /** The server builds wsmp from source (`WMP_CLI_SOURCE_REV`, or no release yet): D8. */
  | { kind: "source"; version: string; commit: string | null }
  /** The manifest could not be read (no `sha256.sum`, a network failure): fail closed. */
  | { kind: "unavailable"; version: string; commit: string | null };

/**
 * What identifies a release's builds: SHA-256 over its version and every target's archive
 * checksum, in target order. `null` when the server offers no release binaries.
 */
export function agentUpdateReleaseDigest(release: AgentUpdateRelease): string | null {
  if (release.kind !== "release") return null;
  const lines = Object.keys(release.artifacts)
    .sort()
    .map((target) => `${target} ${release.artifacts[target]?.sha256 ?? ""}\n`);
  return createHash("sha256")
    .update(`${release.version}\n${lines.join("")}`)
    .digest("hex");
}

export type AgentUpdateServerInfo = {
  version: string;
  commit: string | null;
  sourceBuild: boolean;
  /** The `cargo install --git … --locked --force wsmp` line `/install.sh` would run. */
  cargoInstall: string;
  /** `WMP_AGENT_UPDATE_WINDOWS`: offer the browser update on Windows (off until it is signed). */
  windowsUpdates: boolean;
};

export type AgentUpdateLiveNode = {
  userId: string;
  connectionGeneration: number;
  trust: "full" | "relay";
  selfUpdate: NodeSelfUpdate | null;
};

/** Server hooks (`apps/server/src/relay/agent-updates.ts`). */
export type AgentUpdatePort = {
  server(): Promise<AgentUpdateServerInfo>;
  release(): Promise<AgentUpdateRelease>;
  /** The node's live session in this process, or null. */
  liveNode(nodeId: string): AgentUpdateLiveNode | null;
  /** Sends `agent.update` to that session (Full control and the owner re-checked there). */
  send(
    nodeId: string,
    frame: AgentUpdateFrame,
    guard: { connectionGeneration: number; userId: string },
  ): boolean;
  /** A batch may move on (an update ended, a batch started): run the driver soon. */
  wake?(): void;
};

// ── Phases ──

type DbPhase =
  | "REQUESTED"
  | "REFUSED"
  | "WAITING_IDLE"
  | "DOWNLOADING"
  | "VERIFYING"
  | "ARMED"
  | "SWAPPED"
  | "RESTARTING"
  | "CONFIRMED"
  | "ROLLED_BACK"
  | "FAILED"
  | "TIMED_OUT";

export function phaseToDb(phase: AgentUpdatePhase): DbPhase {
  return phase.toUpperCase() as DbPhase;
}
export function phaseFromDb(phase: DbPhase): AgentUpdatePhase {
  return phase.toLowerCase() as AgentUpdatePhase;
}

const PHASE_ORDER: Record<AgentUpdatePhase, number> = {
  requested: 0,
  waiting_idle: 1,
  downloading: 2,
  verifying: 3,
  armed: 4,
  swapped: 5,
  restarting: 6,
  confirmed: 7,
  rolled_back: 7,
  failed: 7,
  refused: 7,
  timed_out: 7,
};

/** No answer to `agent.update` at all. */
export const AGENT_UPDATE_REQUESTED_DEADLINE_MS = 120_000;
/** The node waits for idle at most 30 minutes, then refuses `busy` (a minute of slack here). */
export const AGENT_UPDATE_WAIT_IDLE_DEADLINE_MS = 31 * 60_000;
export const AGENT_UPDATE_DOWNLOAD_DEADLINE_MS = 15 * 60_000;
/** After `armed` / `swapped` / `restarting`: the dead-man deadline plus this (contract §4). */
export const AGENT_UPDATE_RESTART_SLACK_MS = 120_000;
/** Ended updates are kept this long (history), then deleted. */
export const AGENT_UPDATE_RETENTION_MS = 30 * 24 * 3_600_000;
/** A batch waits this long for a node that is offline at its turn (a restart, a reconnect). */
export const AGENT_UPDATE_BATCH_OFFLINE_GRACE_MS = 120_000;

/** When the server gives up waiting for the phase after `phase`. */
export function agentUpdateDeadline(
  phase: AgentUpdatePhase,
  rollbackAfterSecs: number,
  now: Date,
): Date | null {
  if (AGENT_UPDATE_TERMINAL_PHASES.has(phase)) return null;
  const ms =
    phase === "requested"
      ? AGENT_UPDATE_REQUESTED_DEADLINE_MS
      : phase === "waiting_idle"
        ? AGENT_UPDATE_WAIT_IDLE_DEADLINE_MS
        : phase === "downloading" || phase === "verifying"
          ? AGENT_UPDATE_DOWNLOAD_DEADLINE_MS
          : rollbackAfterSecs * 1000 + AGENT_UPDATE_RESTART_SLACK_MS;
  return new Date(now.getTime() + ms);
}

/**
 * Whether a report of `next` may follow the stored `current`. Phases only move forward; an
 * ended update stays ended, except that the node's own final word (`confirmed`, `rolled_back`,
 * `failed`, from the binary after the restart) replaces the server's `timed_out` guess.
 */
export function progressAllowed(current: AgentUpdatePhase, next: AgentUpdateNodePhase): boolean {
  if (AGENT_UPDATE_TERMINAL_PHASES.has(current))
    return (
      current === "timed_out" &&
      (next === "confirmed" || next === "rolled_back" || next === "failed")
    );
  return PHASE_ORDER[next] >= PHASE_ORDER[current];
}

/** C0/C1 controls other than tab and newline. */
function isUnsafeControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}
const FORMAT_CHARACTER = /\p{Cf}/u;

/** Node text kept as plain text: control and format characters dropped, 4000 characters. */
export function cleanAgentUpdateDetail(detail: string): string {
  return Array.from(detail)
    .filter((char) => !isUnsafeControl(char) && !FORMAT_CHARACTER.test(char))
    .slice(0, 4000)
    .join("");
}

// ── Eligibility ──

export type AgentUpdateNodeRow = {
  id: string;
  userId: string;
  slug: string;
  connection: "ONLINE" | "OFFLINE";
  trust: "FULL" | "RELAY" | null;
  trustLowerRequestedAt: Date | null;
  cliVersion: string | null;
  cliBuild: unknown;
  environment: unknown;
  features: unknown;
  agentUpdatePolicy: "ALLOWED" | "OFF";
};

export const AGENT_UPDATE_NODE_SELECT = {
  id: true,
  userId: true,
  slug: true,
  connection: true,
  trust: true,
  trustLowerRequestedAt: true,
  cliVersion: true,
  cliBuild: true,
  environment: true,
  features: true,
  agentUpdatePolicy: true,
} as const;

export function parseBuild(value: unknown): NodeBuild | null {
  const parsed = nodeBuildSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseWsl(value: unknown): boolean {
  const parsed = nodeEnvironmentSchema.safeParse(value);
  return parsed.success && parsed.data.wsl === true;
}

function storedSelfUpdate(features: unknown): NodeSelfUpdate | null {
  const parsed = nodeFeaturesSchema.safeParse(features);
  if (parsed.success) return parsed.data.selfUpdate ?? null;
  // Older rows or a partial shape: read just the self-update part.
  const raw =
    features && typeof features === "object" ? Reflect.get(features, "selfUpdate") : undefined;
  const own = nodeSelfUpdateSchema.safeParse(raw);
  return own.success ? own.data : null;
}

/**
 * Where the browser update is offered: each operating system with the strategy verified on a
 * real machine there (the dead-man, the restart, the confirmation). Linux covers WSL. Adding one
 * is a server deploy, no new wsmp. `optIn` entries are offered only when the server turns them on.
 */
export const AGENT_UPDATE_OFFERED: ReadonlyArray<{
  os: "linux" | "macos" | "windows";
  strategy: AgentUpdateStrategy;
  optIn?: "windowsUpdates";
}> = [
  { os: "linux", strategy: "self-replace" },
  { os: "macos", strategy: "self-replace" },
  { os: "macos", strategy: "homebrew" },
  // Verified, but Defender flags the unsigned wsmp.exe run as a scheduled task (issue #254):
  // off until Windows releases are signed.
  { os: "windows", strategy: "self-replace", optIn: "windowsUpdates" },
];

function osOf(target: string): "linux" | "macos" | "windows" | null {
  if (target.includes("-linux-")) return "linux";
  if (target.includes("-apple-darwin")) return "macos";
  if (target.includes("-windows-")) return "windows";
  return null;
}

/** Whether the browser update is offered for this build with this strategy. */
export function agentUpdateOffered(
  build: NodeBuild | null,
  strategy: AgentUpdateStrategy,
  server: Pick<AgentUpdateServerInfo, "windowsUpdates">,
): boolean {
  const os = build ? osOf(build.target) : null;
  return AGENT_UPDATE_OFFERED.some(
    (entry) =>
      entry.os === os &&
      entry.strategy === strategy &&
      (entry.optIn === undefined || server[entry.optIn]),
  );
}

function isWindows(row: AgentUpdateNodeRow, build: NodeBuild | null): boolean {
  if (build) return build.target.includes("windows");
  const parsed = nodeFeaturesSchema.safeParse(row.features);
  return parsed.success && parsed.data.launch?.platform === "windows";
}

export function isOutdated(
  version: string | null,
  build: NodeBuild | null,
  server: { version: string; commit: string | null },
): boolean {
  if (version !== server.version) return true;
  return build?.commit != null && server.commit !== null && build.commit !== server.commit;
}

/** The exact command to run on the node when it cannot update itself (or a recovery). */
export function manualCommandFor(input: {
  origin: string;
  build: NodeBuild | null;
  windows: boolean;
  server: AgentUpdateServerInfo;
  /** The latest update was a Homebrew one that did not confirm (D10: no rollback). */
  homebrewFailed?: boolean;
}): string {
  const base = input.origin.replace(/\/+$/, "");
  const method = input.build?.installMethod;
  if (method === "homebrew" || input.homebrewFailed)
    return "brew reinstall flycockpit/tap/wsmp && wsmp service restart";
  if (method === "source" || method === "cargo")
    return input.windows
      ? `${input.server.cargoInstall}; wsmp service restart`
      : `${input.server.cargoInstall} && wsmp service restart`;
  if (input.windows)
    return `irm ${base}/install.ps1 | iex; & "$env:USERPROFILE\\.cargo\\bin\\wsmp.exe" service restart`;
  return `curl -fsSL ${base}/install.sh | sh && ~/.cargo/bin/wsmp service restart`;
}

export type AgentUpdateEligibility = {
  canUpdate: boolean;
  blockedReason: RefusalReason | null;
  outdated: boolean;
  manualCommand: string | null;
  strategy: AgentUpdateStrategy | null;
  artifact: { url: string; sha256: string } | null;
  selfUpdate: NodeSelfUpdate | null;
  build: NodeBuild | null;
};

export type AgentUpdateActive = { phase: AgentUpdatePhase; strategy: string } | null;

/**
 * Whether the owner may update this node now, and if not why (the first that applies):
 * in progress, already current, offline (no live session here), not Full control, the owner's
 * policy off, a wsmp without self-update (`upgrade_wsmp`), no strategy the server knows
 * (source build, pinned or foreign Homebrew), not offered on its platform yet
 * ({@link AGENT_UPDATE_OFFERED}), the node's operator opted out, or no release
 * artifact for its target (a source-build server, an unreadable manifest).
 */
export function agentUpdateEligibility(input: {
  row: AgentUpdateNodeRow;
  live: AgentUpdateLiveNode | null;
  release: AgentUpdateRelease;
  server: AgentUpdateServerInfo;
  origin: string;
  active: AgentUpdateActive;
  /** The latest ended update, for the Homebrew recovery command. */
  latest?: { phase: AgentUpdatePhase; strategy: string } | null;
}): AgentUpdateEligibility {
  const { row, release, server } = input;
  const live = input.live && input.live.userId === row.userId ? input.live : null;
  const build = parseBuild(row.cliBuild);
  const selfUpdate = live ? live.selfUpdate : storedSelfUpdate(row.features);
  const outdated = isOutdated(row.cliVersion, build, server);
  const strategy =
    (selfUpdate?.strategies.find((value): value is AgentUpdateStrategy =>
      (AGENT_UPDATE_STRATEGIES as readonly string[]).includes(value),
    ) as AgentUpdateStrategy | undefined) ?? null;
  const artifact =
    release.kind === "release" && build ? (release.artifacts[build.target] ?? null) : null;
  const full = live !== null && live.trust === "full" && effectiveTrust(row) === "FULL";
  const blockedReason: RefusalReason | null = input.active
    ? "agent_update_in_progress"
    : !outdated
      ? "agent_update_current"
      : !live
        ? "node_offline"
        : !full
          ? "trust_relay"
          : row.agentUpdatePolicy === "OFF"
            ? "agent_update_off"
            : !selfUpdate
              ? "upgrade_wsmp"
              : !strategy
                ? "agent_update_unsupported"
                : !agentUpdateOffered(build, strategy, server)
                  ? "agent_update_platform"
                  : selfUpdate.remote === "off"
                    ? "agent_update_opted_out"
                    : !artifact
                      ? "agent_update_unavailable"
                      : null;
  const homebrewFailed =
    input.latest?.strategy === "homebrew" &&
    (input.latest.phase === "timed_out" || input.latest.phase === "failed");
  const needsHand =
    (blockedReason !== null &&
      blockedReason !== "agent_update_in_progress" &&
      blockedReason !== "agent_update_current") ||
    homebrewFailed;
  return {
    canUpdate: blockedReason === null,
    blockedReason,
    outdated,
    manualCommand: needsHand
      ? manualCommandFor({
          origin: input.origin,
          build,
          windows: isWindows(row, build),
          server,
          homebrewFailed,
        })
      : null,
    strategy,
    artifact,
    selfUpdate,
    build,
  };
}

/** Fixed, developer-written messages per refusal (they may name the node, never node text). */
export function agentUpdateRefusalMessage(reason: RefusalReason, slug: string): string {
  switch (reason) {
    case "agent_update_in_progress":
      return `An update of ${slug} is already in progress.`;
    case "agent_update_current":
      return `${slug} already runs this server's wsmp.`;
    case "node_offline":
      return `${slug} is offline. Run the install command on the node instead.`;
    case "trust_relay":
      return `${slug} is Relay only: only a Full-control node updates from the browser.`;
    case "agent_update_off":
      return `Browser updates are off for ${slug}. Allow them in its settings first.`;
    case "upgrade_wsmp":
      return `The wsmp on ${slug} cannot update itself yet. Run the install command on the node once.`;
    case "agent_update_unsupported":
      return `This install of wsmp on ${slug} cannot update itself. Run the shown command on the node.`;
    case "agent_update_platform":
      return `Browser updates are not offered on ${slug}'s platform yet. Run the install command on the node.`;
    case "agent_update_opted_out":
      return `The operator of ${slug} turned remote updates off on the node.`;
    case "agent_update_unavailable":
      return "This server has no release binary to offer for that node (it builds wsmp from source, or its release could not be read).";
    default:
      return `${slug} cannot be updated now.`;
  }
}

// ── Starting an update ──

export type StartOutcome =
  | { kind: "started"; updateId: string }
  | { kind: "refused"; reason: RefusalReason; message: string }
  | { kind: "not_found" }
  /** A batch step whose run was pinned to another release than the server offers now. */
  | { kind: "release_changed" };

function newUpdateId(): string {
  return randomBytes(16).toString("base64url");
}

function frameFor(
  update: { id: string; toVersion: string; force: boolean; rollbackAfterSecs: number },
  artifact: { url: string; sha256: string },
): AgentUpdateFrame {
  return {
    type: "agent.update",
    updateId: update.id,
    version: update.toVersion,
    artifactUrl: artifact.url,
    sha256: artifact.sha256,
    signature: null,
    force: update.force,
    rollbackAfterSecs: update.rollbackAfterSecs,
  };
}

/** The node's update in flight, if any (owner-scoped). */
async function activeUpdate(userId: string, nodeId: string) {
  return prisma.nodeAgentUpdate.findFirst({
    where: { userId, nodeId, endedAt: null },
    select: {
      id: true,
      phase: true,
      strategy: true,
      toVersion: true,
      force: true,
      rollbackAfterSecs: true,
    },
  });
}

/**
 * Starts one update of the owner's node: checks everything {@link agentUpdateEligibility}
 * checks against the live session, writes the `requested` row (with `batch`, advancing that
 * run atomically), then sends `agent.update`. A send that does not go out undoes both.
 *
 * `force` on a node whose update waits for idle (`waiting_idle`) is not a second update: it
 * marks that update forced and sends the same `agent.update` again with `force: true` (the
 * node stops waiting, stops the instances and goes on).
 */
export async function startAgentUpdate(
  port: AgentUpdatePort,
  input: {
    userId: string;
    nodeId: string;
    force: boolean;
    origin: string;
    batch?: {
      id: string;
      position: number;
      targetVersion?: string | null;
      targetDigest?: string | null;
    };
    now?: Date;
  },
): Promise<StartOutcome> {
  const now = input.now ?? new Date();
  const row = await prisma.node.findFirst({
    where: { id: input.nodeId, userId: input.userId },
    select: AGENT_UPDATE_NODE_SELECT,
  });
  if (!row) return { kind: "not_found" };
  const active = await activeUpdate(input.userId, row.id);
  const live = port.liveNode(row.id);
  const refused = (reason: RefusalReason): StartOutcome => ({
    kind: "refused",
    reason,
    message: agentUpdateRefusalMessage(reason, row.slug),
  });

  if (active && input.force && !input.batch && phaseFromDb(active.phase) === "waiting_idle")
    return forceWaitingUpdate(port, { ...input, now }, row, active, live, refused);

  const release = await port.release();
  // An "Update all" run installs only the release its canary validated.
  if (input.batch?.targetVersion && release.version !== input.batch.targetVersion)
    return { kind: "release_changed" };
  // The same version, built again (another commit, other archives): not what the canary ran.
  if (
    input.batch?.targetDigest &&
    release.kind === "release" &&
    agentUpdateReleaseDigest(release) !== input.batch.targetDigest
  )
    return { kind: "release_changed" };
  const server = await port.server();
  const eligibility = agentUpdateEligibility({
    row,
    live,
    release,
    server,
    origin: input.origin,
    active: active ? { phase: phaseFromDb(active.phase), strategy: active.strategy } : null,
  });
  if (!eligibility.canUpdate || !eligibility.strategy || !eligibility.artifact || !live)
    return refused(eligibility.blockedReason ?? "agent_update_unavailable");

  const update = {
    id: newUpdateId(),
    userId: input.userId,
    nodeId: row.id,
    batchId: input.batch?.id ?? null,
    fromVersion: row.cliVersion,
    fromCommit: eligibility.build?.commit ?? null,
    toVersion: release.version,
    strategy: eligibility.strategy,
    force: input.force,
    rollbackAfterSecs: AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
    phase: "REQUESTED" as const,
    deadlineAt: agentUpdateDeadline("requested", AGENT_UPDATE_ROLLBACK_SECS_DEFAULT, now),
  };
  const batch = input.batch;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.nodeAgentUpdate.create({ data: update, select: { id: true } });
      if (batch) {
        const moved = await tx.nodeAgentUpdateBatch.updateMany({
          where: {
            id: batch.id,
            userId: input.userId,
            state: "RUNNING",
            position: batch.position,
            currentUpdateId: null,
          },
          data: { currentUpdateId: update.id, currentNodeId: row.id },
        });
        if (moved.count !== 1) throw new BatchMoved();
      }
    });
  } catch (error) {
    if (error instanceof BatchMoved) return refused("agent_update_in_progress");
    // Another start won the race for this node (`node_agent_update_one_active`).
    if (isUniqueViolation(error)) return refused("agent_update_in_progress");
    throw error;
  }
  const sent = port.send(row.id, frameFor(update, eligibility.artifact), {
    connectionGeneration: live.connectionGeneration,
    userId: input.userId,
  });
  if (!sent) {
    // Gone (or lowered) between the check and the send: nothing reached the node.
    await prisma.$transaction(async (tx) => {
      await tx.nodeAgentUpdate.deleteMany({
        where: { id: update.id, userId: input.userId, phase: "REQUESTED" },
      });
      if (batch)
        await tx.nodeAgentUpdateBatch.updateMany({
          where: { id: batch.id, userId: input.userId, currentUpdateId: update.id },
          data: { currentUpdateId: null, currentNodeId: null },
        });
    });
    return refused("node_offline");
  }
  return { kind: "started", updateId: update.id };
}

class BatchMoved extends Error {}

async function forceWaitingUpdate(
  port: AgentUpdatePort,
  input: { userId: string; nodeId: string; now: Date },
  row: AgentUpdateNodeRow,
  active: NonNullable<Awaited<ReturnType<typeof activeUpdate>>>,
  live: AgentUpdateLiveNode | null,
  refused: (reason: RefusalReason) => StartOutcome,
): Promise<StartOutcome> {
  if (!live || live.userId !== input.userId) return refused("node_offline");
  if (live.trust !== "full" || effectiveTrust(row) !== "FULL") return refused("trust_relay");
  if (row.agentUpdatePolicy === "OFF") return refused("agent_update_off");
  const release = await port.release();
  const build = parseBuild(row.cliBuild);
  const artifact =
    release.kind === "release" && build ? (release.artifacts[build.target] ?? null) : null;
  // The same release as the waiting update, or nothing to resend.
  if (!artifact || release.version !== active.toVersion) return refused("agent_update_unavailable");
  const marked = await prisma.nodeAgentUpdate.updateMany({
    where: { id: active.id, userId: input.userId, nodeId: row.id, phase: "WAITING_IDLE" },
    data: { force: true },
  });
  if (marked.count !== 1) return refused("agent_update_in_progress");
  const sent = port.send(row.id, frameFor({ ...active, force: true }, artifact), {
    connectionGeneration: live.connectionGeneration,
    userId: input.userId,
  });
  if (!sent) {
    await prisma.nodeAgentUpdate.updateMany({
      where: { id: active.id, userId: input.userId, phase: "WAITING_IDLE", force: true },
      data: { force: active.force },
    });
    return refused("node_offline");
  }
  return { kind: "started", updateId: active.id };
}

// ── Progress from the node ──

/**
 * Applies one `agent.update.progress` from the node's session. A frame about an update that is
 * not this node's (an unknown or foreign updateId) changes nothing. Returns whether the update
 * ended with this report.
 */
export async function applyAgentUpdateProgress(
  node: { nodeId: string; userId: string },
  frame: {
    updateId: string;
    phase: AgentUpdateNodePhase;
    reason?: AgentUpdateReason;
    detail?: string;
  },
  now: Date = new Date(),
): Promise<{ applied: boolean; ended: boolean; settled: boolean }> {
  const ended = AGENT_UPDATE_TERMINAL_PHASES.has(frame.phase);
  // A report that loses the conditional write to another report of the same update (frames
  // handled concurrently: `verifying`, then at once `refused`) reads the row again and tries
  // again, so the later report is never dropped. The deadline sweep can win too: then the
  // re-read decides whether the report still applies.
  for (let attempt = 0; attempt < AGENT_UPDATE_PROGRESS_ATTEMPTS; attempt += 1) {
    const row = await prisma.nodeAgentUpdate.findFirst({
      where: { id: frame.updateId, nodeId: node.nodeId, userId: node.userId },
      select: { phase: true, rollbackAfterSecs: true },
    });
    // No such update of this node (pruned, or never): nothing to store, ever.
    if (!row) return { applied: false, ended: false, settled: true };
    const stored = phaseFromDb(row.phase);
    if (!progressAllowed(stored, frame.phase))
      return {
        applied: false,
        ended: false,
        settled: AGENT_UPDATE_TERMINAL_PHASES.has(stored),
      };
    const written = await prisma.nodeAgentUpdate.updateMany({
      // Unchanged since the read: a concurrent report or the deadline wins once.
      where: { id: frame.updateId, nodeId: node.nodeId, userId: node.userId, phase: row.phase },
      data: {
        phase: phaseToDb(frame.phase),
        reason:
          frame.phase === "refused" || frame.phase === "failed" ? (frame.reason ?? null) : null,
        ...(frame.detail !== undefined ? { detail: cleanAgentUpdateDetail(frame.detail) } : {}),
        deadlineAt: agentUpdateDeadline(frame.phase, row.rollbackAfterSecs, now),
        endedAt: ended ? now : null,
      },
    });
    if (written.count === 1) return { applied: true, ended, settled: ended };
  }
  return { applied: false, ended: false, settled: false };
}

/** How often one progress report re-reads after losing to a concurrent write. */
const AGENT_UPDATE_PROGRESS_ATTEMPTS = 5;

/**
 * The server deadline: an update that did not reach its next phase in time is `timed_out`
 * (its `reason` is the phase it was stuck in). Also how a Homebrew update that never confirmed
 * surfaces (D10). Returns how many ended.
 */
export async function expireAgentUpdates(now: Date = new Date()): Promise<number> {
  const due = await prisma.nodeAgentUpdate.findMany({
    where: { endedAt: null, deadlineAt: { lte: now } },
    select: { id: true, phase: true },
    take: 200,
  });
  let ended = 0;
  for (const update of due) {
    const written = await prisma.nodeAgentUpdate.updateMany({
      where: { id: update.id, phase: update.phase, endedAt: null, deadlineAt: { lte: now } },
      data: {
        phase: "TIMED_OUT",
        reason: phaseFromDb(update.phase),
        deadlineAt: null,
        endedAt: now,
      },
    });
    ended += written.count;
  }
  return ended;
}

/** Ended updates older than the retention go (history only). */
export async function pruneAgentUpdates(now: Date = new Date()): Promise<void> {
  const before = new Date(now.getTime() - AGENT_UPDATE_RETENTION_MS);
  await prisma.nodeAgentUpdate.deleteMany({ where: { endedAt: { lt: before } } });
  await prisma.nodeAgentUpdateBatch.deleteMany({ where: { endedAt: { lt: before } } });
}

// ── Update all (D7) ──

/**
 * The canary rule: among the nodes that can update now, the one with the fewest running
 * instances; ties by slug (the server keeps no "last idle" time).
 */
export function chooseCanary(
  candidates: ReadonlyArray<{ nodeId: string; slug: string; running: number }>,
): string | null {
  return orderForBatch(candidates)[0] ?? null;
}

/** Batch order: fewest running instances first, then slug. */
export function orderForBatch(
  candidates: ReadonlyArray<{ nodeId: string; slug: string; running: number }>,
): string[] {
  return [...candidates]
    .sort((a, b) => a.running - b.running || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((candidate) => candidate.nodeId);
}

/** `BatchView.stoppedReason`: exactly these. */
export type BatchStopReason =
  | "stopped"
  | "refused"
  | "failed"
  | "rolled_back"
  | "timed_out"
  | "release_changed";

function stopReasonOf(phase: AgentUpdatePhase | null): BatchStopReason {
  return phase === "rolled_back" || phase === "timed_out" || phase === "refused" ? phase : "failed";
}

type BatchRow = {
  id: string;
  userId: string;
  nodeIds: string[];
  position: number;
  currentUpdateId: string | null;
  currentNodeId: string | null;
  skippedNodeIds: string[];
  targetVersion: string | null;
  targetDigest: string | null;
  updatedAt: Date;
};

const BATCH_DRIVER_SELECT = {
  id: true,
  userId: true,
  nodeIds: true,
  position: true,
  currentUpdateId: true,
  currentNodeId: true,
  skippedNodeIds: true,
  targetVersion: true,
  targetDigest: true,
  updatedAt: true,
} as const;

async function stopBatch(
  batch: BatchRow,
  nodeId: string | null,
  reason: BatchStopReason,
  now: Date,
): Promise<void> {
  await prisma.nodeAgentUpdateBatch.updateMany({
    where: { id: batch.id, userId: batch.userId, state: "RUNNING", position: batch.position },
    data: {
      state: "STOPPED",
      stoppedNodeId: nodeId,
      stoppedReason: reason,
      currentUpdateId: null,
      currentNodeId: null,
      endedAt: now,
    },
  });
}

/**
 * One batch, one step at a time, from its row: wait for the update in flight; on `confirmed`
 * move on; on anything else stop (the rest stay untouched). A node whose turn comes while it
 * cannot update is passed over (`skippedNodeIds`), after a short grace when it is offline;
 * an unavailable canary stops the run (`refused`). Idempotent and safe to run concurrently:
 * every move is a compare-and-set on the batch row.
 */
export async function advanceAgentUpdateBatch(
  port: AgentUpdatePort,
  batchId: string,
  origin: string,
  now: Date = new Date(),
): Promise<void> {
  for (let step = 0; step < 512; step += 1) {
    const batch = await prisma.nodeAgentUpdateBatch.findFirst({
      where: { id: batchId, state: "RUNNING" },
      select: BATCH_DRIVER_SELECT,
    });
    if (!batch) return;
    if (batch.currentUpdateId) {
      const update = await prisma.nodeAgentUpdate.findFirst({
        where: { id: batch.currentUpdateId, userId: batch.userId },
        select: { phase: true },
      });
      const phase = update ? phaseFromDb(update.phase) : null;
      if (phase && !AGENT_UPDATE_TERMINAL_PHASES.has(phase)) return;
      if (phase !== "confirmed") {
        await stopBatch(batch, batch.currentNodeId, stopReasonOf(phase), now);
        return;
      }
      const moved = await prisma.nodeAgentUpdateBatch.updateMany({
        where: { id: batch.id, state: "RUNNING", currentUpdateId: batch.currentUpdateId },
        data: { currentUpdateId: null, currentNodeId: null, position: batch.position + 1 },
      });
      if (moved.count !== 1) return;
      continue;
    }
    const nodeId = batch.nodeIds[batch.position];
    if (nodeId === undefined) {
      await prisma.nodeAgentUpdateBatch.updateMany({
        where: { id: batch.id, state: "RUNNING", position: batch.position, currentUpdateId: null },
        data: { state: "DONE", endedAt: now },
      });
      return;
    }
    const outcome = await startAgentUpdate(port, {
      userId: batch.userId,
      nodeId,
      force: false,
      origin,
      batch: {
        id: batch.id,
        position: batch.position,
        targetVersion: batch.targetVersion,
        targetDigest: batch.targetDigest,
      },
      now,
    });
    if (outcome.kind === "started") return;
    // The server offers another release than the canary validated (a deploy during the run):
    // stop, and the rest stay untouched.
    if (outcome.kind === "release_changed") {
      await stopBatch(batch, null, "release_changed", now);
      return;
    }
    const reason = outcome.kind === "refused" ? outcome.reason : "unknown_node";
    // A manual update of that node is still running: its own deadline ends it.
    if (reason === "agent_update_in_progress") return;
    if (
      reason === "node_offline" &&
      now.getTime() - batch.updatedAt.getTime() < AGENT_UPDATE_BATCH_OFFLINE_GRACE_MS
    )
      return;
    if (reason !== "agent_update_current" && batch.position === 0) {
      await stopBatch(batch, nodeId, "refused", now);
      return;
    }
    const moved = await prisma.nodeAgentUpdateBatch.updateMany({
      where: { id: batch.id, state: "RUNNING", position: batch.position, currentUpdateId: null },
      data: {
        position: batch.position + 1,
        // Already current needs nothing; anything else was passed over.
        ...(reason === "agent_update_current"
          ? {}
          : { skippedNodeIds: [...batch.skippedNodeIds, nodeId] }),
      },
    });
    if (moved.count !== 1) return;
  }
}

/** Every running batch (the server's tick, and after an update ended). */
export async function advanceAgentUpdateBatches(
  port: AgentUpdatePort,
  origin: string,
  now: Date = new Date(),
): Promise<void> {
  const running = await prisma.nodeAgentUpdateBatch.findMany({
    where: { state: "RUNNING" },
    select: { id: true },
    take: 100,
  });
  for (const batch of running) {
    try {
      await advanceAgentUpdateBatch(port, batch.id, origin, now);
    } catch (error) {
      console.error(
        "[agent-update] batch step failed",
        error instanceof Error ? error.constructor.name : typeof error,
      );
    }
  }
}

/** `BatchView.untouchedNodeIds`: passed over, and (once stopped) every node not reached. */
export function untouchedNodeIds(batch: {
  state: "RUNNING" | "DONE" | "STOPPED";
  nodeIds: string[];
  position: number;
  skippedNodeIds: string[];
  stoppedNodeId: string | null;
  currentUpdateId: string | null;
}): string[] {
  const untouched = [...batch.skippedNodeIds];
  if (batch.state === "STOPPED") {
    const reached = batch.stoppedNodeId !== null || batch.currentUpdateId !== null ? 1 : 0;
    for (const id of batch.nodeIds.slice(batch.position + reached))
      if (!untouched.includes(id)) untouched.push(id);
  }
  return untouched;
}
