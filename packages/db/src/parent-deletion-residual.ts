/**
 * Parent-deletion scope and the user-history contract (DL-1 design (d), #78).
 *
 * A parent delete is a plain delete under owner fences
 * (`fenceParentDelete` in ./capacity-lock-order.ts). It cascades only into
 * graph and auxiliary rows: no hot-path (H) table has a foreign key to the
 * graph, so no delete reaches request history, and the old final-phase
 * residual bound (DL1-TXBOUND) has nothing left to bound.
 *
 * Request history keeps plain ids of deleted parents and readers tolerate
 * them. The one exception is the user's own history, which a user deletion
 * removes for privacy: {@link HISTORY_DRAIN_EDGES} lists, for every H table,
 * the columns naming the user whose deletion removes the row (drained by
 * ./parent-deletion.ts before the user row is deleted, and purged afterwards
 * by the history sweeper for rows that were still live) and the H-internal
 * foreign keys its rows go with. The catalog test
 * (packages/api/src/lib/parent-deletion-catalog.test.ts) checks it against
 * the Prisma schema.
 */
import { Prisma } from "../prisma/generated/client";

/**
 * Read-only surface the parent resolution needs: the shared client, or the
 * transaction client of a delete.
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

export type DrainEdge = readonly [column: string, parent: "user"];

/**
 * For every H table: the columns naming a user whose deletion removes the row
 * (`delete`; the user's own history, for privacy) and the H-internal foreign
 * keys whose parent row takes it along (`internal`). Rows that name a deleted
 * pool, target, model, device or capacity are kept with a dangling id.
 */
export const HISTORY_DRAIN_EDGES = {
  relay_request: { delete: [["userId", "user"]], internal: [] },
  relay_execution_event: { delete: [["userId", "user"]], internal: ["relayRequestId"] },
  relay_execution_attempt: { delete: [["userId", "user"]], internal: ["relayRequestId"] },
  admission_request: { delete: [["userId", "user"]], internal: ["relayRequestId"] },
  capacity_waiter: { delete: [["userId", "user"]], internal: ["admissionRequestId"] },
  capacity_lease: { delete: [["userId", "user"]], internal: ["admissionRequestId"] },
  capacity_runtime: { delete: [["userId", "user"]], internal: [] },
  cache_affinity_record: {
    delete: [
      ["userId", "user"],
      ["tenantUserId", "user"],
    ],
    internal: [],
  },
  response_stickiness_record: { delete: [["userId", "user"]], internal: [] },
  usage_rollup_minute: { delete: [["ownerUserId", "user"]], internal: [] },
  usage_rollup_hour: { delete: [["ownerUserId", "user"]], internal: [] },
  // Provider accounting is retained history: a user who has any is refused
  // deletion before anything is drained (`findRetainedHistoryBlocker`).
  provider_attempt: { delete: [], internal: [] },
  public_provider_attempt_event: { delete: [], internal: ["providerAttemptId"] },
  provider_budget_reservation: { delete: [], internal: [] },
  provider_budget_settlement: { delete: [], internal: ["reservationId"] },
  provider_usage_ledger: { delete: [], internal: ["reservationId"] },
} as const satisfies Record<string, { delete: readonly DrainEdge[]; internal: readonly string[] }>;

/**
 * History tables that carry a user id as a PLAIN column (no foreign key): the
 * cascade never reaches them, so a whole-user delete drains them by this
 * column in bounded batches (`drainParentDeletionHistory`) and the residual
 * count ignores them (they are not part of the locked cascade). The catalog
 * test requires every table with a `userId`-like column and no foreign key to
 * be listed here or in `PLAIN_USER_ID_EXEMPT` there, so a new plain-id table
 * cannot ship unclassified. A row the drain skipped (locked) or one written
 * after the drain (a queued audit write, another replica) is taken by the
 * deleted-user purge (`purgeDeletedUserHistory`, driven by the
 * `deleted_user_purge` queue entry the delete writes), which also counts these
 * tables as remaining; the 90-day retention sweep is the last bound.
 */
export const USER_PLAIN_ID_HISTORY_TABLES = {
  cli_agent_action_event: { userColumn: "userId" },
} as const satisfies Record<string, { userColumn: string }>;

/**
 * Drain budget exceeded, or a drain batch hit its own timeout; completion
 * should return pending. `timeout` is the SQLSTATE of a batch timeout (55P03
 * lock wait, 57014 statement), absent otherwise.
 */
export class ParentDeletionDrainPendingError extends Error {
  readonly code = "PARENT_DELETION_DRAIN_PENDING";
  readonly timeout: "55P03" | "57014" | undefined;
  constructor(message: string, options?: { timeout?: "55P03" | "57014"; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ParentDeletionDrainPendingError";
    this.timeout = options?.timeout;
  }
}

/**
 * A whole-user drain or delete was called without naming the deletion
 * generation it works for (or, for a drain, naming another user's). A
 * programming error in the caller: the operation refuses before touching any
 * row, since without an owner it would delete for a generation that may
 * already have been abandoned. Thrown by the drain (./parent-deletion.ts) and
 * by `fenceParentDelete` (./capacity-lock-order.ts).
 */
export class ParentDeletionOwnerRequiredError extends Error {
  readonly code = "PARENT_DELETION_OWNER_REQUIRED";
  constructor() {
    super("A whole-user deletion must name the deletion generation it owns.");
    this.name = "ParentDeletionOwnerRequiredError";
  }
}

/**
 * What a parent delete removes. `fenceParentDelete` derives from it the rows
 * the cascade reaches and the owners whose fences the delete needs.
 */
export type ParentDeletionScope = {
  userId: string;
  /** Devices whose endpoints, models and targets are deleted. */
  cliDeviceIds?: readonly string[];
  poolIds?: readonly string[];
  poolMemberIds?: readonly string[];
  /** Targets deleted directly or through a discovered/provider model cascade. */
  executionTargetIds?: readonly string[];
  capacityIds?: readonly string[];
  /** The user row itself is deleted: every graph row of the user. */
  wholeUser?: boolean;
  /** Endpoints deleted directly (their models and targets follow). */
  endpointIds?: readonly string[];
  /** Discovered models deleted directly (their targets follow). */
  discoveredModelIds?: readonly string[];
  /**
   * With `wholeUser`: the deletion generation the caller owns. The user row
   * lock matches only a row still carrying it; otherwise the delete throws
   * `UserDeletionGenerationChangedError` (the row is gone, or the deletion
   * was abandoned or replaced), having taken only fences and pool locks.
   */
  userDeletionGeneration?: string;
};

/** The deleted rows of every parent table, sorted. */
export type DeletedParents = Record<DeletedParentTable, string[]>;

function sorted(values: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) if (value) ids.add(value);
  return [...ids].sort();
}

/**
 * Resolves the graph rows a delete removes. Read-only and unlocked; the
 * delete re-resolves under its owner fences (`fenceParentDelete`).
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
