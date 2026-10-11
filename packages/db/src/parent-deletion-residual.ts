/**
 * Parent-deletion scope and the user-history contract (DL-1 design (d), #78), for the 0.4.0
 * graph (nodes, runtimes, instances, pools, shares, keys, providers, profiles).
 *
 * A parent delete is a plain delete under owner fences (`fenceParentDelete` in
 * ./capacity-lock-order.ts). It cascades only into graph and auxiliary rows: no hot-path (H)
 * table has a foreign key to the graph, so no delete reaches request history.
 *
 * Request history keeps plain ids of deleted parents and readers tolerate them. The one
 * exception is the user's own history, which a user deletion removes for privacy:
 * {@link HISTORY_DRAIN_EDGES} lists, for every H table, the columns naming the user whose
 * deletion removes the row (drained by ./parent-deletion.ts before the user row is deleted,
 * and purged afterwards by the history sweeper for rows that were still live) and the
 * H-internal foreign keys its rows go with. The catalog test
 * (./parent-deletion-catalog.test.ts) checks it against the Prisma schema.
 */
import { Prisma } from "../prisma/generated/client";

/** Read-only surface the parent resolution needs: the shared client or a delete's tx. */
export type ResidualDb = Pick<
  Prisma.TransactionClient,
  | "$queryRaw"
  | "node"
  | "runtime"
  | "runtimeModel"
  | "runtimeInstance"
  | "runtimeShare"
  | "executionTarget"
  | "profile"
  | "pool"
  | "poolMember"
  | "share"
  | "apiKey"
  | "providerAccount"
  | "providerModel"
>;

/** Rows per drain batch; each batch is one short transaction. */
export const PARENT_DELETION_DRAIN_BATCH = 5_000;

/** Parent tables whose rows a delete removes, by the id sets resolved below. */
export type DeletedParentTable =
  | "user"
  | "node"
  | "runtime"
  | "runtime_model"
  | "runtime_instance"
  | "runtime_share"
  | "execution_target"
  | "profile"
  | "pool"
  | "pool_member"
  | "share"
  | "api_key"
  | "provider_account"
  | "provider_model";

export type DrainEdge = readonly [column: string, parent: "user"];

/**
 * For every H table: the columns naming a user whose deletion removes the row (`delete`; the
 * user's own history, for privacy) and the H-internal foreign keys whose parent row takes it
 * along (`internal`). Rows that name a deleted pool, target, instance or node are kept with a
 * dangling id.
 */
export const HISTORY_DRAIN_EDGES = {
  relay_request: { delete: [["userId", "user"]], internal: [] },
  attempt: { delete: [["userId", "user"]], internal: ["requestId"] },
  attempt_event: { delete: [["userId", "user"]], internal: ["attemptId"] },
  admission_request: { delete: [["userId", "user"]], internal: [] },
  capacity_waiter: { delete: [["userId", "user"]], internal: ["admissionRequestId"] },
  capacity_lease: { delete: [["userId", "user"]], internal: ["admissionRequestId"] },
  capacity_scheduler: { delete: [["userId", "user"]], internal: [] },
  cache_affinity_record: {
    delete: [
      ["userId", "user"],
      ["tenantUserId", "user"],
    ],
    internal: [],
  },
  cache_affinity_residency: { delete: [["userId", "user"]], internal: [] },
  cache_affinity_scope: { delete: [["userId", "user"]], internal: [] },
  cache_affinity_observer: { delete: [["userId", "user"]], internal: [] },
  cache_affinity_node: {
    delete: [
      ["userId", "user"],
      ["tenantUserId", "user"],
    ],
    internal: [],
  },
  // One row of global repair state, owned by no user.
  cache_affinity_residency_cursor: { delete: [], internal: [] },
  response_stickiness_record: { delete: [["userId", "user"]], internal: [] },
  usage_rollup_minute: { delete: [["ownerUserId", "user"]], internal: [] },
  usage_rollup_hour: { delete: [["ownerUserId", "user"]], internal: [] },
  // The paying user's cloud spend. Drained with the rest of the user's history: settlements
  // first (their reservation FK is RESTRICT), then reservations, which only the user-deletion
  // writer may delete (`spend_reservation_transition`, schema-hardening.sql).
  spend_reservation: { delete: [["userId", "user"]], internal: [] },
  spend_settlement: { delete: [["userId", "user"]], internal: ["reservationId"] },
  usage_ledger: { delete: [["userId", "user"]], internal: [] },
  // Expiring caches (routing verdicts, KV feedback): never drained; the retention sweep
  // deletes rows expired more than an hour ago and readers ignore expired rows.
  routing_verdict: { delete: [], internal: [] },
  capacity_kv_eviction: { delete: [], internal: [] },
  // Per-minute load and node metrics (display only, short retention).
  runtime_load_minute: { delete: [["ownerUserId", "user"]], internal: [] },
  node_metrics_minute: { delete: [["ownerUserId", "user"]], internal: [] },
} as const satisfies Record<string, { delete: readonly DrainEdge[]; internal: readonly string[] }>;

/**
 * History tables that carry a user id as a PLAIN column (no foreign key): the cascade never
 * reaches them, so a whole-user delete drains them by this column in bounded batches, and the
 * deleted-user purge takes what the drain could not. The catalog test requires every table
 * with a user-id column and no foreign key to be listed here, in {@link HISTORY_DRAIN_EDGES},
 * or in its exemption list.
 */
export const USER_PLAIN_ID_HISTORY_TABLES = {
  node_audit_event: { userColumn: "userId" },
  audit_event: { userColumn: "userId" },
} as const satisfies Record<string, { userColumn: string }>;

/**
 * Drain budget exceeded, or a drain batch hit its own timeout; completion should return
 * pending. `timeout` is the SQLSTATE of a batch timeout (55P03 lock wait, 57014 statement).
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
 * A whole-user drain or delete was called without naming the deletion generation it works
 * for (or, for a drain, naming another user's). A programming error in the caller.
 */
export class ParentDeletionOwnerRequiredError extends Error {
  readonly code = "PARENT_DELETION_OWNER_REQUIRED";
  constructor() {
    super("A whole-user deletion must name the deletion generation it owns.");
    this.name = "ParentDeletionOwnerRequiredError";
  }
}

/**
 * What a parent delete removes. `fenceParentDelete` derives from it the rows the cascade
 * reaches and the owners whose fences the delete needs.
 */
export type ParentDeletionScope = {
  userId: string;
  nodeIds?: readonly string[];
  runtimeIds?: readonly string[];
  runtimeModelIds?: readonly string[];
  instanceIds?: readonly string[];
  profileIds?: readonly string[];
  poolIds?: readonly string[];
  poolMemberIds?: readonly string[];
  shareIds?: readonly string[];
  apiKeyIds?: readonly string[];
  providerAccountIds?: readonly string[];
  providerModelIds?: readonly string[];
  /** The user row itself is deleted: every graph row of the user. */
  wholeUser?: boolean;
  /**
   * With `wholeUser`: the deletion generation the caller owns. The user row lock matches
   * only a row still carrying it; otherwise the delete throws
   * `UserDeletionGenerationChangedError`, having taken only fences.
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

const ID = { id: true } as const;

/**
 * Resolves the graph rows a delete removes, following the cascades of the 0.4.0 schema:
 * node → its always-on runtimes (and their instance, removed by `node_delete_release`);
 * runtime → models, shares; model or instance → execution targets; model, provider model or
 * share → pool members; pool → members, shares, API-key entries, sidecars; provider account
 * → models. Read-only and unlocked; the delete re-resolves under its owner fences.
 */
export async function resolveDeletedParents(
  db: ResidualDb,
  scope: ParentDeletionScope,
): Promise<DeletedParents> {
  const { userId } = scope;
  const whole = scope.wholeUser === true;
  const nodes = new Set(scope.nodeIds ?? []);
  const runtimes = new Set(scope.runtimeIds ?? []);
  const models = new Set(scope.runtimeModelIds ?? []);
  const instances = new Set(scope.instanceIds ?? []);
  const runtimeShares = new Set<string>();
  const targets = new Set<string>();
  const profiles = new Set(scope.profileIds ?? []);
  const pools = new Set(scope.poolIds ?? []);
  const members = new Set(scope.poolMemberIds ?? []);
  const shares = new Set(scope.shareIds ?? []);
  const apiKeys = new Set(scope.apiKeyIds ?? []);
  const accounts = new Set(scope.providerAccountIds ?? []);
  const providerModels = new Set(scope.providerModelIds ?? []);

  if (whole) {
    const own = { where: { userId }, select: ID };
    for (const row of await db.node.findMany(own)) nodes.add(row.id);
    for (const row of await db.runtime.findMany(own)) runtimes.add(row.id);
    for (const row of await db.runtimeInstance.findMany(own)) instances.add(row.id);
    for (const row of await db.profile.findMany(own)) profiles.add(row.id);
    for (const row of await db.pool.findMany(own)) pools.add(row.id);
    for (const row of await db.apiKey.findMany(own)) apiKeys.add(row.id);
    for (const row of await db.providerAccount.findMany(own)) accounts.add(row.id);
    for (const row of await db.share.findMany({
      where: { OR: [{ ownerUserId: userId }, { granteeUserId: userId }] },
      select: ID,
    }))
      shares.add(row.id);
    for (const row of await db.runtimeShare.findMany({
      where: { OR: [{ ownerUserId: userId }, { granteeUserId: userId }] },
      select: ID,
    }))
      runtimeShares.add(row.id);
  }

  if (nodes.size > 0) {
    // Always-on runtimes cascade with their node; `node_delete_release` removes their instance.
    for (const row of await db.runtime.findMany({
      where: { userId, nodeId: { in: [...nodes] } },
      select: ID,
    }))
      runtimes.add(row.id);
  }
  if (runtimes.size > 0) {
    const inRuntimes = { runtimeId: { in: [...runtimes] } };
    for (const row of await db.runtimeModel.findMany({ where: inRuntimes, select: ID }))
      models.add(row.id);
    for (const row of await db.runtimeShare.findMany({ where: inRuntimes, select: ID }))
      runtimeShares.add(row.id);
    for (const row of await db.runtimeInstance.findMany({
      where: { ...inRuntimes, Runtime: { kind: "ALWAYS_ON" } },
      select: ID,
    }))
      instances.add(row.id);
  }
  if (accounts.size > 0)
    for (const row of await db.providerModel.findMany({
      where: { providerAccountId: { in: [...accounts] } },
      select: ID,
    }))
      providerModels.add(row.id);

  const targetFilters: Prisma.ExecutionTargetWhereInput[] = [];
  if (models.size > 0) targetFilters.push({ runtimeModelId: { in: [...models] } });
  if (instances.size > 0) targetFilters.push({ instanceId: { in: [...instances] } });
  if (providerModels.size > 0) targetFilters.push({ providerModelId: { in: [...providerModels] } });
  if (targetFilters.length > 0)
    for (const row of await db.executionTarget.findMany({
      where: { OR: targetFilters },
      select: ID,
    }))
      targets.add(row.id);

  if (pools.size > 0)
    for (const row of await db.share.findMany({
      where: { poolId: { in: [...pools] } },
      select: ID,
    }))
      shares.add(row.id);

  const memberFilters: Prisma.PoolMemberWhereInput[] = [];
  if (pools.size > 0) memberFilters.push({ poolId: { in: [...pools] } });
  if (models.size > 0) memberFilters.push({ runtimeModelId: { in: [...models] } });
  if (providerModels.size > 0) memberFilters.push({ providerModelId: { in: [...providerModels] } });
  if (shares.size > 0) memberFilters.push({ shareId: { in: [...shares] } });
  if (memberFilters.length > 0)
    for (const row of await db.poolMember.findMany({
      where: { OR: memberFilters },
      select: ID,
    }))
      members.add(row.id);

  return {
    user: whole ? [userId] : [],
    node: sorted(nodes),
    runtime: sorted(runtimes),
    runtime_model: sorted(models),
    runtime_instance: sorted(instances),
    runtime_share: sorted(runtimeShares),
    execution_target: sorted(targets),
    profile: sorted(profiles),
    pool: sorted(pools),
    pool_member: sorted(members),
    share: sorted(shares),
    api_key: sorted(apiKeys),
    provider_account: sorted(accounts),
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
