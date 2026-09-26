/**
 * Shutdown timing that more than one module has to agree on, in a module with
 * no imports of its own so both sides can name it without pulling in a server
 * boot.
 *
 * The invariants:
 *
 * 1. The process exits within `PROCESS_SHUTDOWN_DEADLINE_MS` of the shutdown
 *    signal, whatever any step, client or the database is doing: a watchdog
 *    armed before anything is awaited exits with status 1 at that deadline
 *    (`runProcessShutdown`, ./graceful-shutdown.ts). The normal path exits
 *    with status 0 once every bounded step finished, well before it.
 * 2. The database step waits on the shared client's disconnect for at most
 *    `SHARED_DISCONNECT_TIMEOUT_MS` (D_shared) after the sweep's shutdown
 *    returned (`disconnectDatabaseClients`, ./graceful-shutdown.ts). A shared
 *    operation admitted before the DB fence armed can wait on a row lock the
 *    quarantined sweep backend still holds (its `COMMIT` stalled on the
 *    server); pg-pool's `end()` waits for that checked-out client, so an
 *    unbounded disconnect would make the process wait on sweep work
 *    indirectly. Past D_shared the disconnect is abandoned and the process
 *    exit closes every socket; the server rolls back what was open.
 * 3. Shutdown waits on the user-deletion sweep itself for at most
 * `USER_DELETION_SWEEP_JOIN_TIMEOUT_MS` (J) plus
 * `USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS` (D), whatever the sweep or the
 * database is doing. `shutDownUserDeletionSweep` (./user-deletion-sweep.ts,
 * called from apps/server/src/index.ts) enforces it: it waits up to J for the
 * tick in flight; if the tick has not settled by then it quarantines the
 * sweep's pool (destroys every socket, refuses every reconnect); then it
 * waits up to D for the sweep client's disconnect, quarantining if that runs
 * out too. Neither wait depends on the server finishing anything.
 *
 * The sweep's server-side work in flight may outlive the process. No session
 * setting bounds the end of a transaction: PostgreSQL disarms
 * `statement_timeout` before running a `COMMIT`'s deferred triggers and its
 * synchronous-replication wait, so a `COMMIT` can wait on a missing
 * synchronous standby indefinitely. Such work resolves on the server by
 * commit or rollback after the process leaves, and both are recoverable:
 * the durable marker and generation keep a user whose delete rolled back for
 * the next process (the drain is idempotent, and the backoff and abandon
 * writes act only on the generation they read), and a committed delete
 * removed the user with its marker.
 *
 * Why J is sized as it is: once the DB shutdown fence arms, the sweep's
 * client is fenced at dispatch (no statement written and no connection
 * opened, except the `COMMIT` or `ROLLBACK` that ends a transaction), so the
 * tick has at most one of these in flight:
 *
 * - a statement (any stage of the tick), cut off by the connection's
 *   server-side `statement_timeout` or a drain batch's transaction-local one,
 *   which remains the primary bound for ordinary statements; then the
 *   `COMMIT` or `ROLLBACK` ending its transaction, normally one round trip;
 * - or a connect, cut off by the connect bound, after which the connection's
 *   first statement is refused.
 *
 * max(connect, statement) plus the rollback margin is 4 s; J (7.5 s) leaves
 * 3.5 s on top of that for an ordinary transaction end, so a healthy or
 * lock-blocked tick settles inside J and the client disconnects gracefully
 * (keeping the quarantine for the case the bounds cannot cover: a
 * transaction end the server does not finish). `shutdown-timeouts.test.ts`
 * pins the arithmetic; parent-deletion.postgres.integration.test.ts executes
 * both paths against PostgreSQL.
 *
 * Whole-shutdown budget: the sweep's J + D (8.5 s at most) is the first half
 * of the last step, `disconnectDatabaseClients` (./graceful-shutdown.ts,
 * called from index.ts `disconnectPrisma`); the shared client's disconnect
 * follows under `SHARED_DISCONNECT_TIMEOUT_MS`, so the database step ends
 * within J + D + D_shared after the sweep join starts, whatever the sweep or
 * the database is doing. `PROCESS_SHUTDOWN_DEADLINE_MS` (below) bounds the
 * whole process on top of that.
 */
export const USER_DELETION_SWEEP_JOIN_TIMEOUT_MS = 7_500;

/**
 * Server-side `statement_timeout` of every connection of the user-deletion
 * sweep's client (a connection parameter, so it applies to every statement
 * the tick issues, inside or outside a transaction). A drain batch's own
 * transaction-local `statement_timeout`
 * (`PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS`) overrides it inside the
 * batch, so the join arithmetic uses the larger of the two.
 *
 * Kept well above normal statements: on 20,000-row histories the largest
 * drain batch measured 570 ms and the whole ordered final phase 52 ms. A
 * statement past it raises SQLSTATE 57014, which the sweep treats as a
 * transient failure (backoff, marker kept), never as a refusal.
 */
export const USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS = 3_000;

/**
 * Bound on the sweep client's pool checkout plus connection setup
 * (`connectionTimeoutMillis`). A connect already started when the fence arms
 * runs on to this bound; the connection's first statement is then refused,
 * so the connect is an alternative to the in-flight statement in the join
 * arithmetic, not an addition to it.
 *
 * Sized for a cold connect to a remote PostgreSQL over TLS with password
 * (SCRAM) authentication: TCP, TLS and SCRAM take about six round trips plus
 * DNS, so a few hundred milliseconds across regions; 3 s leaves room for a
 * slow network or a loaded server without letting a hung connect stall a tick
 * indefinitely. A connect past it fails the tick (logged, retried next tick).
 *
 * A cold connect is rare: the sweep's pool keeps one connection open between
 * ticks (`createUserDeletionSweepClient`: `min: 1`, so pg-pool's idle timeout
 * never closes it), and within a tick every statement reuses it. A cold
 * connect happens on the first tick of a process and after the server, a
 * proxy or TCP keepalive closed the held connection (pg-pool then drops it
 * and the next checkout connects again).
 */
export const USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS = 3_000;

/**
 * Time the sweep still needs after the bounded work above: the `ROLLBACK`
 * round trip of a cancelled statement (a `ROLLBACK` takes no locks) and the
 * JavaScript continuation that ends the tick. Reserved
 * out of the sweep join so the bounded work plus this margin cannot reach
 * the join deadline.
 */
export const USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS = 1_000;

/**
 * Bound on the sweep client's disconnect during shutdown, after the join (or
 * after the quarantine that followed a join past its deadline). A
 * disconnect after a settled join closes idle connections (one Terminate
 * message each); after a quarantine the pool's sockets are already gone.
 * Measured at a few milliseconds either way; the bound only keeps an
 * unforeseen wait (Prisma or pg-pool holding a client) from extending
 * shutdown, and a disconnect past it quarantines the pool.
 */
export const USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS = 1_000;

/**
 * Bound on the shared (request) client's disconnect (D_shared), the last
 * database step, after the sweep's shutdown returned. Prisma's driver adapter
 * ends the pg pool, and pg-pool's `end()` waits for every checked-out client:
 * an operation admitted before the DB fence armed (a request handler whose
 * connection the HTTP drain already closed, an abandoned relay-close or MCP
 * write, a periodic-job tick in flight) keeps its client until the server
 * answers, and that can be a row lock the quarantined sweep backend holds
 * while its `COMMIT` waits on the server. A healthy disconnect takes a few
 * milliseconds. Past this bound the disconnect is abandoned with a warning;
 * the process exit that follows closes every socket, and the server rolls
 * back an open transaction and finishes or aborts an in-flight statement or
 * `COMMIT` atomically, the same outcome as the platform's SIGKILL.
 */
export const SHARED_DISCONNECT_TIMEOUT_MS = 2_000;

/** HTTP drain deadline (`drainHttpWithDeadline`, index.ts `drainHttp`). */
export const HTTP_DRAIN_TIMEOUT_MS = 10_000;

/** Bound on the final relay close (DB writes for CLIs still busy at drain end). */
export const RELAY_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Cap on the MCP close's shadow-await of admitted exchanges
 * (apps/server/src/mcp/auth.ts), the longest wait of the MCP close step.
 */
export const MCP_CLOSE_SHADOW_AWAIT_MS = 10_000;

/**
 * Process watchdog deadline, armed at the start of `shutdown()` before
 * anything is awaited (`runProcessShutdown`, ./graceful-shutdown.ts): at this
 * deadline the process logs and exits with status 1, whatever is still
 * pending. It is the sum of the step bounds plus a margin, so it never fires
 * before a bounded step finishes:
 *
 *   HTTP drain 10 s + relay close 5 s + MCP close 10 s
 *   + sweep join 7.5 s + sweep disconnect 1 s + shared disconnect 2 s
 *   = 35.5 s, plus a 4.5 s margin (periodic-job stop, browser socket close,
 *   JavaScript continuations) = 40 s.
 *
 * Any future step that waits without a bound still ends here. The timer is
 * unref'd, so it never keeps an otherwise finished process alive, and it uses
 * `process.exit`, not an event-loop drain: abandoned pg sockets and timers
 * must not keep the process alive. `shutdown-timeouts.test.ts` pins the
 * arithmetic.
 *
 * Container stop grace: the repository sets none (Dockerfile, entrypoint and
 * compose files have none), and Docker's default is 10 s, after which SIGKILL
 * can land anywhere in the sequence (for the sweep, the same uncertain-outcome
 * case as a quarantine; the durable marker and generation make it
 * recoverable). A deployment that wants every step to finish sets its
 * platform's stop grace to at least this deadline plus a margin, 45 s
 * (`docker stop -t 45`, compose `stop_grace_period: 45s`).
 */
export const PROCESS_SHUTDOWN_DEADLINE_MS = 40_000;
