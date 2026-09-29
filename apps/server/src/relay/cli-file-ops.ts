import { randomBytes } from "node:crypto";
import type { FileOpClass } from "@ws-model-proxy/api/lib/cli-file-access";
import {
  type CliAgentAdmissionRejection,
  judgeCliAgentAdmission,
  readCliAgentAdmission,
  revokeOpenCliAgentAdmissions,
} from "./cli-agent-admission.js";
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
  // TODO(#132): record the audit event here, the ONE place a file op ends.
  // Call `recordCliAgentAction` (from PR #132, not merged yet) with: userId,
  // cliDeviceId, tokenId, kind file_read|file_write by `record.mutating`, the
  // op and PATH from the request (never content or diffs), the outcome
  // (`outcome.ok`, `outcome.code`, `outcome.outcome === "unknown"`), and the
  // elapsed time from `record.startedAt`. Do not add another call site.
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

function rejectionFailure(reason: FileRejectReason, detail?: FileRejectDetail): FileOpFailure {
  // The CLI's own refusals are definitive: nothing was committed.
  if (reason === "bad_frame") return { ok: false, code: "io_error" };
  return { ok: false, code: reason, ...(detail ? { detail } : {}) };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A `file.result` whose spilled text arrived (or never spilled): validate and settle. */
function finishResult(record: FileOpRecord, frame: FileResultFrame, spilled: string | null) {
  if (frame.op !== record.op) {
    settle(record, serverFailure(record, "io_error"));
    return;
  }
  const result = { ...frame.result };
  if (frame.dataField !== undefined && spilled !== null) result[frame.dataField] = spilled;
  settle(record, { ok: true, op: record.op, result: result as FileOpResult["result"] });
}

function newRecord(input: {
  opId: string;
  userId: string;
  tokenId: string;
  cliDeviceId: string;
  op: FileOp;
  tokenExpiresAt: number | null;
  resolve: (outcome: FileOpOutcome) => void;
}): FileOpRecord {
  const record: FileOpRecord = {
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
      settle(record, rejectionFailure(reason, detail));
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
  const mutating = isMutatingFileOp(input.op);
  const opClass: FileOpClass = mutating ? "write" : "read";
  if (input.signal?.aborted) return { ok: false, code: "cancelled" };

  const verdict = judgeCliAgentAdmission(
    await readCliAgentAdmission(input),
    mutating ? "file_write" : "file_read",
  );
  // From the verdict to the dispatch nothing awaits (see `Admission`).
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
  const slot = takeRateSlot(input.userId, mutating, Date.now());
  if (!slot.ok) return { ok: false, code: "limit", retryAfterMs: slot.retryAfterMs };

  return await new Promise<FileOpOutcome>((resolve) => {
    const record = newRecord({
      opId,
      userId: input.userId,
      tokenId: input.tokenId,
      cliDeviceId: input.cliDeviceId,
      op: input.op,
      tokenExpiresAt: verdict.token.expiresAt ? verdict.token.expiresAt.getTime() : null,
      resolve,
    });
    pendingById.set(opId, record);
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
      relaySessionManager.forgetFileOp(record.cliDeviceId, opId);
      const refusal = relaySessionManager.fileOpModeRefusal(input.cliDeviceId, opClass);
      resolve({ ok: false, code: refusal ?? "offline" });
      return;
    }
    record.deadlineTimer = setTimeout(() => {
      relaySessionManager.dispatchFileCancel(record.cliDeviceId, record.opId);
      settle(record, serverFailure(record, "timeout"));
    }, FILE_OP_DEADLINE_MS);
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
