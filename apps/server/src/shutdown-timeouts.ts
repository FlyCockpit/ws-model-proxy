/**
 * Shutdown timing that more than one module has to agree on, in a module with
 * no imports of its own so both sides can name it without pulling in a server
 * boot.
 *
 * The invariant: shutdown waits on the user-deletion sweep for at most
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
 * Whole-shutdown budget: the sweep's J + D (8.5 s at most) is the last step
 * before the shared client disconnects, after the HTTP drain (up to 10 s),
 * the relay close (up to 5 s) and the MCP close (up to 10 s; its start arms
 * the fence). The repository sets no container stop grace (Dockerfile,
 * entrypoint and compose files have none), so a deployment that wants every
 * step to finish sets its platform's grace above that sum; with Docker's
 * default 10 s the SIGKILL can land anywhere in the sequence, and for the
 * sweep that is the same uncertain-outcome case as a quarantine.
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
