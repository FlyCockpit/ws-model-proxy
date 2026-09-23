import { randomBytes } from "node:crypto";
import prisma from "@ws-model-proxy/db";
import { relaySessionManager, type TrackedCliCommand } from "./session-manager.js";

const HEAD_MAX_BYTES = 8192;
const TAIL_MAX_BYTES = 40960;
const FINISHED_TTL_MS = 15 * 60 * 1000;
const SERVER_COMMAND_DEADLINE_MS = 11 * 60 * 1000;
const SERVER_COMMAND_GRACE_MS = 15 * 1000;
const COMMANDS_PER_CLI = 2;
const COMMANDS_PER_USER = 8;
const COMMAND_MAX_BYTES = 4096;

export type CliCommandRejection =
  | "not_found"
  | "grant_disabled"
  | "offline"
  | "feature_disabled"
  | "limit"
  | "invalid_command";

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

export async function startCliCommand(input: {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  command: string;
  cwd?: string;
}): Promise<{ ok: true; commandId: string } | { ok: false; error: CliCommandRejection }> {
  const device = await prisma.cliDevice.findUnique({
    where: { id: input.cliDeviceId },
    select: { id: true, userId: true, allowMcpCommands: true },
  });
  if (!device || device.userId !== input.userId) return { ok: false, error: "not_found" };
  if (!device.allowMcpCommands) return { ok: false, error: "grant_disabled" };

  const live = relaySessionManager.getLiveCliFeatures([input.cliDeviceId]).get(input.cliDeviceId);
  if (live?.protocolVersion !== "2.4") return { ok: false, error: "offline" };
  if (!live.mcpCommands) return { ok: false, error: "feature_disabled" };

  const counts = runningCounts(input.userId, input.cliDeviceId);
  if (counts.cli >= COMMANDS_PER_CLI || counts.user >= COMMANDS_PER_USER) {
    return { ok: false, error: "limit" };
  }

  const cwd = input.cwd;
  if (
    commandBytes(input.command) < 1 ||
    commandBytes(input.command) > COMMAND_MAX_BYTES ||
    input.command.includes("\0") ||
    (cwd !== undefined &&
      (cwd.length === 0 || cwd.includes("\0") || commandBytes(cwd) > COMMAND_MAX_BYTES))
  ) {
    return { ok: false, error: "invalid_command" };
  }

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
    expiresAt: input.expiresAt ? input.expiresAt.getTime() : null,
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
  if (!sent) return { ok: false, error: "offline" };
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
  for (const command of commandsById.values()) {
    if (command.tokenId !== tokenId || command.status !== "running") continue;
    relaySessionManager.dispatchExecCancel(command.cliDeviceId, command.commandId);
  }
}

/** Test isolation. Production callers must not drop in-flight commands. */
export function resetCliCommandsForTests(): void {
  for (const record of commandsById.values()) clearCommandTimers(record);
  commandsById.clear();
}

export function sweepExpiredTokenCommands(now = Date.now()): number {
  let swept = 0;
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
