import { randomBytes } from "node:crypto";
import type { FileOpClass } from "@ws-model-proxy/api/lib/cli-file-access";
import {
  lowestMcpCommandMode,
  mcpCommandModeFromDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import {
  CLI_AGENT_ACTION_UNKNOWN_DEVICE,
  type CliAgentActionKind,
  type CliAgentActionOutcome,
} from "@ws-model-proxy/config/cli-agent-audit";
import {
  type CliAgentAdmissionRejection,
  closeCliAgentAdmission,
  judgeCliAgentAdmission,
  readCliAgentAdmission,
  revokeOpenCliAgentAdmissions,
} from "./cli-agent-admission.js";
import { recordCliAgentAction } from "./cli-agent-audit.js";
import {
  FILE_BODY_MAX_BYTES,
  type FileErrorCode,
  type FileOp,
  type FileOpFrame,
  type FileOpResult,
  type FileRejectDetail,
  type FileRejectReason,
  type FileResultFrame,
  fileOpFrameSchema,
  isMutatingFileOp,
} from "./file-protocol.js";
import { encodeRelayServerControlMessage } from "./protocol.js";
import { relaySessionManager, type TrackedFileOp } from "./session-manager.js";

/**
 * Node file ops (relay 2.8, #103): the server side of `file.op`. One request
 * runs admission (`cli-agent-admission.ts`), the limits below, and then sends
 * the frame; the CLI's `file.result` / `file.rejected` (and `file.data` for a
 * spilled text field) settles it. Ops are never queued, never retried, and
 * file content is never logged or persisted here.
 */

// Limits are code constants, not env vars (the #88 precedent).
export const FILE_OPS_PER_MINUTE_PER_USER = 120;
export const FILE_MUTATIONS_PER_MINUTE_PER_USER = 30;
export const FILE_OPS_PER_CLI = 4;
export const FILE_OPS_PER_USER = 16;
/** The server deadline; the CLI's own budgets (search 25 s, hash 20 s) are shorter. */
export const FILE_OP_DEADLINE_MS = 30_000;
const RATE_WINDOW_MS = 60_000;
/** Advice for a `limit` caused by concurrency (an op is normally short). */
const CONCURRENCY_RETRY_AFTER_MS = 1_000;
/**
 * After an MCP abort the CLI drops the op without an answer, so its record (and
 * concurrency slot) is released after this grace, with an unknown outcome for a
 * mutation.
 */
const ABORT_GRACE_MS = 5_000;
/** A `file.op` control frame is at most 64 KiB (`RELAY_JSON_CONTROL_MAX_BYTES`). */
const FILE_OP_FRAME_MAX_BYTES = 64 * 1024;

export type FileOpErrorCode =
  | CliAgentAdmissionRejection
  | FileErrorCode
  | "supervised_only"
  | "feature_disabled";

export type FileOpFailure = {
  ok: false;
  code: FileOpErrorCode;
  detail?: FileRejectDetail;
  /** `limit`: when a retry can succeed. */
  retryAfterMs?: number;
  /** A mutating op whose result the server does not know: `file_stat` and compare etags. */
  outcome?: "unknown";
  /** `upgrade_required`: the relay protocol the refused CLI spoke. */
  rejectedProtocolVersion?: string;
  /** `not_found` from admission means the device, not a file. */
  scope?: "device";
};

export type FileOpSuccess = {
  ok: true;
  op: FileOp;
  result: FileOpResult["result"];
};

export type FileOpOutcome = FileOpSuccess | FileOpFailure;

type FileOpRecord = TrackedFileOp & {
  audit: FileAudit;
  userId: string;
  tokenId: string;
  mutating: boolean;
  tokenExpiresAt: number | null;
  startedAt: number;
  settled: boolean;
  /** The caller stopped waiting (MCP abort); the record stays until the CLI answers or the deadline. */
  callerGone: boolean;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** A `file.result` whose text field follows as `file.data`. */
  awaitingData: FileResultFrame | null;
  resolve(outcome: FileOpOutcome): void;
};

const pendingById = new Map<string, FileOpRecord>();

// ---------------------------------------------------------------------------
// Rate limiter: a sliding one-minute window per user, in process (one replica
// is the supported topology, like the other MCP limiters).

const opTimesByUser = new Map<string, number[]>();
const mutationTimesByUser = new Map<string, number[]>();

function prune(times: number[], now: number): number[] {
  const cutoff = now - RATE_WINDOW_MS;
  let first = 0;
  while (first < times.length && (times[first] ?? 0) <= cutoff) first += 1;
  return first === 0 ? times : times.slice(first);
}

function windowFor(map: Map<string, number[]>, userId: string, now: number): number[] {
  const times = prune(map.get(userId) ?? [], now);
  if (times.length === 0) map.delete(userId);
  else map.set(userId, times);
  return times;
}

/** Charges one op to the user's budget, or says when to retry. */
function takeRateSlot(
  userId: string,
  mutating: boolean,
  now: number,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const ops = windowFor(opTimesByUser, userId, now);
  const mutations = windowFor(mutationTimesByUser, userId, now);
  const retryAfter = (times: number[]) => Math.max(1, (times[0] ?? now) + RATE_WINDOW_MS - now);
  if (ops.length >= FILE_OPS_PER_MINUTE_PER_USER) {
    return { ok: false, retryAfterMs: retryAfter(ops) };
  }
  if (mutating && mutations.length >= FILE_MUTATIONS_PER_MINUTE_PER_USER) {
    return { ok: false, retryAfterMs: retryAfter(mutations) };
  }
  opTimesByUser.set(userId, [...ops, now]);
  if (mutating) mutationTimesByUser.set(userId, [...mutations, now]);
  return { ok: true };
}

/** Gives back the slot of an op that was never sent (nothing reached the CLI). */
function refundRateSlot(userId: string, mutating: boolean, at: number): void {
  for (const map of mutating ? [opTimesByUser, mutationTimesByUser] : [opTimesByUser]) {
    const times = map.get(userId);
    if (!times) continue;
    const index = times.lastIndexOf(at);
    if (index >= 0) times.splice(index, 1);
    if (times.length === 0) map.delete(userId);
  }
}

function pendingCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
  let user = 0;
  let cli = 0;
  for (const record of pendingById.values()) {
    if (record.userId !== userId) continue;
    user += 1;
    if (record.cliDeviceId === cliDeviceId) cli += 1;
  }
  return { user, cli };
}

// ---------------------------------------------------------------------------
// Audit (#104 part B). Metadata only: the kind, the requested path, the etag
// the caller expected and the etag or size the result carries, the byte count
// of a write, the outcome and a stable reason code. Never content, diffs or
// masked text. Every op that reaches `runFileOp` is recorded exactly once:
// refusals before dispatch by `runFileOp` itself, dispatched ops by `settle`.

const FILE_AUDIT_KINDS: Readonly<Record<FileOp, CliAgentActionKind>> = {
  read: "file_read",
  stat: "file_stat",
  list: "file_list",
  search: "file_search",
  edit: "file_edit",
  write: "file_write",
  rename: "file_rename",
  mkdir: "file_mkdir",
  delete: "file_delete",
};

type FileAudit = {
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  kind: CliAgentActionKind;
  path: string;
  etagBefore: string | null;
  bytes: number | null;
  startedAt: Date;
  /**
   * The admission verdict resolved `cliDeviceId` to one of the caller's own
   * devices. Before that the id is caller-supplied text, so the row stores
   * {@link CLI_AGENT_ACTION_UNKNOWN_DEVICE} instead (as the command audit does).
   */
  deviceVerified: boolean;
  /** The op was registered: `settle` records it. */
  registered: boolean;
  recorded: boolean;
};

function stringField(source: unknown, key: string): string | null {
  if (source === null || typeof source !== "object") return null;
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : null;
}

/** The path an event names: `path`, `root`, the first of `paths`, or a rename's `from`. */
function auditPathOf(args: unknown): string {
  const direct =
    stringField(args, "path") ?? stringField(args, "root") ?? stringField(args, "from");
  if (direct !== null) return direct;
  if (args !== null && typeof args === "object") {
    const paths: unknown = Reflect.get(args, "paths");
    if (Array.isArray(paths) && typeof paths[0] === "string") return paths[0];
  }
  return "";
}

function newFileAudit(input: RunFileOpInput): FileAudit {
  return {
    userId: input.userId,
    tokenId: input.tokenId,
    cliDeviceId: input.cliDeviceId,
    kind: FILE_AUDIT_KINDS[input.op],
    path: auditPathOf(input.args),
    etagBefore: stringField(input.args, "expectedEtag"),
    bytes: input.op === "write" && input.body ? input.body.byteLength : null,
    startedAt: new Date(),
    deviceVerified: false,
    registered: false,
    recorded: false,
  };
}

/** Codes of an op that started or was refused by the server's own state, not by the file. */
const CANCELLED_CODES: ReadonlySet<string> = new Set([
  "cancelled",
  "timeout",
  "offline",
  "token_inactive",
  "grant_disabled",
  "feature_disabled",
  "supervised_only",
]);

function auditOutcomeOf(
  audit: FileAudit,
  outcome: FileOpOutcome,
): { outcome: CliAgentActionOutcome; reason: string | null } {
  if (outcome.ok) return { outcome: "completed", reason: null };
  if (outcome.outcome === "unknown") return { outcome: "unknown", reason: outcome.code };
  if (!audit.registered) return { outcome: "refused", reason: outcome.code };
  if (CLI_ANSWERED.has(outcome)) {
    // The CLI answered: its mode/root/load refusals ran nothing, its own
    // `cancelled` is a cancellation, everything else (including its own
    // timeout) is a failure of the op.
    if (REFUSED_BY_CLI_CODES.has(outcome.code)) return { outcome: "refused", reason: outcome.code };
    return {
      outcome: outcome.code === "cancelled" ? "cancelled" : "failed",
      reason: outcome.code,
    };
  }
  return {
    outcome: CANCELLED_CODES.has(outcome.code) ? "cancelled" : "failed",
    reason: outcome.code,
  };
}

/**
 * An input the MCP layer refused before `runFileOp` (strict shape, content the
 * relay cannot carry): recorded as a refusal like the commands' `invalid_command`.
 * The device is unverified there, so the row stores the unknown-device id.
 */
export function auditRefusedFileInput(input: {
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  op: FileOp;
  args: unknown;
}): void {
  const audit = newFileAudit({ ...input, expiresAt: null });
  recordFileAudit(audit, { ok: false, code: "invalid_input" });
}

/** The ONE call site of `recordCliAgentAction` for file ops. Never throws. */
function recordFileAudit(audit: FileAudit, outcome: FileOpOutcome): void {
  if (audit.recorded) return;
  audit.recorded = true;
  const { outcome: auditOutcome, reason } = auditOutcomeOf(audit, outcome);
  let etagAfter: string | null = null;
  let bytes = audit.bytes;
  if (outcome.ok) {
    etagAfter = stringField(outcome.result, "etag");
    const size: unknown = Reflect.get(outcome.result, "size");
    if (bytes === null && audit.kind === "file_write" && typeof size === "number") bytes = size;
  }
  recordCliAgentAction({
    userId: audit.userId,
    cliDeviceId: audit.deviceVerified ? audit.cliDeviceId : CLI_AGENT_ACTION_UNKNOWN_DEVICE,
    mcpTokenId: audit.tokenId,
    kind: audit.kind,
    path: audit.path,
    etagBefore: audit.etagBefore,
    etagAfter,
    bytes,
    outcome: auditOutcome,
    reason,
    startedAt: audit.startedAt,
    finishedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// The single settle point. Every path that ends an op (result, rejection,
// timeout, session loss, revoke, malformed answer) goes through here exactly
// once.

function settle(record: FileOpRecord, outcome: FileOpOutcome): void {
  if (record.settled) return;
  record.settled = true;
  if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
  record.deadlineTimer = null;
  pendingById.delete(record.opId);
  relaySessionManager.forgetFileOp(record.cliDeviceId, record.opId);
  recordFileAudit(record.audit, outcome);
  record.resolve(outcome);
}

/**
 * A failure the SERVER produced (timeout, session loss, revoke, malformed
 * answer): for a mutating op the result is unknown, because the CLI may have
 * committed before it stopped.
 */
function serverFailure(record: FileOpRecord, code: FileOpErrorCode): FileOpFailure {
  return { ok: false, code, ...(record.mutating ? { outcome: "unknown" as const } : {}) };
}

/** Failures the CLI itself answered with (rather than the server ending the op), for the audit. */
const CLI_ANSWERED = new WeakSet<object>();

/** The CLI's own mode/root/load refusals: nothing ran. */
const REFUSED_BY_CLI_CODES: ReadonlySet<string> = new Set([
  "unsupported",
  "limit",
  "supervised_only",
  "grant_disabled",
  "feature_disabled",
]);

function cliAnswered<T extends FileOpFailure>(failure: T): T {
  CLI_ANSWERED.add(failure);
  return failure;
}

function rejectionFailure(
  reason: FileRejectReason,
  detail: FileRejectDetail | undefined,
  mutating: boolean,
  ambiguousNotFound: boolean,
): FileOpFailure {
  // The CLI's own refusals are definitive (nothing was committed), with one
  // exception: after its commit point the file library can still fail (a
  // directory sync, a post-rename check) and the CLI cannot send a result that
  // is too big. For a mutation those two say nothing about whether the change
  // was made, so the outcome is unknown and the agent must file_stat first.
  // Ops whose cleanup runs after the commit can also fail with `not_found`
  // (the source vanished): for rename and delete that code is ambiguous.
  // Older CLIs can report a failed exchange undo as a `replaced` conflict.
  // Keep that conservative mapping; new CLIs report uncertain_outcome and
  // include the locations needed for manual recovery.
  const replacedConflict = reason === "conflict" && detail?.currentEtag === "replaced";
  if (
    mutating &&
    (reason === "io_error" ||
      reason === "uncertain_outcome" ||
      replacedConflict ||
      (ambiguousNotFound && reason === "not_found"))
  ) {
    return cliAnswered({
      ok: false,
      code: reason,
      outcome: "unknown",
      ...(reason === "uncertain_outcome" && detail ? { detail } : {}),
    });
  }
  if (reason === "bad_frame") return cliAnswered({ ok: false, code: "io_error" });
  return cliAnswered({ ok: false, code: reason, ...(detail ? { detail } : {}) });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A `file.result` whose spilled text arrived (or never spilled): validate and settle. */
function finishResult(record: FileOpRecord, frame: FileResultFrame, spilled: string | null) {
  if (frame.op !== record.op) {
    settle(record, serverFailure(record, "io_error"));
    return;
  }
  // An answer that lands after the credential expired is not delivered.
  if (record.tokenExpiresAt !== null && Date.now() >= record.tokenExpiresAt) {
    settle(record, serverFailure(record, "token_inactive"));
    return;
  }
  const result = { ...frame.result };
  if (frame.dataField !== undefined && spilled !== null) result[frame.dataField] = spilled;
  settle(record, { ok: true, op: record.op, result: result as FileOpResult["result"] });
}

function newRecord(input: {
  audit: FileAudit;
  opId: string;
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  op: FileOp;
  tokenExpiresAt: number | null;
  resolve: (outcome: FileOpOutcome) => void;
}): FileOpRecord {
  const record: FileOpRecord = {
    audit: input.audit,
    opId: input.opId,
    cliDeviceId: input.cliDeviceId,
    op: input.op,
    userId: input.userId,
    tokenId: input.tokenId,
    mutating: isMutatingFileOp(input.op),
    tokenExpiresAt: input.tokenExpiresAt,
    startedAt: Date.now(),
    settled: false,
    callerGone: false,
    deadlineTimer: null,
    awaitingData: null,
    resolve: input.resolve,
    markResult(frame) {
      if (record.settled || record.awaitingData) return;
      if (frame.dataField === undefined) {
        finishResult(record, frame, null);
        return;
      }
      // The text follows as file.data; the deadline keeps running.
      record.awaitingData = frame;
    },
    markData(body) {
      const frame = record.awaitingData;
      if (record.settled || !frame) return;
      record.awaitingData = null;
      if (frame.bodyBytes === undefined || body.byteLength !== frame.bodyBytes) {
        settle(record, serverFailure(record, "io_error"));
        return;
      }
      let text: string;
      try {
        text = utf8.decode(body);
      } catch {
        settle(record, serverFailure(record, "io_error"));
        return;
      }
      finishResult(record, frame, text);
    },
    markRejected(reason, detail) {
      settle(
        record,
        rejectionFailure(
          reason,
          detail,
          record.mutating,
          record.op === "rename" || record.op === "delete",
        ),
      );
    },
    markMalformed() {
      settle(record, serverFailure(record, "io_error"));
    },
    markLost(cause) {
      settle(record, serverFailure(record, cause === "offline" ? "offline" : cause));
    },
  };
  return record;
}

export type RunFileOpInput = {
  userId: string;
  tokenId: string;
  expiresAt: Date | null;
  cliDeviceId: string;
  op: FileOp;
  /** The relay args for `op` (a write's content is `body`, not in the args). */
  args: unknown;
  /** Write content bytes (at most 1 MiB); required for `write`, absent otherwise. */
  body?: Uint8Array;
  signal?: AbortSignal;
};

function invalid(): FileOpFailure {
  return { ok: false, code: "invalid_input" };
}

/**
 * Run one file op on a CLI and wait for its outcome. Checks run in the
 * command order (token, device, owner, grant, live CLI and mode), then the
 * input and the limits; the frame is sent in the same synchronous step that
 * registers the op (nothing awaits between the admission verdict and the
 * dispatch).
 */
export async function runFileOp(input: RunFileOpInput): Promise<FileOpOutcome> {
  const audit = newFileAudit(input);
  let outcome: FileOpOutcome;
  try {
    outcome = await runFileOpChecked(input, audit);
  } catch (error) {
    recordFileAudit(audit, { ok: false, code: "io_error" });
    throw error;
  }
  // Refused before dispatch: no record exists, so record it here. A registered
  // op is recorded by `settle` (possibly after this caller already got its answer).
  if (!audit.registered) recordFileAudit(audit, outcome);
  return outcome;
}

async function runFileOpChecked(input: RunFileOpInput, audit: FileAudit): Promise<FileOpOutcome> {
  const mutating = isMutatingFileOp(input.op);
  const opClass: FileOpClass = mutating ? "write" : "read";
  if (input.signal?.aborted) return { ok: false, code: "cancelled" };

  const reads = await readCliAgentAdmission(input);
  // The caller may have gone while the admission read: never start new work for
  // a request that is already aborted (a cancel after the dispatch could lose a
  // race with a fast mutation).
  if (input.signal?.aborted) {
    closeCliAgentAdmission(reads);
    return { ok: false, code: "cancelled" };
  }
  const verdict = judgeCliAgentAdmission(reads, mutating ? "file_write" : "file_read");
  // From the verdict to the dispatch nothing awaits (see `Admission`).
  // The verdict resolved the device to one of the caller's own unless it said
  // the device is unknown or the token/owner is out (checked before ownership).
  audit.deviceVerified =
    verdict.ok || (verdict.error !== "not_found" && verdict.error !== "token_inactive");
  if (!verdict.ok) {
    return {
      ok: false,
      code: verdict.error,
      ...(verdict.error === "not_found" ? { scope: "device" as const } : {}),
      ...(verdict.rejectedProtocolVersion
        ? { rejectedProtocolVersion: verdict.rejectedProtocolVersion }
        : {}),
    };
  }

  // Input: the strict relay frame, the 64 KiB control-frame cap, well-formed text.
  const opId = randomBytes(16).toString("base64url");
  if (mutating && input.op === "write") {
    if (!input.body || input.body.byteLength > FILE_BODY_MAX_BYTES) return invalid();
  } else if (input.body !== undefined) {
    return invalid();
  }
  const parsed = fileOpFrameSchema.safeParse({
    type: "file.op",
    mode: lowestMcpCommandMode(
      mcpCommandModeFromDb(verdict.device.mcpCommandMode),
      verdict.live.mcpCommandMode,
    ),
    readGrant:
      verdict.device.mcpFileRead === true &&
      verdict.live.mcpFileRead === true &&
      verdict.live.fileRootsConfigured === true,
    opId,
    op: input.op,
    args: input.args,
    ...(input.op === "write" ? { bodyBytes: input.body?.byteLength ?? 0 } : {}),
  });
  if (!parsed.success) return invalid();
  const frame: FileOpFrame = parsed.data;
  try {
    if (
      new TextEncoder().encode(encodeRelayServerControlMessage(frame)).byteLength >
      FILE_OP_FRAME_MAX_BYTES
    ) {
      return invalid();
    }
  } catch {
    return invalid();
  }

  const counts = pendingCounts(input.userId, input.cliDeviceId);
  if (counts.cli >= FILE_OPS_PER_CLI || counts.user >= FILE_OPS_PER_USER) {
    return { ok: false, code: "limit", retryAfterMs: CONCURRENCY_RETRY_AFTER_MS };
  }
  const slotAt = Date.now();
  const slot = takeRateSlot(input.userId, mutating, slotAt);
  if (!slot.ok) return { ok: false, code: "limit", retryAfterMs: slot.retryAfterMs };

  return await new Promise<FileOpOutcome>((resolve) => {
    const record = newRecord({
      audit,
      opId,
      userId: input.userId,
      tokenId: input.tokenId,
      cliDeviceId: input.cliDeviceId,
      op: input.op,
      // The earliest expiry the credential carries (its row and the one it was admitted with).
      tokenExpiresAt: [verdict.token.expiresAt, input.expiresAt]
        .filter((date): date is Date => date !== null)
        .reduce<number | null>(
          (earliest, date) =>
            earliest === null ? date.getTime() : Math.min(earliest, date.getTime()),
          null,
        ),
      resolve,
    });
    pendingById.set(opId, record);
    audit.registered = true;
    let dispatched = false;
    try {
      dispatched = relaySessionManager.dispatchFileOp(record, frame, input.body);
    } catch {
      dispatched = false;
    }
    if (!dispatched) {
      // Nothing was sent, so the CLI will never answer: drop the record from
      // both maps the dispatch could have filled (a send throw leaves the
      // session entry behind) and resolve the mode refusal without an unknown
      // outcome.
      pendingById.delete(opId);
      record.settled = true;
      audit.registered = false;
      refundRateSlot(input.userId, mutating, slotAt);
      relaySessionManager.forgetFileOp(record.cliDeviceId, opId);
      const refusal = relaySessionManager.fileOpModeRefusal(input.cliDeviceId, opClass);
      resolve({ ok: false, code: refusal ?? "offline" });
      return;
    }
    // The op ends at its deadline, or at the credential's expiry if that is
    // sooner: an expiring token keeps no authority until the minute sweep.
    const untilExpiry =
      record.tokenExpiresAt === null ? Infinity : record.tokenExpiresAt - Date.now();
    const expiresFirst = untilExpiry < FILE_OP_DEADLINE_MS;
    record.deadlineTimer = setTimeout(
      () => {
        relaySessionManager.dispatchFileCancel(record.cliDeviceId, record.opId);
        settle(record, serverFailure(record, expiresFirst ? "token_inactive" : "timeout"));
      },
      expiresFirst ? Math.max(0, untilExpiry) : FILE_OP_DEADLINE_MS,
    );
    record.deadlineTimer.unref?.();
    const onAbort = () => {
      if (record.settled) return;
      // An MCP abort sends file.cancel and returns cancelled. The CLI honors it
      // before the commit point of a mutation, so a mutating caller learns the
      // outcome is unknown. The record stays until the CLI answers or the
      // deadline, so the concurrency slot is honest.
      record.callerGone = true;
      relaySessionManager.dispatchFileCancel(record.cliDeviceId, record.opId);
      resolve(serverFailure(record, "cancelled"));
      if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
      record.deadlineTimer = setTimeout(
        () => settle(record, serverFailure(record, "cancelled")),
        ABORT_GRACE_MS,
      );
      record.deadlineTimer.unref?.();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cancel the in-flight file ops of a revoked or narrowed token, and refuse ops still in admission. */
export function cancelFileOpsForToken(tokenId: string): void {
  revokeOpenCliAgentAdmissions(tokenId);
  for (const record of [...pendingById.values()]) {
    if (record.tokenId !== tokenId) continue;
    relaySessionManager.dispatchFileCancel(record.cliDeviceId, record.opId);
    settle(record, serverFailure(record, "token_inactive"));
  }
}

/** Expired tokens end their in-flight ops; also drops rate-limit windows that have emptied. */
export function sweepExpiredFileOps(now = Date.now()): number {
  let swept = 0;
  for (const record of [...pendingById.values()]) {
    if (record.tokenExpiresAt === null || record.tokenExpiresAt > now) continue;
    relaySessionManager.dispatchFileCancel(record.cliDeviceId, record.opId);
    settle(record, serverFailure(record, "token_inactive"));
    swept += 1;
  }
  for (const map of [opTimesByUser, mutationTimesByUser]) {
    for (const userId of [...map.keys()]) windowFor(map, userId, now);
  }
  return swept;
}

/** Test isolation. Production callers must not drop in-flight ops. */
export function resetFileOpsForTests(): void {
  for (const record of pendingById.values()) {
    if (record.deadlineTimer) clearTimeout(record.deadlineTimer);
  }
  pendingById.clear();
  opTimesByUser.clear();
  mutationTimesByUser.clear();
}
