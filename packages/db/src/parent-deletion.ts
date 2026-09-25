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
 *     capacity lock. Only the cascade children of a deleted history row are
 *     not skipped: the waiters of a terminal admission request (nothing writes
 *     them after the request's terminal transition commits) and the
 *     execution rows of a terminal relay request (their writers take no
 *     admission or capacity lock). Batches are idempotent: a crash, a shutdown fence or an
 *     error leaves only rows the next run processes. The drain never touches
 *     live rows (PENDING relay requests, WAITING/ADMITTED admission requests)
 *     nor RESTRICT-protected history; those stay for phase 3.
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
 * backoff act only on the generation their worker selected.
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
} from "./capacity-lock-order";
import {
  countFinalPhaseResidualRows,
  type DeletedParents,
  edgeFilters,
  HISTORY_DRAIN_EDGES,
  PARENT_DELETION_DRAIN_BATCH,
  PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS,
  ParentDeletionDrainPendingError,
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
  type ParentDeletionScope,
  resolveDeletedParents,
} from "./parent-deletion-residual";

/** Max rows processed in one drain invocation; further work returns pending. */
export const PARENT_DELETION_MAX_DRAIN_ROWS_PER_RUN = 2_000_000;

/** Max inner drain-loop iterations per step label in one invocation. */
export const PARENT_DELETION_MAX_DRAIN_LOOP_ITERATIONS = 100_000;

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

async function drainLoop(
  report: ParentDeletionDrainReport,
  label: string,
  budget: DrainBudget,
  step: () => Promise<number>,
): Promise<void> {
  report[label] ??= 0;
  for (;;) {
    // Between batches only: a batch is one statement or one short
    // transaction, and the residual is picked up by the next run.
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
 * batches that never wait on a row lock. Leaf tables first, so no batch
 * cascades further than its own children. Returns rows processed per step.
 */
export type ParentDeletionDrainOptions = {
  batch?: number;
  maxRowsPerRun?: number;
  maxLoopIterations?: number;
};

export async function drainParentDeletionHistory(
  db: Db,
  parents: DeletedParents,
  {
    batch = PARENT_DELETION_DRAIN_BATCH,
    maxRowsPerRun = PARENT_DELETION_MAX_DRAIN_ROWS_PER_RUN,
    maxLoopIterations = PARENT_DELETION_MAX_DRAIN_LOOP_ITERATIONS,
  }: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  const report: ParentDeletionDrainReport = {};
  const limit = Math.max(1, Math.trunc(batch));
  const budget: DrainBudget = {
    maxRows: maxRowsPerRun,
    maxLoopIterations,
    rowsProcessed: 0,
    loopIterations: 0,
  };

  // response_stickiness_record: CASCADE edges delete; the one SET NULL edge
  // (selectedDiscoveredModelId) only matters for a row none of the CASCADE
  // edges removes, handled after the deletes.
  const stickiness = HISTORY_DRAIN_EDGES.response_stickiness_record;
  const stickinessDelete = edgeFilters("s", stickiness.cascade, parents);
  if (stickinessDelete.length > 0)
    await drainLoop(
      report,
      "response_stickiness_record.delete",
      budget,
      () =>
        db.$executeRaw`
        DELETE FROM response_stickiness_record
         WHERE id IN (
           SELECT s.id FROM response_stickiness_record s
            WHERE ${Prisma.join(stickinessDelete, " OR ")}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
    );
  const stickinessNull = edgeFilters("s", stickiness.setNull, parents);
  if (stickinessNull.length > 0)
    await drainLoop(
      report,
      "response_stickiness_record.detach",
      budget,
      () =>
        db.$executeRaw`
        UPDATE response_stickiness_record
           SET "selectedDiscoveredModelId" = NULL
         WHERE id IN (
           SELECT s.id FROM response_stickiness_record s
            WHERE ${Prisma.join(stickinessNull, " OR ")}
            LIMIT ${limit}
              FOR NO KEY UPDATE SKIP LOCKED)`,
    );

  // capacity_waiter rows of terminal requests that reference a deleted
  // capacity, target, pool or member (their own request may survive).
  const waiterFilters = edgeFilters("w", HISTORY_DRAIN_EDGES.capacity_waiter.cascade, parents);
  if (waiterFilters.length > 0)
    await drainLoop(
      report,
      "capacity_waiter.delete",
      budget,
      () =>
        db.$executeRaw`
        DELETE FROM capacity_waiter
         WHERE id IN (
           SELECT w.id FROM capacity_waiter w
             JOIN admission_request r ON r.id = w."admissionRequestId"
            WHERE r.state IN ${TERMINAL_ADMISSION}
              AND (${Prisma.join(waiterFilters, " OR ")})
            LIMIT ${limit}
              FOR UPDATE OF w SKIP LOCKED)`,
    );

  // Terminal admission requests the cascade deletes. A request with a lease
  // is RESTRICT-protected history; the preflight refused such a delete, and
  // the drain never removes one (the NOT EXISTS keeps it that way if a lease
  // appears after the preflight: the ordered delete then fails unchanged).
  const admissionFilters = edgeFilters("r", HISTORY_DRAIN_EDGES.admission_request.cascade, parents);
  if (admissionFilters.length > 0)
    await drainLoop(
      report,
      "admission_request.delete",
      budget,
      () =>
        db.$executeRaw`
        DELETE FROM admission_request
         WHERE id IN (
           SELECT r.id FROM admission_request r
            WHERE r.state IN ${TERMINAL_ADMISSION}
              AND (${Prisma.join(admissionFilters, " OR ")})
              AND NOT EXISTS (
                SELECT 1 FROM capacity_lease l WHERE l."admissionRequestId" = r.id)
            LIMIT ${limit}
              FOR UPDATE OF r SKIP LOCKED)`,
    );

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
    await drainLoop(report, "relay_request.scan", budget, async () => {
      const after = cursor;
      // No creation cutoff: the keyset cursor only moves forward and the
      // shared budget bounds the scan, so rows arriving during the drain are
      // taken until the budget says pending. After a user's deletion mark
      // nothing new may authenticate as the user, so the tail is the
      // requests already in flight at the mark.
      const rows: Array<{ id: string; createdAt: Date }> = after
        ? await db.$queryRaw`
            SELECT id, "createdAt" FROM relay_request
             WHERE "userId" = ${userId} AND status IN ${TERMINAL_RELAY}
               AND ("createdAt", id) > (${after.createdAt}, ${after.id})
             ORDER BY "createdAt", id
             LIMIT ${limit}`
        : await db.$queryRaw`
            SELECT id, "createdAt" FROM relay_request
             WHERE "userId" = ${userId} AND status IN ${TERMINAL_RELAY}
             ORDER BY "createdAt", id
             LIMIT ${limit}`;
      const last = rows.at(-1);
      if (!last) return 0;
      cursor = { createdAt: last.createdAt, id: last.id };
      const deleted = await db.$transaction(
        (tx) =>
          deleteTerminalRelayRequestsWithoutWaiting(
            tx,
            rows.map((row) => row.id),
          ),
        { timeout: 60_000 },
      );
      report["relay_request.delete"] = (report["relay_request.delete"] ?? 0) + deleted;
      return rows.length;
    });
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
    await drainLoop(
      report,
      "relay_request.detach",
      budget,
      () =>
        db.$executeRaw`
        UPDATE relay_request
           SET ${Prisma.join(assignments, ", ")}
         WHERE id IN (
           SELECT q.id FROM relay_request q
            WHERE q.status IN ${TERMINAL_RELAY}
              AND (${Prisma.join(relayFilters, " OR ")})
            LIMIT ${limit}
              FOR NO KEY UPDATE SKIP LOCKED)`,
    );
  }

  // Usage rollups owned by a deleted user.
  for (const userId of parents.user) {
    await drainLoop(
      report,
      "usage_rollup_minute.delete",
      budget,
      () =>
        db.$executeRaw`
        DELETE FROM usage_rollup_minute
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_minute
            WHERE "ownerUserId" = ${userId}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
    );
    await drainLoop(
      report,
      "usage_rollup_hour.delete",
      budget,
      () =>
        db.$executeRaw`
        DELETE FROM usage_rollup_hour
         WHERE ctid IN (
           SELECT ctid FROM usage_rollup_hour
            WHERE "ownerUserId" = ${userId}
            LIMIT ${limit}
              FOR UPDATE SKIP LOCKED)`,
    );
    await drainLoop(report, "usage_rollup_requester", budget, () =>
      drainRequesterUsageRollupsBatch(db, userId, limit),
    );
  }
  return report;
}

/**
 * Phases 1 and 2 for a delete of `scope`: refuses retained history, then
 * drains. The caller runs its ordered delete (phase 3) next.
 */
export async function prepareParentDeletion(
  db: Db,
  scope: ParentDeletionScope,
  options: ParentDeletionDrainOptions = {},
): Promise<ParentDeletionDrainReport> {
  const parents = await resolveDeletedParents(db, scope);
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
 * or no longer carries that generation (the final check is under the L7
 * lock, see `deleteUserInCapacityLockOrder`). Throws
 * {@link RetainedHistoryError}, a permanent database refusal, a
 * {@link ParentDeletionDrainPendingError}, or a transient failure (see
 * {@link isPermanentParentDeletionFailure}).
 */
export async function completeUserDeletion(
  db: Db,
  userId: string,
  generation: string,
  options: ParentDeletionDrainOptions = {},
): Promise<boolean> {
  // Plain read, a hint only: the authoritative check is the L7 statement.
  const existing = await db.user.findUnique({
    where: { id: userId },
    select: { deletionGeneration: true },
  });
  if (existing?.deletionGeneration !== generation) return false;
  // Impersonation sessions reference the user without a foreign key, so the
  // cascade misses them. The mark already deleted them and the trigger
  // refuses new ones; this covers users marked before either existed.
  await db.session.deleteMany({ where: { impersonatedBy: userId } });
  await prepareParentDeletion(db, { userId, wholeUser: true }, options);
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
