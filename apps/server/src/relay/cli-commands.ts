import { randomBytes } from "node:crypto";
import type {
  PendingSupervisedRequest,
  SubmitSupervisedOutputResult,
  SupervisedCommandStatus,
  SupervisedOutputMode,
} from "@ws-model-proxy/api/lib/supervised-command-types";
import {
  CLI_AGENT_ACTION_UNKNOWN_DEVICE,
  type CliAgentActionKind,
  type CliAgentActionOutcome,
  cliAgentSignalReason,
  cliAgentWireReason,
  commandAuditPath,
} from "@ws-model-proxy/config/cli-agent-audit";
import {
  appendRollingTail,
  cleanText,
  TerminalByteState,
} from "@ws-model-proxy/config/cli-command-output";
import {
  judgeCliAgentAdmission,
  readCliAgentAdmission,
  resetCliAgentAdmissionsForTests,
  revokeOpenCliAgentAdmissions,
  revokeOpenCliAgentAdmissionsForUser,
} from "./cli-agent-admission.js";
import { recordCliAgentAction } from "./cli-agent-audit.js";
import { commandAuditDigest } from "./command-audit-digest.js";
import {
  relaySessionManager,
  type SupervisedTerminalGoneCause,
  type SupervisedTerminalListing,
  type TrackedCliCommand,
  type TrackedSupervisedCommand,
} from "./session-manager.js";
import { characterCount, isWellFormedText, truncateCharacters } from "./wire-text.js";

// ---------------------------------------------------------------------------
// Agent audit log: one metadata-only event per terminal outcome (see
// ./cli-agent-audit.ts). Refusals are recorded by the start wrappers, started
// commands by `finish` / `finishSupervised`, each the single point their
// outcome passes through. Nothing here can fail or delay a command.
// ---------------------------------------------------------------------------

/** Input bound: a refused oversized command is still audited cheaply. */
const AUDIT_COMMAND_MAX_CHARS = 16_384;

/**
 * `path` of a command event (keyed HMAC-SHA256 of the command text plus its
 * program; see ./command-audit-digest.ts). Never throws: `commandAuditDigest`
 * degrades to `unavailable` and this guards an unexpected parse error.
 */
function auditPathOf(command: unknown): string {
  try {
    if (typeof command !== "string") return "";
    return commandAuditPath(command.slice(0, AUDIT_COMMAND_MAX_CHARS), commandAuditDigest, {
      truncated: command.length > AUDIT_COMMAND_MAX_CHARS,
    });
  } catch {
    return "";
  }
}

/** `exit:<code>`, `signal:<name>` or `timed_out` for a command that ran. */
function exitReason(fields: {
  exitCode: number | null;
  signal: string | null;
  timedOut?: boolean;
}): string {
  if (fields.timedOut === true) return "timed_out";
  if (fields.signal !== null) return cliAgentSignalReason(fields.signal);
  return fields.exitCode !== null ? `exit:${fields.exitCode}` : "exit";
}

/**
 * Refusals raised before (or without) the ownership check of the requested
 * device: its id is caller-supplied text there, so the row stores
 * {@link CLI_AGENT_ACTION_UNKNOWN_DEVICE} instead. Every other refusal comes
 * after the device was resolved to one of the caller's own (see
 * `admitCliCommand`, `admitSupervisedCommand`).
 */
const UNVERIFIED_DEVICE_REFUSALS: ReadonlySet<string> = new Set([
  "not_found",
  "token_inactive",
  "internal_error",
]);

function auditRefusal(
  kind: Extract<CliAgentActionKind, "command" | "supervised_command">,
  input: { userId: string; tokenId: string; cliDeviceId: string; command: string },
  startedAt: Date,
  outcome: Extract<CliAgentActionOutcome, "refused" | "failed">,
  reason: string,
): void {
  recordCliAgentAction({
    userId: input.userId,
    cliDeviceId: UNVERIFIED_DEVICE_REFUSALS.has(reason)
      ? CLI_AGENT_ACTION_UNKNOWN_DEVICE
      : input.cliDeviceId,
    mcpTokenId: input.tokenId,
    kind,
    path: auditPathOf(input.command),
    outcome,
    reason,
    startedAt,
    finishedAt: new Date(),
  });
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
  /** The terminal parser across the bytes dropped from the tail's front. */
  tailState: TerminalByteState;
};

type CommandRecord = TrackedCliCommand & {
  userId: string;
  tokenId: string;
  /** Audit `path` (command hash plus program), computed once at start. */
  auditPath: string;
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
  /**
   * The server ended the record (authority gone) but the CLI has not yet
   * acknowledged the `exec.cancel`, so the remote process may still exist: the
   * record keeps its per-CLI and per-user slot until the CLI's `exec.done` /
   * `exec.rejected` or {@link SERVER_COMMAND_GRACE_MS}, whichever comes first. A
   * lost session does not release it early (the CLI has killed the process, so
   * this only over-holds, by at most the grace). Nothing caller-visible depends
   * on it (see {@link endExecFromServer}).
   */
  slotHeld: boolean;
  waiters: Set<(snapshot: CliCommandSnapshot) => void>;
};

const commandsById = new Map<string, CommandRecord>();

function emptyBounded(): MutableBounded {
  return {
    head: new Uint8Array(),
    tail: new Uint8Array(),
    totalBytes: 0,
    tailState: new TerminalByteState(),
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function appendBounded(state: MutableBounded, chunk: Uint8Array) {
  if (chunk.byteLength === 0) return;
  const copy = chunk.slice();
  if (state.head.byteLength < HEAD_MAX_BYTES) {
    const room = HEAD_MAX_BYTES - state.head.byteLength;
    const take = Math.min(room, copy.byteLength);
    state.head = concatBytes(state.head, copy.subarray(0, take));
  }
  // Starts at a terminal-parser boundary, so a DCS/APC/PM/OSC body that the
  // head/tail gap cuts into is never shown as text.
  state.tail = appendRollingTail(state.tail, copy, TAIL_MAX_BYTES, state.tailState);
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
  auditHeadlessCommand(record, status);
  // A server-ended record stays routable until the CLI answers, so its late
  // `exec.done` frees the held slot (and is otherwise dropped: `finish` only
  // acts on a running record).
  if (!record.slotHeld) relaySessionManager.forgetCommand(record.cliDeviceId, record.commandId);
  notify(record);
}

/** The CLI answered (or the grace ran out): the held slot is free and the record leaves the session. */
function releaseHeldSlot(record: CommandRecord) {
  if (!record.slotHeld) return;
  record.slotHeld = false;
  if (record.graceTimer) clearTimeout(record.graceTimer);
  record.graceTimer = null;
  relaySessionManager.forgetCommand(record.cliDeviceId, record.commandId);
}

function auditHeadlessCommand(
  record: CommandRecord,
  status: "exited" | "cancelled" | "rejected",
): void {
  const outcome: CliAgentActionOutcome =
    status === "exited" ? "completed" : status === "cancelled" ? "cancelled" : "refused";
  recordCliAgentAction({
    userId: record.userId,
    cliDeviceId: record.cliDeviceId,
    mcpTokenId: record.tokenId,
    kind: "command",
    path: record.auditPath,
    outcome,
    reason:
      status === "exited"
        ? exitReason(record)
        : status === "rejected"
          ? (record.rejectionReason ?? "rejected")
          : record.timedOut
            ? "timed_out"
            : record.rejectionReason,
    startedAt: new Date(record.startedAt),
    finishedAt: new Date(record.finishedAt ?? Date.now()),
  });
}

function runningCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
  let user = 0;
  let cli = 0;
  for (const command of commandsById.values()) {
    if ((command.status !== "running" && !command.slotHeld) || command.userId !== userId) continue;
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

type StartCliCommandInput = {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  command: string;
  cwd?: string;
};

export async function startCliCommand(
  input: StartCliCommandInput,
): Promise<{ ok: true; commandId: string } | { ok: false; error: CliCommandRejection }> {
  const startedAt = new Date();
  try {
    const result = await admitCliCommand(input);
    if (!result.ok) auditRefusal("command", input, startedAt, "refused", result.error);
    return result;
  } catch (error) {
    auditRefusal("command", input, startedAt, "failed", "internal_error");
    throw error;
  }
}

async function admitCliCommand(
  input: StartCliCommandInput,
): Promise<{ ok: true; commandId: string } | { ok: false; error: CliCommandRejection }> {
  // From the verdict to the dispatch nothing awaits (see `Admission`).
  const verdict = judgeCliAgentAdmission(await readCliAgentAdmission(input), "headless_exec");
  if (!verdict.ok) return verdict;
  const { token } = verdict;

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
    auditPath: auditPathOf(input.command),
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
    slotHeld: false,
    waiters: new Set(),
    markCancelled() {},
    markStarted() {},
    markRejected() {},
    markDone() {},
    appendOutput() {},
  };
  record.markCancelled = () => {
    finish(record, "cancelled", {});
    releaseHeldSlot(record);
  };
  record.markRejected = (reason: string) => {
    // The wire accepts any string here: store a known code or the fallback,
    // never CLI-supplied text (see `cliAgentWireReason`). A record the server
    // already ended keeps the reason it was ended for.
    if (record.status === "running") record.rejectionReason = cliAgentWireReason(reason);
    finish(record, "rejected", {});
    releaseHeldSlot(record);
  };
  record.markDone = (result) => {
    finish(record, "exited", result);
    releaseHeldSlot(record);
  };
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

/** Who a cancel sweep ends: every record of one token, or of one user. */
type CancelScope = { tokenId: string } | { userId: string };

function inCancelScope(record: { tokenId: string; userId: string }, scope: CancelScope): boolean {
  return "tokenId" in scope ? record.tokenId === scope.tokenId : record.userId === scope.userId;
}

/**
 * The ONE way the server ends a running headless command because its authority
 * went away (token revoked, narrowed or expired; user banned): ask the CLI to
 * stop, then settle the record as cancelled right here. Sending `exec.cancel`
 * alone left the record running, so a waiting MCP call still returned later
 * output and exit as a success, audited as completed. After this the record is
 * terminal for every caller-visible purpose: waiters wake, output and the CLI's
 * late `exec.done` are dropped, and the audit says cancelled. Only the
 * execution slot stays held (`slotHeld`) until the CLI acknowledges or the grace
 * runs out, because the remote process may still exist. The server deadline
 * keeps its own grace (`armServerDeadline`): there the CLI's real exit is wanted.
 */
function endExecFromServer(
  record: CommandRecord,
  reason: "token_revoked" | "user_banned" | "token_expired",
) {
  if (record.status !== "running") return;
  relaySessionManager.dispatchExecCancel(record.cliDeviceId, record.commandId);
  record.rejectionReason = reason;
  record.slotHeld = true;
  finish(record, "cancelled", {});
  const grace = setTimeout(() => releaseHeldSlot(record), SERVER_COMMAND_GRACE_MS);
  grace.unref?.();
  record.graceTimer = grace;
}

/** The ONE sweep behind the token and user cancels: running exec and active supervised requests. */
function cancelCommandsIn(scope: CancelScope, reason: "token_revoked" | "user_banned") {
  for (const command of [...commandsById.values()]) {
    if (!inCancelScope(command, scope) || command.status !== "running") continue;
    endExecFromServer(command, reason);
  }
  for (const record of [...supervisedById.values()]) {
    if (!inCancelScope(record, scope) || !isActiveSupervised(record.status)) continue;
    endSupervisedFromServer(record, reason);
  }
}

export function cancelCommandsForToken(tokenId: string) {
  // Starts still between their first await and their record refuse.
  revokeOpenCliAgentAdmissions(tokenId);
  cancelCommandsIn({ tokenId }, "token_revoked");
}

/**
 * A user was banned: end every running command and active supervised request
 * they own, and refuse starts still reading (#159). Covers every token of the
 * user, so a token minted or used after the ban started is ended too.
 */
export function cancelCommandsForUser(userId: string) {
  revokeOpenCliAgentAdmissionsForUser(userId);
  cancelCommandsIn({ userId }, "user_banned");
}

/** Test isolation. Production callers must not drop in-flight commands. */
export function resetCliCommandsForTests(): void {
  for (const record of commandsById.values()) clearCommandTimers(record);
  commandsById.clear();
  for (const record of supervisedById.values()) clearWaitTimer(record);
  supervisedById.clear();
  resetCliAgentAdmissionsForTests();
}

export function sweepExpiredTokenCommands(now = Date.now()): number {
  let swept = sweepSupervised(now);
  for (const command of [...commandsById.values()]) {
    if (command.status !== "running") continue;
    if (command.expiresAt === null || command.expiresAt > now) continue;
    endExecFromServer(command, "token_expired");
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
  /** Audit `path` (command hash plus program), computed once at start. */
  auditPath: string;
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
  auditSupervisedCommand(record, status);
  relaySessionManager.notifyTerminalListChanged(record.userId);
}

function auditSupervisedCommand(
  record: SupervisedRecord,
  status: Exclude<SupervisedCommandStatus, "awaiting_user" | "running" | "awaiting_output_review">,
): void {
  const outcome: CliAgentActionOutcome =
    status === "exited"
      ? "completed"
      : status === "rejected"
        ? "refused"
        : status === "declined"
          ? "declined"
          : status === "expired"
            ? "expired"
            : "cancelled";
  recordCliAgentAction({
    userId: record.userId,
    cliDeviceId: record.cliDeviceId,
    mcpTokenId: record.tokenId,
    kind: "supervised_command",
    path: record.auditPath,
    outcome,
    reason:
      status === "exited"
        ? exitReason(record)
        : (record.rejectionReason ?? (record.acceptedAt === null ? "not_started" : null)),
    startedAt: new Date(record.createdAt),
    finishedAt: new Date(record.finishedAt ?? Date.now()),
  });
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
  reason: "token_revoked" | "user_banned" | "token_expired" | "stop_unanswered",
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
      // The wire accepts any string here: store a known code or the fallback,
      // never CLI-supplied text (see `cliAgentWireReason`).
      finishSupervised(record, "rejected", {
        rejectionReason: cliAgentWireReason(reason.slice(0, 64)),
      });
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
type StartSupervisedCommandInput = {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  command: string;
  cwd?: string;
  reason?: string;
  shareOutput: boolean;
};

type StartSupervisedCommandResult =
  | { ok: true; commandId: string; terminalId: string; expiresAt: string }
  | { ok: false; error: CliCommandRejection };

export async function startSupervisedCommand(
  input: StartSupervisedCommandInput,
): Promise<StartSupervisedCommandResult> {
  const startedAt = new Date();
  try {
    const result = await admitSupervisedCommand(input);
    if (!result.ok) auditRefusal("supervised_command", input, startedAt, "refused", result.error);
    return result;
  } catch (error) {
    auditRefusal("supervised_command", input, startedAt, "failed", "internal_error");
    throw error;
  }
}

async function admitSupervisedCommand(
  input: StartSupervisedCommandInput,
): Promise<StartSupervisedCommandResult> {
  // From the verdict to the dispatch nothing awaits (see `Admission`).
  const verdict = judgeCliAgentAdmission(await readCliAgentAdmission(input), "supervised");
  if (!verdict.ok) return verdict;
  const { token } = verdict;

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
    auditPath: auditPathOf(input.command),
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
