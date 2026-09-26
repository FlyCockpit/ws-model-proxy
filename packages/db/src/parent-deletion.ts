/**
 * Parent deletes with a bounded capacity-lock critical section (DL1-TXBOUND).
 *
 * An ordered parent delete (see `lockCapacityGraphForDelete` in
 * ./capacity-lock-order.ts) takes L0-L6 for everything its cascade can reach
 * and then runs the DELETE inside one READ COMMITTED transaction capped at
 * 15 s. The cascade's size is not bounded by configuration, though: a user,
 * pool, endpoint, model, device, member or capacity drags along its request
 * history (relay requests and their execution rows, terminal admission
 * requests and waiters, response-stickiness records, usage rollups). With a
 * large history the single transaction exceeded its budget on every retry,
 * and it held the capacity locks for the whole history delete.
 *
 * So every ordered parent delete runs in three phases:
 *
 *  1. Preflight ({@link findRetainedHistoryBlocker}). Retained history that
 *     the schema protects with ON DELETE RESTRICT (capacity leases, provider
 *     accounting) makes the final DELETE fail. The check runs before anything
 *     is drained, so a delete that cannot succeed removes nothing.
 *  2. Drain ({@link drainParentDeletionHistory}). The history rows the
 *     cascade would delete or SET NULL are processed in bounded batches, each
 *     batch its own short transaction that takes the rows it deletes or
 *     rewrites with SKIP LOCKED, like the retention sweeper, and takes no
 *     capacity lock. A terminal admission request is deleted only together
 *     with every one of its waiters, all taken with SKIP LOCKED first, so its
 *     cascade never waits on a waiter the batch skipped. The waits left (the
 *     execution rows of a terminal relay request, whose writers take no
 *     admission or capacity lock, and the requester-rollup merge) are bounded
 *     by a transaction-local `lock_timeout`
 *     ({@link PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS}); a timeout rolls the
 *     batch back and reports pending. Every statement of a batch is also
 *     bounded by a transaction-local `statement_timeout`
 *     ({@link PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS}): a cascade that
 *     waits on several rows in turn can outlast any single `lock_timeout`
 *     without one wait reaching it, so the statement bound is what stops a
 *     batch growing with the number of locked rows (for a request, which
 *     then answers pending instead of hanging). Batches are idempotent: a crash, a
 *     shutdown fence, a timeout or an error leaves only rows the next run
 *     processes. The drain never touches live rows (PENDING relay requests,
 *     WAITING/ADMITTED admission requests) nor RESTRICT-protected history;
 *     those stay for phase 3.
 *  3. The ordered delete, now over the capacity graph plus the residual
 *     that arrived during the drain. That is what the capacity locks are held
 *     for. The residual is bounded inside that transaction: after its last
 *     lock, `lockCapacityGraphForDelete` re-counts it and refuses (pending /
 *     CONFLICT) above {@link PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS}
 *     (./parent-deletion-residual.ts).
 *
 * The table-level contract (which history tables are drained through which
 * foreign keys, which RESTRICT edges the preflight covers) is data below and
 * is checked against the Prisma schema by
 * packages/api/src/lib/parent-deletion-catalog.test.ts, so a new foreign key
 * into the deleted graph fails a test instead of silently growing the locked
 * cascade.
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
 * Other parents need no marker: until phase 3 commits the parent is intact
 * and fully usable, the drained rows are exactly those its requested delete
 * removes or detaches, and re-issuing the delete resumes the drain.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  deleteTerminalRelayRequestsWithoutWaiting,
  deleteUserInCapacityLockOrder,
  UserDeletionGenerationChangedError,
} from "./capacity-lock-order";
import {
  countFinalPhaseResidualRows,
  type DeletedParents,
  edgeFilters,
  HISTORY_DRAIN_EDGES,
  PARENT_DELETION_DRAIN_BATCH,
  PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS,
  ParentDeletionDrainPendingError,
  ParentDeletionOwnerRequiredError,
  type ParentDeletionScope,
  resolveDeletedParents,
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

// The contract data, parent resolution and residual count are shared with
// the in-transaction recount of ./capacity-lock-order.ts.
export {
  countFinalPhaseResidualRows,
  type DeletedParents,
  type DeletedParentTable,
  HISTORY_DRAIN_EDGES,
  PARENT_DELETE_TRIGGER_WORK,
  PARENT_DELETION_DRAIN_BATCH,
  PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS,
  ParentDeletionDrainPendingError,
  ParentDeletionOwnerRequiredError,
  type ParentDeletionScope,
  resolveDeletedParents,
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
 * DELETE cannot trip it after a passing preflight. `lease` and
 * `owner-history` are checked by {@link findRetainedHistoryBlocker};
 * `co-deleted` edges point between two rows the same cascade deletes and do
 * not fail it (the P1 fixture: a user with a target on its capacity deletes).
 */
export const RETAINED_HISTORY_EDGES = {
  "capacity_lease.capacityId": "lease",
  "capacity_lease.executionTargetId": "lease",
  "capacity_lease.poolId": "lease",
  "capacity_lease.poolMemberId": "lease",
  "execution_target.inferenceCapacityId": "co-deleted",
  "provider_credential.replacedById": "owner-history",
  "provider_budget_reservation.policyId": "owner-history",
  "provider_budget_reservation.ruleId": "owner-history",
  "provider_budget_reservation.credentialId": "owner-history",
  "provider_attempt.userId": "owner-history",
  "provider_attempt.providerAccountId": "owner-history",
  "provider_attempt.providerModelId": "owner-history",
  "provider_attempt.credentialId": "owner-history",
  "public_provider_attempt_event.userId": "owner-history",
  "public_provider_attempt_event.providerAccountId": "owner-history",
  "public_provider_attempt_event.providerModelId": "owner-history",
  "provider_usage_ledger.userId": "owner-history",
  "provider_usage_ledger.providerAccountId": "owner-history",
  "provider_usage_ledger.providerModelId": "owner-history",
  "provider_usage_ledger.credentialId": "owner-history",
  "provider_pricing_version.providerAccountId": "owner-history",
  "provider_pricing_version.providerModelId": "owner-history",
  "provider_audit_event.userId": "owner-history",
} as const satisfies Record<string, "lease" | "owner-history" | "co-deleted">;

/**
 * Provider accounting tables with a RESTRICT edge into a user's graph (each
 * also refuses DELETE by trigger). Every such edge is composite with
 * `userId` or references the user itself, so "no row with this userId" is
 * exactly "no RESTRICT edge fires". `provider_credential.replacedById`
 * (rotation history inside the user's own credentials) is checked apart.
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
 * The delete would fail on retained history (ON DELETE RESTRICT). Raised
 * before anything is drained. Permanent: retrying cannot help.
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

const PERMANENT_CODES = new Set(["RETAINED_HISTORY", "P2003", "P2014", "23503", "23514", "55000"]);

/**
 * True for failures a retry cannot fix: retained history, a foreign-key or
 * check violation (a database invariant refused the delete). Deadlocks,
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
      if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
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
 * Returns the kind of retained history that makes the final DELETE fail, or
 * null. Covers every RESTRICT edge in {@link RETAINED_HISTORY_EDGES}.
 */
export async function findRetainedHistoryBlocker(
  db: Db,
  parents: DeletedParents,
): Promise<string | null> {
  const leaseFilters: Prisma.Sql[] = [];
  const add = (column: string, ids: string[]) => {
    if (ids.length > 0)
      leaseFilters.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ANY(${ids}::text[])`);
  };
  add("capacityId", parents.inference_capacity);
  add("executionTargetId", parents.execution_target);
  add("poolId", parents.model_pool);
  add("poolMemberId", parents.pool_member);
  if (leaseFilters.length > 0) {
    const leases = await db.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM capacity_lease WHERE ${Prisma.join(leaseFilters, " OR ")} LIMIT 1`;
    if (leases.length > 0) return "capacity lease";
  }
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
 * raises SQLSTATE 57014, which {@link isDrainTimeout} maps to
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
 * True for the two SQLSTATEs a drain batch's own timeouts raise: 55P03
 * (`lock_timeout` cancelled a lock wait) and 57014 (a `statement_timeout`
 * cancelled the statement, or PostgreSQL cancelled it on request). Both roll
 * the batch back and become {@link ParentDeletionDrainPendingError}; 57014 is
 * deliberately NOT in {@link PERMANENT_CODES}, so a timeout can never abandon
 * or archive a user.
 */
function isDrainTimeout(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (code === "55P03" || code === "57014") return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

/**
 * Takes the user row FOR SHARE when it still carries the owner's deletion
 * generation; throws {@link UserDeletionGenerationChangedError} otherwise.
 * Lock order: this is the first lock of its batch transaction, which takes
 * no capacity lock; the rows the batch takes afterwards are history rows
 * (SKIP LOCKED) and their bounded cascades. The ordered user delete takes
 * the same row FOR UPDATE only after its L0-L6 locks, and no drain batch
 * waits on an L0-L6 lock, so the two cannot wait on each other in a cycle.
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
 * the owner check, then `work`. Either timeout becomes
 * {@link ParentDeletionDrainPendingError}; the batch rolled back, so the next
 * run resumes it.
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
    if (isDrainTimeout(error)) {
      throw new ParentDeletionDrainPendingError(
        "Parent deletion history drain is waiting on a busy row; retry later.",
      );
    }
    throw error;
  }
}

async function drainLoop(
  report: ParentDeletionDrainReport,
  label: string,
  budget: DrainBudget,
  step: () => Promise<number>,
): Promise<void> {
  report[label] ??= 0;
  for (;;) {
    // Between batches only: a batch is one short transaction, and the
    // residual is picked up by the next run.
    if (isDbShutdownFenceArmed()) throw new ParentDeletionInterruptedError();
    const processed = await step();
    noteDrainWork(budget, processed);
    report[label] = (report[label] ?? 0) + processed;
    // Zero means drained, or only rows another transaction holds remain
    // (SKIP LOCKED); those go with the ordered delete.
    if (processed === 0) return;
  }
}

/**
 * Drains the history a delete of `parents` would cascade into, in bounded
 * batches that never wait on a row they skipped and wait on any other row
 * lock at most {@link PARENT_DELETION_DRAIN_LOCK_TIMEOUT_MS}. Leaf tables
 * first, so no batch cascades further than its own children. Returns rows
 * processed per step.
 *
 * A drain that includes a whole user must name the deletion generation it
 * works for (`owner`); every batch is then bound to it (see
 * {@link UserDeletionOwner}) and the drain throws
 * `UserDeletionGenerationChangedError` once the generation is withdrawn.
 */
export type ParentDeletionDrainOptions = {
  batch?: number;
  maxRowsPerRun?: number;
  maxLoopIterations?: number;
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
    owner,
  }: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  assertDrainOwner(parents, owner);
  const report: ParentDeletionDrainReport = {};
  const limit = Math.max(1, Math.trunc(batch));
  const budget: DrainBudget = {
    maxRows: maxRowsPerRun,
    maxLoopIterations,
    rowsProcessed: 0,
    loopIterations: 0,
  };
  const inBatch = (work: (tx: DrainTx) => Promise<number>) =>
    runParentDeletionDrainBatch(db, owner, work);

  // response_stickiness_record: CASCADE edges delete; the one SET NULL edge
  // (selectedDiscoveredModelId) only matters for a row none of the CASCADE
  // edges removes, handled after the deletes.
  const stickiness = HISTORY_DRAIN_EDGES.response_stickiness_record;
  const stickinessDelete = edgeFilters("s", stickiness.cascade, parents);
  if (stickinessDelete.length > 0)
    await drainLoop(report, "response_stickiness_record.delete", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM response_stickiness_record
         WHERE id IN (
           SELECT s.id FROM response_stickiness_record s
            WHERE ${Prisma.join(stickinessDelete, " OR ")}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );
  const stickinessNull = edgeFilters("s", stickiness.setNull, parents);
  if (stickinessNull.length > 0)
    await drainLoop(report, "response_stickiness_record.detach", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        UPDATE response_stickiness_record
           SET "selectedDiscoveredModelId" = NULL
         WHERE id IN (
           SELECT s.id FROM response_stickiness_record s
            WHERE ${Prisma.join(stickinessNull, " OR ")}
            LIMIT ${limit}
              FOR NO KEY UPDATE SKIP LOCKED)`,
      ),
    );

  // capacity_waiter rows of terminal requests that reference a deleted
  // capacity, target, pool or member (their own request may survive).
  const waiterFilters = edgeFilters("w", HISTORY_DRAIN_EDGES.capacity_waiter.cascade, parents);
  if (waiterFilters.length > 0)
    await drainLoop(report, "capacity_waiter.delete", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM capacity_waiter
         WHERE id IN (
           SELECT w.id FROM capacity_waiter w
             JOIN admission_request r ON r.id = w."admissionRequestId"
            WHERE r.state IN ${TERMINAL_ADMISSION}
              AND (${Prisma.join(waiterFilters, " OR ")})
            LIMIT ${limit}
              FOR UPDATE OF w SKIP LOCKED)`,
      ),
    );

  // Terminal admission requests the cascade deletes. A request with a lease
  // is RESTRICT-protected history; the preflight refused such a delete, and
  // the drain never removes one (the NOT EXISTS keeps it that way if a lease
  // appears after the preflight: the ordered delete then fails unchanged).
  //
  // The DELETE cascades into every waiter of the request, and a waiter another
  // transaction holds would make it wait (the waiter step above skipped it).
  // So each batch first takes its requests and then all their waiters with
  // SKIP LOCKED, and deletes only the requests whose every waiter it now
  // holds: the cascade then touches only rows this transaction already
  // locked. A request with a busy waiter is passed, not retried, in this run
  // (the ordered delete takes the residual).
  const admissionFilters = edgeFilters("r", HISTORY_DRAIN_EDGES.admission_request.cascade, parents);
  if (admissionFilters.length > 0) {
    const passed: string[] = [];
    report["admission_request.passed"] ??= 0;
    // The scan label counts candidates examined (busy ones included), which
    // is what drives loop termination; the delete label counts only the rows
    // actually deleted.
    report["admission_request.delete"] ??= 0;
    await drainLoop(report, "admission_request.scan", budget, () =>
      inBatch(async (tx) => {
        const candidates = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM admission_request r
           WHERE r.state IN ${TERMINAL_ADMISSION}
             AND (${Prisma.join(admissionFilters, " OR ")})
             AND NOT (r.id = ANY(${passed}::text[]))
             AND NOT EXISTS (
               SELECT 1 FROM capacity_lease l WHERE l."admissionRequestId" = r.id)
           LIMIT ${limit}
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
        if (passed.length > PARENT_DELETION_MAX_PASSED_ADMISSIONS) {
          throw new ParentDeletionDrainPendingError(
            "Parent deletion history drain passed too many busy admission requests; retry later.",
          );
        }
        const eligible = ids.filter((id) => !busy.has(id));
        const deletedRows =
          eligible.length > 0
            ? await tx.$executeRaw`
                DELETE FROM admission_request r
                 WHERE r.id = ANY(${eligible}::text[])
                   AND NOT EXISTS (
                     SELECT 1 FROM capacity_lease l WHERE l."admissionRequestId" = r.id)`
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
  // Keyset order over the ("userId", "createdAt") index, so each batch starts
  // past the rows earlier batches deleted instead of rescanning their dead
  // index entries. A row the helper skipped (busy) is passed, not retried:
  // the ordered delete takes the residual.
  for (const userId of parents.user) {
    let cursor: { createdAt: Date; id: string } | null = null;
    report["relay_request.delete"] ??= 0;
    await drainLoop(report, "relay_request.scan", budget, () =>
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
               LIMIT ${limit}`
          : await tx.$queryRaw`
              SELECT id, "createdAt" FROM relay_request
               WHERE "userId" = ${userId} AND status IN ${TERMINAL_RELAY}
               ORDER BY "createdAt", id
               LIMIT ${limit}`;
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

  // relay_request rows that reference a deleted parent through a SET NULL
  // edge: detach them the way the cascade would, columns of surviving
  // parents unchanged. Setting a foreign key to NULL takes no parent lock.
  const relayEdges = HISTORY_DRAIN_EDGES.relay_request.setNull.filter(
    ([, parent]) => parents[parent].length > 0,
  );
  if (relayEdges.length > 0) {
    const assignments = relayEdges.map(
      ([column, parent]) =>
        Prisma.sql`${Prisma.raw(`"${column}"`)} = CASE WHEN ${Prisma.raw(
          `"${column}"`,
        )} = ANY(${parents[parent]}::text[]) THEN NULL ELSE ${Prisma.raw(`"${column}"`)} END`,
    );
    const relayFilters = edgeFilters("q", relayEdges, parents);
    await drainLoop(report, "relay_request.detach", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        UPDATE relay_request
           SET ${Prisma.join(assignments, ", ")}
         WHERE id IN (
           SELECT q.id FROM relay_request q
            WHERE q.status IN ${TERMINAL_RELAY}
              AND (${Prisma.join(relayFilters, " OR ")})
            LIMIT ${limit}
              FOR NO KEY UPDATE SKIP LOCKED)`,
      ),
    );
  }

  // Usage rollups owned by a deleted user.
  for (const userId of parents.user) {
    await drainLoop(report, "usage_rollup_minute.delete", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM usage_rollup_minute
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_minute
            WHERE "ownerUserId" = ${userId}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );
    await drainLoop(report, "usage_rollup_hour.delete", budget, () =>
      inBatch(
        (tx) => tx.$executeRaw`
        DELETE FROM usage_rollup_hour
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_hour
            WHERE "ownerUserId" = ${userId}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
      ),
    );
    // The merge into other owners' sentinel rows can wait on a destination
    // row (a finalizer or compaction holds it) or an FK parent; the batch's
    // lock_timeout bounds that wait and the drain reports pending.
    await drainLoop(report, "usage_rollup_requester", budget, () =>
      inBatch((tx) => drainRequesterUsageRollupsBatch(tx, userId, limit)),
    );
  }
  return report;
}

/**
 * Phases 1 and 2 for a delete of `scope`: refuses retained history, then
 * drains. The caller runs its ordered delete (phase 3) next. A whole-user
 * scope needs `options.owner` (see {@link drainParentDeletionHistory}).
 */
export async function prepareParentDeletion(
  db: Db,
  scope: ParentDeletionScope,
  options: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  const parents = await resolveDeletedParents(db, scope);
  assertDrainOwner(parents, options.owner);
  const blocker = await findRetainedHistoryBlocker(db, parents);
  if (blocker) throw new RetainedHistoryError(blocker);
  const report = await drainParentDeletionHistory(db, parents, options);
  // Early exit only: rows committed after this count are counted again by
  // the ordered delete's in-transaction recount (lockCapacityGraphForDelete).
  const residual = await countFinalPhaseResidualRows(db, parents);
  if (residual > PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS) {
    throw new ParentDeletionDrainPendingError(
      "Parent deletion still has more history rows than the final delete may take; retry later.",
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// Users: durable intent, completion and the sweeper's queue
// ---------------------------------------------------------------------------

export const USER_DELETION_BAN_REASON = "Account deletion in progress";
export const USER_DELETION_FAILED_BAN_REASON =
  "Account deletion could not complete; the account was archived instead";

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
  const cleared = await db.$executeRaw`
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
     WHERE id = ${userId} AND "deletionGeneration" = ${generation}`;
  return cleared === 1;
}

/**
 * Phases 1-3 for deletion generation `generation` of a user marked by
 * {@link requestUserDeletion}. Returns false when the user no longer exists
 * or no longer carries that generation. Every destructive effect is bound to
 * the generation under the user row lock: the impersonation-session delete
 * and each drain batch take the row FOR SHARE on the generation first (see
 * {@link UserDeletionOwner}), and the final delete checks it under the L7
 * lock (`deleteUserInCapacityLockOrder`). So once an abandon, restore or new
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
  return deleteUserInCapacityLockOrder(db, userId, generation);
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

/** Users with a recorded deletion intent older than `before`, fairest first. */
export async function listPendingUserDeletions(
  db: Db,
  { before, limit = 10, now = new Date() }: { before: Date; limit?: number; now?: Date },
): Promise<PendingUserDeletion[]> {
  const rows = await db.user.findMany({
    where: {
      deletionRequestedAt: { not: null, lte: before },
      deletionGeneration: { not: null },
      OR: [{ deletionSweepNextAttemptAt: null }, { deletionSweepNextAttemptAt: { lte: now } }],
    },
    orderBy: [
      { deletionSweepNextAttemptAt: { sort: "asc", nulls: "first" } },
      { deletionRequestedAt: "asc" },
    ],
    select: { id: true, deletionGeneration: true, deletionSweepAttempts: true },
    take: limit,
  });
  return rows.flatMap((row) =>
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
