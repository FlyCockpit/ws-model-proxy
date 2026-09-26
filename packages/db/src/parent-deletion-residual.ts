/**
 * The final-phase residual bound of an ordered parent delete (DL1-TXBOUND).
 *
 * The contract data (which history tables reach which deleted parents
 * through which foreign keys, {@link HISTORY_DRAIN_EDGES}; trigger-driven
 * delete work, {@link PARENT_DELETE_TRIGGER_WORK}), the parent resolution and
 * the capped residual count live here so both halves of a parent delete use
 * one definition:
 *  - ./parent-deletion.ts drains by these edges and counts once before the
 *    ordered transaction (a cheap early exit);
 *  - ./capacity-lock-order.ts (`lockCapacityGraphForDelete`, the chokepoint
 *    of all seven ordered deletes) re-counts inside the ordered transaction
 *    after its last lock ({@link assertFinalPhaseResidualWithinBound}). That
 *    recount is the bound: the pre-lock count alone left rows committed
 *    between it and the locks uncounted.
 */
import { Prisma } from "../prisma/generated/client";
import type { CapacityDeleteScope } from "./capacity-lock-order";

/**
 * Read-only surface the resolution and the count need: the shared client, or
 * the transaction client of an ordered delete.
 */
type ResidualDb = Pick<
  Prisma.TransactionClient,
  | "$queryRaw"
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

/** Rows per drain batch; each batch is one short transaction. */
export const PARENT_DELETION_DRAIN_BATCH = 5_000;

/**
 * Max history rows the capacity-locked final delete may still delete, detach
 * or trigger work for: every row of every history table the cascade reaches
 * from the resolved parents (live PENDING / WAITING rows, rows the drain
 * skipped as locked, rows that arrived during or after the drain), plus their
 * history-internal children and the requester-rollup trigger work of a user
 * delete. Counted by {@link countFinalPhaseResidualRows} for every
 * parent-delete kind, and enforced inside the ordered-delete transaction by
 * {@link assertFinalPhaseResidualWithinBound} after its last lock; above it
 * the delete returns pending instead of holding the capacity locks over an
 * unbounded cascade.
 */
export const PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS = PARENT_DELETION_DRAIN_BATCH * 4;

/**
 * Every DELETE trigger (schema-hardening.sql) on a table an ordered parent
 * delete removes or rewrites, with the work it adds to the final phase. The
 * catalog test parses the SQL and requires this list to match exactly, so a
 * new trigger cannot escape the residual count.
 * - `requester_usage_rollup_merge`: writes rows; counted by
 *   {@link countFinalPhaseResidualRows} (requester rollups of a user delete).
 * - `none`: a per-row check that returns OLD on DELETE; its cost is
 *   proportional to rows already counted.
 * - `retained_history_refused`: the table is retained history the preflight
 *   refuses (`findRetainedHistoryBlocker`), so the trigger never fires on a
 *   delete that proceeds.
 * - `refuses_delete`: raises 55000 on any DELETE, a permanent refusal
 *   (`isPermanentParentDeletionFailure`); it adds no rows.
 */
export const PARENT_DELETE_TRIGGER_WORK = [
  {
    id: "usage_rollup_detach_requester",
    parentTable: "user",
    timing: "AFTER DELETE",
    work: "requester_usage_rollup_merge",
  },
  {
    id: "relay_execution_attempt_transition",
    parentTable: "relay_execution_attempt",
    timing: "BEFORE DELETE",
    work: "none",
  },
  {
    id: "provider_audit_event_immutable",
    parentTable: "provider_audit_event",
    timing: "BEFORE DELETE",
    work: "retained_history_refused",
  },
  {
    id: "provider_budget_rule_immutable",
    parentTable: "provider_budget_rule",
    timing: "BEFORE DELETE",
    work: "refuses_delete",
  },
] as const;

/** Parent tables whose rows a delete removes, by the id sets resolved below. */
export type DeletedParentTable =
  | "user"
  | "model_pool"
  | "pool_member"
  | "pool_grant"
  | "discovered_model"
  | "execution_target"
  | "inference_capacity"
  | "model_api_token"
  | "provider_account"
  | "provider_model";

export type DrainEdge = readonly [column: string, parent: DeletedParentTable];

/**
 * Every foreign key from a drained history table into the deleted graph, with
 * the action the cascade would apply. The drain applies the same action in
 * batches. History-internal edges (relay_execution_event -> relay_request,
 * capacity_waiter -> admission_request, ...) are listed in `internal`: the
 * child goes with its drained history parent.
 */
export const HISTORY_DRAIN_EDGES = {
  relay_request: {
    cascade: [["userId", "user"]],
    setNull: [
      ["modelApiTokenId", "model_api_token"],
      ["requestedDiscoveredModelId", "discovered_model"],
      ["requestedModelPoolId", "model_pool"],
      ["selectedDiscoveredModelId", "discovered_model"],
      ["requestedExecutionTargetId", "execution_target"],
      ["selectedExecutionTargetId", "execution_target"],
      ["selectedPoolMemberId", "pool_member"],
    ],
    internal: [],
  },
  relay_execution_event: {
    // Deleted with its relay request (same owner by the relay FK).
    cascade: [["userId", "user"]],
    setNull: [],
    internal: ["relayRequestId"],
  },
  relay_execution_attempt: {
    cascade: [["userId", "user"]],
    setNull: [],
    internal: ["relayRequestId"],
  },
  admission_request: {
    cascade: [
      ["userId", "user"],
      ["poolId", "model_pool"],
      ["directExecutionTargetId", "execution_target"],
    ],
    setNull: [],
    internal: ["relayRequestId"],
  },
  capacity_waiter: {
    cascade: [
      ["capacityId", "inference_capacity"],
      ["executionTargetId", "execution_target"],
      ["poolId", "model_pool"],
      ["poolMemberId", "pool_member"],
    ],
    setNull: [],
    internal: ["admissionRequestId"],
  },
  response_stickiness_record: {
    cascade: [
      ["userId", "user"],
      ["modelApiTokenId", "model_api_token"],
      ["targetDiscoveredModelId", "discovered_model"],
      ["targetModelPoolId", "model_pool"],
      ["targetExecutionTargetId", "execution_target"],
      ["selectedExecutionTargetId", "execution_target"],
      ["providerAccountId", "provider_account"],
      ["providerModelId", "provider_model"],
      ["poolGrantId", "pool_grant"],
    ],
    setNull: [["selectedDiscoveredModelId", "discovered_model"]],
    internal: [],
  },
  usage_rollup_minute: { cascade: [["ownerUserId", "user"]], setNull: [], internal: [] },
  usage_rollup_hour: { cascade: [["ownerUserId", "user"]], setNull: [], internal: [] },
} as const satisfies Record<
  string,
  { cascade: readonly DrainEdge[]; setNull: readonly DrainEdge[]; internal: readonly string[] }
>;

/** Drain budget or residual bound exceeded; completion should return pending. */
export class ParentDeletionDrainPendingError extends Error {
  readonly code = "PARENT_DELETION_DRAIN_PENDING";
  constructor(message: string) {
    super(message);
    this.name = "ParentDeletionDrainPendingError";
  }
}

/**
 * A whole-user drain or ordered delete was called without naming the
 * deletion generation it works for (or, for a drain, naming another user's).
 * A programming error in the caller: the operation refuses before touching
 * any row, since without an owner it would delete for a generation that may
 * already have been abandoned. Thrown by the drain (./parent-deletion.ts) and
 * by `lockCapacityGraphForDelete` (./capacity-lock-order.ts).
 */
export class ParentDeletionOwnerRequiredError extends Error {
  readonly code = "PARENT_DELETION_OWNER_REQUIRED";
  constructor() {
    super("A whole-user deletion must name the deletion generation it owns.");
    this.name = "ParentDeletionOwnerRequiredError";
  }
}

/** What a parent delete removes, for the drain and the preflight. */
export type ParentDeletionScope = CapacityDeleteScope;

/** The deleted rows of every parent table, sorted. */
export type DeletedParents = Record<DeletedParentTable, string[]>;

function sorted(values: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) if (value) ids.add(value);
  return [...ids].sort();
}

/**
 * Resolves the rows a delete removes. Read-only and unlocked: rows created
 * afterwards are handled by the ordered delete (phase 3), which plans under
 * its own locks.
 */
export async function resolveDeletedParents(
  db: ResidualDb,
  scope: ParentDeletionScope,
): Promise<DeletedParents> {
  const { userId } = scope;
  const whole = scope.wholeUser === true;
  const ownerFilter = { userId };
  const devices = new Set(scope.cliDeviceIds ?? []);
  const endpoints = new Set(scope.endpointIds ?? []);
  const models = new Set(scope.discoveredModelIds ?? []);
  const targets = new Set(scope.executionTargetIds ?? []);
  const pools = new Set(scope.poolIds ?? []);
  const members = new Set(scope.poolMemberIds ?? []);
  const capacities = new Set(scope.capacityIds ?? []);
  const tokens = new Set<string>();
  const grants = new Set<string>();
  const providerAccounts = new Set<string>();
  const providerModels = new Set<string>();

  if (whole) {
    for (const row of await db.cliDevice.findMany({ where: ownerFilter, select: { id: true } }))
      devices.add(row.id);
    for (const row of await db.discoveredModel.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      models.add(row.id);
    for (const row of await db.executionTarget.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      targets.add(row.id);
    for (const row of await db.modelPool.findMany({ where: ownerFilter, select: { id: true } }))
      pools.add(row.id);
    for (const row of await db.inferenceCapacity.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      capacities.add(row.id);
    for (const row of await db.modelApiToken.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      tokens.add(row.id);
    for (const row of await db.poolGrant.findMany({
      where: { OR: [{ ownerUserId: userId }, { granteeUserId: userId }] },
      select: { id: true },
    }))
      grants.add(row.id);
    for (const row of await db.providerAccount.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      providerAccounts.add(row.id);
    for (const row of await db.providerModel.findMany({
      where: ownerFilter,
      select: { id: true },
    }))
      providerModels.add(row.id);
  }

  if (devices.size > 0)
    for (const row of await db.endpoint.findMany({
      where: { userId, cliDeviceId: { in: [...devices] } },
      select: { id: true },
    }))
      endpoints.add(row.id);
  if (endpoints.size > 0)
    for (const row of await db.discoveredModel.findMany({
      where: { userId, endpointId: { in: [...endpoints] } },
      select: { id: true },
    }))
      models.add(row.id);
  if (models.size > 0)
    for (const row of await db.executionTarget.findMany({
      where: { userId, discoveredModelId: { in: [...models] } },
      select: { id: true },
    }))
      targets.add(row.id);
  if (targets.size > 0)
    for (const row of await db.executionTarget.findMany({
      where: { id: { in: [...targets] } },
      select: { discoveredModelId: true },
    }))
      if (row.discoveredModelId) models.add(row.discoveredModelId);

  const memberFilters: Prisma.PoolMemberWhereInput[] = [];
  if (pools.size > 0) memberFilters.push({ poolId: { in: [...pools] } });
  if (targets.size > 0) memberFilters.push({ executionTargetId: { in: [...targets] } });
  if (models.size > 0) memberFilters.push({ discoveredModelId: { in: [...models] } });
  if (memberFilters.length > 0)
    for (const row of await db.poolMember.findMany({
      where: { OR: memberFilters },
      select: { id: true },
    }))
      members.add(row.id);
  if (!whole && pools.size > 0)
    for (const row of await db.poolGrant.findMany({
      where: { poolId: { in: [...pools] } },
      select: { id: true },
    }))
      grants.add(row.id);

  return {
    user: whole ? [userId] : [],
    model_pool: sorted(pools),
    pool_member: sorted(members),
    pool_grant: sorted(grants),
    discovered_model: sorted(models),
    execution_target: sorted(targets),
    inference_capacity: sorted(capacities),
    model_api_token: sorted(tokens),
    provider_account: sorted(providerAccounts),
    provider_model: sorted(providerModels),
  };
}

export function edgeFilters(
  alias: string,
  edges: readonly DrainEdge[],
  parents: DeletedParents,
): Prisma.Sql[] {
  const filters: Prisma.Sql[] = [];
  for (const [column, parent] of edges) {
    const ids = parents[parent];
    if (ids.length === 0) continue;
    filters.push(Prisma.sql`${Prisma.raw(`${alias}."${column}"`)} = ANY(${ids}::text[])`);
  }
  return filters;
}

/** Rows `sql` (a `SELECT 1 ... WHERE ...` without LIMIT) matches, counted up to `cap`. */
async function countUpTo(db: ResidualDb, select: Prisma.Sql, cap: number): Promise<number> {
  const [{ count }] = await db.$queryRaw<[{ count: bigint }]>`
    SELECT count(*)::bigint AS count FROM (${select} LIMIT ${cap}) AS residual`;
  return Number(count ?? 0);
}

/**
 * Upper bound (capped just above {@link PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS})
 * of the history rows the final ordered delete of `parents` will delete,
 * detach or run trigger work for. Enumerates, for every parent-delete kind:
 * - every {@link HISTORY_DRAIN_EDGES} table through each of its CASCADE and
 *   SET NULL edges into the resolved parents, whatever the row's status,
 *   creation time or lock state (so live PENDING/WAITING rows and rows the
 *   drain skipped with SKIP LOCKED are counted; rows committed after this
 *   count are counted by the in-transaction recount,
 *   {@link assertFinalPhaseResidualWithinBound});
 * - the history-internal children those rows cascade into on their own
 *   foreign keys (capacity waiters of a deleted admission request, admission
 *   requests of a deleted relay request; relay execution events and attempts
 *   carry the relay request's owner and are counted by their `userId` edge);
 * - the {@link PARENT_DELETE_TRIGGER_WORK} of a user delete (requester usage
 *   rollups merged by `usage_rollup_detach_requester`).
 * Each pass counts rows once per table (OR of edges within a pass). The
 * second pass can count some tables again, so totals may over-count; that
 * only makes the delete return pending sooner.
 */
export async function countFinalPhaseResidualRows(
  db: ResidualDb,
  parents: DeletedParents,
  cap = PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS + 1,
): Promise<number> {
  let total = 0;
  const add = async (select: Prisma.Sql) => {
    if (total >= cap) return;
    total += await countUpTo(db, select, cap - total);
  };
  for (const [table, edges] of Object.entries(HISTORY_DRAIN_EDGES)) {
    const filters = edgeFilters("x", [...edges.cascade, ...edges.setNull], parents);
    if (filters.length === 0) continue;
    await add(
      Prisma.sql`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} x WHERE ${Prisma.join(filters, " OR ")}`,
    );
  }
  const admissionFilters = edgeFilters("r", HISTORY_DRAIN_EDGES.admission_request.cascade, parents);
  if (admissionFilters.length > 0)
    await add(Prisma.sql`
      SELECT 1 FROM capacity_waiter w
        JOIN admission_request r ON r.id = w."admissionRequestId"
       WHERE ${Prisma.join(admissionFilters, " OR ")}`);
  if (parents.user.length > 0) {
    await add(Prisma.sql`
      SELECT 1 FROM admission_request r
        JOIN relay_request q ON q.id = r."relayRequestId"
       WHERE q."userId" = ANY(${parents.user}::text[])`);
    await add(Prisma.sql`
      SELECT 1 FROM usage_rollup_minute WHERE "requesterUserId" = ANY(${parents.user}::text[])`);
    await add(Prisma.sql`
      SELECT 1 FROM usage_rollup_hour WHERE "requesterUserId" = ANY(${parents.user}::text[])`);
  }
  return total;
}

/**
 * The in-transaction recount (DL1-TXBOUND). Called by
 * `lockCapacityGraphForDelete` after its last lock, and before the caller's
 * DELETE, in the ordered delete's READ COMMITTED transaction, so it sees
 * every producer that committed while the locks were being taken. Resolves
 * the parents of `scope` under those locks and throws
 * {@link ParentDeletionDrainPendingError} when the residual exceeds
 * {@link PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS}: the transaction
 * rolls back with nothing deleted, a user delete stays pending for the
 * sweeper and a dashboard delete answers CONFLICT. The error is neither
 * retried inside the transaction runner nor a permanent refusal.
 *
 * Plain reads only: it takes no lock, so it adds nothing to the lock order.
 * Its cost under the locks is bounded by the cap: every count is
 * `LIMIT`-capped and filters on indexed foreign-key columns.
 *
 * Exactness per edge:
 * - `userId` / `ownerUserId` edges of a user delete: final. The L7 user lock
 *   (FOR UPDATE) blocks every new referencing insert until this transaction
 *   ends, and the insert then fails its foreign key.
 * - Rows that reference capacity state (admissions, waiters) are excluded by
 *   the held L4/L5/L6 locks.
 * - SET NULL / CASCADE edges into parents held only FOR NO KEY UPDATE or not
 *   locked at all (`cli_device`, `model_pool`, `execution_target`,
 *   `pool_member`, `discovered_model`, `model_api_token`, `provider_*`,
 *   `pool_grant`) are not closed to producers (FOR NO KEY UPDATE does not
 *   conflict with a child insert's FOR KEY SHARE). Known issue F2-01
 *   (user-accepted; closed by DL-1 design (d), which drops these cascades):
 *   rows such producers commit between this recount and the caller's DELETE,
 *   one statement later, are not counted. Its size is the producer rate times one statement, not
 *   a lock wait. Holding those parents FOR UPDATE would close it but needs
 *   its own lock-cycle proof against producers that hold FOR KEY SHARE.
 */
export async function assertFinalPhaseResidualWithinBound(
  db: ResidualDb,
  scope: ParentDeletionScope,
  cap = PARENT_DELETION_MAX_FINAL_PHASE_RESIDUAL_ROWS,
): Promise<void> {
  const parents = await resolveDeletedParents(db, scope);
  const residual = await countFinalPhaseResidualRows(db, parents, cap + 1);
  if (residual > cap) {
    throw new ParentDeletionDrainPendingError(
      "Parent deletion still has more history rows than the final delete may take; retry later.",
    );
  }
}
