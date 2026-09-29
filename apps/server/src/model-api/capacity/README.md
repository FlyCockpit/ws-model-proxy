# Durable capacity invariants

PostgreSQL rows are the reservation ledger: active `CapacityLease` rows consume physical and
membership capacity; `PoolMember` and `ExecutionTarget` rows define reservation and borrowing
policy; waiting `CapacityWaiter` rows determine whether reserved work is queued. No process-local
counter grants capacity.

The CI-gated integration suite uses independent clients for advisory-lock, admission, fencing,
restart, notification, and race proofs. Serialization (`40001`) and deadlock (`40P01`) retry logic is
tested through the production transaction runner with injected rollback attempts. A live
opposite-lock deadlock is intentionally not forced: PostgreSQL chooses the deadlock victim and
detection timing based on server configuration, making such a test nondeterministic and slow on
shared CI. The injected proof deterministically verifies the same driver error codes, retry bound,
and absence of state committed by failed attempts.

## One admission planner: who gets a slot

Every grant of a physical-capacity slot goes through `admission-planner.ts` (`planGrants`), the
single enforcement point for "who gets a slot". `PostgresCapacityAdmissionStore.#admitCapacity` runs
it for both callers: acquire (offer mode: stop once the polling or creating request is granted)
and release/reclaim (fill mode: grant until nothing more fits).

1. **Read** (`#readAdmissionSnapshot`): the deadline sweep (deferred waiters are left to their
   owner's poll), the grant-time routability re-check, then ONE snapshot of the capacity (limit, DRR
   cursor/deficits/version), ACTIVE leases, WAITING waiters, reservation members, direct
   reservations and per-scope lease counts, all under the L4/L6 locks the caller already holds.
2. **Plan** (`planGrants`, pure, no database): applies the decision repeatedly in memory. Each step
   is the single-grant decision (eligibility: `notBefore <= now`, candidate/request deadlines with
   the creating-request and last-chance exceptions, member/scope and physical limits, reservation
   borrowing, then one weighted deficit round robin pick), then updates the in-memory state (active
   counts, per-owner and per-scope counts, the winner's request leaves the queue, DRR state). The
   loop is bounded by progress (waiters at entry + 1 steps, every grant removes a waiter), never by a
   constant, so unlimited capacities are served completely. Borrow-check aggregates are computed
   once per step.
3. **Write** (`#persistGrants`): one sorted `FOR UPDATE` over the winners' request rows plus a
   re-read (a winner no longer WAITING ends the persisted prefix and the pass re-plans), the
   shutdown fence checked ONCE right before the first write (armed: nothing is written), then
   batched writes: the capacity's scheduler state and fencing counter, `createMany` leases,
   requests to ADMITTED, sibling waiters to CANCELLED, winner waiters to ADMITTED.

The transaction can be retried (`runCapacitySerializable`): nothing is carried across attempts;
each attempt re-reads, re-plans and takes fencing tokens from the capacity row's counter. Cost per
transaction is one snapshot plus O(waiters) work per grant in memory and a handful of statements,
independent of how many waiters are granted (256 grants: about 0.5 s release, 1.5 s poll on a
loaded development machine). Lock order (`packages/db/src/capacity-lock-order.ts`) is unchanged. The planner is O(k·W) per
transaction (k grants over W waiters) and is suited to at most a few thousand simultaneously
grantable waiters per capacity.

## Spill-over `notBefore` and grant-time routability (saturation S-A)

- A pool request whose prefix is warm on one member (the cache holder: best continuation
  prefix depth, or a conversation match) defers every other candidate: the store sets
  `CapacityWaiter.notBefore = clock_timestamp() + notBeforeMs` at enqueue (database clock,
  capped at 30 s). A waiter before its `notBefore` is neither granted nor counted in the
  reservation-borrowing arbitration, and the DRR scheduler never sees it.
- Every wait budget of an attempt counts from its spill instant (the latest `notBefore`), so a
  deadline never precedes `notBefore` and an `:external` caller leaves the local queue only at
  `max(notBefore) + externalAfterWaitMs`. A deferred attempt keeps at least 250 ms of eligibility
  so a zero budget is still checked once at the spill instant.
- Time passing is not a release event and sends no notification: the runtime re-polls every
  100 ms and each poll re-runs admission, so a deferred waiter becomes grantable on the first
  poll at or after its `notBefore`.
- A deferred waiter always gets one admission check after it becomes eligible. Each poll stamps
  `AdmissionRequest.heartbeatAt`; when a poll is delayed past a deferred waiter's deadline (for
  example by contended capacity locks) and the previous poll ran before its `notBefore`, that poll
  runs admission for it once ("last chance") and expires it only afterwards. Other admitters'
  deadline sweeps skip deferred waiters and leave them to their owner's poll; the request's
  absolute deadline still applies.
- A retry round (a new attempt after a pre-commit failure) may pass
  `schedule: { anchorAttemptId, spillDelayMs }`: its `notBefore`, spill instant and budgets are
  then computed from the first attempt's database-clock enqueue instant
  (`AdmissionRequest.enqueuedAt`), not restarted, so lock waits before the retry's transaction
  never extend the original external deadline. Instants already in the past are clamped to now.
- At each admission pass (even while the capacity is full), waiters whose member is no longer
  routable (`routingStatus` not ACTIVE; for PRIMARY members also `weight <= 0` or UNHEALTHY with a future
  `nextRetryAt`; external members use provider health at dispatch)
  are cancelled with `terminalReason = member_unroutable`; the request expires with that reason
  once no candidate is left. The `pool_member` read is a plain subquery (no row lock), so it adds
  no lock-order edge. CLI connection state is per process and remains a candidate-build and
  dispatch check only.

## Per-grant queue priority (saturation S-C)

- A pool attempt carries the requester's `accessGrantId` (grantees only). When the grant's
  `queuePriority` is set, it replaces the pool/member `capacityPriority` as every candidate's
  effective waiter priority (clamped to 0..31) and is recorded as the request's `basePriority`;
  null, the owner (no grant) and a grant of another pool inherit. It is read once, when the
  attempt is created, with a plain `pool_grant` read after the L2 fences: no row lock, so no
  lock-order edge. The DRR scheduler is unchanged; the grant only moves the waiter's class.
- Warm-session protection (`../warm-protection.ts`) never touches the store: it reorders and
  filters candidates before the attempt is built, so it adds no waiter state and no lock.

## Lease ownership from admission to release (F2-CAP-1)

`StoreCapacityAdmissionRuntime.acquire` attaches one `CapacityLeaseOwner` to the admitted handle,
keyed by lease ID and fencing token. Before exposing the handle it confirms ownership with a
heartbeat; this also rejects a stale admission received after a delayed poll/notification. The
owner renews the 30-second database lease every 10 seconds throughout dispatch, including relay
prefill and provider header waits. Only one renewal may be in flight. A monotonic watchdog aborts
at the last acknowledged renewal's conservative expiry (query start plus extension), so a stalled
heartbeat cannot leave dispatch running past its lease. A false renewal, watchdog expiry, client
abort, runtime shutdown, or explicit release abort the handle's signal before starting durable
release. Late heartbeat results cannot restart a stopped owner.

A thrown renewal (F2-CAP-5) is retried after 1 s, 2 s, then every 4 s while the last
*acknowledged* TTL still covers the delay plus a 2 s margin; when no retry fits, the owner releases
before the TTL ends. An error never extends or re-arms the watchdog: only a successful renewal
does, measured from that query's start. A `false` result is never retried.

Lease loss has its own abort reason (F2-CAP-3): `CapacityLeaseLostError` (`lease-loss.ts`, with a
`kind`: `ownership_lost`, `heartbeat_timeout`, `heartbeat_failed`, `max_lifetime`,
`request_scope_closed`). Dispatches classify on `signal.reason`, never on `signal.aborted`: a lost
lease is the server-only failure `capacity_lease_lost` (HTTP 503, attempt/relay `errorClass`,
provider event reason `CAPACITY_LEASE_LOST`), never a 499 cancellation. Before the first client
byte it is a retryable precommit failure: pool routes fail over to the next member (local and
external tiers, subject to `retrySafe` and the relay deadline) without a member or provider health
penalty, and answer 503 when nothing else is available. `hold` refuses a hand-off whose lifetime
already ended, so the route's precommit path classifies it. The window between a successful
dispatch and the hand-off counts too, including a non-streaming provider body that is fully read
before `hold`: the external route re-enters its tier traversal on the loss (never re-admitting the
member whose lease was lost), and the bound Responses route, which has no failover, answers its
family's 503 `external_unavailable` envelope. A lease lost while ownership is still being
confirmed at admission surfaces as the runtime outcome `LEASE_LOST` (naming the member), never as a
cancellation or rate limit: a pool excludes that member from the admission call and re-admits the
rest (a later retry in the same request may admit it again under a fresh lease; no health penalty,
bounded by the relay deadline), direct and sticky routes answer 503. Every route's precommit catch classifies through one predicate
(`precommitLeaseLost`: typed loss OR a lost lease signal, never a client abort) evaluated before
cleanup releases the owner, so a completed upstream attempt or a transport error caused by the loss
is still a lease loss. A provider body that is abandoned by such a loss is cancelled so its
attempt settles as `FAILED`/`CAPACITY_LEASE_LOST` (never `CANCELLED`), and the bound route's
request finalizer is scheduled only after a successful hand-off (or when an error that is not a
lease loss ends the request). After commit the body ends in an
error, never a clean EOF. The relay wire protocol has no lease-loss reason: the CLI is sent
`relay.cancel` with `cancelled`.

All five physical dispatch families (direct, local pool, local sticky, external pool, external
sticky) pass that signal to their existing cancellation-aware transport. Each retry acquires a
new lease after releasing the prior member. Chat diagnostics reuse these routes. Transformer
prepasses and member probes use `acquireGlobal`/`acquireCli` process counters, which do not expire
and do not create physical capacity leases. They retain their existing terminal/finally cleanup.
Raw store acquisition elsewhere is confined to PostgreSQL test fixtures/process workers.

`hold` adopts the same owner, preserving heartbeat cadence and any in-flight renewal. The
response wrapper adds body EOF/error/cancel cleanup; it never creates another owner for a runtime
handle. Bodyless responses explicitly release before returning. Repeated release calls for the
same handle join one retry sequence. Shutdown first stops maintenance and the wake source;
admissions and owner heartbeats remain available throughout HTTP drain. After drain completes or
reaches its deadline, shutdown closes both production and shared diagnostics runtimes, cancels
remaining admissions and dispatches, and awaits owner release before the MCP gate arms the DB
fence and Prisma disconnects. Runtime shutdown/owner terminal flags are lifecycle states, not
locks or permits.

PostgreSQL remains the durable admission ledger; admission commits before dispatch, including its
lease identity and fencing token. No new persistent state or external effect precedes admission.
A process crash stops renewal, so the existing database-clock expiry/reclaim path recovers its
slots; no process-local ownership is trusted across restart.

Heartbeat is a single-row conditional UPDATE of `capacity_lease` at L7. It takes no advisory,
capacity, request, parent, or foreign-key locks and adds **no lock-order edges**. Its state, fencing
token and unexpired predicates prevent renewal of a released/reclaimed lease. Both reclaim sites
(maintenance and idempotent acquire of an expired lease) condition the UPDATE on expiry, so a
renewal racing their earlier read wins without being overwritten. Admission/release/reclaim retain
L0-L7 ordering from `packages/db/src/capacity-lock-order.ts`; only durable release/terminalization
use the existing shutdown cleanup permit. Heartbeats get no shutdown or request-abort exemption.

Every Prisma pool initializes each connection with session `TimeZone=UTC` in
`packages/db/src/client-factory.ts`, after startup options and role/database defaults. This keeps
database-clock comparisons and assignments consistent with Prisma's UTC wall-time `DateTime`
columns, including heartbeat expiry and reclaim. Application SQL must preserve that setting;
direct PostgreSQL/session-preserving connections are required. A failed initialization refuses
checkout. Replacement connections run the same initialization.

Renewal fails closed on a lost fence and never retries a false ownership result. Route exits
must still release or hand off to the response wrapper, but a missing release no longer leaks
(F2-CAP-6): every owner registers with the `CapacityRequestScope` (`request-scope.ts`, an
`AsyncLocalStorage` scope installed as middleware on the model API and Chat Test routes, and
around the MCP chat diagnostic). The scope closes when the handler throws, returns a bodyless
response, or its response body reaches EOF, errors or is cancelled; it logs and releases any owner
still alive then (`request_scope_closed`). Correct paths never trip it: the response wrapper marks
its owner released before exposing EOF or an error. The scope does not close on request abort
(owners already release on their parent signal as a client cancellation). As a backstop, each
owner also has a hard lifetime cap of `MODEL_API_RELAY_TIMEOUT_MS` plus 60 s
(`max_lifetime`). Shutdown still releases every owner exactly once with a shutdown reason.

The isolated runtime and route regressions use fake timers to cover dispatch exceeding 30 seconds,
ownership loss, stalled renewal, handoff without a duplicate timer, failover/re-entry, EOF/error/
cancel/client abort, and shutdown. The existing registered PostgreSQL suite also checks that a
heartbeat completes while another transaction holds the capacity's admission locks, alongside its
database-clock, fencing, restart and reclaim tests.
