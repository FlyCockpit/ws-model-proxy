/**
 * Capacity-domain lock order (DL-1). This module is the single enforcement
 * point for every lock that capacity admission can wait on, and for the
 * ordered parent deletes that cascade into capacity rows. It lives in the db
 * package so the admission store (apps/server), the API writers
 * (packages/api) and the Better Auth user-deletion hook (packages/auth) share
 * one implementation.
 *
 * Every transaction that touches capacity policy, capacity admission state,
 * or a parent row of capacity state acquires locks in this order, skips the
 * levels it does not need, and never requests a lower level while holding a
 * higher one:
 *
 *   L0  identity: `cli_device` rows FOR NO KEY UPDATE (relay registration,
 *       device/endpoint/model/user deletes), `admission-attempt:*` advisory
 *       (admission only, first), `execution-target:*` advisory (target
 *       discovery/creation). No transaction holds two different L0 kinds.
 *       An `execution-target:*` fence may follow L1 (provider attach): no
 *       holder of an identity fence ever waits on a pool row.
 *   L1  `model_pool` rows FOR NO KEY UPDATE, sorted (writers take one; parent
 *       deletes take the sorted set they cascade into).
 *   L2  `execution_target` rows FOR NO KEY UPDATE, each followed by its
 *       `capacity-policy:<targetId>` advisory lock, sorted
 *       ({@link lockExecutionTargetPolicies}).
 *   L3  concurrency-scope advisory locks (`0:concurrency:*`), sorted.
 *   L4  physical-capacity advisory locks (the capacity id), sorted.
 *   L5  `inference_capacity` rows, sorted. Admission locks them FOR UPDATE
 *       ({@link lockCapacityAdmissionResources}); policy writers take the
 *       rows they write FOR NO KEY UPDATE or write them directly, always
 *       after their L2 locks.
 *   L6  `admission_request` rows FOR UPDATE, sorted: an admitter first locks
 *       every queued request that also waits on a capacity it does not hold
 *       ({@link lockCrossCapacityAdmissionRequests}); rows no other admitter
 *       can reach follow in any order. `capacity_waiter` rows are written
 *       only by a holder of their request row or of their capacity's L4.
 *   L7  trailing writes: `relay_request` status rows, `capacity_lease`
 *       inserts/updates, pool-member health, and the parent row a delete
 *       removes (the user row FOR UPDATE, then the in-transaction residual
 *       recount, which is plain reads, then the DELETE itself). Relay
 *       request deletes never wait on L6/L7 rows at all
 *       ({@link deleteTerminalRelayRequestsWithoutWaiting}).
 *
 * Physical lease heartbeat is a single-row conditional UPDATE at L7, holding
 * no other locks and acquiring none afterwards: it adds no lock-order edges.
 * The runtime owns renewal from admission through dispatch and body release;
 * response wrapping adopts that owner (apps/server/src/model-api/capacity/README.md).
 * Expiry reclaim UPDATEs recheck expiry because heartbeat takes no L3-L5 lock.
 *
 * Implicit locks count as locks at their level. A child INSERT (and an
 * UPDATE that changes a foreign key) takes FOR KEY SHARE on each parent row.
 * An UPDATE, and an INSERT ... ON CONFLICT DO UPDATE, takes FOR NO KEY
 * UPDATE on the row unless it touches a key column (a column of any unique
 * index): a plain UPDATE is then FOR UPDATE only when a key value changes,
 * but ON CONFLICT DO UPDATE takes FOR UPDATE whenever its SET list names a
 * key column, even with an unchanged value (ExecUpdateLockMode). DELETE takes
 * FOR UPDATE and runs its ON DELETE CASCADE / SET NULL actions as further
 * writes to the child rows.
 *
 * Provider management/health order (PR2-C10), skipping unused levels:
 *   provider-budget-* advisories -> L0 execution-target:provider-model fence
 *   (when creating a target or editing policy) -> provider_account FOR UPDATE
 *   -> provider-pricing:<user>:<model> advisory -> provider_model row
 *   -> provider_pricing_version rows -> provider_credential / provider_attempt
 *   rows -> child inserts -> L2 target policy -> L5 capacity rows.
 * Provider rows sit between L0 and L2. Acquire the account before any model
 * or pricing write, including pricing INSERTs: their FK checks can take KEY
 * SHARE on account/model in either RI trigger order. Audit INSERTs also take
 * KEY SHARE on the account. These provider parents must already be held;
 * later model updates/audits (even after L2/L5) only re-enter held locks.
 * A freshly inserted model's id is transaction-private and needs no L0 fence;
 * its pricing advisory cannot contend. Catalog import re-enters its advisory
 * after locking the existing model. Pricing-only writers need no L0 fence.
 * Pricing writers and catalog import (existing model) take the model FOR NO
 * KEY UPDATE (pricing and metadata fields are not keys), compatible with
 * target-insert FK KEY SHARE during pool setup. They never wait on
 * pool/target/capacity locks. Import and updateModel share the
 * L0 fence with provider attach before taking the account/model rows; none
 * requests a pool row or another identity fence afterwards. The static
 * inventory and pricing writer sequence tests include implicit FK locks.
 *
 * Deferred provider siblings (NOT covered by this order proof): budget
 * admission/reservation and usage-ledger INSERTs still take account/model FK
 * locks in database-dependent RI trigger order. Settlement takes an attempt
 * before ledger FK parents; runtime takes account -> model -> attempt. Also,
 * user deletion takes L7 user -> provider cascade while provider child inserts
 * can take KEY SHARE on user after account. These pre-existing risks require
 * separate follow-up; neither terminal status nor an audit is a lock.
 *
 * Consequences enforced here and in the callers:
 * - L1/L2 parent rows (`execution_target`, `model_pool`, `pool_member`,
 *   `user`) are never held FOR UPDATE, explicitly or implicitly, by a
 *   transaction that later waits on L3-L6: the L4/L5 holder inserts
 *   `capacity_lease`, `capacity_waiter`, `admission_request` and
 *   `cache_affinity_record` rows whose FK checks take FOR KEY SHARE on them.
 * - A parent DELETE is an L7 write: the deleting transaction first takes
 *   L0-L6 for everything its cascade can reach
 *   ({@link lockCapacityGraphForDelete}), so no admitter can be holding a
 *   capacity lock and waiting on the deleted row.
 *
 * Outside the capacity domain: the `session_refuse_deleting_user` trigger
 * (schema-hardening.sql) reads the session owner's `user` row FOR SHARE on
 * every session INSERT (DEL-STATE commit point), and for an impersonation
 * session (Better Auth `impersonatedBy`) then the impersonating admin's
 * `user` row FOR SHARE too (IMP-MARK), owner first. A session inserter holds
 * no capacity lock and takes none afterwards, so its waits (on a deletion
 * mark, an L7 user lock or another user writer) close no cycle. The two
 * reads are FOR SHARE on user rows: they never conflict with each other, and
 * each user writer they can wait on (the mark, the ordered delete's L7 lock,
 * an abandon, a ban or role write) writes one user row and never waits on a
 * session inserter's rows, so the owner-then-impersonator pair adds no edge
 * either; the mark deletes the admin's impersonation sessions after its own
 * UPDATE, the same order. Two more transactions outside the capacity domain
 * take the user row FOR SHARE:
 *
 * - A user-deletion drain batch (./parent-deletion.ts,
 *   `runParentDeletionDrainBatch`) takes it first, on its deletion
 *   generation, then only history rows with SKIP LOCKED and their cascades,
 *   every statement bounded by a transaction-local `statement_timeout` (and
 *   every lock wait by the lower `lock_timeout`). It never waits on an L0-L6
 *   lock, so the ordered user delete (L0-L6, then this row FOR UPDATE)
 *   waiting on it closes no cycle.
 * - The CLI device-code exchange
 *   (packages/api/src/lib/cli-credential-access.ts) takes it after the
 *   device row and before the device-code row, the order the ordered user
 *   delete uses (device at L0, user at L7, then its cascade into
 *   `device_code` and the device credentials).
 *
 * The E0 send-claim transaction (external provider egress,
 * packages/api/src/lib/model-api-token-access.ts `lockExternalSendConsent`
 * then apps/server/src/model-api/public-overflow.ts
 * `claimPublicProviderCredentialForSend`) is also outside the capacity
 * domain. It starts holding nothing and takes, in this order:
 *
 *   C1  `model_pool` FOR SHARE (the pool being sent for);
 *   C2  `pool_grant` FOR SHARE (the requester's grant, grantees only);
 *   C3  `model_api_token` FOR SHARE (the requester's token, if any);
 *   C4  `model_api_token_allowlist_entry` FOR SHARE (that token's entry for
 *       the pool);
 *   C5  `provider_account` FOR UPDATE, then (own-key only) `provider_model`
 *       FOR SHARE, then `provider_credential` FOR UPDATE
 *       (the order every provider lifecycle writer uses).
 *
 *   C6  own-key only: `pool_fallback_preference` FOR SHARE. Preference writers
 *       take pool -> grant -> account -> model -> preference, and deletes
 *       cascade from grant/model into preference. No preference holder waits
 *       on any of those parents. Clear takes only the preference row.
 *       The preference composite FKs are key-shares on already held parents.
 *
 * Preference setter transaction (separate from the send claim): starts with
 * nothing held, then pool SHARE -> exact grant SHARE -> requester account
 * SHARE -> model SHARE -> preference upsert. The L1 pool SHARE is reviewed:
 * capacity admission's FK KEY SHARE is compatible; pool writers and ordered
 * user deletion serialize at the pool before reaching grants/provider rows.
 * Provider writers serialize at the account before reaching model/preference;
 * none waits on the granting owner's pool while holding those rows. Grant or
 * model deletion reaches preference only after its parent lock; clear holds
 * only preference. No holder of preference waits for a parent. The setter
 * neither holds nor later acquires a capacity lock, so adds no reverse edge.
 *
 * After C6 (C5 for pool fallback; the last statement that can wait) it re-reads the requester's
 * token and `user` row WITHOUT a lock in one SQL statement that evaluates
 * token expiry, ban and deletion mark against statement_timestamp()
 * (`recheckExternalSendRequesterValidity`). The snapshot and its clock must
 * be coherent: comparing a returned ban expiry with a later JS clock could
 * accept a continuously renewed ban. Transaction now() predates the C5 wait.
 * No `user` lock is needed: every statement after that read is non-blocking
 * (the credential row is already held) and none writes a row the ban or
 * deletion-mark writers read, so a mark committing after the read serializes
 * after the claim, the same order a FOR SHARE would force, and the `user`
 * row stays out of this order.
 *
 * It takes no capacity lock and writes only the credential's `lastUsedAt`, so
 * no admitter ever waits on it (FOR SHARE does not conflict with the FOR KEY
 * SHARE of child inserts), and its C1 wait on an L1 holder closes no cycle.
 * Every transaction that holds a C-row in a conflicting mode and then waits
 * on a later C-level takes them in the same order: pool writers and deletes
 * (L1 first, then their grant/allowlist cascades), grant upserts (pool L1
 * first), grant revokes (single statement), user deletes (L1 on every owned
 * and granted pool before the L7 cascade into grants, tokens, entries and
 * provider rows), `updateExternalAccess` (the caller's own token FOR NO KEY
 * UPDATE, scoped by `userId`, before its entries), token revoke (single
 * statement). Provider writers that hold C5
 * take no C1-C4 lock in a conflicting mode (their pool references are FK KEY
 * SHARE, which FOR SHARE admits).
 *
 * The user-row writers that wait while holding the row (the deletion mark
 * and archive, each then deleting session rows; the ordered delete's
 * cascade) never hold a row either transaction waits on first. The static
 * guard (apps/server/src/model-api/capacity/lock-order.test.ts) lists every
 * reviewed FOR SHARE site.
 */
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  assertFinalPhaseResidualWithinBound,
  ParentDeletionOwnerRequiredError,
} from "./parent-deletion-residual";

type Tx = Prisma.TransactionClient;

const RETRYABLE_TRANSACTION_CODES = new Set([
  "P2034",
  "40001",
  "40P01",
  "CAPACITY_LOCK_SET_CHANGED",
]);

/**
 * Thrown when the rows an ordered delete must lock changed between planning
 * and locking. The caller's transaction rolls back and retries with a fresh
 * plan; no lock was taken out of order.
 */
export class CapacityLockSetChangedError extends Error {
  readonly code = "CAPACITY_LOCK_SET_CHANGED";
  constructor() {
    super("Capacity rows changed while the delete was locking them. Retry.");
    this.name = "CapacityLockSetChangedError";
  }
}

/** True for PostgreSQL serialization/deadlock failures and lock-set changes. */
export function isRetryableCapacityTransactionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (typeof code === "string" && RETRYABLE_TRANSACTION_CODES.has(code)) return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

// ---------------------------------------------------------------------------
// L2
// ---------------------------------------------------------------------------

/**
 * L2: execution-target rows FOR NO KEY UPDATE plus their capacity-policy
 * advisory locks, in sorted target-id order.
 *
 * FOR NO KEY UPDATE, never FOR UPDATE: it conflicts with FOR NO KEY UPDATE,
 * UPDATE and DELETE (writers and admissions stay mutually exclusive on the
 * row and the advisory lock) but not with the FOR KEY SHARE that an L4/L5
 * holder's child inserts take. It does not block child inserts: every path
 * that inserts a policy-relevant child (pool member attach, admission
 * waiter) takes the parent lock itself.
 */
export async function lockExecutionTargetPolicies(
  tx: Tx,
  executionTargetIds: readonly string[],
): Promise<void> {
  for (const targetId of [...new Set(executionTargetIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${targetId} FOR NO KEY UPDATE`;
    // pg_advisory_xact_lock returns PostgreSQL void, which Prisma's pg adapter
    // cannot deserialize through $queryRaw. Execute it for its side effect.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"capacity-policy:" + targetId}, 0))`;
  }
}

// ---------------------------------------------------------------------------
// L3 - L5
// ---------------------------------------------------------------------------

export function concurrencyLockKey(scope: string, scopeId: string): string {
  return `0:concurrency:${scope}:${scopeId}`;
}

/**
 * L3 -> L4 -> L5 for a set of physical capacities: the concurrency-scope
 * advisory locks of every durable waiter on them (plus `additionalScopeKeys`),
 * then the capacity advisory locks, then the `inference_capacity` rows FOR
 * UPDATE, each level sorted. Capacity IDs remain the historical L4 key shared
 * with API policy mutations and process workers; changing that key would
 * silently split the lock domain. The first capacity snapshot after this call
 * runs as a new READ COMMITTED statement after a contended writer commits,
 * instead of admitting against its stale pre-update limit.
 */
export async function lockCapacityAdmissionResources(
  tx: Tx,
  capacityIds: readonly string[],
  additionalScopeKeys: readonly string[] = [],
): Promise<void> {
  const durableScopes = capacityIds.length
    ? await tx.capacityWaiter.findMany({
        where: {
          capacityId: { in: [...capacityIds] },
          effectiveConcurrencyLimit: { not: null },
        },
        select: {
          effectiveConcurrencyScope: true,
          effectiveConcurrencyScopeId: true,
        },
        distinct: ["effectiveConcurrencyScope", "effectiveConcurrencyScopeId"],
      })
    : [];
  const scopeKeys = durableScopes.map((waiter) =>
    concurrencyLockKey(waiter.effectiveConcurrencyScope, waiter.effectiveConcurrencyScopeId),
  );
  for (const lockKey of [...new Set([...scopeKeys, ...additionalScopeKeys])].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const orderedCapacityIds = [...new Set(capacityIds)].sort();
  for (const capacityId of orderedCapacityIds)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityId}, 0))`;
  if (orderedCapacityIds.length > 0)
    await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id IN (${Prisma.join(
      orderedCapacityIds,
    )}) ORDER BY id FOR UPDATE`;
}

/**
 * L5 for a policy writer: the `inference_capacity` rows it may write, sorted,
 * FOR NO KEY UPDATE. Call it after every L2 lock and before the first write
 * to any of these rows. FOR NO KEY UPDATE conflicts with admission's FOR
 * UPDATE but not with the FOR KEY SHARE of child inserts.
 */
export async function lockCapacityRowsForPolicyWrite(
  tx: Tx,
  userId: string,
  capacityIds: readonly string[],
): Promise<void> {
  const ordered = [...new Set(capacityIds)].sort();
  if (ordered.length === 0) return;
  await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id IN (${Prisma.join(
    ordered,
  )}) AND "userId" = ${userId} ORDER BY id FOR NO KEY UPDATE`;
}

// ---------------------------------------------------------------------------
// L6
// ---------------------------------------------------------------------------

/**
 * L6 for an admitter that holds L4/L5 on `heldCapacityIds`: locks, in one
 * sorted statement, `ownRequestIds` plus every WAITING admission request that
 * waits on a held capacity AND on a capacity outside the held set. Only such
 * a request can be locked by another admitter (one holding a different
 * capacity); a request whose live waiters are all on held capacities is
 * reachable only through those held capacity locks. Taking the contended
 * rows up front, sorted, removes the sibling-winner inversion where two
 * admitters each lock the request the other admits next. The set cannot grow
 * afterwards: a new waiter on a held capacity needs that capacity's L4 lock.
 */
export async function lockCrossCapacityAdmissionRequests(
  tx: Tx,
  heldCapacityIds: readonly string[],
  ownRequestIds: readonly string[] = [],
): Promise<void> {
  const held = [...new Set(heldCapacityIds)].sort();
  const own = [...new Set(ownRequestIds)].sort();
  if (held.length === 0 && own.length === 0) return;
  const heldArray = held.length > 0 ? held : [""];
  const ownArray = own.length > 0 ? own : [""];
  await tx.$queryRaw`
    SELECT request.id FROM admission_request request
     WHERE request.id IN (${Prisma.join(ownArray)})
        OR (request.state = 'WAITING'
            AND EXISTS (
              SELECT 1 FROM capacity_waiter held
               WHERE held."admissionRequestId" = request.id
                 AND held.state = 'WAITING'
                 AND held."capacityId" IN (${Prisma.join(heldArray)}))
            AND EXISTS (
              SELECT 1 FROM capacity_waiter other
               WHERE other."admissionRequestId" = request.id
                 AND other.state = 'WAITING'
                 AND other."capacityId" NOT IN (${Prisma.join(heldArray)})))
     ORDER BY request.id
     FOR UPDATE OF request`;
}

/**
 * Deletes terminal `relay_request` rows without waiting on an admission or
 * relay row lock.
 *
 * The DELETE's ON DELETE SET NULL rewrites the referencing `admission_request`
 * rows (L6), while an admitter locks admission requests (L6, in an order that
 * is only partly sorted: its cross-capacity set, then its own and winning
 * rows) and afterwards updates their relay rows (L7). A relay delete that
 * waited on either kind of row could close a cycle with such an admitter, so
 * it takes both kinds with SKIP LOCKED: first the referencing admission rows
 * (sorted), then only the relay rows whose every referencing admission row it
 * now holds. Skipped rows stay for a later run. `status` is re-checked under
 * the lock; the other filters the caller applied (owner, age, ids) are
 * immutable. Returns the number of deleted rows.
 *
 * Not taken with SKIP LOCKED: the ON DELETE CASCADE children of a deleted
 * relay row (`relay_execution_event`, `relay_execution_attempt`). The DELETE
 * can wait on one of those rows while its writer holds it. Their writers
 * (the model-API routes' attempt start/finalization transactions and relay
 * telemetry recovery) write attempt, event and relay rows and take no
 * admission or capacity lock, so the wait does not close a cycle with an
 * admitter. It is the same wait retention had at HEAD. The parent-deletion
 * drain runs this in a batch with transaction-local `lock_timeout` and
 * `statement_timeout`, so there the wait is bounded in time (the statement
 * bound covers a cascade that waits on several rows in turn, which the
 * per-lock bound alone does not).
 */
export async function deleteTerminalRelayRequestsWithoutWaiting(
  tx: Tx,
  relayRequestIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(relayRequestIds)].sort();
  if (ids.length === 0) return 0;
  // One array parameter per statement: batches run to thousands of ids.
  const locked = await tx.$queryRaw<Array<{ relayRequestId: string }>>`
    SELECT "relayRequestId" FROM admission_request
     WHERE "relayRequestId" = ANY(${ids}::text[])
     ORDER BY id
     FOR NO KEY UPDATE SKIP LOCKED`;
  const referencing = await tx.$queryRaw<Array<{ relayRequestId: string; total: bigint }>>`
    SELECT "relayRequestId", count(*) AS total FROM admission_request
     WHERE "relayRequestId" = ANY(${ids}::text[])
     GROUP BY "relayRequestId"`;
  const lockedByRelay = new Map<string, number>();
  for (const row of locked)
    lockedByRelay.set(row.relayRequestId, (lockedByRelay.get(row.relayRequestId) ?? 0) + 1);
  const busy = new Set(
    referencing
      .filter((row) => (lockedByRelay.get(row.relayRequestId) ?? 0) < Number(row.total))
      .map((row) => row.relayRequestId),
  );
  const eligible = ids.filter((id) => !busy.has(id));
  if (eligible.length === 0) return 0;
  return tx.$executeRaw`
    DELETE FROM relay_request
     WHERE id IN (
       SELECT id FROM relay_request
        WHERE id = ANY(${eligible}::text[])
          AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
        FOR UPDATE SKIP LOCKED)`;
}

// ---------------------------------------------------------------------------
// Ordered parent deletes
// ---------------------------------------------------------------------------

/**
 * What a delete removes. The helper derives everything its cascade can reach
 * (members, targets, capacities, live admission requests) and the pools and
 * targets whose locks exclude concurrent writers of those rows.
 */
export type CapacityDeleteScope = {
  userId: string;
  /** Devices whose endpoints, models and targets are deleted. */
  cliDeviceIds?: readonly string[];
  /**
   * Devices locked (L0) but not deleted: the owner of a deleted endpoint or
   * model, so the delete serializes with that device's relay registration.
   */
  lockedCliDeviceIds?: readonly string[];
  poolIds?: readonly string[];
  poolMemberIds?: readonly string[];
  /** Targets deleted directly or through a discovered/provider model cascade. */
  executionTargetIds?: readonly string[];
  capacityIds?: readonly string[];
  /** The user row itself is deleted: every capacity row of the user. */
  wholeUser?: boolean;
  /**
   * Endpoints deleted directly (their models and targets follow). Used by
   * the residual recount only; the lock set comes from the targets above.
   */
  endpointIds?: readonly string[];
  /**
   * Discovered models deleted directly (their targets follow). Used by the
   * residual recount only; the lock set comes from the targets above.
   */
  discoveredModelIds?: readonly string[];
  /**
   * With `wholeUser`: the deletion generation the caller owns. The L7 user
   * lock matches only a row still carrying it; otherwise the helper throws
   * {@link UserDeletionGenerationChangedError} (the row is gone, or the
   * deletion was abandoned or replaced), having taken only ordered locks.
   */
  userDeletionGeneration?: string;
};

/** The L7 user lock found no row carrying the caller's deletion generation. */
export class UserDeletionGenerationChangedError extends Error {
  constructor() {
    super("The user row no longer carries this deletion generation.");
    this.name = "UserDeletionGenerationChangedError";
  }
}

type CapacityLockSet = {
  devices: string[];
  pools: string[];
  targets: string[];
  capacities: string[];
  requests: string[];
};

const LIVE_REQUEST_STATES = ["WAITING", "ADMITTED"] as const;

function sortedIds(values: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) if (value) ids.add(value);
  return [...ids].sort();
}

async function resolveCapacityDeleteLockSet(
  tx: Tx,
  scope: CapacityDeleteScope,
): Promise<CapacityLockSet> {
  const userId = scope.userId;
  const devices = new Set(scope.cliDeviceIds ?? []);
  const deletedPools = new Set(scope.poolIds ?? []);
  const deletedMembers = new Set(scope.poolMemberIds ?? []);
  const deletedTargets = new Set(scope.executionTargetIds ?? []);
  const deletedCapacities = new Set(scope.capacityIds ?? []);
  const lockedPools = new Set<string>();

  if (scope.wholeUser) {
    for (const row of await tx.cliDevice.findMany({ where: { userId }, select: { id: true } }))
      devices.add(row.id);
    for (const row of await tx.modelPool.findMany({ where: { userId }, select: { id: true } }))
      deletedPools.add(row.id);
    for (const row of await tx.executionTarget.findMany({
      where: { userId },
      select: { id: true },
    }))
      deletedTargets.add(row.id);
    for (const row of await tx.inferenceCapacity.findMany({
      where: { userId },
      select: { id: true },
    }))
      deletedCapacities.add(row.id);
    // Rows of other owners' pools that reference this user as grantee or
    // tenant are removed by the cascade; their writers hold that pool's L1.
    for (const row of await tx.poolGrant.findMany({
      where: { granteeUserId: userId },
      select: { poolId: true },
    }))
      lockedPools.add(row.poolId);
    for (const row of await tx.cacheAffinityRecord.findMany({
      where: { tenantUserId: userId },
      select: { poolId: true },
      distinct: ["poolId"],
    }))
      lockedPools.add(row.poolId);
  }

  const lockedDevices = new Set([...devices, ...(scope.lockedCliDeviceIds ?? [])]);
  if (devices.size > 0)
    for (const row of await tx.executionTarget.findMany({
      where: {
        userId,
        DiscoveredModel: { is: { Endpoint: { cliDeviceId: { in: [...devices] } } } },
      },
      select: { id: true },
    }))
      deletedTargets.add(row.id);

  const targetRows = deletedTargets.size
    ? await tx.executionTarget.findMany({
        where: { id: { in: [...deletedTargets] } },
        select: { id: true, discoveredModelId: true, inferenceCapacityId: true },
      })
    : [];
  for (const target of targetRows)
    if (target.inferenceCapacityId) deletedCapacities.add(target.inferenceCapacityId);
  const deletedModelIds = sortedIds(targetRows.map((target) => target.discoveredModelId));

  const memberFilters: Prisma.PoolMemberWhereInput[] = [];
  if (deletedMembers.size) memberFilters.push({ id: { in: [...deletedMembers] } });
  if (deletedPools.size) memberFilters.push({ poolId: { in: [...deletedPools] } });
  if (deletedTargets.size) memberFilters.push({ executionTargetId: { in: [...deletedTargets] } });
  if (deletedModelIds.length) memberFilters.push({ discoveredModelId: { in: deletedModelIds } });
  const members = memberFilters.length
    ? await tx.poolMember.findMany({
        where: { OR: memberFilters },
        select: { id: true, poolId: true, executionTargetId: true },
      })
    : [];
  for (const member of members) deletedMembers.add(member.id);

  const affinityPools = deletedTargets.size
    ? await tx.cacheAffinityRecord.findMany({
        where: { executionTargetId: { in: [...deletedTargets] } },
        select: { poolId: true },
        distinct: ["poolId"],
      })
    : [];

  const requestFilters: Prisma.AdmissionRequestWhereInput[] = [];
  if (scope.wholeUser) requestFilters.push({ userId });
  if (deletedPools.size) requestFilters.push({ poolId: { in: [...deletedPools] } });
  // Plain column filters valid for both capacity_waiter and capacity_lease.
  const childFilters: Array<
    | { executionTargetId: { in: string[] } }
    | { poolMemberId: { in: string[] } }
    | { capacityId: { in: string[] } }
  > = [];
  if (deletedTargets.size) {
    requestFilters.push({ directExecutionTargetId: { in: [...deletedTargets] } });
    childFilters.push({ executionTargetId: { in: [...deletedTargets] } });
  }
  if (deletedMembers.size) childFilters.push({ poolMemberId: { in: [...deletedMembers] } });
  if (deletedCapacities.size) childFilters.push({ capacityId: { in: [...deletedCapacities] } });
  if (childFilters.length) {
    requestFilters.push({ Waiters: { some: { OR: childFilters } } });
    requestFilters.push({ Lease: { is: { OR: childFilters } } });
  }
  const requests = requestFilters.length
    ? await tx.admissionRequest.findMany({
        where: { state: { in: [...LIVE_REQUEST_STATES] }, OR: requestFilters },
        select: {
          id: true,
          Waiters: { select: { capacityId: true } },
          Lease: { select: { capacityId: true } },
        },
      })
    : [];

  return {
    devices: sortedIds(lockedDevices),
    pools: sortedIds([
      ...deletedPools,
      ...lockedPools,
      ...members.map((member) => member.poolId),
      ...affinityPools.map((record) => record.poolId),
    ]),
    targets: sortedIds([...deletedTargets, ...members.map((member) => member.executionTargetId)]),
    capacities: sortedIds([
      ...deletedCapacities,
      ...requests.flatMap((request) => [
        ...request.Waiters.map((waiter) => waiter.capacityId),
        request.Lease?.capacityId,
      ]),
    ]),
    requests: sortedIds(requests.map((request) => request.id)),
  };
}

function coversLockSet(locked: CapacityLockSet, needed: CapacityLockSet): boolean {
  return (Object.keys(needed) as Array<keyof CapacityLockSet>).every((key) => {
    const held = new Set(locked[key]);
    return needed[key].every((id) => held.has(id));
  });
}

/**
 * Takes L0-L6 for everything a parent delete's cascade can reach, in lock
 * order, then (for a user delete) the user row itself (L7). Re-plans after
 * locking: if a concurrent writer added a row the cascade would reach after
 * the plan was read, the transaction must roll back and retry
 * ({@link CapacityLockSetChangedError}) instead of waiting on that row out of
 * order. Run it in a READ COMMITTED transaction
 * ({@link runCapacityOrderedTransaction}) so the re-plan sees committed rows.
 *
 * Last, after every lock, it re-counts the history the caller's DELETE will
 * still cascade into and throws `ParentDeletionDrainPendingError` above the
 * final-phase bound (DL1-TXBOUND, `assertFinalPhaseResidualWithinBound` in
 * ./parent-deletion-residual.ts). The recount is plain reads: it takes no
 * lock and so adds nothing to the order above. Every ordered parent delete
 * (user, device, endpoint, discovered model, pool, pool member, capacity)
 * passes through here, so each is bounded under its own locks. A caller must
 * name everything it deletes in `scope` (including `endpointIds` /
 * `discoveredModelIds`) and run its DELETE right after this returns.
 */
export async function lockCapacityGraphForDelete(
  tx: Tx,
  scope: CapacityDeleteScope,
): Promise<void> {
  const planned = await resolveCapacityDeleteLockSet(tx, scope);
  if (planned.devices.length > 0)
    await tx.$queryRaw`SELECT id FROM cli_device WHERE id IN (${Prisma.join(
      planned.devices,
    )}) ORDER BY id FOR NO KEY UPDATE`;
  if (planned.pools.length > 0)
    await tx.$queryRaw`SELECT id FROM model_pool WHERE id IN (${Prisma.join(
      planned.pools,
    )}) ORDER BY id FOR NO KEY UPDATE`;
  await lockExecutionTargetPolicies(tx, planned.targets);
  await lockCapacityAdmissionResources(tx, planned.capacities);
  if (planned.requests.length > 0)
    await tx.$queryRaw`SELECT id FROM admission_request WHERE id IN (${Prisma.join(
      planned.requests,
    )}) ORDER BY id FOR UPDATE`;
  if (scope.wholeUser) {
    const generation = scope.userDeletionGeneration;
    if (generation === undefined) throw new ParentDeletionOwnerRequiredError();
    // lock-order:L7 — the user row is taken last, after every capacity lock.
    // From here on no transaction can insert a row that references this
    // user, so the re-plan below is final. The generation predicate is
    // evaluated under this lock: READ COMMITTED re-checks the WHERE on the
    // newest row version after waiting, so an abandon, unarchive or new
    // generation committed meanwhile yields no row. The writers that change
    // the generation take no capacity lock, so waiting on them here closes
    // no cycle.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user"
       WHERE id = ${scope.userId} AND "deletionGeneration" = ${generation}
       FOR UPDATE /* lock-order:L7 */`;
    if (locked.length === 0) throw new UserDeletionGenerationChangedError();
  }
  const current = await resolveCapacityDeleteLockSet(tx, scope);
  if (!coversLockSet(planned, current)) throw new CapacityLockSetChangedError();
  // DL1-TXBOUND: the residual bound, evaluated after the last lock that
  // excludes producers (plain reads, no lock).
  await assertFinalPhaseResidualWithinBound(tx, scope);
}

type TransactionRunner = Pick<PrismaClient, "$transaction">;

/**
 * Upper bound on any single lock wait inside a capacity-ordered transaction
 * (`lock_timeout`, transaction-local, set as the transaction's first
 * statement). The ordered delete waits on L0-L7 holders (live admissions,
 * policy writers, relay registration); past this bound it gives up instead
 * of queueing behind them, and every later admission queued behind it is
 * released. SQLSTATE 55P03, surfaced as
 * {@link CapacityOrderedTransactionTimeoutError}.
 */
export const CAPACITY_ORDERED_LOCK_TIMEOUT_MS = 2_000;

/**
 * Upper bound on any single statement inside a capacity-ordered transaction
 * (`statement_timeout`, transaction-local). `lock_timeout` bounds each lock
 * acquisition; a DELETE whose cascade waits on several rows in turn can
 * outlast it, so this bounds the statement as a whole. It is server-side:
 * unlike Prisma's client-side 15 s transaction cap it cancels the statement
 * and releases its locks. SQLSTATE 57014, surfaced as
 * {@link CapacityOrderedTransactionTimeoutError}.
 *
 * On the user-deletion sweep's client this transaction-local value
 * overrides the connection's session `statement_timeout`, so it must also
 * let the statement settle inside the sweep's shutdown join
 * (apps/server/src/shutdown-timeouts.test.ts checks it). The whole ordered
 * final phase measured 52 ms on a 20,000-row history, so 3 s only cuts off
 * a statement stuck behind other sessions' locks.
 */
export const CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS = 3_000;

/**
 * A capacity-ordered transaction hit its own server-side bound
 * ({@link CAPACITY_ORDERED_LOCK_TIMEOUT_MS} or
 * {@link CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS}): the transaction rolled
 * back, nothing was deleted. Not retried here (a retry would queue behind the
 * same holders again); request paths answer `delete_contended`, and the
 * user-deletion sweep treats it as transient (backoff, marker kept).
 */
export class CapacityOrderedTransactionTimeoutError extends Error {
  readonly code = "CAPACITY_ORDERED_TIMEOUT";
  readonly sqlState: "55P03" | "57014";
  constructor(sqlState: "55P03" | "57014", options?: { cause?: unknown }) {
    super(
      sqlState === "55P03"
        ? "The ordered delete waited too long for a lock held by live traffic. Retry."
        : "An ordered delete statement ran past its bound. Retry.",
      options,
    );
    this.name = "CapacityOrderedTransactionTimeoutError";
    this.sqlState = sqlState;
  }
}

/**
 * The SQLSTATE of a server-side timeout this session raised: 55P03
 * (`lock_timeout`) or 57014 (`statement_timeout`, or a cancel request),
 * looked up through Prisma's and the driver adapter's wrappers.
 */
export function serverTimeoutSqlState(error: unknown): "55P03" | "57014" | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (code === "55P03" || code === "57014") return code;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return undefined;
}

/**
 * Runs `work` in a READ COMMITTED transaction and retries deadlock,
 * serialization and lock-set-change failures with a fresh transaction. Used
 * by ordered deletes: their correctness comes from the explicit lock order,
 * and READ COMMITTED lets each post-lock read see the committed rows.
 *
 * Server-side bounds: the transaction's first statement sets a
 * transaction-local `lock_timeout` ({@link CAPACITY_ORDERED_LOCK_TIMEOUT_MS})
 * and `statement_timeout` ({@link CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS}),
 * so every statement of `work` (the L0-L7 lock reads, the re-plan, the
 * residual recount and the final DELETE with its cascade) is cancelled by
 * PostgreSQL at that bound, on every client: the shared request client (which
 * has no session bound of its own) and the sweep's statement-bounded client
 * alike. A cancelled statement aborts the transaction, which rolls back and
 * releases every lock it held. The timeout is not retried and surfaces as
 * {@link CapacityOrderedTransactionTimeoutError}; request paths map it to
 * the `delete_contended` CONFLICT (packages/api `runCapacityDeleteTransaction`
 * and the CLI device delete), the sweep backs off.
 *
 * The 15 s cap is Prisma's client-side transaction timeout, a backstop for
 * JavaScript time between statements: with every statement bounded
 * server-side, the capacity locks are held at most a few statements' bounds.
 * It holds for any history size only because every ordered delete drains its
 * request history first (./parent-deletion.ts, DL1-TXBOUND); a new ordered
 * delete must do the same.
 *
 * The user-deletion sweep's client is also fenced at dispatch
 * (./client-factory.ts): once the shutdown fence arms it sends no further
 * statement but the `COMMIT` / `ROLLBACK`, including the separate queries a
 * single Prisma call issues (the admission read in
 * `resolveCapacityDeleteLockSet` selects its `Waiters` and `Lease`
 * relations as queries of their own), so what is left at shutdown is one
 * statement and the end of its transaction, not every statement of one
 * call. The end of a transaction has no server-side bound (a `COMMIT` can
 * wait on synchronous replication); shutdown waits on the sweep for its
 * join deadline and then quarantines the sweep's connections
 * (`shutDownUserDeletionSweep`), so the server finishes that transaction by
 * commit or rollback after the process leaves.
 */
export async function runCapacityOrderedTransaction<T>(
  db: TransactionRunner,
  work: (tx: Tx) => Promise<T>,
  { maxAttempts = 5 }: { maxAttempts?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${CAPACITY_ORDERED_LOCK_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS}ms`}, true)`;
          return work(tx);
        },
        { isolationLevel: "ReadCommitted", timeout: 15_000 },
      );
    } catch (error) {
      const timeout = serverTimeoutSqlState(error);
      if (timeout !== undefined) {
        throw new CapacityOrderedTransactionTimeoutError(timeout, { cause: error });
      }
      if (attempt >= maxAttempts || !isRetryableCapacityTransactionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8 * attempt)));
    }
  }
}

/**
 * Deletes a user and its whole cascade in capacity lock order. Returns false
 * when the user no longer exists or no longer carries `deletionGeneration`
 * (checked under the L7 lock, after L0-L6). Foreign-key RESTRICT failures (retained
 * capacity or provider history) propagate unchanged.
 *
 * Phase 3 only: callers go through `deleteUserDurably` /
 * `completeUserDeletion` in ./parent-deletion.ts, which refuse retained
 * history and drain the request history first, so this transaction's cascade
 * (and the time it holds the capacity locks) is bounded by the capacity graph
 * plus a residual that the in-transaction recount caps (it throws
 * `ParentDeletionDrainPendingError` above the bound), not by the user's
 * traffic.
 */
export async function deleteUserInCapacityLockOrder(
  db: TransactionRunner,
  userId: string,
  deletionGeneration: string,
): Promise<boolean> {
  try {
    return await runCapacityOrderedTransaction(db, async (tx) => {
      // No user-row lock (nor marker read) before L0-L6: the generation is
      // checked by the L7 statement inside lockCapacityGraphForDelete.
      await lockCapacityGraphForDelete(tx, {
        userId,
        wholeUser: true,
        userDeletionGeneration: deletionGeneration,
      });
      await tx.user.delete({ where: { id: userId }, select: { id: true } });
      return true;
    });
  } catch (error) {
    if (error instanceof UserDeletionGenerationChangedError) return false;
    throw error;
  }
}
