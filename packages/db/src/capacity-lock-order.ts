/**
 * Capacity lock order, DL-1 design (d) (#78): writer classes, fences, and no
 * foreign key across the hot-path boundary. This module owns every advisory
 * lock in the application ({@link acquireFences}, the only caller of the
 * database's `wsmp_acquire_fences`, which is the only `pg_advisory*` caller
 * outside deploy scripts) and the admission store's internal row order. The
 * admission store (apps/server), the API writers (packages/api), the deletion
 * subsystem (./parent-deletion.ts) and the sweepers share it.
 *
 * Table classes (pinned by the catalog test,
 * packages/api/src/lib/writer-classes.postgres.integration.test.ts):
 *
 * - Graph (configuration): {@link GRAPH_TABLES}: `user`, `node`, `runtime`, its versions,
 *   models, shares, instances, ranks, steps and operations, `execution_target`, profiles,
 *   pools and their 1:1 children, members, routing rules, sidecars, `api_key`(+`_pool`),
 *   `share`, `share_invite`, provider accounts, models, credentials, pricing and spend caps.
 * - Hot path, H-private ({@link HOT_PATH_TABLES}): admission and capacity
 *   runtime state, cache affinity, relay and provider history and accounting,
 *   response stickiness, usage rollups. They reference graph rows by plain id:
 *   no foreign key runs between an H table and a graph table in either
 *   direction. So an H write never takes an implicit lock on a graph row, and
 *   a graph delete never cascades into an H row. H-internal foreign keys stay.
 *   Integrity uses non-locking validation triggers (plain SELECTs) that
 *   tolerate a deleted parent; readers tolerate dangling ids; sweepers
 *   terminalize or purge orphans.
 * - Auxiliary: every other table (sessions, OAuth, audit events, media, the
 *   deleted-user purge queue). Their writers take at most the `user` row and
 *   their own rows (see "Outside the capacity domain" below).
 *
 * Writer classes:
 *
 * - H (hot path): the admission store, cache affinity, relay and provider
 *   telemetry, provider budget and accounting, stickiness, usage rollups.
 *   Writes H tables. On graph rows it writes only the status columns that
 *   schema-hardening.sql leaves unfenced (health, last-used, connection
 *   state), each as a single-row statement or, for provider health, account
 *   row then model row (the provider order below). It reads the graph without
 *   row locks, after its fences, and never takes an `owner` fence. One
 *   cache-specific nonblocking boundary: source record statement triggers
 *   take a per-target residency advisory try-lock and bucket NOWAIT after
 *   source rows. Contention aborts the transaction with 55P03; they never
 *   wait for a bucket or acquire graph locks. The repair worker locks only
 *   bucket/cursor rows and reads source/graph rows without locks; its upserts
 *   and every statement/checkout have independent short server/pool bounds.
 *   Physical reset first commits capacity cache-generation status in a bounded
 *   standalone statement; only after that commit may it update buckets in
 *   target order. No graph lock spans a projection/source lock. Registration's
 *   connection generation also fences old physical warmth after reconnect.
 *   Source publication checks current authority under the bucket lock. Source
 *   userId is the pool principal; bucket userId is the physical target owner.
 *   This projection lock is not an ordered, waiting capacity-domain fence.
 *   One other
 *   documented exception: the relay disconnect (node-presence, lane A1) runs its
 *   per-target health statements (single-row, id order) inside a transaction that holds
 *   the `node` row, because that row lock is the fence against a reconnect's
 *   registration. Every wait in it is bounded by a transaction-local `lock_timeout`, and
 *   it retries.
 * - M (management): relay registration, dashboard and MCP writes, provider
 *   management, parent deletes, startup backfills and auto-capacity cleanup. It first takes the `owner`
 *   fence of every user whose graph rows it writes (sorted; cascades
 *   included, see {@link fenceParentDelete}), then the policy/capacity fences
 *   of the policy it changes, and only then locks and writes graph rows. It
 *   never writes an H table.
 * - S (sweepers): retention, purge of deleted users' history, orphan
 *   terminalization. Row locks with SKIP LOCKED and fences with
 *   `{ wait: false }` only: an S transaction never waits on a fence or a
 *   graph row. The orphan sweep's refill step is the one exception: after
 *   it holds its fences it takes the cross-capacity `admission_request` set
 *   with the H order (one sorted statement, {@link lockCrossCapacityAdmissionRequests}),
 *   which may wait on an H transaction that follows the same order.
 *   The deleted-user purge's rollup merge can wait on a destination row a hot
 *   writer holds, for at most `lock_timeout` 100 ms; the batch then rolls back
 *   and the entry is retried on the next run.
 * - D (deploy DDL): schema-hardening.sql takes every table in one up-front
 *   `LOCK TABLE ... NOWAIT` and is retried; `prisma db push` runs with a
 *   `lock_timeout` (packages/db/scripts/push-schema.mjs).
 *
 * Fences are transaction-scoped advisory locks named `LL:kind:id`, where the
 * two-digit level LL fixes the global order ({@link fences}):
 *
 *   00 owner:<user>                         M only
 *   01 admission-attempt:<attempt>          admission (first)
 *      spend-attempt:<attempt>              spend reservation/settlement of one attempt
 *   02 execution-target:<identity>          target creation (M)
 *   04 spend-account:<account>              every cloud admission on the account (H), cap writers (M)
 *      spend-cap:<cap>                      cap edits (M)
 *      spend-share:<share>                  every owner-paid share admission (H), cap writers (M)
 *   05 provider-pricing:<user>:<model>
 *   06 capacity-policy:<target>             policy writers (M) and admission (H)
 *   07 concurrency:<scope>:<id>             admission-internal
 *   08 capacity:<instance>                  admission (H), instance policy writers (M)
 *   09 cache-affinity:<owner>:<pool>        cache affinity identity + record/node retention
 *
 * Enforcement (structural, not an inventory):
 *
 * 1. {@link acquireFences} (database function `wsmp_acquire_fences`) refuses
 *    a fence once the transaction has an assigned xid, i.e. after its first
 *    row lock or write (`WMPF1`), and a fence that does not sort after every
 *    fence the transaction already holds (`WMPF2`). It records the held
 *    fences in the transaction-local setting `wsmp.fences`.
 * 2. Fence triggers on the graph tables (schema-hardening.sql,
 *    `enforce_graph_write_fence`) raise `WMPF4` when an INSERT, a DELETE (a
 *    cascaded one too) or an UPDATE of an identity, reference or policy
 *    column runs without the `owner` fence of every owner involved (both
 *    parties of a pool grant; the token owner and the referenced resource's
 *    owner of an allowlist entry), or a policy UPDATE runs without the
 *    `capacity-policy` / `capacity` fence of the rows whose admission view it
 *    changes (spec §2.14: runtime current version, instance version, pool routing and
 *    advanced limits, share class/permissions, member state and weight). A row INSERTED by the same transaction (recorded by an AFTER
 *    INSERT trigger; an earlier update of an existing row does not count)
 *    needs no policy fence (no other transaction can see it). A forgotten fence fails
 *    deterministically in tests instead of deadlocking in production.
 * 3. The catalog test finds no foreign key between an H table and a graph
 *    table (`pg_constraint`, either direction).
 * 4. The static guard (apps/server/src/model-api/capacity/lock-order.test.ts)
 *    allows H-table writes only in the H and S modules, advisory locks only
 *    here and in the deploy scripts, and `wsmp.fences` only here, in
 *    schema-hardening.sql and in test fixtures.
 *
 * Why admission cannot be part of a deadlock:
 *
 * - H waits only on fences (taken before any row, so while holding none,
 *   except further fences in ascending order) and on H-private rows, which
 *   only H and S transactions lock. Graph rows H writes (status columns) are
 *   single-row statements or the provider account->model pair, and no H
 *   transaction waits on a graph row while holding an H row or a fence
 *   another H transaction needs, except in that order.
 * - M waits on fences only at the start of its transaction, holding nothing
 *   but lower fences. After that it waits only on graph rows, held by other M
 *   transactions (which share an `owner` fence with it whenever they write a
 *   common row, so they run one after the other) or by H/auxiliary writers
 *   that hold nothing else of M's and take graph rows in the same order.
 * - S never waits on a fence or graph row (see the S entry above for the orphan refill's H-ordered request lock).
 * - So a wait-for cycle that contains an admission consists of H
 *   transactions only, and their order is the admission-internal order below
 *   (one file, PostgreSQL-tested).
 *
 * Admission-internal order (apps/server/src/model-api/capacity/postgres-store.ts):
 *
 *   admission-attempt fence -> capacity-policy fences of the candidate targets
 *   -> concurrency-scope fences -> capacity fences -> `admission_request` rows
 *   FOR UPDATE, the cross-capacity set first, sorted
 *   ({@link lockCrossCapacityAdmissionRequests}) -> the own request's waiters
 *   -> waiter, lease, request and `capacity_scheduler` writes.
 *
 * Release, reclaim, terminalization and the abandoned/orphan sweep take the
 * same fences (without the attempt fence) in the same order. The relay
 * admission-state projection (`relay_request.admissionTerminalState`) is a
 * separate single-row statement after the store transaction commits, so no
 * store transaction waits on a relay row. Lease heartbeat is a single-row
 * conditional UPDATE holding nothing else. `capacity_scheduler` rows are
 * written only by a holder of their capacity fence, so they need no row lock.
 *
 * Provider order (M writers and H provider runtime):
 *
 *   spend fences -> execution-target identity fence (creating a target) ->
 *   provider-pricing fence -> capacity policy / capacity fences ->
 *   `provider_account` row -> `provider_model` row -> `provider_pricing_version` rows ->
 *   `provider_credential` row -> child inserts.
 *
 * Every fence precedes the first row lock. Every transaction that locks both
 * a provider account and one of its models or credentials takes the account
 * first: M writers explicitly, H provider health and fencing transactions
 * (the attempt pipeline, lane B4) explicitly. Spend admission and accounting write only H tables
 * after their fences and read the account and model without a lock. A graph
 * INSERT that references an account or model (a pool's provider target,
 * pricing, a spend cap) runs after the account and model rows are held,
 * so its foreign-key checks re-enter held rows.
 *
 * Outside the capacity domain: the `session_refuse_deleting_user` trigger
 * (schema-hardening.sql) reads the session owner's `user` row FOR SHARE on
 * every session INSERT (DEL-STATE commit point), and for an impersonation
 * session (Better Auth `impersonatedBy`) then the impersonating admin's
 * `user` row FOR SHARE too (IMP-MARK), owner first. A session inserter holds
 * no fence or row lock and takes none afterwards, so its waits (on a deletion
 * mark, the user delete's row lock or another user writer) close no cycle.
 * The two reads are FOR SHARE on user rows: they never conflict with each
 * other, and each user writer they can wait on (the mark, the user delete,
 * an abandon, a ban or role write) writes one user row and never waits on a
 * session inserter's rows, so the owner-then-impersonator pair adds no edge
 * either; the mark deletes the admin's impersonation sessions after its own
 * UPDATE, the same order. Two more transactions outside the capacity domain
 * take the user row FOR SHARE:
 *
 * - A user-deletion drain batch (./parent-deletion.ts,
 *   `runParentDeletionDrainBatch`) takes it first, on its deletion
 *   generation, then only history rows with SKIP LOCKED, every statement
 *   bounded by a transaction-local `statement_timeout` (and every lock wait
 *   by the lower `lock_timeout`). It never waits on a fence or a graph row,
 *   so the user delete (fences, then this row FOR UPDATE) waiting on it
 *   closes no cycle.
 * - The node enrollment exchange (node-credential-access, lane A1) takes the owner fence
 *   of the code's user first, then that user's row FOR SHARE: the same order as every
 *   M writer.
 */
import type { PrismaClient } from "../prisma/generated/client";
import { Prisma } from "../prisma/generated/client";
import {
  type DeletedParents,
  ParentDeletionOwnerRequiredError,
  type ParentDeletionScope,
  resolveDeletedParents,
} from "./parent-deletion-residual";

type Tx = Prisma.TransactionClient;

/**
 * The hot-path (writer class H) tables. None has a foreign key to or from a
 * graph table; the catalog test checks it against `pg_constraint`.
 */
export const HOT_PATH_TABLES = [
  "admission_request",
  "capacity_waiter",
  "capacity_lease",
  "capacity_scheduler",
  "capacity_kv_eviction",
  "routing_verdict",
  "cache_affinity_record",
  "cache_affinity_residency",
  "cache_affinity_residency_cursor",
  "cache_affinity_node",
  "cache_affinity_scope",
  "cache_affinity_observer",
  "response_stickiness_record",
  "relay_request",
  "attempt",
  "attempt_event",
  "spend_reservation",
  "spend_settlement",
  "usage_ledger",
  "usage_rollup_minute",
  "usage_rollup_hour",
  "runtime_load_minute",
  "node_metrics_minute",
] as const;

/**
 * The graph (configuration) tables: fence triggers guard their writes (the install list of
 * `enforce_graph_write_fence` in schema-hardening.sql).
 */
export const GRAPH_TABLES = [
  "user",
  "node",
  "runtime",
  "runtime_version",
  "runtime_model",
  "runtime_share",
  "runtime_instance",
  "instance_rank",
  "instance_step",
  "runtime_operation",
  "execution_target",
  "profile",
  "profile_node",
  "profile_item",
  "pool",
  "pool_routing",
  "pool_fallback",
  "pool_advanced",
  "pool_sidecar",
  "pool_member",
  "pool_routing_rule",
  "api_key",
  "api_key_pool",
  "share",
  "share_invite",
  "provider_account",
  "provider_model",
  "provider_credential",
  "provider_pricing_version",
  "spend_cap",
] as const;

const RETRYABLE_TRANSACTION_CODES = new Set(["P2034", "40001", "40P01", "FENCE_SET_CHANGED"]);

/** A code found on the error or on one of its Prisma / driver wrappers. */
function findErrorCode(error: unknown, accept: (code: string) => boolean): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (typeof code === "string" && accept(code)) return code;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return undefined;
}

/** True for PostgreSQL serialization/deadlock failures and fence-set changes. */
export function isRetryableCapacityTransactionError(error: unknown): boolean {
  return findErrorCode(error, (code) => RETRYABLE_TRANSACTION_CODES.has(code)) !== undefined;
}

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/** A fence name, `LL:kind:id`; build one with {@link fences}. */
export type Fence = string & { readonly __wsmpFence: unique symbol };

function fence(level: string, kind: string, id: string): Fence {
  if (id.length === 0 || id.includes(",")) throw new Error(`Invalid ${kind} fence id.`);
  return `${level}:${kind}:${id}` as Fence;
}

/**
 * Fence constructors, one per kind, in the global level order documented
 * above. The advisory key is the name without its level prefix.
 */
export const fences = {
  owner: (userId: string) => fence("00", "owner", userId),
  admissionAttempt: (attemptId: string) => fence("01", "admission-attempt", attemptId),
  spendAttempt: (attemptId: string) => fence("01", "spend-attempt", attemptId),
  targetIdentity: (identity: string) => fence("02", "execution-target", identity),
  spendCap: (capId: string) => fence("04", "spend-cap", capId),
  /** Serializes cloud admissions on one provider account, capped or not (cap subject). */
  spendAccount: (providerAccountId: string) => fence("04", "spend-account", providerAccountId),
  /** Serializes owner-paid admissions through one share, capped or not (cap subject). */
  spendShare: (shareId: string) => fence("04", "spend-share", shareId),
  pricing: (userId: string, providerModelId: string) =>
    fence("05", "provider-pricing", `${userId}:${providerModelId}`),
  capacityPolicy: (executionTargetId: string) => fence("06", "capacity-policy", executionTargetId),
  concurrencyScope: (scope: string, scopeId: string) =>
    fence("07", "concurrency", `${scope}:${scopeId}`),
  /** capacityId = RuntimeInstance.id. */
  capacity: (capacityId: string) => fence("08", "capacity", capacityId),
  cacheAffinity: (ownerUserId: string, poolId: string) =>
    fence("09", "cache-affinity", `${ownerUserId}:${poolId}`),
} as const;

/** Refusal codes of `wsmp_acquire_fences` (schema-hardening.sql). */
const FENCE_PROTOCOL_CODES = new Set(["WMPF1", "WMPF2", "WMPF3"]);

/**
 * A fence was requested out of protocol: after the transaction's first row
 * lock or write (`WMPF1`), below a fence it already holds (`WMPF2`), or
 * malformed (`WMPF3`). A programming error in the caller; never retried.
 */
export class FenceProtocolError extends Error {
  readonly code = "FENCE_PROTOCOL";
  constructor(
    readonly sqlState: string,
    options?: { cause?: unknown },
  ) {
    super(
      sqlState === "WMPF1"
        ? "A fence was requested after the transaction locked or wrote a row."
        : sqlState === "WMPF2"
          ? "A fence was requested out of the global fence order."
          : "A malformed fence was requested.",
      options,
    );
    this.name = "FenceProtocolError";
  }
}

/**
 * Takes `requested` fences in the global order: sorted by level, then name.
 * Must run before the transaction's first row lock or write, and each call
 * must request only fences that sort after every fence already held (a fence
 * already held is skipped). Returns true when every fence is held.
 *
 * `wait: false` (sweepers) takes each fence only if it is free and returns
 * false at the first busy one; the caller must then end its transaction
 * without waiting on anything (the fences taken so far are released with it).
 */
export async function acquireFences(
  tx: Tx,
  requested: Iterable<Fence>,
  { wait = true }: { wait?: boolean } = {},
): Promise<boolean> {
  const ordered = [...new Set(requested)].sort();
  if (ordered.length === 0) return true;
  try {
    const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT wsmp_acquire_fences(${ordered}::text[], ${wait}) AS acquired`;
    // A waiting call returns only once every fence is held.
    return wait || rows?.[0]?.acquired === true;
  } catch (error) {
    const sqlState = findErrorCode(error, (code) => FENCE_PROTOCOL_CODES.has(code));
    if (sqlState) throw new FenceProtocolError(sqlState, { cause: error });
    throw error;
  }
}

/** Takes the `owner` fence of every user in `userIds` (M writers, first). */
export async function fenceOwners(tx: Tx, userIds: Iterable<string>): Promise<void> {
  await acquireFences(
    tx,
    [...new Set(userIds)].map((userId) => fences.owner(userId)),
  );
}

// ---------------------------------------------------------------------------
// Admission-internal order (the admission store)
// ---------------------------------------------------------------------------

/**
 * The admission store's capacity fences for a set of physical capacities: the
 * concurrency-scope fences of every durable waiter on them (plus
 * `additionalScopeFences`), then the capacity fences, in one ascending call.
 * The first read after this call runs as a new READ COMMITTED statement, so
 * it sees every capacity policy and admission write committed by the previous
 * holder of these fences.
 *
 * Re-read the scope set UNDER the capacity fences before allowing admission.
 * Waiter writers on these capacities require the same capacity fences, so
 * that read is exact. A new scope cannot be acquired in place: level 07
 * sorts below the held level 08 fences (WMPF2). Throw FenceSetChangedError
 * before any row lock/write so the caller restarts its transaction within
 * its retry bound; non-waiting sweepers return false and retry next run.
 * A shrinking set is safe: extra held scope fences are harmless.
 */
export async function fenceCapacityAdmission(
  tx: Tx,
  capacityIds: readonly string[],
  additionalScopeFences: readonly Fence[] = [],
  options: { wait?: boolean } = {},
): Promise<boolean> {
  const readScopes = async () =>
    capacityIds.length
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
  const scopeFence = (waiter: Awaited<ReturnType<typeof readScopes>>[number]) =>
    fences.concurrencyScope(waiter.effectiveConcurrencyScope, waiter.effectiveConcurrencyScopeId);
  const heldScopes = new Set([...(await readScopes()).map(scopeFence), ...additionalScopeFences]);
  if (
    !(await acquireFences(
      tx,
      [...heldScopes, ...capacityIds.map((capacityId) => fences.capacity(capacityId))],
      options,
    ))
  )
    return false;
  if ((await readScopes()).some((waiter) => !heldScopes.has(scopeFence(waiter)))) {
    if (options.wait === false) return false;
    throw new FenceSetChangedError();
  }
  return true;
}

/**
 * For an admitter that holds the capacity fences of `heldCapacityIds`: locks,
 * in one sorted statement, `ownRequestIds` plus every WAITING admission
 * request that waits on a held capacity AND on a capacity outside the held
 * set. Only such a request can be locked by another admitter (one holding a
 * different capacity); a request whose live waiters are all on held
 * capacities is reachable only through those fences. Taking the contended
 * rows up front, sorted, removes the sibling-winner inversion where two
 * admitters each lock the request the other admits next. The set cannot grow
 * afterwards: a new waiter on a held capacity needs that capacity's fence.
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
 * Deletes terminal `relay_request` rows without waiting on a relay row lock (sweepers and the
 * user-deletion drain): the rows are taken with SKIP LOCKED and `status` is re-checked under
 * the lock; skipped rows stay for a later run. `admission_request.relayRequestId` is a plain
 * id (no foreign key), so no admission row is rewritten.
 *
 * Not taken with SKIP LOCKED: the ON DELETE CASCADE children of a deleted relay row
 * (`attempt`, and its `attempt_event` rows). The DELETE can wait on one of those rows while
 * its writer holds it. Their writers (the attempt pipeline) take no fence, so the wait closes
 * no cycle with an admitter; the drain bounds it with a transaction-local `lock_timeout`.
 * Returns the number of deleted rows.
 */
export async function deleteTerminalRelayRequestsWithoutWaiting(
  tx: Tx,
  relayRequestIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(relayRequestIds)].sort();
  if (ids.length === 0) return 0;
  // One array parameter per statement: batches run to thousands of ids.
  return tx.$executeRaw`
    DELETE FROM relay_request
     WHERE id IN (
       SELECT id FROM relay_request
        WHERE id = ANY(${ids}::text[])
          AND status IN ('SUCCEEDED', 'FAILED', 'CANCELED')
        ORDER BY id
        FOR UPDATE SKIP LOCKED)`;
}

// ---------------------------------------------------------------------------
// Parent deletes (writer class M)
// ---------------------------------------------------------------------------

/** What a parent delete removes; see `ParentDeletionScope`. */
export type CapacityDeleteScope = ParentDeletionScope;

/**
 * A resource set grew between discovery and its fences (admission scopes or
 * parent-delete owners). Roll back and retry with a fresh set; never acquire
 * missing lower-level fences in place. No row is locked or written yet.
 */
export class FenceSetChangedError extends Error {
  readonly code = "FENCE_SET_CHANGED";
  constructor() {
    super("The required fence set grew while the transaction was taking its fences. Retry.");
    this.name = "FenceSetChangedError";
  }
}

/** The user row no longer carries the caller's deletion generation. */
export class UserDeletionGenerationChangedError extends Error {
  constructor() {
    super("The user row no longer carries this deletion generation.");
    this.name = "UserDeletionGenerationChangedError";
  }
}

/**
 * Every user whose graph rows the delete of `parents` writes, cascades included: the owner,
 * both parties of every share and runtime share it removes, the pool owners and contributors
 * of the members it removes (a contributed member links two graphs), the API-key and pool
 * owners of the key entries it removes, and the owners of sidecars that point at a deleted
 * pool. Plain reads.
 */
export async function resolveDeletionOwners(
  tx: Pick<Tx, "$queryRaw">,
  ownerUserId: string,
  parents: DeletedParents,
): Promise<string[]> {
  const owners = new Set([ownerUserId, ...parents.user]);
  const add = (rows: ReadonlyArray<Record<string, string | null>>) => {
    for (const row of rows) for (const value of Object.values(row)) if (value) owners.add(value);
  };
  add(
    await tx.$queryRaw<Array<{ ownerUserId: string; granteeUserId: string }>>`
      SELECT "ownerUserId", "granteeUserId" FROM share
       WHERE id = ANY(${parents.share}::text[])
          OR "poolId" = ANY(${parents.pool}::text[])
          OR "ownerUserId" = ANY(${parents.user}::text[])
          OR "granteeUserId" = ANY(${parents.user}::text[])`,
  );
  add(
    await tx.$queryRaw<Array<{ ownerUserId: string; granteeUserId: string }>>`
      SELECT "ownerUserId", "granteeUserId" FROM runtime_share
       WHERE id = ANY(${parents.runtime_share}::text[])
          OR "runtimeId" = ANY(${parents.runtime}::text[])
          OR "ownerUserId" = ANY(${parents.user}::text[])
          OR "granteeUserId" = ANY(${parents.user}::text[])`,
  );
  add(
    await tx.$queryRaw<Array<{ poolOwner: string | null; modelOwner: string | null }>>`
      SELECT pool."userId" AS "poolOwner", model."userId" AS "modelOwner"
        FROM pool_member member
        JOIN pool ON pool.id = member."poolId"
        LEFT JOIN runtime_model model ON model.id = member."runtimeModelId"
       WHERE member.id = ANY(${parents.pool_member}::text[])`,
  );
  add(
    await tx.$queryRaw<Array<{ keyOwner: string; poolOwner: string }>>`
      SELECT key."userId" AS "keyOwner", pool."userId" AS "poolOwner"
        FROM api_key_pool entry
        JOIN api_key key ON key.id = entry."apiKeyId"
        JOIN pool ON pool.id = entry."poolId"
       WHERE entry."apiKeyId" = ANY(${parents.api_key}::text[])
          OR entry."poolId" = ANY(${parents.pool}::text[])`,
  );
  add(
    await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT pool."userId" FROM pool_sidecar sidecar JOIN pool ON pool.id = sidecar."poolId"
       WHERE sidecar."targetPoolId" = ANY(${parents.pool}::text[])`,
  );
  return [...owners].sort();
}

/**
 * The M prelude of every parent delete, run in a READ COMMITTED transaction
 * ({@link runCapacityOrderedTransaction}) right before the caller's DELETE:
 *
 * 1. plans the owner set of the delete (plain reads,
 *    {@link resolveDeletionOwners});
 * 2. takes their `owner` fences, sorted;
 * 3. re-plans under the fences. Every writer that could add a user to the set
 *    (a grant, an allowlist entry) needs a fence this transaction now holds,
 *    so the re-plan is final; a larger set throws
 *    {@link FenceSetChangedError} (retried) before any row is locked;
 * 4. for a whole-user delete: locks the user row FOR UPDATE on the caller's deletion
 *    generation ({@link UserDeletionGenerationChangedError} when it changed); for any other
 *    delete: takes the policy fences of the targets and the capacity fences of the
 *    instances it removes. Returns those instance ids.
 *
 * The DELETE that follows is a plain delete: it cascades only into graph and
 * auxiliary rows (no H table has a foreign key), each guarded by a fence this
 * transaction holds. A parent with admission or lease history is deletable;
 * the history keeps plain ids and the sweepers terminalize live orphans.
 *
 * A whole-user delete runs in the fixed order of the hardening contract
 * ({@link deleteUserUnderOwnerFences}): instances, profiles, runtimes (current version
 * nulled first), nodes, pools, providers, then the user row.
 */
export async function fenceParentDelete(tx: Tx, scope: CapacityDeleteScope): Promise<string[]> {
  if (scope.wholeUser && scope.userDeletionGeneration === undefined)
    throw new ParentDeletionOwnerRequiredError();
  const planned = await resolveDeletionOwners(
    tx,
    scope.userId,
    await resolveDeletedParents(tx, scope),
  );
  await fenceOwners(tx, planned);
  const parents = await resolveDeletedParents(tx, scope);
  const current = await resolveDeletionOwners(tx, scope.userId, parents);
  const held = new Set(planned);
  if (current.some((owner) => !held.has(owner))) throw new FenceSetChangedError();
  if (!scope.wholeUser) {
    // A delete that removes instances or changes a pool's targets changes admission views:
    // take their policy and capacity fences before the first row lock or write.
    await acquireFences(tx, [
      ...parents.execution_target.map((id) => fences.capacityPolicy(id)),
      ...parents.runtime_instance.map((id) => fences.capacity(id)),
    ]);
    return parents.runtime_instance;
  }
  // The generation predicate is evaluated under this lock: READ COMMITTED re-checks the
  // WHERE on the newest row version after waiting, so an abandon, unarchive or new
  // generation committed meanwhile yields no row. The writers that change the generation
  // take no fence, so waiting on them here closes no cycle.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "user"
     WHERE id = ${scope.userId} AND "deletionGeneration" = ${scope.userDeletionGeneration}
     FOR UPDATE`;
  if (locked.length === 0) throw new UserDeletionGenerationChangedError();
  return [];
}

type TransactionRunner = Pick<PrismaClient, "$transaction">;

/**
 * Upper bound on any single lock wait inside a capacity-ordered transaction
 * (`lock_timeout`, transaction-local, set as the transaction's first
 * statement). A parent delete waits on owner-fence holders (other
 * management writers of the same owners, relay registration) and graph row
 * holders; past this bound it gives up instead of queueing behind them. SQLSTATE 55P03, surfaced as
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
 * serialization and fence-set-change failures with a fresh transaction. Used
 * by parent deletes: READ COMMITTED lets every read after a fence see the
 * rows committed by the previous holder.
 *
 * Server-side bounds: the transaction's first statement sets a
 * transaction-local `lock_timeout` ({@link CAPACITY_ORDERED_LOCK_TIMEOUT_MS})
 * and `statement_timeout` ({@link CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS}),
 * so every statement of `work` (the owner-fence wait, the re-plan and the
 * final DELETE with its graph cascade) is cancelled by PostgreSQL at that
 * bound, on every client: the shared request client (which has no session
 * bound of its own) and the sweep's statement-bounded client alike. A
 * cancelled statement aborts the transaction, which rolls back and releases
 * every lock and fence it held. The timeout is not retried and surfaces as
 * {@link CapacityOrderedTransactionTimeoutError}; request paths map it to
 * the `delete_contended` CONFLICT (packages/api `runCapacityDeleteTransaction`
 * and the CLI device delete), the sweep backs off.
 *
 * The 15 s cap is Prisma's client-side transaction timeout, a backstop for
 * JavaScript time between statements: with every statement bounded
 * server-side, the fences and row locks are held at most a few statements'
 * bounds. Under DL-1 (d) the final DELETE never reaches a hot-path row (no
 * foreign key crosses the boundary), so its cost does not grow with request
 * history; the user drain still runs first for privacy (./parent-deletion.ts).
 *
 * The user-deletion sweep's client is also fenced at dispatch
 * (./client-factory.ts): once the shutdown fence arms it sends no further
 * statement but the `COMMIT` / `ROLLBACK`, including the separate queries a
 * single Prisma call issues, so what is left at shutdown is one statement and
 * the end of its transaction, not every statement of one call. The end of a
 * transaction has no server-side bound (a `COMMIT` can wait on synchronous
 * replication); shutdown waits on the sweep for its join deadline and then
 * quarantines the sweep's connections (`shutDownUserDeletionSweep`), so the
 * server finishes that transaction by commit or rollback after the process
 * leaves.
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
 * The user's graph in the hardening contract's order (docs/contracts/0.4.0-schema-hardening.md,
 * "Delete rules"): the `NoAction` edges (instance → runtime/version, profile item → runtime,
 * runtime → current version, pricing → model/account, credential rotation) must be gone
 * before their parent, so the user cascade alone would fail at statement end.
 */
async function deleteUserGraphInOrder(tx: Tx, userId: string): Promise<void> {
  await tx.runtimeInstance.deleteMany({ where: { userId } });
  await tx.profile.deleteMany({ where: { userId } });
  await tx.runtime.updateMany({ where: { userId }, data: { currentVersionId: null } });
  await tx.runtime.deleteMany({ where: { userId } });
  await tx.node.deleteMany({ where: { userId } });
  await tx.pool.deleteMany({ where: { userId } });
  await tx.providerPricingVersion.deleteMany({ where: { userId } });
  // Rotated keys first: clearing replacedById on a REPLACED key would break its shape CHECK.
  // One statement takes the whole chain (NoAction is checked at statement end, and only the
  // ACTIVE head, which nothing deleted here references, remains for the account cascade).
  await tx.providerCredential.deleteMany({ where: { userId, replacedById: { not: null } } });
  await tx.providerAccount.deleteMany({ where: { userId } });
}

/**
 * Deletes a user and its graph under the owner fences of every affected user
 * ({@link fenceParentDelete}), and records the user in the purge queue
 * (`deleted_user_purge`) in the same transaction: the user's hot-path history
 * has no foreign key to the user, so what the drain could not take (requests
 * still in flight) is purged by the history sweeper afterwards. Returns false
 * when the user no longer exists or no longer carries `deletionGeneration`.
 * Foreign-key RESTRICT failures (retained provider history) propagate
 * unchanged.
 *
 * Phase 3 only: callers go through `deleteUserDurably` /
 * `completeUserDeletion` in ./parent-deletion.ts, which refuse retained
 * history and drain the user's own history first.
 */
export async function deleteUserUnderOwnerFences(
  db: TransactionRunner,
  userId: string,
  deletionGeneration: string,
): Promise<boolean> {
  try {
    return await runCapacityOrderedTransaction(db, async (tx) => {
      await fenceParentDelete(tx, {
        userId,
        wholeUser: true,
        userDeletionGeneration: deletionGeneration,
      });
      // The purge-queue entry is written before the DELETE so the DELETE is
      // the transaction's last statement: a DB shutdown fence that arms while
      // it runs lets it finish and commit (the fence refuses only statements
      // dispatched after it arms), instead of refusing a trailing INSERT and
      // rolling the delete back.
      await tx.$executeRaw`
        INSERT INTO deleted_user_purge ("userId") VALUES (${userId})
        ON CONFLICT ("userId") DO NOTHING`;
      await deleteUserGraphInOrder(tx, userId);
      await tx.user.delete({ where: { id: userId }, select: { id: true } });
      return true;
    });
  } catch (error) {
    if (error instanceof UserDeletionGenerationChangedError) return false;
    throw error;
  }
}
