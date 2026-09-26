import { randomBytes } from "node:crypto";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  type McpCommandModeDb,
  mcpCommandModeFromDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { activeMcpPersonalTokenWhere } from "@ws-model-proxy/api/lib/mcp-token-active";
import type {
  PendingSupervisedRequest,
  SubmitSupervisedOutputResult,
  SupervisedCommandStatus,
  SupervisedOutputMode,
} from "@ws-model-proxy/api/lib/supervised-command-types";
import { cleanText } from "@ws-model-proxy/config/cli-command-output";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { relayProtocolAtLeast } from "./protocol.js";
import {
  relaySessionManager,
  type SupervisedTerminalGoneCause,
  type SupervisedTerminalListing,
  type TrackedCliCommand,
  type TrackedSupervisedCommand,
} from "./session-manager.js";
import { characterCount, isWellFormedText, truncateCharacters } from "./wire-text.js";

type CliOwnerState = {
  banned: boolean | null;
  banExpires: Date | null;
  deletionRequestedAt: Date | null;
};

/**
 * The owner's account state, read inside the admission (same `Promise.all`
 * as the device and token reads) so the verdict needs no await after
 * `admitted()`. See `Admission` for why a mark committed after this read is
 * still covered.
 */
function readCliOwner(userId: string): Promise<CliOwnerState | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { banned: true, banExpires: true, deletionRequestedAt: true },
  });
}

/** Synchronous owner verdict: missing, banned (with expiry) or deleting refuses. */
function ownerAllowsCliEffects(owner: CliOwnerState | null): boolean {
  return owner !== null && !userCredentialAccessBlocked(owner, new Date());
}

const HEAD_MAX_BYTES = 8192;
const TAIL_MAX_BYTES = 40960;
const FINISHED_TTL_MS = 15 * 60 * 1000;
const SERVER_COMMAND_DEADLINE_MS = 11 * 60 * 1000;
const SERVER_COMMAND_GRACE_MS = 15 * 1000;
const COMMANDS_PER_CLI = 2;
const COMMANDS_PER_USER = 8;
const COMMAND_MAX_BYTES = 4096;
/** A supervised request waits this long for Enter on the confirm screen. */
export const SUPERVISED_CONFIRM_TTL_MS = 15 * 60 * 1000;
/** Held output waits this long for review; then it is redacted. */
export const SUPERVISED_REVIEW_TTL_MS = 15 * 60 * 1000;
/**
 * After the server asks the CLI to stop a waiting request (confirm deadline,
 * browser decline), the CLI's answer decides the outcome. Without an answer
 * in this time the terminal is ended outright.
 */
export const SUPERVISED_STOP_GRACE_MS = 60 * 1000;
/** Supervised requests waiting for Enter, per CLI. */
const SUPERVISED_AWAITING_PER_CLI = 1;
/**
 * Supervised PTYs per CLI (waiting plus running). An Enter cannot be refused,
 * so "1 waiting + 1 running" is enforced at spawn as this total.
 */
const SUPERVISED_LIVE_PER_CLI = 2;
/** Supervised requests waiting for Enter, per user. */
const SUPERVISED_AWAITING_PER_USER = 2;
const SUPERVISED_REASON_MAX_CHARS = 500;
const SUPERVISED_REQUESTER_MAX_CHARS = 100;

export type CliCommandRejection =
  | "not_found"
  | "grant_disabled"
  | "offline"
  | "feature_disabled"
  | "supervised_only"
  | "unsupported"
  | "limit"
  | "invalid_command"
  | "invalid_reason"
  | "token_inactive";

export type BoundedBytes = {
  head: Uint8Array;
  tail: Uint8Array;
  totalBytes: number;
};

export type CliCommandSnapshot = {
  commandId: string;
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  status: "running" | "exited" | "cancelled" | "rejected";
  stdout: BoundedBytes;
  stderr: BoundedBytes;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  rejectionReason: string | null;
};

type MutableBounded = {
  head: Uint8Array;
  tail: Uint8Array;
  totalBytes: number;
};

type CommandRecord = TrackedCliCommand & {
  userId: string;
  tokenId: string;
  stdout: MutableBounded;
  stderr: MutableBounded;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
  rejectionReason: string | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  waiters: Set<(snapshot: CliCommandSnapshot) => void>;
};

const commandsById = new Map<string, CommandRecord>();

function emptyBounded(): MutableBounded {
  return { head: new Uint8Array(), tail: new Uint8Array(), totalBytes: 0 };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function rollingAppend(existing: Uint8Array, chunk: Uint8Array, max: number): Uint8Array {
  if (chunk.byteLength >= max) return chunk.subarray(chunk.byteLength - max).slice();
  const combined = existing.byteLength + chunk.byteLength;
  if (combined <= max) return concatBytes(existing, chunk);
  const keep = max - chunk.byteLength;
  return concatBytes(existing.subarray(existing.byteLength - keep), chunk);
}

function appendBounded(state: MutableBounded, chunk: Uint8Array) {
  if (chunk.byteLength === 0) return;
  const copy = chunk.slice();
  if (state.head.byteLength < HEAD_MAX_BYTES) {
    const room = HEAD_MAX_BYTES - state.head.byteLength;
    const take = Math.min(room, copy.byteLength);
    state.head = concatBytes(state.head, copy.subarray(0, take));
  }
  state.tail = rollingAppend(state.tail, copy, TAIL_MAX_BYTES);
  state.totalBytes += copy.byteLength;
}

function viewBounded(state: MutableBounded): BoundedBytes {
  return {
    head: state.head.slice(),
    tail: state.totalBytes > HEAD_MAX_BYTES ? state.tail.slice() : new Uint8Array(),
    totalBytes: state.totalBytes,
  };
}

function snapshotOf(record: CommandRecord): CliCommandSnapshot {
  return {
    commandId: record.commandId,
    userId: record.userId,
    tokenId: record.tokenId,
    cliDeviceId: record.cliDeviceId,
    status: record.status,
    stdout: viewBounded(record.stdout),
    stderr: viewBounded(record.stderr),
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    expiresAt: record.expiresAt,
    rejectionReason: record.rejectionReason,
  };
}

function notify(record: CommandRecord) {
  const snapshot = snapshotOf(record);
  for (const waiter of record.waiters) waiter(snapshot);
  record.waiters.clear();
}

function clearCommandTimers(record: CommandRecord) {
  if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
  if (record.graceTimer) clearTimeout(record.graceTimer);
  record.deadlineTimer = null;
  record.graceTimer = null;
}

function armServerDeadline(record: CommandRecord) {
  const timer = setTimeout(() => {
    if (record.status !== "running") return;
    relaySessionManager.dispatchExecCancel(record.cliDeviceId, record.commandId);
    const grace = setTimeout(() => {
      if (record.status !== "running") return;
      finish(record, "cancelled", {});
    }, SERVER_COMMAND_GRACE_MS);
    grace.unref?.();
    record.graceTimer = grace;
  }, SERVER_COMMAND_DEADLINE_MS);
  timer.unref?.();
  record.deadlineTimer = timer;
}

function finish(
  record: CommandRecord,
  status: "exited" | "cancelled" | "rejected",
  fields: { exitCode?: number; signal?: string; timedOut?: boolean },
) {
  if (record.status !== "running") return;
  clearCommandTimers(record);
  record.status = status;
  record.finishedAt = Date.now();
  if (fields.exitCode !== undefined) record.exitCode = fields.exitCode;
  if (fields.signal !== undefined) record.signal = fields.signal;
  if (fields.timedOut !== undefined) record.timedOut = fields.timedOut;
  relaySessionManager.forgetCommand(record.cliDeviceId, record.commandId);
  notify(record);
}

function runningCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
  let user = 0;
  let cli = 0;
  for (const command of commandsById.values()) {
    if (command.status !== "running" || command.userId !== userId) continue;
    user += 1;
    if (command.cliDeviceId === cliDeviceId) cli += 1;
  }
  return { user, cli };
}

function commandBytes(command: string): number {
  return new TextEncoder().encode(command).byteLength;
}

/**
 * Command and cwd as the CLI accepts them: well-formed Unicode (the relay
 * cannot carry an unpaired surrogate), 1..=4096 UTF-8 bytes, no NUL.
 */
function validCommandInput(command: string, cwd: string | undefined): boolean {
  if (!isWellFormedText(command) || command.includes("\0")) return false;
  const bytes = commandBytes(command);
  if (bytes < 1 || bytes > COMMAND_MAX_BYTES) return false;
  if (cwd === undefined) return true;
  return (
    cwd.length > 0 &&
    isWellFormedText(cwd) &&
    !cwd.includes("\0") &&
    commandBytes(cwd) <= COMMAND_MAX_BYTES
  );
}

/**
 * One start request between its first await and the moment its record is
 * registered (or it is refused). `cancelCommandsForToken` only sees records
 * that exist, so it also marks the open admissions of the token; the start
 * then refuses. Together with the live token read (issued after the
 * admission opened) this orders every revoke or narrowing against a start:
 * - committed before the read: the read sees it and the start refuses;
 * - swept while the admission is open: the mark refuses the start;
 * - swept later: the record exists by then (closing the admission,
 *   registering the record and sending the frame happen in one synchronous
 *   step) and the sweep ends it like any other.
 * The owner read (ban, ban expiry, deletion marker) is issued in the same
 * `Promise.all`, so its verdict is also taken without an await after
 * `admitted()`. A deletion mark is ordered against a start the same way:
 * - committed before the owner read: the read sees it and the start refuses;
 * - committed after it: `notifyUserDeletionMarked` runs the in-process
 *   `closeSessionsForUser`, which tears down and detaches the device socket
 *   synchronously. Before the start's synchronous step the device has no
 *   live session (the start returns `offline`); after it, the registered
 *   record is ended with the session.
 * In memory, single process: the relay sockets and the sweeps live here.
 */
type Admission = { tokenId: string; revoked: boolean };
const openAdmissions = new Set<Admission>();

function openAdmission(tokenId: string): Admission {
  const admission = { tokenId, revoked: false };
  openAdmissions.add(admission);
  return admission;
}

type LiveCliToken = { name: string; expiresAt: Date | null };

/**
 * The PAT as it is now: unrevoked (with its grant), unexpired, still minted
 * with CLI commands and mcp:write. Null when any of that no longer holds.
 */
async function liveCliToken(tokenId: string, userId: string): Promise<LiveCliToken | null> {
  const token = await prisma.mcpPersonalToken.findFirst({
    where: { id: tokenId, ...activeMcpPersonalTokenWhere(userId, new Date()) },
    select: { name: true, scopes: true, allowCliCommands: true, expiresAt: true },
  });
  if (token?.allowCliCommands !== true || !token.scopes.includes("mcp:write")) {
    return null;
  }
  return { name: token.name, expiresAt: token.expiresAt };
}

/**
 * The admission verdict, taken in the same synchronous step that registers
 * the record: the token must be live, not swept meanwhile, and unexpired now.
 */
function admitted(
  admission: Admission,
  token: LiveCliToken | null,
  admittedExpiry: Date | null,
): token is LiveCliToken {
  if (admission.revoked || token === null) return false;
  const now = Date.now();
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) return false;
  return admittedExpiry === null || admittedExpiry.getTime() > now;
}

export async function startCliCommand(input: {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  command: string;
  cwd?: string;
}): Promise<{ ok: true; commandId: string } | { ok: false; error: CliCommandRejection }> {
  const admission = openAdmission(input.tokenId);
  let device: { id: string; userId: string; mcpCommandMode: McpCommandModeDb } | null;
  let token: LiveCliToken | null;
  let owner: CliOwnerState | null;
  try {
    [device, token, owner] = await Promise.all([
      prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, mcpCommandMode: true },
      }),
      liveCliToken(input.tokenId, input.userId),
      readCliOwner(input.userId),
    ]);
  } finally {
    openAdmissions.delete(admission);
  }
  // From here to the dispatch nothing awaits (see `Admission`).
  if (!admitted(admission, token, input.expiresAt)) return { ok: false, error: "token_inactive" };
  if (!device || device.userId !== input.userId) return { ok: false, error: "not_found" };
  if (!ownerAllowsCliEffects(owner)) return { ok: false, error: "token_inactive" };
  const grant = mcpCommandModeFromDb(device.mcpCommandMode);
  if (grant === "off") return { ok: false, error: "grant_disabled" };
  // Mode `supervised`: a person must confirm each command. Headless exec is refused.
  if (!allowsHeadlessCommands(grant)) return { ok: false, error: "supervised_only" };

  const live = relaySessionManager.getLiveCliFeatures([input.cliDeviceId]).get(input.cliDeviceId);
  if (!live || !relayProtocolAtLeast(live.protocolVersion, "2.6")) {
    return { ok: false, error: "offline" };
  }
  if (live.mcpCommandMode === "off") return { ok: false, error: "feature_disabled" };
  if (!allowsHeadlessCommands(live.mcpCommandMode)) return { ok: false, error: "supervised_only" };

  const counts = runningCounts(input.userId, input.cliDeviceId);
  if (counts.cli >= COMMANDS_PER_CLI || counts.user >= COMMANDS_PER_USER) {
    return { ok: false, error: "limit" };
  }

  const cwd = input.cwd;
  if (!validCommandInput(input.command, cwd)) return { ok: false, error: "invalid_command" };

  const commandId = randomBytes(16).toString("base64url");
  const record: CommandRecord = {
    commandId,
    cliDeviceId: input.cliDeviceId,
    userId: input.userId,
    tokenId: input.tokenId,
    status: "running",
    stdout: emptyBounded(),
    stderr: emptyBounded(),
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: token.expiresAt ? token.expiresAt.getTime() : null,
    rejectionReason: null,
    deadlineTimer: null,
    graceTimer: null,
    waiters: new Set(),
    markCancelled() {},
    markStarted() {},
    markRejected() {},
    markDone() {},
    appendOutput() {},
  };
  record.markCancelled = () => finish(record, "cancelled", {});
  record.markRejected = (reason: string) => {
    record.rejectionReason = reason;
    finish(record, "rejected", {});
  };
  record.markDone = (result) => finish(record, "exited", result);
  record.markStarted = () => {
    if (record.status !== "running") return;
  };
  record.appendOutput = (stream, body) => {
    if (record.status !== "running") return;
    appendBounded(stream === "stdout" ? record.stdout : record.stderr, body);
  };

  const sent = relaySessionManager.dispatchExecStart(record, {
    command: input.command,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (!sent) {
    // The mode may have changed after the grant was read (the change's
    // post-commit sweep then found nothing to cancel): say so, not "offline".
    const refusal = relaySessionManager.commandModeRefusal(input.cliDeviceId, "headless");
    return { ok: false, error: refusal ?? "offline" };
  }
  commandsById.set(commandId, record);
  armServerDeadline(record);
  return { ok: true, commandId };
}

function commandForCaller(
  commandId: string,
  userId: string,
  tokenId: string,
): CommandRecord | null {
  const record = commandsById.get(commandId);
  if (!record || record.userId !== userId || record.tokenId !== tokenId) return null;
  return record;
}

export function snapshotCliCommand(
  commandId: string,
  userId: string,
  tokenId: string,
): CliCommandSnapshot | null {
  const record = commandForCaller(commandId, userId, tokenId);
  if (!record) return null;
  return snapshotOf(record);
}

export function waitCliCommand(
  commandId: string,
  userId: string,
  tokenId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<CliCommandSnapshot | null> {
  const record = commandForCaller(commandId, userId, tokenId);
  if (!record) return Promise.resolve(null);
  if (record.status !== "running" || waitMs <= 0) return Promise.resolve(snapshotOf(record));
  return new Promise((resolve) => {
    let settled = false;
    const finishWait = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.waiters.delete(onDone);
      signal?.removeEventListener("abort", onAbort);
      const current = commandsById.get(commandId);
      resolve(
        current && current.userId === userId && current.tokenId === tokenId
          ? snapshotOf(current)
          : null,
      );
    };
    const onDone = () => finishWait();
    const onAbort = () => finishWait();
    const timer = setTimeout(finishWait, waitMs);
    record.waiters.add(onDone);
    if (signal) {
      if (signal.aborted) {
        finishWait();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function cancelCommandsForToken(tokenId: string) {
  // Starts still between their first await and their record refuse.
  for (const admission of openAdmissions) {
    if (admission.tokenId === tokenId) admission.revoked = true;
  }
  for (const command of commandsById.values()) {
    if (command.tokenId !== tokenId || command.status !== "running") continue;
    relaySessionManager.dispatchExecCancel(command.cliDeviceId, command.commandId);
  }
  for (const record of [...supervisedById.values()]) {
    if (record.tokenId !== tokenId || !isActiveSupervised(record.status)) continue;
    endSupervisedFromServer(record, "token_revoked");
  }
}

/** Test isolation. Production callers must not drop in-flight commands. */
export function resetCliCommandsForTests(): void {
  for (const record of commandsById.values()) clearCommandTimers(record);
  commandsById.clear();
  for (const record of supervisedById.values()) clearWaitTimer(record);
  supervisedById.clear();
  openAdmissions.clear();
}

export function sweepExpiredTokenCommands(now = Date.now()): number {
  let swept = sweepSupervised(now);
  for (const command of [...commandsById.values()]) {
    if (command.status !== "running") continue;
    if (command.expiresAt === null || command.expiresAt > now) continue;
    relaySessionManager.dispatchExecCancel(command.cliDeviceId, command.commandId);
    swept += 1;
  }
  for (const [commandId, command] of [...commandsById]) {
    if (command.status === "running" || command.finishedAt === null) continue;
    if (now - command.finishedAt < FINISHED_TTL_MS) continue;
    commandsById.delete(commandId);
    relaySessionManager.forgetCommand(command.cliDeviceId, commandId);
    swept += 1;
  }
  return swept;
}

// ---------------------------------------------------------------------------
// Supervised commands: an MCP agent asks, a person confirms on the CLI-drawn
// screen in an E2E terminal, and the agent polls the outcome. In memory only,
// like exec: a server restart or CLI reconnect ends them (`cancelled`).
// ---------------------------------------------------------------------------

type SupervisedRecord = {
  commandId: string;
  terminalId: string;
  cliDeviceId: string;
  userId: string;
  tokenId: string;
  command: string;
  cwd: string | null;
  reason: string | null;
  requester: string;
  shareOutput: boolean;
  status: SupervisedCommandStatus;
  createdAt: number;
  spawnedAt: number | null;
  acceptedAt: number | null;
  finishedAt: number | null;
  /** The MCP token's own expiry. */
  tokenExpiresAt: number | null;
  /** Deadline of the current wait (confirm or review). */
  waitDeadline: number | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
  /** Shared output as the CLI sent it (only when shared and not reviewed). */
  head: Uint8Array | null;
  tail: Uint8Array | null;
  outputBytes: number;
  /** The text a person submitted after review. */
  reviewedText: string | null;
  outputMode: SupervisedOutputMode | null;
  edited: boolean;
  exitCode: number | null;
  signal: string | null;
  rejectionReason: string | null;
  /**
   * The server asked the CLI to stop the waiting request (`expire` at the
   * confirm deadline, `decline` from the browser). The CLI decides: it
   * declines a request still waiting, and an Enter it already took wins.
   */
  stopRequested: "expire" | "decline" | null;
  /**
   * The CLI's last word on this command arrived (its terminal exit, decline
   * or rejection), so `acceptedAt === null` means the command never started.
   */
  cliSettled: boolean;
};

export type SupervisedCommandSnapshot = {
  kind: "supervised";
  commandId: string;
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  status: SupervisedCommandStatus;
  exitCode: number | null;
  signal: string | null;
  rejectionReason: string | null;
  /** Deadline of the current wait (confirm or review), epoch ms. */
  waitDeadline: number | null;
  /**
   * Whether the command started (a person pressed Enter and the CLI let it
   * run). `null` while that is not known yet, or for good when the CLI
   * disconnected before saying.
   */
  started: boolean | null;
  /** Set once the command exited. */
  output: { mode: SupervisedOutputMode; edited: boolean } | null;
  /** Mode `shared`: the bounded capture. */
  shared: BoundedBytes | null;
  /** Mode `reviewed`: the submitted text. */
  reviewedText: string | null;
};

const supervisedById = new Map<string, SupervisedRecord>();

function isActiveSupervised(status: SupervisedCommandStatus): boolean {
  return status === "awaiting_user" || status === "running" || status === "awaiting_output_review";
}

function clearWaitTimer(record: SupervisedRecord) {
  if (record.waitTimer) clearTimeout(record.waitTimer);
  record.waitTimer = null;
  record.waitDeadline = null;
}

function armWait(record: SupervisedRecord, ttlMs: number, onExpire: () => void) {
  clearWaitTimer(record);
  record.waitDeadline = Date.now() + ttlMs;
  const timer = setTimeout(onExpire, ttlMs);
  timer.unref?.();
  record.waitTimer = timer;
}

function finishSupervised(
  record: SupervisedRecord,
  status: Exclude<SupervisedCommandStatus, "awaiting_user" | "running" | "awaiting_output_review">,
  fields: { rejectionReason?: string } = {},
) {
  if (!isActiveSupervised(record.status)) return;
  clearWaitTimer(record);
  record.status = status;
  record.finishedAt = Date.now();
  if (fields.rejectionReason !== undefined) record.rejectionReason = fields.rejectionReason;
  relaySessionManager.notifyTerminalListChanged(record.userId);
}

/** Exited with this output decision. Unreviewed bytes never outlive it. */
function exitSupervised(
  record: SupervisedRecord,
  mode: SupervisedOutputMode,
  fields: { reviewedText?: string | null; edited?: boolean } = {},
) {
  if (!isActiveSupervised(record.status)) return;
  if (mode !== "shared") {
    record.head = null;
    record.tail = null;
    record.outputBytes = 0;
  }
  record.outputMode = mode;
  record.reviewedText = mode === "reviewed" ? (fields.reviewedText ?? "") : null;
  record.edited = mode === "reviewed" && fields.edited === true;
  finishSupervised(record, "exited");
}

/**
 * The server ends a request: its terminal is closed on the CLI and the record
 * is settled first, so the terminal-gone hook that follows is a no-op.
 */
function endSupervisedFromServer(
  record: SupervisedRecord,
  reason: "token_revoked" | "token_expired" | "stop_unanswered",
) {
  if (record.status === "awaiting_output_review") {
    // The command already ran; nobody released its output.
    exitSupervised(record, "redacted");
  } else {
    finishSupervised(record, "cancelled", { rejectionReason: reason });
  }
  relaySessionManager.cancelSupervised(record.cliDeviceId, record.commandId, "closed");
}

/**
 * Ask the CLI to stop a request that still waits for Enter. The CLI owns the
 * decision: a request still waiting there is declined and never starts
 * (`supervised.declined` → `expired` or `declined`); if its Enter was taken
 * first, the `supervised.accepted` already on its way makes it `running`, and
 * the command runs out its normal lifetime.
 */
function requestSupervisedStop(record: SupervisedRecord, why: "expire" | "decline"): boolean {
  if (record.status !== "awaiting_user") return false;
  if (record.stopRequested !== null) return true;
  if (!relaySessionManager.requestSupervisedStop(record.cliDeviceId, record.commandId, why)) {
    return false;
  }
  record.stopRequested = why;
  // Unanswered, the request ends when the grace runs out: listings and the
  // agent's result say so rather than the (possibly later) confirm deadline.
  const stopDeadline = Date.now() + SUPERVISED_STOP_GRACE_MS;
  record.waitDeadline = Math.min(record.waitDeadline ?? stopDeadline, stopDeadline);
  if (record.waitTimer) clearTimeout(record.waitTimer);
  const timer = setTimeout(() => {
    if (record.status !== "awaiting_user") return;
    endSupervisedFromServer(record, "stop_unanswered");
  }, SUPERVISED_STOP_GRACE_MS);
  timer.unref?.();
  record.waitTimer = timer;
  relaySessionManager.notifyTerminalListChanged(record.userId);
  return true;
}

function startedOf(record: SupervisedRecord): boolean | null {
  if (record.acceptedAt !== null || record.status === "exited") return true;
  if (
    record.status === "declined" ||
    record.status === "expired" ||
    record.status === "rejected" ||
    record.cliSettled
  ) {
    return false;
  }
  return null;
}

function listingOf(record: SupervisedRecord): SupervisedTerminalListing {
  return {
    commandId: record.commandId,
    status: record.status,
    requester: record.requester,
    reason: record.reason,
    command: record.command,
    cwd: record.cwd,
    shareOutput: record.shareOutput,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: record.waitDeadline === null ? null : new Date(record.waitDeadline).toISOString(),
    exitCode: record.exitCode,
    signal: record.signal,
  };
}

function goneReason(cause: SupervisedTerminalGoneCause): string {
  if (cause === "disconnected") return "cli_disconnected";
  if (cause === "policy") return "policy_disabled";
  if (cause === "user") return "closed_by_user";
  if (cause === "closed") return "closed";
  return "terminal_closed";
}

function trackerFor(record: SupervisedRecord): TrackedSupervisedCommand {
  return {
    commandId: record.commandId,
    terminalId: record.terminalId,
    cliDeviceId: record.cliDeviceId,
    userId: record.userId,
    listing: () => listingOf(record),
    onSpawned() {
      if (record.status !== "awaiting_user" || record.spawnedAt !== null) return;
      record.spawnedAt = Date.now();
    },
    onRejected(reason) {
      if (record.status !== "awaiting_user") return;
      finishSupervised(record, "rejected", { rejectionReason: reason.slice(0, 64) });
    },
    onAccepted() {
      // The CLI took an Enter: that is authoritative, also over a stop the
      // server asked for meanwhile.
      if (record.status !== "awaiting_user") return;
      clearWaitTimer(record);
      record.status = "running";
      record.acceptedAt = Date.now();
    },
    onDeclined() {
      if (record.status !== "awaiting_user") return;
      record.cliSettled = true;
      finishSupervised(record, record.stopRequested === "expire" ? "expired" : "declined");
    },
    requestDecline() {
      // A Decline never ends a command that started: Enter first wins.
      if (record.status === "running" || record.status === "awaiting_output_review") {
        return "started";
      }
      if (record.status !== "awaiting_user") return "ended";
      return requestSupervisedStop(record, "decline") ? "requested" : "unavailable";
    },
    onLateReport(report) {
      // Reports for a request the server already ended (token revoked,
      // policy, End session, disconnect of the terminal): they only say
      // whether the command had started. No output is taken from them.
      if (isActiveSupervised(record.status)) return;
      if (report === "accepted") {
        if (record.acceptedAt === null) record.acceptedAt = Date.now();
      } else {
        record.cliSettled = true;
      }
    },
    onOutput(part, body) {
      // Output is accepted only for a shared request whose command is still
      // running (the CLI sends it right before `supervised.done`), once per part.
      if (!record.shareOutput || record.status !== "running") return;
      if (part === "head") {
        if (record.head !== null) return;
        record.head = body.slice(0, HEAD_MAX_BYTES);
      } else {
        if (record.tail !== null) return;
        record.tail = body.slice(Math.max(0, body.byteLength - TAIL_MAX_BYTES));
      }
    },
    onDone(result) {
      if (record.status !== "running") return;
      if (result.exitCode !== undefined) record.exitCode = result.exitCode;
      if (result.signal !== undefined) record.signal = result.signal;
      if (!record.shareOutput) {
        exitSupervised(record, "private");
        return;
      }
      if (result.review) {
        // Held for review in the browser: nothing the CLI may have sent is kept.
        record.head = null;
        record.tail = null;
        record.outputBytes = 0;
        record.status = "awaiting_output_review";
        armWait(record, SUPERVISED_REVIEW_TTL_MS, () => {
          if (record.status !== "awaiting_output_review") return;
          exitSupervised(record, "redacted");
          relaySessionManager.cancelSupervised(record.cliDeviceId, record.commandId, "closed");
        });
        return;
      }
      const head = record.head ?? new Uint8Array();
      const tail = record.tail ?? new Uint8Array();
      const reported = result.outputBytes ?? head.byteLength;
      record.head = head;
      record.tail = reported > HEAD_MAX_BYTES ? tail : new Uint8Array();
      record.outputBytes = Math.max(reported, head.byteLength);
      exitSupervised(record, "shared");
    },
    onTerminalGone(cause) {
      // `exit` is the CLI's own report that the terminal ended.
      if (cause === "exit") record.cliSettled = true;
      if (record.status === "awaiting_output_review") {
        // The reviewer's terminal is gone and the capture with it.
        exitSupervised(record, "redacted");
        return;
      }
      if (record.status === "awaiting_user") {
        // Ended by the CLI without an Enter: a stop the server asked for,
        // its own confirm deadline, or the confirm child failing. A person's
        // Decline that was out when the CLI's deadline closed it is a decline.
        if (cause === "exit" && record.stopRequested === "decline") {
          finishSupervised(record, "declined");
          return;
        }
        const expired =
          cause === "exit" &&
          (record.stopRequested === "expire" ||
            (record.waitDeadline !== null && Date.now() >= record.waitDeadline));
        if (expired) finishSupervised(record, "expired");
        else finishSupervised(record, "cancelled", { rejectionReason: goneReason(cause) });
        return;
      }
      if (record.status === "running") {
        finishSupervised(record, "cancelled", { rejectionReason: goneReason(cause) });
      }
    },
  };
}

function supervisedCounts(userId: string, cliDeviceId: string) {
  let userAwaiting = 0;
  let cliAwaiting = 0;
  let cliLive = 0;
  for (const record of supervisedById.values()) {
    if (record.status === "awaiting_user" && record.userId === userId) userAwaiting += 1;
    if (record.cliDeviceId !== cliDeviceId) continue;
    if (record.status === "awaiting_user") cliAwaiting += 1;
    if (record.status === "awaiting_user" || record.status === "running") cliLive += 1;
  }
  return { userAwaiting, cliAwaiting, cliLive };
}

function newTerminalId(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const terminalId = randomBytes(16).toString("base64url");
    if (!relaySessionManager.hasTerminal(terminalId)) return terminalId;
  }
  return randomBytes(16).toString("base64url");
}

/**
 * The requesting token's name as the confirm screen shows it (escaped there
 * too): well-formed, no C0/C1 controls, at most 100 characters (code points,
 * as the CLI counts them), never empty, cut between graphemes (or between
 * code points when the first grapheme alone is too long).
 */
export function requesterLabel(tokenName: string): string {
  const cleaned = [...tokenName.toWellFormed().trim()]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("")
    .trim();
  // The fallback applies to the final form: the CLI refuses an empty
  // requester, so what is checked is what goes on the wire.
  return truncateCharacters(cleaned, SUPERVISED_REQUESTER_MAX_CHARS) || "MCP token";
}

/**
 * Create a supervised request: checks run in the exec order (grant, live CLI
 * and its mode, limits, input), then the CLI is asked to spawn the confirm
 * terminal. Nothing runs until a person presses Enter on that screen.
 */
export async function startSupervisedCommand(input: {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  command: string;
  cwd?: string;
  reason?: string;
  shareOutput: boolean;
}): Promise<
  | { ok: true; commandId: string; terminalId: string; expiresAt: string }
  | { ok: false; error: CliCommandRejection }
> {
  const admission = openAdmission(input.tokenId);
  let device: { id: string; userId: string; mcpCommandMode: McpCommandModeDb } | null;
  let token: LiveCliToken | null;
  let owner: CliOwnerState | null;
  try {
    [device, token, owner] = await Promise.all([
      prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, mcpCommandMode: true },
      }),
      liveCliToken(input.tokenId, input.userId),
      readCliOwner(input.userId),
    ]);
  } finally {
    openAdmissions.delete(admission);
  }
  // From here to the dispatch nothing awaits (see `Admission`).
  if (!admitted(admission, token, input.expiresAt)) return { ok: false, error: "token_inactive" };
  if (!device || device.userId !== input.userId) return { ok: false, error: "not_found" };
  if (!ownerAllowsCliEffects(owner)) return { ok: false, error: "token_inactive" };
  if (!allowsSupervisedCommands(mcpCommandModeFromDb(device.mcpCommandMode))) {
    return { ok: false, error: "grant_disabled" };
  }

  const live = relaySessionManager.getLiveCliFeatures([input.cliDeviceId]).get(input.cliDeviceId);
  if (!live || !relayProtocolAtLeast(live.protocolVersion, "2.6") || !live.supervisedCommands) {
    return { ok: false, error: "offline" };
  }
  if (!allowsSupervisedCommands(live.mcpCommandMode)) {
    return { ok: false, error: "feature_disabled" };
  }
  if (!live.terminalSupported) return { ok: false, error: "unsupported" };

  const counts = supervisedCounts(input.userId, input.cliDeviceId);
  if (
    counts.cliAwaiting >= SUPERVISED_AWAITING_PER_CLI ||
    counts.cliLive >= SUPERVISED_LIVE_PER_CLI ||
    counts.userAwaiting >= SUPERVISED_AWAITING_PER_USER
  ) {
    return { ok: false, error: "limit" };
  }

  const cwd = input.cwd;
  if (!validCommandInput(input.command, cwd)) return { ok: false, error: "invalid_command" };
  const reason = input.reason?.trim();
  if (
    reason !== undefined &&
    (!isWellFormedText(reason) ||
      characterCount(reason) > SUPERVISED_REASON_MAX_CHARS ||
      reason.includes("\0"))
  ) {
    return { ok: false, error: "invalid_reason" };
  }

  const requester = requesterLabel(token.name);
  const now = Date.now();
  const record: SupervisedRecord = {
    commandId: randomBytes(16).toString("base64url"),
    terminalId: newTerminalId(),
    cliDeviceId: input.cliDeviceId,
    userId: input.userId,
    tokenId: input.tokenId,
    command: input.command,
    cwd: cwd ?? null,
    reason: reason ? reason : null,
    requester,
    shareOutput: input.shareOutput,
    status: "awaiting_user",
    createdAt: now,
    spawnedAt: null,
    acceptedAt: null,
    finishedAt: null,
    tokenExpiresAt: token.expiresAt ? token.expiresAt.getTime() : null,
    waitDeadline: null,
    waitTimer: null,
    head: null,
    tail: null,
    outputBytes: 0,
    reviewedText: null,
    outputMode: null,
    edited: false,
    exitCode: null,
    signal: null,
    rejectionReason: null,
    stopRequested: null,
    cliSettled: false,
  };
  const sent = relaySessionManager.dispatchSupervisedSpawn(trackerFor(record), {
    command: record.command,
    ...(record.cwd !== null ? { cwd: record.cwd } : {}),
    ...(record.reason !== null ? { reason: record.reason } : {}),
    requester: record.requester,
    shareOutput: record.shareOutput,
  });
  if (!sent) {
    const refusal = relaySessionManager.commandModeRefusal(input.cliDeviceId, "supervised");
    return { ok: false, error: refusal ?? "offline" };
  }
  supervisedById.set(record.commandId, record);
  armWait(record, SUPERVISED_CONFIRM_TTL_MS, () => {
    if (record.status !== "awaiting_user") return;
    if (requestSupervisedStop(record, "expire")) return;
    // No live session to ask: its terminal is already gone with it.
    finishSupervised(record, "expired");
  });
  return {
    ok: true,
    commandId: record.commandId,
    terminalId: record.terminalId,
    expiresAt: new Date(record.waitDeadline ?? now + SUPERVISED_CONFIRM_TTL_MS).toISOString(),
  };
}

function supervisedSnapshotOf(record: SupervisedRecord): SupervisedCommandSnapshot {
  const exited = record.status === "exited" && record.outputMode !== null;
  return {
    kind: "supervised",
    commandId: record.commandId,
    userId: record.userId,
    tokenId: record.tokenId,
    cliDeviceId: record.cliDeviceId,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    rejectionReason: record.rejectionReason,
    waitDeadline: record.waitDeadline,
    started: startedOf(record),
    output: exited && record.outputMode ? { mode: record.outputMode, edited: record.edited } : null,
    shared:
      exited && record.outputMode === "shared"
        ? {
            head: (record.head ?? new Uint8Array()).slice(),
            tail: (record.tail ?? new Uint8Array()).slice(),
            totalBytes: record.outputBytes,
          }
        : null,
    reviewedText: exited && record.outputMode === "reviewed" ? record.reviewedText : null,
  };
}

/** The MCP caller's view: only the token that started it may read it. */
export function snapshotSupervisedCommand(
  commandId: string,
  userId: string,
  tokenId: string,
): SupervisedCommandSnapshot | null {
  const record = supervisedById.get(commandId);
  if (!record || record.userId !== userId || record.tokenId !== tokenId) return null;
  return supervisedSnapshotOf(record);
}

/** Dashboard awareness: requests a person still has to act on. */
export function listPendingSupervised(userId: string): PendingSupervisedRequest[] {
  const pending: PendingSupervisedRequest[] = [];
  for (const record of supervisedById.values()) {
    if (record.userId !== userId || !isActiveSupervised(record.status)) continue;
    // Not attachable until the CLI spawned it.
    if (record.status === "awaiting_user" && record.spawnedAt === null) continue;
    pending.push({
      commandId: record.commandId,
      terminalId: record.terminalId,
      cliDeviceId: record.cliDeviceId,
      status: record.status as PendingSupervisedRequest["status"],
      requester: record.requester,
      reason: record.reason,
      command: record.command,
      cwd: record.cwd,
      shareOutput: record.shareOutput,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: record.waitDeadline === null ? null : new Date(record.waitDeadline).toISOString(),
    });
  }
  return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * A person's review of held output. Owner-only; accepted only while the
 * record awaits review; the first submission wins. `null` redacts all.
 */
export function submitSupervisedOutput(input: {
  userId: string;
  commandId: string;
  output: string | null;
  edited: boolean;
}): SubmitSupervisedOutputResult {
  const record = supervisedById.get(input.commandId);
  if (!record || record.userId !== input.userId) return { ok: false, error: "not_found" };
  if (record.status !== "awaiting_output_review") return { ok: false, error: "conflict" };
  if (input.output === null) {
    exitSupervised(record, "redacted");
  } else {
    // Same cleanup as any shared output: no terminal sequences, no wsmp_ secrets.
    exitSupervised(record, "reviewed", {
      reviewedText: cleanText(input.output),
      edited: input.edited,
    });
  }
  // The CLI no longer needs to hold the capture.
  relaySessionManager.cancelSupervised(record.cliDeviceId, record.commandId, "closed");
  return { ok: true, outputMode: record.outputMode === "reviewed" ? "reviewed" : "redacted" };
}

function sweepSupervised(now: number): number {
  let swept = 0;
  for (const record of [...supervisedById.values()]) {
    if (!isActiveSupervised(record.status)) continue;
    if (record.tokenExpiresAt === null || record.tokenExpiresAt > now) continue;
    endSupervisedFromServer(record, "token_expired");
    swept += 1;
  }
  for (const [commandId, record] of [...supervisedById]) {
    if (isActiveSupervised(record.status) || record.finishedAt === null) continue;
    if (now - record.finishedAt < FINISHED_TTL_MS) continue;
    supervisedById.delete(commandId);
    swept += 1;
  }
  return swept;
}
