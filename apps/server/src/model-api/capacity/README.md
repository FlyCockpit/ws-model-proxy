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


## Lease ownership from admission to release (F2-CAP-1)

`StoreCapacityAdmissionRuntime.acquire` attaches one `CapacityLeaseOwner` to the admitted handle,
keyed by lease ID and fencing token. Before exposing the handle it confirms ownership with a
heartbeat; this also rejects a stale admission received after a delayed poll/notification. The
owner renews the 30-second database lease every 10 seconds throughout dispatch, including relay
prefill and provider header waits. Only one renewal may be in flight. A monotonic watchdog aborts
at the last acknowledged renewal's conservative expiry (query start plus extension), so a stalled
heartbeat cannot leave dispatch running past its lease. False/rejected renewal, client abort,
runtime shutdown, or explicit release abort the handle's signal before starting durable release.
Late heartbeat results cannot restart a stopped owner.

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

Renewal intentionally fails closed on the first error or lost fence; it never retries a false
ownership result. There is no arbitrary owner lifetime cap: long-running responses remain valid
while renewal succeeds. All route exits must release or hand off to the response wrapper; client
abort, expiry watchdog and post-drain shutdown are the other termination paths. A future missing
release would leak until one of those events, so release-path coverage remains load-bearing.

The isolated runtime and route regressions use fake timers to cover dispatch exceeding 30 seconds,
ownership loss, stalled renewal, handoff without a duplicate timer, failover/re-entry, EOF/error/
cancel/client abort, and shutdown. The existing registered PostgreSQL suite also checks that a
heartbeat completes while another transaction holds the capacity's admission locks, alongside its
database-clock, fencing, restart and reclaim tests.
