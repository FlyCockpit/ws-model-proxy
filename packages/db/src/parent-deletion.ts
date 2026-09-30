/**
 * User deletion and parent deletes under DL-1 design (d) (#78).
 *
 * A parent delete (user, device, endpoint, discovered model, pool, pool
 * member, capacity) is a plain delete under owner fences
 * (`fenceParentDelete` in ./capacity-lock-order.ts): it cascades only into
 * graph and auxiliary rows, each guarded by a fence the delete holds. No
 * hot-path (H) table has a foreign key to the graph, so a parent with request,
 * admission or lease history is deletable; that history keeps plain ids of the
 * deleted rows, readers tolerate them, and the capacity sweepers terminalize
 * live orphans.
 *
 * A user deletion additionally removes the user's own history, for privacy,
 * in three phases:
 *
 *  1. Preflight ({@link findRetainedHistoryBlocker}). Provider accounting is
 *     retained history: a user who has any (attempts, ledger, reservations,
 *     pricing versions, provider audit, credential rotation) is refused before
 *     anything is drained or marked. The graph-side rows (pricing versions,
 *     audit, rotation) are also protected by ON DELETE RESTRICT.
 *  2. Drain ({@link drainParentDeletionHistory}). The user's H rows (by the
 *     columns in `HISTORY_DRAIN_EDGES`) are deleted in bounded batches, each
 *     batch its own short transaction that takes the rows it deletes with
 *     SKIP LOCKED, like the retention sweeper, and takes no fence: a sweeper
 *     (writer class S). A terminal admission request is deleted only together
 *     with every one of its waiters, all taken with SKIP LOCKED first, so its
 *     cascade (waiters and lease, H-internal foreign keys) never waits on a
 *     waiter the batch skipped. The waits left (the execution rows of a
 *     terminal relay request, whose writers take no fence, and the
 *     requester-rollup merge) are bounded by a transaction-local
 *     `lock_timeout` ({@link PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS}); a
 *     timeout rolls the batch back and reports pending. Every statement of a
 *     batch is also bounded by a transaction-local `statement_timeout`
 *     ({@link PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS}). Batches are
 *     idempotent: a crash, a shutdown fence, a timeout or an error leaves only
 *     rows the next run processes. The drain never touches live rows (PENDING
 *     relay requests, WAITING/ADMITTED admission requests).
 *  3. The delete under owner fences, which also queues the user in
 *     `deleted_user_purge`: the history sweeper
 *     (apps/server/src/model-api/usage-retention.ts, `startUsageRetention` ->
 *     `purgeDeletedUsersHistory`) purges what the drain could not take
 *     (requests still in flight at the delete) once it is terminal.
 *
 * Durable intent. A user delete marks the user first
 * ({@link requestUserDeletion}: `deletionRequestedAt`, a ban and the removal
 * of browser sessions, in one short transaction) and only then drains. If the
 * process dies or the final delete fails transiently, the marker survives and
 * the user-deletion sweeper (apps/server/src/user-deletion-sweep.ts) finishes
 * it, so a user whose sessions (and, on the Better Auth path, accounts) are
 * already gone is never left behind with nothing to complete the delete. The
 * marker alone refuses new browser sessions, MCP, CLI and model API access
 * while the drain runs, whatever the ban fields later hold
 * (`@ws-model-proxy/auth/user-deletion-access-guard`). Each marking starts a
 * deletion generation (`deletionGeneration`); completion, abandon and sweep
 * backoff act only on the generation their worker selected. Completion binds
 * every destructive effect to it under the user row lock: each drain batch
 * (and the impersonation-session delete) takes the row FOR SHARE on the
 * generation first, so an abandon, restore or new mark waits for the batch in
 * flight and no later batch of the withdrawn generation deletes anything
 * ({@link UserDeletionOwner}).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  deleteTerminalRelayRequestsWithoutWaiting,
  deleteUserUnderOwnerFences,
  serverTimeoutSqlState,
  UserDeletionGenerationChangedError,
} from "./capacity-lock-order";
import {
  type DeletedParents,
  edgeFilters,
  HISTORY_DRAIN_EDGES,
  PARENT_DELETION_DRAIN_BATCH,
  ParentDeletionDrainPendingError,
  ParentDeletionOwnerRequiredError,
  type ParentDeletionScope,
  resolveDeletedParents,
  USER_PLAIN_ID_HISTORY_TABLES,
} from "./parent-deletion-residual";
import { isDbShutdownFenceArmed } from "./shutdown-fence";
import { drainRequesterUsageRollupsBatch } from "./usage-rollup-requester-drain";

type Db = Pick<
  PrismaClient,
  | "$transaction"
  | "$queryRaw"
  | "$executeRaw"
  | "user"
  | "session"
  | "cliDevice"
  | "endpoint"
  | "discoveredModel"
  | "executionTarget"
  | "modelPool"
  | "poolMember"
  | "poolGrant"
  | "inferenceCapacity"
  | "modelApiToken"
  | "providerAccount"
  | "providerModel"
>;

// The contract data and parent resolution are shared with the owner-fence
// planner of ./capacity-lock-order.ts.
export {
  type DeletedParents,
  type DeletedParentTable,
  HISTORY_DRAIN_EDGES,
  PARENT_DELETION_DRAIN_BATCH,
  ParentDeletionDrainPendingError,
  ParentDeletionOwnerRequiredError,
  type ParentDeletionScope,
  resolveDeletedParents,
  USER_PLAIN_ID_HISTORY_TABLES,
} from "./parent-deletion-residual";

/** Max rows processed in one drain invocation; further work returns pending. */
export const PARENT_DELETION_MAX_DRAIN_ROWS_PER_RUN = 2_000_000;

/** Max inner drain-loop iterations per step label in one invocation. */
export const PARENT_DELETION_MAX_DRAIN_LOOP_ITERATIONS = 100_000;

/**
 * Max terminal admission requests one drain invocation passes because a waiter
 * of theirs is busy (g1-M1). The passed ids are kept in memory and sent with
 * every later batch's scan, so past this bound the drain stops with
 * {@link ParentDeletionDrainPendingError} (retried later) instead of carrying
 * a growing exclusion list.
 */
export const PARENT_DELETION_MAX_PASSED_ADMISSIONS = 10_000;

// ---------------------------------------------------------------------------
// Table-level contract (checked against the Prisma schema by a unit test)
// ---------------------------------------------------------------------------

/**
 * Every ON DELETE RESTRICT edge into a deleted graph, and why the final
 * DELETE cannot trip it after a passing preflight. `owner-history` is checked
 * by {@link findRetainedHistoryBlocker}; `co-deleted` edges point between two
 * rows the same cascade deletes and do not fail it (a user with a target on
 * its capacity deletes). No hot-path table has a foreign key into the graph,
 * so admission and lease history never block a delete.
 */
export const RETAINED_HISTORY_EDGES = {
  "execution_target.inferenceCapacityId": "co-deleted",
  "provider_credential.replacedById": "owner-history",
  "provider_pricing_version.providerAccountId": "owner-history",
  "provider_pricing_version.providerModelId": "owner-history",
  "provider_audit_event.userId": "owner-history",
} as const satisfies Record<string, "owner-history" | "co-deleted">;

/**
 * Provider accounting a user deletion refuses to discard (retained history):
 * the hot-path accounting tables (no foreign key, a policy) and the graph-side
 * pricing and audit tables (also ON DELETE RESTRICT). Every table carries
 * `userId`, so "no row with this userId" is exactly "nothing to retain".
 * `provider_credential.replacedById` (rotation history inside the user's own
 * credentials) is checked apart.
 */
export const OWNER_RETAINED_HISTORY_TABLES = [
  "provider_attempt",
  "public_provider_attempt_event",
  "provider_usage_ledger",
  "provider_budget_reservation",
  "provider_pricing_version",
  "provider_audit_event",
] as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The user has retained provider history ({@link OWNER_RETAINED_HISTORY_TABLES}).
 * Raised before anything is drained. Permanent: retrying cannot help.
 */
export class RetainedHistoryError extends Error {
  readonly code = "RETAINED_HISTORY";
  constructor(readonly blocker: string) {
    super(`Retained ${blocker} history blocks this delete.`);
    this.name = "RetainedHistoryError";
  }
}

/** The DB shutdown fence armed mid-drain; the next run resumes. Transient. */
export class ParentDeletionInterruptedError extends Error {
  readonly code = "PARENT_DELETION_INTERRUPTED";
  constructor() {
    super("The delete was interrupted by shutdown before it finished. Retry.");
    this.name = "ParentDeletionInterruptedError";
  }
}

type DrainBudget = {
  maxRows: number;
  maxLoopIterations: number;
  rowsProcessed: number;
  loopIterations: number;
};

function drainBudgetExceeded(budget: DrainBudget): boolean {
  return (
    budget.rowsProcessed >= budget.maxRows || budget.loopIterations >= budget.maxLoopIterations
  );
}

function noteDrainWork(budget: DrainBudget, rows: number): void {
  budget.rowsProcessed += rows;
  budget.loopIterations += 1;
  if (drainBudgetExceeded(budget)) {
    throw new ParentDeletionDrainPendingError(
      "Parent deletion history drain reached its work bound; retry later.",
    );
  }
}

const PERMANENT_CODES = new Set(["RETAINED_HISTORY", "P2003", "P2014", "23503", "23514"]);

/**
 * SQLSTATE 55000 (object_not_in_prerequisite_state) is what the hardening
 * triggers (schema-hardening.sql) raise for both kinds of refusal:
 *
 * - permanent: a table that refuses every DELETE (append-only history,
 *   `provider_attempt`, budget reservations, budget rules). Retrying the same
 *   delete hits the same trigger;
 * - transient: the relay execution attempt state checks (identity, active
 *   ownership, terminal immutability, heartbeat), which a delete can meet
 *   while an attempt is being finalized concurrently. The next try sees the
 *   settled row.
 *
 * So a 55000 is transient (retried with the sweep's backoff) unless its
 * message is one of the permanent refusals below. Keep this list in step
 * with the refusing triggers in schema-hardening.sql.
 */
const OBJECT_NOT_IN_PREREQUISITE_STATE = "55000";
const PERMANENT_55000_MESSAGES: readonly RegExp[] = [
  /\bis append-only\b/,
  /\bprovider_attempt is durable history\b/,
  /\bprovider budget reservations cannot be deleted\b/,
  /\bprovider budget rules are immutable\b/,
];

function isPermanent55000(candidate: object): boolean {
  for (const key of ["message", "originalMessage"]) {
    const message = Reflect.get(candidate, key);
    if (typeof message === "string" && PERMANENT_55000_MESSAGES.some((re) => re.test(message)))
      return true;
  }
  return false;
}

/**
 * True for failures a retry cannot fix: retained history, a foreign-key or
 * check violation (a database invariant refused the delete), or a 55000 from
 * a trigger that refuses every delete of its table. Other 55000s, deadlocks,
 * serialization failures, timeouts, lost connections and shutdown are
 * transient.
 */
export function isPermanentParentDeletionFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (typeof code !== "string") continue;
      if (PERMANENT_CODES.has(code)) return true;
      // The message sits next to the SQLSTATE on the same object (the
      // driver-adapter cause, or a raw query's `meta`).
      if (code === OBJECT_NOT_IN_PREREQUISITE_STATE && isPermanent55000(candidate)) return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scope resolution (read-only, no locks)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 1: preflight
// ---------------------------------------------------------------------------

/**
 * Returns the kind of retained history that refuses the delete, or null.
 * Covers every RESTRICT edge in {@link RETAINED_HISTORY_EDGES} and the
 * provider accounting policy ({@link OWNER_RETAINED_HISTORY_TABLES}).
 */
export async function findRetainedHistoryBlocker(
  db: Db,
  parents: DeletedParents,
): Promise<string | null> {
  for (const userId of parents.user) {
    for (const table of OWNER_RETAINED_HISTORY_TABLES) {
      const rows = await db.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS one FROM ${Prisma.raw(table)} WHERE "userId" = ${userId} LIMIT 1`;
      if (rows.length > 0) return "provider accounting";
    }
    const rotated = await db.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM provider_credential
       WHERE "userId" = ${userId} AND "replacedById" IS NOT NULL LIMIT 1`;
    if (rotated.length > 0) return "provider credential rotation";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 2: drain
// ---------------------------------------------------------------------------

export type ParentDeletionDrainReport = Record<string, number>;

const TERMINAL_RELAY = Prisma.sql`('SUCCEEDED', 'FAILED', 'CANCELED')`;
const TERMINAL_ADMISSION = Prisma.sql`('CANCELLED', 'EXPIRED', 'TERMINAL')`;

/**
 * The deletion generation a whole-user drain works for. Every drain batch of
 * a user deletion (and its impersonation-session delete) first takes the
 * user row FOR SHARE on `deletionGeneration = generation`, in the batch's own
 * transaction: an abandon, restore or new mark (each an UPDATE of that row)
 * waits for the batch in flight, and once it commits no later batch of this
 * generation finds its row, so nothing is deleted for a withdrawn generation.
 */
export type UserDeletionOwner = { userId: string; generation: string };

/**
 * Upper bound on any single lock wait inside a drain batch (`lock_timeout`,
 * transaction-local). Batches take their own rows with SKIP LOCKED; the waits
 * left are the owner check above, the ON DELETE CASCADE children of a deleted
 * terminal relay request (execution rows), and the requester-rollup merge's
 * destination rows and FK parents. A wait past this bound rolls the batch
 * back and the drain reports pending ({@link ParentDeletionDrainPendingError}):
 * a user deletion stays marked for the sweeper, a parent delete answers
 * CONFLICT. It also bounds how long an abandon or restore waits for a batch
 * that holds the user row.
 */
export const PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS = 2_000;

/**
 * Upper bound on any single statement inside a drain batch
 * (`statement_timeout`, transaction-local). `lock_timeout` bounds each
 * individual lock acquisition, so a DELETE whose ON DELETE CASCADE waits on
 * several locked rows in turn runs for the sum of those waits without any one
 * reaching the lock timeout (a four-row cascade ran 6 s under a 2 s
 * `lock_timeout`). The statement timeout bounds each statement of the batch
 * (and so the batch, which is a few statements), for every caller: request
 * paths on the shared client, which has no other server-side bound, answer
 * pending instead of waiting on the cascade. A statement past this bound
 * raises SQLSTATE 57014, which {@link runParentDeletionDrainBatch} maps to
 * {@link ParentDeletionDrainPendingError} the same way as 55P03.
 *
 * The user-deletion sweep runs on its own client whose connections carry a
 * server-side `statement_timeout` for every statement of the tick, inside a
 * batch or not (`createUserDeletionSweepClient`,
 * apps/server/src/user-deletion-sweep.ts). Inside a batch this
 * transaction-local value overrides that one, so it too must let an ordinary
 * statement settle inside the sweep's shutdown join;
 * `apps/server/src/shutdown-timeouts.test.ts` pins both. (Neither bounds the
 * end of a transaction; shutdown quarantines the sweep's client when the
 * join runs out instead.)
 * Kept well above a normal batch's runtime (an ordinary batch is one bounded
 * statement over at most {@link PARENT_DELETION_DRAIN_BATCH} rows).
 */
export const PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS = 3_000;

/** Interactive-transaction cap of one drain batch (bounded work plus bounded waits). */
const DRAIN_BATCH_TRANSACTION_TIMEOUT_MS = 60_000;

type DrainTx = Prisma.TransactionClient;

/**
 * Takes the user row FOR SHARE when it still carries the owner's deletion
 * generation; throws {@link UserDeletionGenerationChangedError} otherwise.
 * Lock order: this is the first lock of its batch transaction, which takes
 * no fence; the rows the batch takes afterwards are the user's history rows
 * (SKIP LOCKED) and their bounded H-internal cascades. The user delete takes
 * the same row FOR UPDATE after its fences, and no drain batch waits on a
 * fence or a graph row, so the two cannot wait on each other in a cycle.
 */
async function lockUserDeletionOwner(tx: DrainTx, owner: UserDeletionOwner): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user"
     WHERE id = ${owner.userId} AND "deletionGeneration" = ${owner.generation}
       FOR SHARE`;
  if (rows.length === 0) throw new UserDeletionGenerationChangedError();
}

/**
 * Runs one drain batch in its own short transaction: the batch timeouts
 * first (`lock_timeout` and `statement_timeout`), then (for a user deletion)
 * the owner check, then `work`. Either timeout (55P03 or 57014) becomes
 * {@link ParentDeletionDrainPendingError} carrying its SQLSTATE; the batch
 * rolled back, so a smaller retry (see {@link drainParentDeletionHistory}) or
 * the next run resumes it. 57014 is deliberately NOT a permanent failure
 * ({@link isPermanentParentDeletionFailure}), so a timeout can never abandon
 * or archive a user.
 *
 * Exported as the batch boundary: the timeout mapping (55P03 and 57014) is
 * exercised against real PostgreSQL through this function.
 */
export async function runParentDeletionDrainBatch<T>(
  db: Db,
  owner: UserDeletionOwner | undefined,
  work: (tx: DrainTx) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS}ms`}, true)`;
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS}ms`}, true)`;
        if (owner) await lockUserDeletionOwner(tx, owner);
        return work(tx);
      },
      { timeout: DRAIN_BATCH_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    const timeout = serverTimeoutSqlState(error);
    if (timeout !== undefined) {
      throw new ParentDeletionDrainPendingError(
        "Parent deletion history drain is waiting on a busy row; retry later.",
        { timeout },
      );
    }
    throw error;
  }
}

/**
 * Smallest batch the drain shrinks to after statement timeouts
 * ({@link drainParentDeletionHistory}). From the default
 * {@link PARENT_DELETION_DRAIN_BATCH} that is at most three halvings, so a
 * batch that keeps timing out costs at most three extra batch attempts
 * before the drain reports pending. Each attempt is a whole batch
 * transaction: its settings, the owner check and up to four work
 * statements, each under its own statement bound. This caps retries; it is
 * not a wall-clock deadline for the drain.
 */
export const PARENT_DELETION_DRAIN_MIN_BATCH = 625;

/** The drain's current batch size, shared by every step of one run. */
type AdaptiveBatch = { limit: number; readonly floor: number };

async function drainLoop(
  report: ParentDeletionDrainReport,
  label: string,
  budget: DrainBudget,
  size: AdaptiveBatch,
  step: () => Promise<number>,
): Promise<void> {
  report[label] ??= 0;
  for (;;) {
    // Between batches only: a batch is one short transaction, and the
    // residual is picked up by the next run.
    if (isDbShutdownFenceArmed()) throw new ParentDeletionInterruptedError();
    let processed: number;
    try {
      processed = await step();
    } catch (error) {
      // A batch cancelled by its statement bound (57014) did too much work
      // for one statement (a large DELETE right after a bulk insert, with
      // stale statistics or autovacuum running). It rolled back, so retry
      // it smaller. A lock wait (55P03) is another session's lock: a smaller
      // batch would wait on it just the same, so it reports pending at once.
      if (
        error instanceof ParentDeletionDrainPendingError &&
        error.timeout === "57014" &&
        size.limit > size.floor
      ) {
        size.limit = Math.max(size.floor, Math.floor(size.limit / 2));
        report["batch.halved"] = (report["batch.halved"] ?? 0) + 1;
        continue;
      }
      throw error;
    }
    noteDrainWork(budget, processed);
    report[label] = (report[label] ?? 0) + processed;
    // Zero means drained, or only rows another transaction holds remain
    // (SKIP LOCKED); the history sweeper purges those after the delete.
    if (processed === 0) return;
  }
}

/**
 * Drains the deleted user's own hot-path history (the rows
 * `HISTORY_DRAIN_EDGES` names by user), in bounded batches that never wait on
 * a row they skipped and wait on any other row lock at most
 * {@link PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS}. Leaf tables first, so no
 * batch cascades further than its own H-internal children. Returns rows
 * processed per step. Parents other than a user have no history to drain:
 * nothing references them by foreign key, and their history keeps plain ids.
 *
 * A drain that includes a whole user must name the deletion generation it
 * works for (`owner`); every batch is then bound to it (see
 * {@link UserDeletionOwner}) and the drain throws
 * `UserDeletionGenerationChangedError` once the generation is withdrawn.
 *
 * Adaptive batch: a batch cancelled by its statement bound (57014) is retried
 * at half the size, down to {@link PARENT_DELETION_DRAIN_MIN_BATCH}, and the
 * rest of the run keeps the smaller size (`batch.halved` in the report counts
 * the halvings). A timeout at the floor, or any lock timeout (55P03), reports
 * pending. The shutdown fence is still checked before every retry.
 */
export type ParentDeletionDrainOptions = {
  batch?: number;
  maxRowsPerRun?: number;
  maxLoopIterations?: number;
  /** Defaults to {@link PARENT_DELETION_MAX_PASSED_ADMISSIONS}. */
  maxPassedAdmissions?: number;
  /** Required when the drained parents include a user row. */
  owner?: UserDeletionOwner;
};

function assertDrainOwner(parents: DeletedParents, owner: UserDeletionOwner | undefined): void {
  if (parents.user.length === 0) return;
  if (!owner || parents.user.some((userId) => userId !== owner.userId)) {
    throw new ParentDeletionOwnerRequiredError();
  }
}

export async function drainParentDeletionHistory(
  db: Db,
  parents: DeletedParents,
  {
    batch = PARENT_DELETION_DRAIN_BATCH,
    maxRowsPerRun = PARENT_DELETION_MAX_DRAIN_ROWS_PER_RUN,
    maxLoopIterations = PARENT_DELETION_MAX_DRAIN_LOOP_ITERATIONS,
    maxPassedAdmissions = PARENT_DELETION_MAX_PASSED_ADMISSIONS,
    owner,
  }: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  assertDrainOwner(parents, owner);
  const report: ParentDeletionDrainReport = {};
  const initial = Math.max(1, Math.trunc(batch));
  const size: AdaptiveBatch = {
    limit: initial,
    floor: Math.min(initial, PARENT_DELETION_DRAIN_MIN_BATCH),
  };
  const budget: DrainBudget = {
    maxRows: maxRowsPerRun,
    maxLoopIterations,
    rowsProcessed: 0,
    loopIterations: 0,
  };
  const inBatch = (work: (tx: DrainTx) => Promise<number>) =>
    runParentDeletionDrainBatch(db, owner, work);

  const stickinessDelete = edgeFilters(
    "s",
    HISTORY_DRAIN_EDGES.response_stickiness_record.delete,
    parents,
  );
  if (stickinessDelete.length > 0)
    await drainLoop(report, "response_stickiness_record.delete", budget, size, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM response_stickiness_record
         WHERE id IN (
           SELECT s.id FROM response_stickiness_record s
            WHERE ${Prisma.join(stickinessDelete, " OR ")}
            LIMIT ${size.limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );

  const affinityDelete = edgeFilters(
    "a",
    HISTORY_DRAIN_EDGES.cache_affinity_record.delete,
    parents,
  );
  if (affinityDelete.length > 0)
    await drainLoop(report, "cache_affinity_record.delete", budget, size, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM cache_affinity_record
         WHERE id IN (
           SELECT a.id FROM cache_affinity_record a
            WHERE ${Prisma.join(affinityDelete, " OR ")}
            LIMIT ${size.limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );

  const affinityNodeDelete = edgeFilters(
    "a",
    HISTORY_DRAIN_EDGES.cache_affinity_node.delete,
    parents,
  );
  if (affinityNodeDelete.length > 0)
    await drainLoop(report, "cache_affinity_node.delete", budget, size, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM cache_affinity_node
         WHERE id IN (
           SELECT a.id FROM cache_affinity_node a
            WHERE ${Prisma.join(affinityNodeDelete, " OR ")}
            LIMIT ${size.limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );

  // The user's terminal admission requests, with their waiters and lease
  // (H-internal ON DELETE CASCADE). The DELETE cascades into every waiter of
  // the request, and a waiter another transaction holds would make it wait.
  // So each batch first takes its requests and then all their waiters with
  // SKIP LOCKED, and deletes only the requests whose every waiter it now
  // holds: the cascade then touches only rows this transaction already
  // locked, plus the lease, which only an admitter holding the request row
  // writes. A request with a busy waiter is passed, not retried, in this run
  // (the history sweeper takes it after the delete).
  const admissionFilters = edgeFilters("r", HISTORY_DRAIN_EDGES.admission_request.delete, parents);
  if (admissionFilters.length > 0) {
    const passed: string[] = [];
    report["admission_request.passed"] ??= 0;
    // The scan label counts candidates examined (busy ones included), which
    // is what drives loop termination; the delete label counts only the rows
    // actually deleted.
    report["admission_request.delete"] ??= 0;
    await drainLoop(report, "admission_request.scan", budget, size, () =>
      inBatch(async (tx) => {
        const candidates = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM admission_request r
           WHERE r.state IN ${TERMINAL_ADMISSION}
             AND (${Prisma.join(admissionFilters, " OR ")})
             AND NOT (r.id = ANY(${passed}::text[]))
           LIMIT ${size.limit}
             FOR UPDATE OF r SKIP LOCKED`;
        if (candidates.length === 0) return 0;
        const ids = candidates.map((row) => row.id);
        const held = await tx.$queryRaw<Array<{ admissionRequestId: string }>>`
          SELECT "admissionRequestId" FROM capacity_waiter
           WHERE "admissionRequestId" = ANY(${ids}::text[])
             FOR UPDATE SKIP LOCKED`;
        const totals = await tx.$queryRaw<Array<{ admissionRequestId: string; total: bigint }>>`
          SELECT "admissionRequestId", count(*) AS total FROM capacity_waiter
           WHERE "admissionRequestId" = ANY(${ids}::text[])
           GROUP BY "admissionRequestId"`;
        const heldByRequest = new Map<string, number>();
        for (const row of held)
          heldByRequest.set(
            row.admissionRequestId,
            (heldByRequest.get(row.admissionRequestId) ?? 0) + 1,
          );
        const busy = new Set(
          totals
            .filter((row) => (heldByRequest.get(row.admissionRequestId) ?? 0) < Number(row.total))
            .map((row) => row.admissionRequestId),
        );
        passed.push(...busy);
        report["admission_request.passed"] = (report["admission_request.passed"] ?? 0) + busy.size;
        if (passed.length > maxPassedAdmissions) {
          throw new ParentDeletionDrainPendingError(
            "Parent deletion history drain passed too many busy admission requests; retry later.",
          );
        }
        const eligible = ids.filter((id) => !busy.has(id));
        const deletedRows =
          eligible.length > 0
            ? await tx.$executeRaw`
                DELETE FROM admission_request r WHERE r.id = ANY(${eligible}::text[])`
            : 0;
        report["admission_request.delete"] =
          (report["admission_request.delete"] ?? 0) + deletedRows;
        // Candidates, busy or not: the loop ends when none is left.
        return candidates.length;
      }),
    );
  }

  // relay_request owned by a deleted user: delete terminal rows (their
  // execution events and attempts cascade) through the shared helper that
  // takes the referencing admission rows and the relay rows with SKIP LOCKED.
  // Keyset order over the ("userId", "createdAt", id) index, so each batch
  // starts past the rows earlier batches deleted instead of rescanning their
  // dead index entries. A row the helper skipped (busy) is passed, not
  // retried: the history sweeper takes the residual after the delete.
  for (const userId of parents.user) {
    let cursor: { createdAt: Date; id: string } | null = null;
    report["relay_request.delete"] ??= 0;
    await drainLoop(report, "relay_request.scan", budget, size, () =>
      inBatch(async (tx) => {
        const after = cursor;
        // No creation cutoff: the keyset cursor only moves forward and the
        // shared budget bounds the scan, so rows arriving during the drain are
        // taken until the budget says pending. After a user's deletion mark
        // nothing new may authenticate as the user, so the tail is the
        // requests already in flight at the mark.
        const rows: Array<{ id: string; createdAt: Date }> = after
          ? await tx.$queryRaw`
              SELECT id, "createdAt" FROM relay_request
               WHERE "userId" = ${userId} AND status IN ${TERMINAL_RELAY}
                 AND ("createdAt", id) > (${after.createdAt}, ${after.id})
               ORDER BY "createdAt", id
               LIMIT ${size.limit}`
          : await tx.$queryRaw`
              SELECT id, "createdAt" FROM relay_request
               WHERE "userId" = ${userId} AND status IN ${TERMINAL_RELAY}
               ORDER BY "createdAt", id
               LIMIT ${size.limit}`;
        const last = rows.at(-1);
        if (!last) return 0;
        const deleted = await deleteTerminalRelayRequestsWithoutWaiting(
          tx,
          rows.map((row) => row.id),
        );
        // Only after the batch's work: a rolled-back batch is scanned again.
        cursor = { createdAt: last.createdAt, id: last.id };
        report["relay_request.delete"] = (report["relay_request.delete"] ?? 0) + deleted;
        return rows.length;
      }),
    );
  }

  // Usage rollups owned by a deleted user.
  for (const userId of parents.user) {
    await drainLoop(report, "usage_rollup_minute.delete", budget, size, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM usage_rollup_minute
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_minute
            WHERE "ownerUserId" = ${userId}
            LIMIT ${size.limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );
    await drainLoop(report, "usage_rollup_hour.delete", budget, size, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM usage_rollup_hour
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_hour
            WHERE "ownerUserId" = ${userId}
            LIMIT ${size.limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );
    // The merge into other owners' sentinel rows can wait on a destination
    // row (a finalizer or compaction holds it); the batch's lock_timeout
    // bounds that wait and the drain reports pending.
    await drainLoop(report, "usage_rollup_requester", budget, size, () =>
      inBatch((tx) => drainRequesterUsageRollupsBatch(tx, userId, size.limit)),
    );
  }

  // History tables keyed by a plain user id (no foreign key, so no cascade).
  for (const userId of parents.user) {
    for (const [table, { userColumn }] of Object.entries(USER_PLAIN_ID_HISTORY_TABLES)) {
      const from = Prisma.raw(`"${table}"`);
      const column = Prisma.raw(`"${userColumn}"`);
      await drainLoop(report, `${table}.delete`, budget, size, () =>
        inBatch(
          (tx) => tx.$executeRaw`
          DELETE FROM ${from}
           WHERE ctid IN (
             SELECT ctid FROM ${from}
              WHERE ${column} = ${userId}
              LIMIT ${size.limit}
                FOR UPDATE SKIP LOCKED)`,
        ),
      );
    }
  }
  return report;
}

/**
 * Phases 1 and 2 for a delete of `scope`: refuses retained history, then
 * drains. The caller runs its delete (phase 3) next. Only a whole-user scope
 * has anything to check or drain; it needs `options.owner` (see
 * {@link drainParentDeletionHistory}).
 */
export async function prepareParentDeletion(
  db: Db,
  scope: ParentDeletionScope,
  options: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  if (scope.wholeUser !== true) return {};
  const parents = await resolveDeletedParents(db, scope);
  assertDrainOwner(parents, options.owner);
  const blocker = await findRetainedHistoryBlocker(db, parents);
  if (blocker) throw new RetainedHistoryError(blocker);
  return drainParentDeletionHistory(db, parents, options);
}

// ---------------------------------------------------------------------------
// Users: durable intent, completion and the sweeper's queue
// ---------------------------------------------------------------------------

export const USER_DELETION_BAN_REASON = "Account deletion in progress";
export const USER_DELETION_FAILED_BAN_REASON =
  "Account deletion could not complete; the account was archived instead";

/**
 * Transaction-local setting the `user_deletion_marker_guard` trigger
 * (schema-hardening.sql) requires before a pending deletion's marker is
 * cleared or its generation rewritten. Only {@link abandonUserDeletion} sets
 * it.
 */
export const USER_DELETION_WRITER_SETTING = "wsmp.user_deletion_writer";

/** A user's deletion generation as recorded by {@link requestUserDeletion}. */
export type UserDeletionMark = {
  /** Identity of the generation; every later transition is predicated on it. */
  generation: string;
  /** True when this call started the generation (the marker was absent). */
  created: boolean;
};

/**
 * Records the durable intent to delete a user: `deletionRequestedAt` and a
 * fresh `deletionGeneration` (both kept if a deletion is already pending), an
 * indefinite ban, and the removal of every browser session the user acts
 * through (`userId`, or `impersonatedBy` for sessions they impersonate
 * another user with), in one short transaction. Returns null when the user
 * does not exist. The `session_refuse_deleting_user` trigger refuses later
 * inserts for either principal, so none reappears while the mark stands.
 *
 * The marker and the generation are written together here and cleared
 * together by {@link abandonUserDeletion}; nothing else writes either (the
 * row delete removes both). Access is refused on the marker alone
 * (`@ws-model-proxy/db/user-deletion-access`), whatever the ban fields later
 * hold.
 */
export async function requestUserDeletion(
  db: Db,
  userId: string,
): Promise<UserDeletionMark | null> {
  const candidate = randomUUID();
  const [rows] = await db.$transaction([
    db.$queryRaw<Array<{ generation: string }>>`
      UPDATE "user"
         SET "deletionRequestedAt" = COALESCE("deletionRequestedAt", now()),
             "deletionGeneration" = CASE
               WHEN "deletionRequestedAt" IS NULL THEN ${candidate}
               ELSE COALESCE("deletionGeneration", ${candidate}) END,
             "deletionSweepAttempts" = CASE
               WHEN "deletionRequestedAt" IS NULL THEN 0 ELSE "deletionSweepAttempts" END,
             "deletionSweepLastAttemptAt" = CASE
               WHEN "deletionRequestedAt" IS NULL THEN NULL ELSE "deletionSweepLastAttemptAt" END,
             "deletionSweepNextAttemptAt" = CASE
               WHEN "deletionRequestedAt" IS NULL THEN NULL ELSE "deletionSweepNextAttemptAt" END,
             banned = true,
             "banReason" = ${USER_DELETION_BAN_REASON},
             "banExpires" = NULL,
             "updatedAt" = now()
       WHERE id = ${userId}
       RETURNING "deletionGeneration" AS generation`,
    // Every session the user acts through: their own and the ones they
    // impersonate another user with (Better Auth `impersonatedBy`, no FK).
    db.session.deleteMany({ where: { OR: [{ userId }, { impersonatedBy: userId }] } }),
  ]);
  const generation = rows[0]?.generation;
  if (!generation) return null;
  return { generation, created: generation === candidate };
}

/**
 * Clears the intent of generation `generation` after a permanent failure and
 * archives the user: the same statement that clears the marker sets an
 * indefinite ban (`banned = true`, `banExpires = NULL`), so the result does
 * not depend on ban fields another writer changed while the deletion was
 * pending (a Better Auth unban or ban-with-expiry whose guard read preceded
 * the mark). Archiving is the fallback the refusal recommends. A no-op when
 * the user carries another generation (a newer deletion was requested
 * meanwhile) or none. Returns whether this generation was abandoned.
 */
export async function abandonUserDeletion(
  db: Db,
  userId: string,
  generation: string,
): Promise<boolean> {
  // The `user_deletion_marker_guard` trigger (schema-hardening.sql) refuses
  // to clear a marker unless this transaction-local setting is on: the
  // deletion subsystem is the marker's only clearing writer.
  const [, cleared] = await db.$transaction([
    db.$executeRaw`SELECT set_config(${USER_DELETION_WRITER_SETTING}, 'on', true)`,
    db.$executeRaw`
    UPDATE "user"
       SET "deletionRequestedAt" = NULL,
           "deletionGeneration" = NULL,
           "deletionSweepAttempts" = 0,
           "deletionSweepLastAttemptAt" = NULL,
           "deletionSweepNextAttemptAt" = NULL,
           banned = true,
           "banExpires" = NULL,
           "banReason" = ${USER_DELETION_FAILED_BAN_REASON},
           "updatedAt" = now()
     WHERE id = ${userId} AND "deletionGeneration" = ${generation}`,
  ]);
  return cleared === 1;
}

/**
 * Phases 1-3 for deletion generation `generation` of a user marked by
 * {@link requestUserDeletion}. Returns false when the user no longer exists
 * or no longer carries that generation. Every destructive effect is bound to
 * the generation under the user row lock: the impersonation-session delete
 * and each drain batch take the row FOR SHARE on the generation first (see
 * {@link UserDeletionOwner}), and the final delete checks it under the user
 * row lock (`deleteUserUnderOwnerFences`). So once an abandon, restore or new
 * mark commits, a worker still holding this generation deletes nothing more.
 * Throws {@link RetainedHistoryError}, a permanent database refusal, a
 * {@link ParentDeletionDrainPendingError}, or a transient failure (see
 * {@link isPermanentParentDeletionFailure}).
 */
export async function completeUserDeletion(
  db: Db,
  userId: string,
  generation: string,
  options: Omit<ParentDeletionDrainOptions, "owner"> = {},
): Promise<boolean> {
  // Plain read, an early exit only: each effect below re-checks under a lock.
  const existing = await db.user.findUnique({
    where: { id: userId },
    select: { deletionGeneration: true },
  });
  if (existing?.deletionGeneration !== generation) return false;
  const owner: UserDeletionOwner = { userId, generation };
  try {
    // Impersonation sessions reference the user without a foreign key, so the
    // cascade misses them. The mark already deleted them and the trigger
    // refuses new ones; this covers users marked before either existed.
    await runParentDeletionDrainBatch(db, owner, (tx) =>
      tx.session.deleteMany({ where: { impersonatedBy: userId } }),
    );
    await prepareParentDeletion(db, { userId, wholeUser: true }, { ...options, owner });
  } catch (error) {
    if (error instanceof UserDeletionGenerationChangedError) return false;
    throw error;
  }
  return deleteUserUnderOwnerFences(db, userId, generation);
}

/**
 * - "deleted": the user row is gone (notify listeners).
 * - "missing": no such user.
 * - "pending": the intent is recorded but completion failed transiently or
 *   was interrupted; the sweeper finishes it.
 * - "abandoned": the user exists but its deletion was abandoned (a
 *   permanent refusal archived it) before this call could finish.
 */
export type DurableUserDeletionResult = "deleted" | "missing" | "pending" | "abandoned";

/**
 * The one user-delete entry point (dashboard users.remove and the Better
 * Auth delete hook): preflight, durable intent, then completion of the
 * generation the intent returned. Throws {@link RetainedHistoryError} before
 * recording anything when the delete cannot succeed, and rethrows a
 * permanent failure after abandoning its own generation.
 */
export async function deleteUserDurably(
  db: Db,
  userId: string,
  options: {
    batch?: number;
    onTransientFailure?: (error: unknown) => void;
    onMarked?: (userId: string) => void | Promise<void>;
  } = {},
): Promise<DurableUserDeletionResult> {
  const existing = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!existing) return "missing";
  const blocker = await findRetainedHistoryBlocker(
    db,
    await resolveDeletedParents(db, { userId, wholeUser: true }),
  );
  if (blocker) throw new RetainedHistoryError(blocker);
  const mark = await requestUserDeletion(db, userId);
  if (!mark) return "missing";
  if (mark.created) await options.onMarked?.(userId);
  let failure: unknown;
  try {
    if (await completeUserDeletion(db, userId, mark.generation, { batch: options.batch })) {
      return "deleted";
    }
  } catch (error) {
    if (isPermanentParentDeletionFailure(error)) {
      await abandonUserDeletion(db, userId, mark.generation);
      throw error;
    }
    failure = error;
  }
  const still = await db.user.findUnique({
    where: { id: userId },
    select: { deletionGeneration: true },
  });
  if (!still) return "missing";
  if (!still.deletionGeneration) return "abandoned";
  if (failure !== undefined) options.onTransientFailure?.(failure);
  return "pending";
}

/** A marked user as the sweeper selected it: the generation it will act on. */
export type PendingUserDeletion = {
  userId: string;
  generation: string;
  /** Transient failures of this generation so far (backoff exponent). */
  attempts: number;
};

/**
 * Position of the sweep's round-robin over the marked users: the immutable
 * sort key `(deletionRequestedAt, id)` of the last user it selected. It is a
 * keyset bound only; the user it names need not exist any more (deleted,
 * abandoned or marked again with a new `deletionRequestedAt`).
 */
export type UserDeletionSweepCursor = { requestedAt: Date; userId: string };

/**
 * Queue state of one sweep loop, owned by that loop and passed to each tick
 * (in memory only; a new process starts from the beginning). An empty object
 * starts from the oldest marked user.
 */
export type UserDeletionSweepQueue = { after?: UserDeletionSweepCursor };

/**
 * Eligible marked users (a recorded deletion intent older than `before`, with
 * no unexpired backoff at `now`), round-robin: in `(deletionRequestedAt, id)`
 * order starting strictly after `after`, wrapping to the oldest when fewer
 * than `limit` remain after it (no user twice). `next` is the key of the last
 * user selected, the `after` of the following call; it moves on whatever
 * happens to the selected users, so every eligible user is selected within
 * `ceil(eligible / limit)` calls even when completion and the backoff write
 * both fail (a user row held locked by another session). A plain read: no
 * row lock (no lock-order edge; ./capacity-lock-order.ts).
 */
export async function listPendingUserDeletions(
  db: Db,
  {
    before,
    limit = 10,
    now = new Date(),
    after,
  }: { before: Date; limit?: number; now?: Date; after?: UserDeletionSweepCursor },
): Promise<{ pending: PendingUserDeletion[]; next: UserDeletionSweepCursor | undefined }> {
  const eligible = {
    deletionRequestedAt: { not: null, lte: before },
    deletionGeneration: { not: null },
    OR: [{ deletionSweepNextAttemptAt: null }, { deletionSweepNextAttemptAt: { lte: now } }],
  };
  const query = {
    orderBy: [{ deletionRequestedAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      deletionGeneration: true,
      deletionSweepAttempts: true,
      deletionRequestedAt: true,
    },
    take: limit,
  };
  const rows = await db.user.findMany({
    ...query,
    where: after
      ? {
          AND: [
            eligible,
            {
              OR: [
                { deletionRequestedAt: { gt: after.requestedAt } },
                { deletionRequestedAt: after.requestedAt, id: { gt: after.userId } },
              ],
            },
          ],
        }
      : eligible,
  });
  if (after && rows.length < limit) {
    // Wrap: the oldest users, up to the page size, skipping any already taken.
    const taken = new Set(rows.map((row) => row.id));
    const wrapped = await db.user.findMany({ ...query, where: eligible });
    for (const row of wrapped) {
      if (rows.length >= limit) break;
      if (!taken.has(row.id)) rows.push(row);
    }
  }
  const last = rows.at(-1);
  const next =
    last?.deletionRequestedAt != null
      ? { requestedAt: last.deletionRequestedAt, userId: last.id }
      : undefined;
  const pending = rows.flatMap((row) =>
    row.deletionGeneration
      ? [
          {
            userId: row.id,
            generation: row.deletionGeneration,
            attempts: row.deletionSweepAttempts,
          },
        ]
      : [],
  );
  return { pending, next };
}

const SWEEP_BACKOFF_BASE_MS = 30_000;
const SWEEP_BACKOFF_MAX_MS = 30 * 60 * 1000;

/** Backoff before the next attempt after `attempt` transient failures (1-based), jittered. */
export function userDeletionSweepBackoffMs(attempt: number, random = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 10);
  const cap = Math.min(SWEEP_BACKOFF_MAX_MS, SWEEP_BACKOFF_BASE_MS * 2 ** exponent);
  return Math.floor(cap / 2 + random() * (cap / 2));
}

/**
 * Records a transient sweep failure of generation `generation` so other
 * pending users get a turn; a no-op when the user now carries another
 * generation (the stale worker must not delay a newer deletion).
 * `attempt` is this failure's 1-based count (selected attempts + 1).
 */
export async function recordUserDeletionSweepFailure(
  db: Db,
  userId: string,
  generation: string,
  { now = new Date(), attempt = 1 }: { now?: Date; attempt?: number } = {},
): Promise<void> {
  const next = new Date(now.getTime() + userDeletionSweepBackoffMs(attempt));
  await db.$executeRaw`
    UPDATE "user"
       SET "deletionSweepAttempts" = "deletionSweepAttempts" + 1,
           "deletionSweepLastAttemptAt" = ${now},
           "deletionSweepNextAttemptAt" = ${next},
           "updatedAt" = now()
     WHERE id = ${userId} AND "deletionGeneration" = ${generation}`;
}
