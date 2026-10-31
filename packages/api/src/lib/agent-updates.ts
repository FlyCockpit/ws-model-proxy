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
  compareReleaseVersions,
  type NodeBuild,
  nodeBuildSchema,
  nodeEnvironmentSchema,
} from "./agent-update-wire";
import { publishNodeEvent } from "./node-events";
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
 * Whether a report of `next` may follow the stored `current`. Phases only move forward, with one
 * step back: a node that got busy during the download waits for idle again before it swaps
 * (`waiting_idle` after `downloading` or `verifying`). An ended update stays ended, except that
 * the node's own final word (`confirmed`, `rolled_back`, `failed`, from the binary after the
 * restart) replaces the server's `timed_out` guess.
 */
export function progressAllowed(current: AgentUpdatePhase, next: AgentUpdateNodePhase): boolean {
  if (AGENT_UPDATE_TERMINAL_PHASES.has(current))
    return (
      current === "timed_out" &&
      (next === "confirmed" || next === "rolled_back" || next === "failed")
    );
  if (next === "waiting_idle" && (current === "downloading" || current === "verifying"))
    return true;
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

/**
 * Whether the node's wsmp is behind the server's: another version (but not a newer one: a wsmp
 * installed anyway from its Homebrew tap, or by hand, is not behind), or the same version built
 * from another commit.
 */
export function isOutdated(
  version: string | null,
  build: NodeBuild | null,
  server: { version: string; commit: string | null },
): boolean {
  if (version !== server.version) return !isNewerThanServer(version, server);
  return build?.commit != null && server.commit !== null && build.commit !== server.commit;
}

/** The node's wsmp is a newer release than the server's. */
export function isNewerThanServer(version: string | null, server: { version: string }): boolean {
  return version !== null && (compareReleaseVersions(version, server.version) ?? 0) > 0;
}

/**
 * The exact command to run on the node when it cannot update itself (or a recovery). It follows
 * how the node is installed now (`build`), not how an earlier update ran: a node reinstalled
 * another way since is repaired the new way.
 */
export function manualCommandFor(input: {
  origin: string;
  build: NodeBuild | null;
  windows: boolean;
  server: AgentUpdateServerInfo;
}): string {
  const base = input.origin.replace(/\/+$/, "");
  const method = input.build?.installMethod;
  if (method === "homebrew") return "brew reinstall flycockpit/tap/wsmp && wsmp service restart";
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
  /** The node runs a newer wsmp release than the server (installed anyway, or by hand). */
  newerThanServer: boolean;
  /**
   * "Install anyway": the version the node's Homebrew tap offered when it refused the server's
   * (see {@link installAnywayVersion}), or null.
   */
  availableVersion: string | null;
  /**
   * `availableVersion` is newer than the server's version (the tap is ahead; upgrading the
   * server is the usual fix). False when it is older (the tap does not have the server's yet).
   */
  availableVersionAhead: boolean;
  manualCommand: string | null;
  strategy: AgentUpdateStrategy | null;
  artifact: { url: string; sha256: string } | null;
  selfUpdate: NodeSelfUpdate | null;
  build: NodeBuild | null;
};

export type AgentUpdateActive = { phase: AgentUpdatePhase; strategy: string } | null;

/** The node's latest update, as eligibility reads it. */
export type AgentUpdateLatest = {
  phase: AgentUpdatePhase;
  strategy: string;
  reason?: string | null;
  fromVersion?: string | null;
  fromCommit?: string | null;
  availableVersion?: string | null;
  availableGeneration?: number | null;
} | null;

/**
 * The wsmp that answered an update is still the one the node runs: the same release version and
 * the same build. A release is one build of one source, so a property the answer proved (a
 * refusal carrying `availableVersion`) still holds.
 *
 * Both commits known: the same commit is the same wsmp, on any connection. Either one unknown:
 * the version alone does not identify the build (a reinstall or a local build reconnects with
 * the same version), so only the connection the answer arrived on (`availableGeneration`, the
 * node's `connectionGeneration`) proves it; after a reconnect the node must answer again.
 */
function sameWsmp(
  from: {
    fromVersion?: string | null;
    fromCommit?: string | null;
    availableGeneration?: number | null;
  },
  now: { cliVersion: string | null; commit: string | null; connectionGeneration: number | null },
): boolean {
  if (now.cliVersion === null || from.fromVersion !== now.cliVersion) return false;
  const was = from.fromCommit ?? null;
  if (was !== null && now.commit !== null) return was === now.commit;
  return (
    was === null &&
    now.commit === null &&
    now.connectionGeneration !== null &&
    (from.availableGeneration ?? null) === now.connectionGeneration
  );
}

/**
 * The version an owner may install anyway, or null.
 *
 * The capability is proved by the node's own answer, never by its hello (a hello field would be
 * refused by a 0.4.3 server): only a wsmp that checks its tap's version before installing sends
 * `availableVersion`, so the node's latest update must have been refused `version_mismatch`
 * carrying it, by the wsmp it still runs ({@link sameWsmp}: when a build commit is unknown, on
 * this same connection; an older wsmp, which would
 * `brew upgrade` blindly, never sent one). Also: the tap's version is newer than the node's
 * (`brew upgrade` never goes back), the node updates with Homebrew, and it is still outdated and
 * otherwise free to update ({@link agentUpdateEligibility}'s gates).
 */
function installAnywayVersion(input: {
  latest: AgentUpdateLatest | undefined;
  cliVersion: string | null;
  commit: string | null;
  connectionGeneration: number | null;
  outdated: boolean;
  free: boolean;
  strategy: AgentUpdateStrategy | null;
}): string | null {
  const { latest, cliVersion } = input;
  if (!input.outdated || !input.free || input.strategy !== "homebrew") return null;
  if (latest?.phase !== "refused" || latest.reason !== "version_mismatch") return null;
  if (latest.strategy !== "homebrew" || !sameWsmp(latest, input)) return null;
  const available = latest.availableVersion ?? null;
  if (available === null || cliVersion === null) return null;
  return (compareReleaseVersions(available, cliVersion) ?? 0) > 0 ? available : null;
}

/**
 * The live gates of every update effect the server makes on a node: its first `agent.update`,
 * a forced resend, and the STOP of its instances a forced update makes. The node's session here
 * (this owner's), Full control on that session and in the database, the owner's browser policy,
 * a wsmp that updates itself, and the node operator's own `selfUpdate.remote` setting, as the
 * session reports it now. Null when all hold.
 *
 * `row` is what the caller read last (under the node row lock in a claim); `live` must be
 * `port.liveNode()` read at the moment of the effect, never a snapshot from before other I/O.
 * When `generation` is given, the session must still be that connection.
 */
export function liveAgentUpdateGate(
  row: Pick<AgentUpdateNodeRow, "userId" | "trust" | "trustLowerRequestedAt" | "agentUpdatePolicy">,
  live: AgentUpdateLiveNode | null,
  generation?: number,
): RefusalReason | null {
  if (!live || live.userId !== row.userId) return "node_offline";
  if (generation !== undefined && live.connectionGeneration !== generation) return "node_offline";
  if (live.trust !== "full" || effectiveTrust(row) !== "FULL") return "trust_relay";
  if (row.agentUpdatePolicy === "OFF") return "agent_update_off";
  if (!live.selfUpdate) return "upgrade_wsmp";
  if (live.selfUpdate.remote === "off") return "agent_update_opted_out";
  return null;
}

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
  /** The latest update: the Homebrew recovery command, and "Install anyway". */
  latest?: AgentUpdateLatest;
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
  // What keeps the server from sending this node an update at all, whatever its version: the
  // live gates ({@link liveAgentUpdateGate}), with the node's opt-out named after what this
  // install cannot do anyway.
  const liveGate = liveAgentUpdateGate(row, live);
  const gate: RefusalReason | null =
    liveGate !== null && liveGate !== "agent_update_opted_out"
      ? liveGate
      : !strategy
        ? "agent_update_unsupported"
        : !agentUpdateOffered(build, strategy, server)
          ? "agent_update_platform"
          : (liveGate ?? (!artifact ? "agent_update_unavailable" : null));
  const blockedReason: RefusalReason | null = input.active
    ? "agent_update_in_progress"
    : !outdated
      ? "agent_update_current"
      : gate;
  // A Homebrew update has no rollback (D10): one that did not confirm needs a hand repair, by
  // the node's current install method (manualCommandFor).
  const homebrewFailed =
    input.latest?.strategy === "homebrew" &&
    (input.latest.phase === "timed_out" || input.latest.phase === "failed");
  const needsHand =
    (blockedReason !== null &&
      blockedReason !== "agent_update_in_progress" &&
      blockedReason !== "agent_update_current") ||
    homebrewFailed;
  const availableVersion = installAnywayVersion({
    latest: input.latest,
    cliVersion: row.cliVersion,
    commit: build?.commit ?? null,
    connectionGeneration: live?.connectionGeneration ?? null,
    outdated,
    free: blockedReason === null,
    strategy,
  });
  return {
    canUpdate: blockedReason === null,
    blockedReason,
    outdated,
    newerThanServer: isNewerThanServer(row.cliVersion, server),
    availableVersion,
    availableVersionAhead:
      availableVersion !== null &&
      (compareReleaseVersions(availableVersion, server.version) ?? 0) > 0,
    manualCommand: needsHand
      ? manualCommandFor({
          origin: input.origin,
          build,
          windows: isWindows(row, build),
          server,
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
      return `${slug} already runs this server's wsmp (or a newer one).`;
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
  /** `connectionGeneration`: the connection the frame went out on (what its STOP is bound to). */
  | { kind: "started"; updateId: string; connectionGeneration: number }
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
      artifactSha256: true,
      fromVersion: true,
      fromCommit: true,
      availableGeneration: true,
    },
  });
}

/** The node's latest update, ended or not (owner-scoped): what "Install anyway" checks. */
async function latestUpdate(
  userId: string,
  nodeId: string,
  db: Pick<typeof prisma, "nodeAgentUpdate"> = prisma,
): Promise<AgentUpdateLatest> {
  const latest = await db.nodeAgentUpdate.findFirst({
    where: { userId, nodeId },
    orderBy: { createdAt: "desc" },
    select: {
      phase: true,
      strategy: true,
      reason: true,
      fromVersion: true,
      fromCommit: true,
      availableVersion: true,
      availableGeneration: true,
    },
  });
  return latest ? { ...latest, phase: phaseFromDb(latest.phase) } : null;
}

/**
 * Starts one update of the owner's node: checks everything {@link agentUpdateEligibility}
 * checks against the live session, writes the `requested` row (with `batch`, advancing that
 * run atomically), then sends `agent.update`. A send that does not go out undoes both.
 *
 * `version` ("Install anyway"): the version the node's Homebrew tap offered instead of the
 * server's, exactly as eligibility offers it now (`availableVersion`); never in a batch.
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
    /** Install this version instead of the server's (only `availableVersion`; never a batch). */
    version?: string;
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

  // "Update all" never installs anything but the server's release.
  if (input.version !== undefined && input.batch) return refused("agent_update_unavailable");
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
    latest: input.version !== undefined ? await latestUpdate(input.userId, row.id) : undefined,
  });
  if (!eligibility.canUpdate || !eligibility.strategy || !eligibility.artifact || !live)
    return refused(eligibility.blockedReason ?? "agent_update_unavailable");
  if (input.version !== undefined && eligibility.availableVersion !== input.version)
    return {
      kind: "refused",
      reason: "agent_update_unavailable",
      message: `wsmp ${input.version} is not what ${row.slug}'s Homebrew tap offered for the wsmp it runs. Press Update to check the tap again.`,
    };

  const update = {
    id: newUpdateId(),
    userId: input.userId,
    nodeId: row.id,
    batchId: input.batch?.id ?? null,
    fromVersion: row.cliVersion,
    fromCommit: eligibility.build?.commit ?? null,
    toVersion: input.version ?? release.version,
    strategy: eligibility.strategy,
    // What the frame carries: a forced resend goes out only while the server still offers it.
    artifactSha256: eligibility.artifact.sha256,
    force: input.force,
    rollbackAfterSecs: AGENT_UPDATE_ROLLBACK_SECS_DEFAULT,
    phase: "REQUESTED" as const,
    deadlineAt: agentUpdateDeadline("requested", AGENT_UPDATE_ROLLBACK_SECS_DEFAULT, now),
    // Install anyway: the connection it goes to, where the tap's version was proved
    // (`sameWsmp`; a forced resend after a reconnect needs a known build).
    availableGeneration: input.version !== undefined ? live.connectionGeneration : null,
  };
  const batch = input.batch;
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockClaimGates(
        tx,
        port,
        input.userId,
        row.id,
        live.connectionGeneration,
      );
      // Install anyway: the tap's version was proved to the wsmp on a connection; still that
      // wsmp, on the connection as stored now (a hello since may have replaced the build).
      if (
        input.version !== undefined &&
        !installAnywayStillProved(
          await latestUpdate(input.userId, row.id, tx),
          locked,
          input.version,
        )
      )
        throw new NoLongerAllowed("agent_update_unavailable");
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
    if (error instanceof NoLongerAllowed) return refused(error.reason);
    if (error instanceof BatchMoved) return refused("agent_update_in_progress");
    // Another start won the race for this node (`node_agent_update_one_active`).
    if (isUniqueViolation(error)) return refused("agent_update_in_progress");
    throw error;
  }
  // The claim is committed (the node's first report finds its row); the send takes the authority
  // lock again and checks everything on what it reads there, the frame going out in that turn.
  const lost = await sendUnderAuthority(
    port,
    {
      userId: input.userId,
      nodeId: row.id,
      generation: live.connectionGeneration,
      claim: { updateId: update.id, kind: "first" },
    },
    frameFor(update, eligibility.artifact),
    // Not sent: nothing reached the node, so the claim goes, under the same lock.
    async (tx) => {
      await tx.nodeAgentUpdate.deleteMany({
        where: { id: update.id, userId: input.userId, phase: "REQUESTED" },
      });
      if (batch)
        await tx.nodeAgentUpdateBatch.updateMany({
          where: { id: batch.id, userId: input.userId, currentUpdateId: update.id },
          data: { currentUpdateId: null, currentNodeId: null },
        });
    },
  );
  if (lost !== null) return refused(lost);
  publishNodeEvent({ type: "node.agentUpdate", userId: input.userId, nodeId: row.id });
  return { kind: "started", updateId: update.id, connectionGeneration: live.connectionGeneration };
}

class BatchMoved extends Error {}

// ── The update-authority lock ──

/** What {@link lockAgentUpdateAuthority} reads under the lock. */
type AgentUpdateAuthority = {
  agentUpdatePolicy: "ALLOWED" | "OFF";
  trust: "FULL" | "RELAY" | null;
  trustLowerRequestedAt: Date | null;
  features: unknown;
  /** The node's connection as stored: a hello commits a new generation before this process
   * installs its session, so the row, not the session map, says which connection is current. */
  connection: "ONLINE" | "OFFLINE";
  connectionGeneration: number;
  /** The build that connection reported (what an Install-anyway approval is bound to). */
  cliVersion: string | null;
  cliBuild: unknown;
};

type RawTx = Pick<typeof prisma, "$queryRaw">;

/**
 * The node's update-authority lock: its row, `FOR UPDATE`, and the columns that decide whether
 * the owner may update it. Every writer that can take that permission away writes this row (so
 * it waits here, or this waits for it): the browser policy (`setPolicy`, through this helper),
 * a trust lowering (`nodes.lowerTrust`), the node's own trust and features as the server records
 * them (`node.state`, hello), the disconnect, the node's deletion. Every effect of an update takes
 * it and decides on what it reads here, right before the effect: the claim, the send of a first
 * or forced `agent.update` (Install anyway and "Update all" steps included), and the STOP of a
 * forced update's instances. Null when the owner has no such node (any more).
 *
 * It also reads the node's connection as stored (ONLINE, and its generation): a hello commits
 * the next generation here before the session map installs the new socket, so an effect that
 * locks after that commit sees the new generation and refuses the old socket.
 *
 * Lock order: after the transaction's fences (owner, then capacity, in a graph write), before the
 * node's update row ({@link lockClaimedUpdate}), then batch, operation and instance rows. Never
 * held across a network wait: a send is synchronous.
 */
export async function lockAgentUpdateAuthority(
  tx: RawTx,
  userId: string,
  nodeId: string,
): Promise<AgentUpdateAuthority | null> {
  const [node] = await tx.$queryRaw<
    AgentUpdateAuthority[]
  >`SELECT "agentUpdatePolicy", trust, "trustLowerRequestedAt", features, connection, "connectionGeneration", "cliVersion", "cliBuild" FROM node WHERE id = ${nodeId} AND "userId" = ${userId} FOR UPDATE`;
  return node ?? null;
}

/**
 * Whether the owner may still update the node, from what {@link lockAgentUpdateAuthority} read
 * and the live session read now (in the same turn as the effect): null when allowed. The stored
 * connection first: ONLINE, on `generation` (the session the effect targets), so a successor
 * hello that committed while the session map still holds the old socket refuses it. Then the live
 * gates ({@link liveAgentUpdateGate}, the session on that same generation), then the features as
 * stored: a node that turned remote updates off writes that here before the session's copy
 * changes, so an effect in between still sees it.
 */
function agentUpdateAuthorityRefusal(
  locked: AgentUpdateAuthority | null,
  userId: string,
  live: AgentUpdateLiveNode | null,
  generation: number,
): RefusalReason | null {
  if (!locked) return "trust_relay";
  if (locked.connection !== "ONLINE" || locked.connectionGeneration !== generation)
    return "node_offline";
  const gate = liveAgentUpdateGate({ ...locked, userId }, live, generation);
  if (gate !== null) return gate;
  const stored = storedSelfUpdate(locked.features);
  if (!stored) return "upgrade_wsmp";
  if (stored.remote === "off") return "agent_update_opted_out";
  return null;
}

/** The node's policy, trust or live gates, read under the authority lock, no longer allow it. */
class NoLongerAllowed extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
  }
}

/**
 * Inside the transaction that claims an update (creates its row, or marks a waiting one
 * forced): takes the authority lock ({@link lockAgentUpdateAuthority}) and refuses (rolls the
 * claim back) unless {@link agentUpdateAuthorityRefusal} allows it on the session as it is now,
 * still the connection the caller checked. The checks before the transaction are a snapshot.
 */
async function lockClaimGates(
  tx: RawTx,
  port: AgentUpdatePort,
  userId: string,
  nodeId: string,
  generation: number,
): Promise<AgentUpdateAuthority> {
  const locked = await lockAgentUpdateAuthority(tx, userId, nodeId);
  const lost = agentUpdateAuthorityRefusal(locked, userId, port.liveNode(nodeId), generation);
  if (lost !== null || !locked) throw new NoLongerAllowed(lost ?? "trust_relay");
  return locked;
}

/** The build identity the locked row names (what {@link sameWsmp} compares). */
function lockedWsmp(locked: AgentUpdateAuthority) {
  return {
    cliVersion: locked.cliVersion,
    commit: parseBuild(locked.cliBuild)?.commit ?? null,
    connectionGeneration: locked.connectionGeneration,
  };
}

/**
 * Under the authority lock: the node's latest update still proves `version` for Install anyway
 * (refused `version_mismatch` by Homebrew, offering exactly that version) to the wsmp and
 * connection the locked row names now.
 */
function installAnywayStillProved(
  latest: AgentUpdateLatest,
  locked: AgentUpdateAuthority,
  version: string,
): boolean {
  return (
    latest?.phase === "refused" &&
    latest.reason === "version_mismatch" &&
    latest.strategy === "homebrew" &&
    latest.availableVersion === version &&
    sameWsmp(latest, lockedWsmp(locked))
  );
}

/** What {@link lockClaimedUpdate} reads under the update row's lock. */
type ClaimedUpdate = { phase: DbPhase; endedAt: Date | null; force: boolean };

/**
 * The claimed update's row, `FOR UPDATE`, after the node's authority lock (that order everywhere:
 * node row, then update row, then batch, operation and instance rows). The update's own
 * lifecycle writers serialize on this same row lock: the deadline sweep and the node's progress
 * each change it with one conditional `UPDATE` (which takes the row's lock and, waiting, re-reads
 * its condition on what committed). So an expiry or a final report that committed first is seen
 * here, and one that comes later waits until the frame is out. Null when the row is gone.
 */
async function lockClaimedUpdate(
  tx: RawTx,
  update: { userId: string; nodeId: string; updateId: string },
): Promise<ClaimedUpdate | null> {
  const [row] = await tx.$queryRaw<
    ClaimedUpdate[]
  >`SELECT phase, "endedAt", force FROM node_agent_update WHERE id = ${update.updateId} AND "userId" = ${update.userId} AND "nodeId" = ${update.nodeId} FOR UPDATE`;
  return row ?? null;
}

/**
 * The send a claim permits: a first send while its row is still `REQUESTED`; a forced resend
 * while it still waits for idle with the force mark its claim set. Ended (timed out, refused,
 * failed) or moved on (the node left the wait): the claim no longer owns a send.
 */
type ClaimedSend = { updateId: string; kind: "first" | "forced_resend" };

function claimPermitsSend(row: ClaimedUpdate | null, send: ClaimedSend): boolean {
  if (!row || row.endedAt !== null) return false;
  return send.kind === "first"
    ? row.phase === "REQUESTED"
    : row.phase === "WAITING_IDLE" && row.force;
}

/**
 * Sends a claimed `agent.update` under the authority lock: in a transaction of its own (the
 * claim is committed, so the node's first report finds its row), takes the node's lock and then
 * the claimed update's ({@link lockClaimedUpdate}), decides on what it reads there and on the
 * live session, and sends in that same turn (no await in between: nothing in this process, and
 * no writer of either row, can land between the check and the send). A writer that commits first
 * refuses it (`undo` then runs under the same locks); one that comes later waits until the frame
 * is out. Null when sent, or the reason it was not.
 */
async function sendUnderAuthority(
  port: AgentUpdatePort,
  target: { userId: string; nodeId: string; generation: number; claim: ClaimedSend },
  frame: AgentUpdateFrame,
  undo: (tx: Pick<typeof prisma, "nodeAgentUpdate" | "nodeAgentUpdateBatch">) => Promise<void>,
): Promise<RefusalReason | null> {
  let sent = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await lockAgentUpdateAuthority(tx, target.userId, target.nodeId);
      const claimed = await lockClaimedUpdate(tx, {
        userId: target.userId,
        nodeId: target.nodeId,
        updateId: target.claim.updateId,
      });
      const lost =
        agentUpdateAuthorityRefusal(
          locked,
          target.userId,
          port.liveNode(target.nodeId),
          target.generation,
        ) ?? (claimPermitsSend(claimed, target.claim) ? null : "agent_update_in_progress");
      sent =
        lost === null &&
        port.send(target.nodeId, frame, {
          connectionGeneration: target.generation,
          userId: target.userId,
        });
      if (sent) return null;
      await undo(tx);
      // Gone, lowered or opted out between the check and the socket: nothing reached the node.
      return lost ?? "node_offline";
    });
  } catch (error) {
    // The frame is out (only the lock's commit failed, and it wrote nothing): the update runs.
    if (sent) return null;
    // Nothing was sent: the claim goes (if that fails too, its deadline ends it), then the error.
    await prisma.$transaction(async (tx) => undo(tx)).catch(() => undefined);
    throw error;
  }
}

async function forceWaitingUpdate(
  port: AgentUpdatePort,
  input: { userId: string; nodeId: string; now: Date },
  row: AgentUpdateNodeRow,
  active: NonNullable<Awaited<ReturnType<typeof activeUpdate>>>,
  live: AgentUpdateLiveNode | null,
  refused: (reason: RefusalReason) => StartOutcome,
): Promise<StartOutcome> {
  const blocked = liveAgentUpdateGate(row, live);
  if (blocked !== null || !live) return refused(blocked ?? "node_offline");
  const release = await port.release();
  const build = parseBuild(row.cliBuild);
  const artifact =
    release.kind === "release" && build ? (release.artifacts[build.target] ?? null) : null;
  // The archive the waiting update was sent, or nothing to resend: a rebuild of the release
  // since (a redeploy, the same version) is not what the owner asked for. A row stored before
  // the checksum was kept is never resent; it keeps waiting until the node goes idle or gives up.
  if (!artifact || !active.artifactSha256 || artifact.sha256 !== active.artifactSha256)
    return refused("agent_update_unavailable");
  // Its version: the server's release, or the tap's version the owner chose to install anyway.
  // That was granted to the wsmp that offered it; resend it only while that wsmp still runs.
  const anyway =
    active.strategy === "homebrew" &&
    sameWsmp(active, {
      cliVersion: row.cliVersion,
      commit: build?.commit ?? null,
      connectionGeneration: live.connectionGeneration,
    });
  if (release.version !== active.toVersion && !anyway) return refused("agent_update_unavailable");
  let marked: { count: number };
  try {
    marked = await prisma.$transaction(async (tx) => {
      const locked = await lockClaimGates(
        tx,
        port,
        input.userId,
        row.id,
        live.connectionGeneration,
      );
      // The tap's version installed anyway: granted to the wsmp that offered it, which the
      // locked row must still name.
      if (release.version !== active.toVersion && !sameWsmp(active, lockedWsmp(locked)))
        throw new NoLongerAllowed("agent_update_unavailable");
      return tx.nodeAgentUpdate.updateMany({
        where: { id: active.id, userId: input.userId, nodeId: row.id, phase: "WAITING_IDLE" },
        data: { force: true },
      });
    });
  } catch (error) {
    if (error instanceof NoLongerAllowed) return refused(error.reason);
    throw error;
  }
  if (marked.count !== 1) return refused("agent_update_in_progress");
  // As a first start: the send under the authority lock; not sent, the force mark goes.
  const lost = await sendUnderAuthority(
    port,
    {
      userId: input.userId,
      nodeId: row.id,
      generation: live.connectionGeneration,
      claim: { updateId: active.id, kind: "forced_resend" },
    },
    frameFor({ ...active, force: true }, artifact),
    async (tx) => {
      await tx.nodeAgentUpdate.updateMany({
        where: { id: active.id, userId: input.userId, phase: "WAITING_IDLE", force: true },
        data: { force: active.force },
      });
    },
  );
  if (lost !== null) return refused(lost);
  publishNodeEvent({ type: "node.agentUpdate", userId: input.userId, nodeId: row.id });
  return { kind: "started", updateId: active.id, connectionGeneration: live.connectionGeneration };
}

/**
 * Whether the STOP of a forced update's instances may be recorded, decided in the STOP's own
 * transaction (`tx`, after its owner and capacity fences): the authority lock
 * ({@link lockAgentUpdateAuthority}) and {@link agentUpdateAuthorityRefusal} on the live session
 * and the stored connection, still the connection the forced frame went out on, and that update,
 * under its row lock ({@link lockClaimedUpdate}), still running and forced (a node that refused
 * it, or ended it, gets no STOP). The stop asks again after its last write, before it commits: a
 * change of the live session meanwhile rolls it back.
 *
 * The STOP's authorization point is its commit. A committed STOP is always dispatched, after the
 * commit, and is not checked again or called back then (as a sent `agent.update` is not): a
 * revocation that commits after it is ordered after the effect.
 */
export async function agentUpdateStopAllowed(
  tx: RawTx,
  port: AgentUpdatePort,
  update: { userId: string; nodeId: string; updateId: string; connectionGeneration: number },
): Promise<boolean> {
  const locked = await lockAgentUpdateAuthority(tx, update.userId, update.nodeId);
  if (
    !locked ||
    agentUpdateAuthorityRefusal(
      locked,
      update.userId,
      port.liveNode(update.nodeId),
      update.connectionGeneration,
    ) !== null
  )
    return false;
  const claimed = await lockClaimedUpdate(tx, update);
  const running = claimed !== null && claimed.endedAt === null && claimed.force;
  // The live session again, after the read (an await): the decision is this turn's.
  return (
    running &&
    liveAgentUpdateGate(
      { ...locked, userId: update.userId },
      port.liveNode(update.nodeId),
      update.connectionGeneration,
    ) === null
  );
}

// ── Progress from the node ──

/**
 * Applies one `agent.update.progress` from the node's session. A frame about an update that is
 * not this node's (an unknown or foreign updateId) changes nothing. Returns whether the update
 * ended with this report.
 */
export async function applyAgentUpdateProgress(
  /** `connectionGeneration`: the session the report arrived on (an offer is bound to it). */
  node: { nodeId: string; userId: string; connectionGeneration?: number },
  frame: {
    updateId: string;
    phase: AgentUpdateNodePhase;
    reason?: AgentUpdateReason;
    detail?: string;
    availableVersion?: string;
  },
  now: Date = new Date(),
): Promise<{ applied: boolean; ended: boolean; settled: boolean }> {
  const ended = AGENT_UPDATE_TERMINAL_PHASES.has(frame.phase);
  // A report that loses the conditional write to another report of the same update (frames
  // handled concurrently: `verifying`, then at once `refused`) reads the row again and tries
  // again, so the later report is never dropped. The deadline sweep can win too: then the
  // re-read decides whether the report still applies.
  // The conditional write takes the update row's lock, the one a send holds while it decides
  // ({@link lockClaimedUpdate}): it waits for that send, then applies to what committed.
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
        // What the node's Homebrew tap has instead: the owner may install it anyway.
        ...(frame.availableVersion !== undefined &&
        frame.phase === "refused" &&
        frame.reason === "version_mismatch"
          ? {
              availableVersion: frame.availableVersion,
              availableGeneration: node.connectionGeneration ?? null,
            }
          : {}),
        deadlineAt: agentUpdateDeadline(frame.phase, row.rollbackAfterSecs, now),
        endedAt: ended ? now : null,
      },
    });
    if (written.count === 1) {
      publishNodeEvent({ type: "node.agentUpdate", userId: node.userId, nodeId: node.nodeId });
      return { applied: true, ended, settled: ended };
    }
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
    select: { id: true, phase: true, userId: true, nodeId: true },
    take: 200,
  });
  let ended = 0;
  for (const update of due) {
    // One conditional write per row: it takes the row's lock, the one a send holds while it
    // decides ({@link lockClaimedUpdate}). Committed first, the send sees the row ended and does
    // not go out; otherwise it waits and times out an update that was sent.
    const written = await prisma.nodeAgentUpdate.updateMany({
      where: { id: update.id, phase: update.phase, endedAt: null, deadlineAt: { lte: now } },
      data: {
        phase: "TIMED_OUT",
        reason: phaseFromDb(update.phase),
        deadlineAt: null,
        endedAt: now,
      },
    });
    if (written.count === 1)
      publishNodeEvent({ type: "node.agentUpdate", userId: update.userId, nodeId: update.nodeId });
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
