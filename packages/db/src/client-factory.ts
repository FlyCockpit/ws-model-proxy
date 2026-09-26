import { PrismaPg } from "@prisma/adapter-pg";
import {
  Client,
  type ClientBase,
  type ClientConfig,
  type QueryArrayConfig,
  type QueryConfig,
  type QueryResult,
  type Submittable,
} from "pg";
import { PrismaClient } from "../prisma/generated/client";
import {
  type PgConnectCallback,
  PgInternalQuery,
  type PgPoolRelease,
  type PgQueryCallback,
  type PgSubmittable,
} from "./pg-internals";
import {
  DbDispatchFenceError,
  isDbShutdownFenceArmed,
  withDbShutdownFence,
} from "./shutdown-fence";

export function createPrismaClient(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type StatementBoundedClientOptions = {
  /** Server-side `statement_timeout` of every connection, in ms (> 0). */
  statementTimeoutMs: number;
  /** Pool checkout plus connection setup bound (`connectionTimeoutMillis`), in ms (> 0). */
  connectTimeoutMs: number;
  /** `application_name` of the connections (visible in `pg_stat_activity`). */
  applicationName: string;
  /** Pool size. */
  maxConnections: number;
  /**
   * Connections the pool keeps open while idle (pg-pool `min`): idle eviction
   * (`idleTimeoutMillis`, 10 s by default) only closes connections above it,
   * so a job that runs less often than that still finds its connection warm.
   * pg-pool never opens connections to reach it; it only stops closing them.
   */
  minIdleConnections: number;
  /**
   * TCP keepalive delay of every connection, in ms (> 0). Keepalive probes
   * keep NAT and proxy mappings of an idle held connection alive and detect a
   * peer that vanished without closing it; pg then drops the dead connection
   * from the pool, so the next checkout connects again instead of writing to
   * a dead socket.
   */
  keepAliveInitialDelayMs: number;
  /**
   * Test seam only (default false): keep a client-side read timeout
   * (`query_timeout`) that the connection string or pg defaults set, instead
   * of switching it off. Lets a test show that the release guard alone keeps
   * a connection with an open transaction out of the pool. Production callers
   * never set it.
   */
  keepClientReadTimeoutForTest?: boolean;
};

/**
 * A statement-bounded client and the handle its owner uses at shutdown.
 */
export type StatementBoundedPrismaClient = {
  /** The Prisma client (method-fenced; its connections are dispatch-fenced). */
  readonly prisma: PrismaClient;
  /**
   * Destroys the socket of every connection of the pool now, whatever it is
   * doing (a statement or a `COMMIT` in flight, idle, or connecting), and
   * refuses every later connect of this pool. Returns how many connections
   * it destroyed. Pending queries fail with a connection error, so a caller
   * awaiting one settles immediately; pg-pool drops the dead clients, so a
   * later `prisma.$disconnect()` does not wait on them.
   *
   * For shutdown only, after the caller's own wait for the work on this
   * client ran out: the server-side work in flight is not cancelled by it.
   * PostgreSQL finishes or aborts that statement or `COMMIT` on its own (a
   * backend notices the lost client when it next reads from or writes to
   * it) and then ends the session, committing or rolling back. The caller
   * must be able to recover from either outcome.
   */
  quarantine(): number;
};

/**
 * A dedicated client for a background job that must settle within a
 * shutdown deadline: every statement on its connections is bounded by a
 * server-side `statement_timeout` (a session setting, so it applies to reads,
 * writes and every statement of an interactive transaction alike; a
 * transaction-local `SET LOCAL` can still override it), and once the DB
 * shutdown fence arms it dispatches no further SQL. The caller owns it and
 * disconnects it during shutdown.
 *
 * The fence applies at two levels. Like the shared client, it is wrapped in
 * the method-level fence ({@link withDbShutdownFence}): no new Prisma
 * operation or transaction starts. And its pool's connections are
 * {@link DispatchFencedClient}s: no statement is written to the wire and no
 * connection is opened after the fence arms, except `COMMIT` and `ROLLBACK`.
 * The second level is what bounds the work left at shutdown: one admitted
 * Prisma operation can dispatch several statements (a relation `select` is
 * one query per relation, a transaction is checkout, `BEGIN`,
 * `SET TRANSACTION`, its statements and `COMMIT`), and the method fence
 * checks only the operation. With the dispatch fence, what can still run
 * after the fence arms is the one statement or the one connect already in
 * flight, then at most the `COMMIT` or `ROLLBACK` that ends its transaction,
 * whatever SQL the ORM generates.
 *
 * The statement is bounded server-side and the connect by the connect
 * bound, but the end of a transaction is not (see
 * {@link TRANSACTION_END_TEXTS}). So the owner never waits on this client
 * without a deadline at shutdown: past its deadline it calls `quarantine`,
 * which destroys every socket of the pool and refuses reconnects, and then
 * disconnects under a short deadline of its own. The server finishes the
 * abandoned work by commit or rollback; the owner must recover from either.
 *
 * Connections go back to the pool only when idle (no open or failed
 * transaction, nothing on the wire), and pg's client-side read timeout is
 * off on them ({@link DispatchFencedClient}): a read timeout fails a
 * query's callback without stopping it, which would otherwise return a
 * connection with an open transaction to the pool.
 *
 * Our bound and `application_name` win over the connection string: the
 * connection string is the deployment's shared `DATABASE_URL`, and
 * node-postgres merges its parameters (`statement_timeout=0`,
 * `application_name=…`, `options=-c statement_timeout=…`) over the ones
 * passed here (pg lib/connection-parameters.js), and PostgreSQL also applies
 * role and database defaults at startup. So besides the startup parameters,
 * every new connection sets both at session level before the pool hands it
 * out ({@link enforceSessionSettings}); a session `SET` takes precedence over
 * every startup source. A `query_timeout` in the connection string is
 * switched off (logged once). The shared request client is not affected.
 *
 * The startup parameter and the session setting need a direct PostgreSQL
 * connection (the supported topology): PgBouncer in transaction mode rejects
 * unknown startup parameters unless it lists them in
 * `ignore_startup_parameters`, and does not keep session settings. The
 * dispatch fence is client-side and works with any topology.
 *
 * Idle connections: up to `minIdleConnections` stay open between uses (they
 * count against the server's `max_connections` for the life of the process).
 * A held connection the server or a proxy closes is removed by pg-pool's idle
 * error listener (the adapter listens for the pool's `error`, so this never
 * crashes the process) and the next checkout connects again, bounded by
 * `connectTimeoutMs`.
 */
export function createStatementBoundedPrismaClient(
  connectionString: string,
  {
    statementTimeoutMs,
    connectTimeoutMs,
    applicationName,
    maxConnections,
    minIdleConnections,
    keepAliveInitialDelayMs,
    keepClientReadTimeoutForTest = false,
  }: StatementBoundedClientOptions,
): StatementBoundedPrismaClient {
  if (!(statementTimeoutMs > 0) || !(connectTimeoutMs > 0)) {
    throw new Error("A statement-bounded client needs positive statement and connect timeouts.");
  }
  if (!(keepAliveInitialDelayMs > 0)) {
    throw new Error("A statement-bounded client needs a positive keepalive delay.");
  }
  if (!(minIdleConnections >= 0 && minIdleConnections <= maxConnections)) {
    throw new Error("A statement-bounded client keeps at most its pool size idle.");
  }
  const pool = new BoundedPoolState({ normalizeReadTimeout: !keepClientReadTimeoutForTest });
  // pg-pool builds every connection with `new Client(options)`: this class
  // binds each connection to this pool's state.
  class PoolConnection extends DispatchFencedClient {
    constructor(config?: ClientConfig) {
      super(config, pool);
    }
  }
  const adapter = new PrismaPg({
    connectionString,
    onConnect: (client) => enforceSessionSettings(client, { statementTimeoutMs, applicationName }),
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: connectTimeoutMs,
    application_name: applicationName,
    max: maxConnections,
    min: minIdleConnections,
    keepAlive: true,
    keepAliveInitialDelayMillis: keepAliveInitialDelayMs,
    // pg-pool builds every connection of this pool with this class.
    Client: PoolConnection,
  });
  return {
    prisma: withDbShutdownFence(new PrismaClient({ adapter })),
    quarantine: () => pool.quarantine(),
  };
}

/**
 * State shared by the connections of one statement-bounded pool: the live
 * connections (for {@link StatementBoundedPrismaClient.quarantine}), the
 * quarantine latch, and the read-timeout normalization.
 */
class BoundedPoolState {
  readonly normalizeReadTimeout: boolean;
  #connections = new Set<DispatchFencedClient>();
  #quarantined = false;
  #readTimeoutLogged = false;

  constructor({ normalizeReadTimeout }: { normalizeReadTimeout: boolean }) {
    this.normalizeReadTimeout = normalizeReadTimeout;
  }

  get quarantined(): boolean {
    return this.#quarantined;
  }

  track(connection: DispatchFencedClient): void {
    this.#connections.add(connection);
  }

  untrack(connection: DispatchFencedClient): void {
    this.#connections.delete(connection);
  }

  quarantine(): number {
    this.#quarantined = true;
    let destroyed = 0;
    for (const connection of this.#connections) {
      connection.connection.stream.destroy();
      destroyed += 1;
    }
    this.#connections.clear();
    return destroyed;
  }

  /** Logged once per pool: the deployment's setting is overridden, not dropped silently. */
  readTimeoutDisabled(): void {
    if (this.#readTimeoutLogged) return;
    this.#readTimeoutLogged = true;
    console.warn(
      "[db] query_timeout from the connection string is ignored on a statement-bounded client; its server-side statement_timeout bounds statements instead.",
    );
  }
}

/**
 * Statements a dispatch-fenced connection still sends after the fence arms:
 * the exact texts Prisma's transaction manager ends a transaction with. They
 * must pass. A refused `COMMIT` would not end the transaction: the adapter's
 * fallback only releases the connection, which would return to the pool with
 * the transaction still open and its locks held. A `COMMIT` or `ROLLBACK`
 * never starts new work. Unlike other statements, it is not bounded by the
 * connection's `statement_timeout`: PostgreSQL disarms that before a
 * `COMMIT` runs deferred triggers and waits for synchronous replication.
 * An owner that must not wait on it past a deadline uses
 * {@link StatementBoundedPrismaClient.quarantine}.
 */
const TRANSACTION_END_TEXTS: ReadonlySet<string> = new Set(["COMMIT", "ROLLBACK"]);

/**
 * Makes `query` refuse its own dispatch once the shutdown fence is armed: pg
 * calls `submit` exactly when it writes the query to the wire (a queued query
 * only when its turn comes), and a returned Error fails the query without
 * writing anything, leaving the connection ready for the next query.
 */
function fenceDispatch(query: PgSubmittable): void {
  const submit = query.submit;
  query.submit = (connection) => {
    if (
      isDbShutdownFenceArmed() &&
      !(query.text !== undefined && TRANSACTION_END_TEXTS.has(query.text))
    ) {
      return new DbDispatchFenceError();
    }
    return submit.call(query, connection);
  };
}

/** pg's own test for a query object it runs as is (`Client#query`). */
function isSubmittable(config: string | QueryConfig | PgSubmittable): config is PgSubmittable {
  return typeof config === "object" && "submit" in config && typeof config.submit === "function";
}

/**
 * A node-postgres client that dispatches no SQL and opens no connection once
 * the DB shutdown fence is armed, except the `COMMIT` / `ROLLBACK` that end a
 * transaction ({@link TRANSACTION_END_TEXTS}). Refusals fail with
 * {@link DbDispatchFenceError}. A statement already written to the wire and
 * a connect already started are not interrupted; the connection's
 * `statement_timeout` and the pool's connect timeout bound them.
 *
 * `query` builds pg's own `Query` ({@link PgInternalQuery}) for text and
 * config calls (as `Client#query` does) and gates its `submit`; submittables
 * passed in are gated the same way. The one difference from pg: a per-query
 * `query_timeout` in a config object is not read (pg reads it off the object
 * it is given); nothing here sets one.
 *
 * Two more rules keep a connection with unfinished work out of the pool:
 *
 * - No client-side read timeout. pg's `query_timeout` (settable from the
 *   connection string) fails a query's callback without stopping it: the
 *   statement keeps running on the server, and a `ROLLBACK` queued behind it
 *   is dropped from the queue. The constructor switches it off (and the pool
 *   logs that once); the server-side `statement_timeout` is the bound.
 * - Release guard. The Prisma adapter releases a transaction's connection
 *   after `COMMIT` or `ROLLBACK` without checking that it ran (@prisma/
 *   adapter-pg `PgTransaction.commit` / `rollback`), and pg-pool returns a
 *   released connection to the pool unless it is given an error or the
 *   socket is dead. `release` here passes an error whenever the connection
 *   is not idle: its last ReadyForQuery status was not `I` (a transaction is
 *   open or failed) or a query is still on the wire. pg-pool then closes it,
 *   and PostgreSQL rolls back whatever it left open.
 */
class DispatchFencedClient extends Client {
  readonly #pool: BoundedPoolState;
  #poolRelease: PgPoolRelease | undefined;

  constructor(config: ClientConfig | undefined, pool: BoundedPoolState) {
    super(config);
    this.#pool = pool;
    if (pool.normalizeReadTimeout && this.connectionParameters.query_timeout) {
      this.connectionParameters.query_timeout = false;
      pool.readTimeoutDisabled();
    }
    pool.track(this);
    this.once("end", () => pool.untrack(this));
  }

  /**
   * pg-pool assigns `release` on every checkout (`_acquireClient`); the
   * setter keeps its function and the getter wraps it with the guard.
   */
  set release(poolRelease: PgPoolRelease) {
    this.#poolRelease = poolRelease;
  }

  get release(): PgPoolRelease {
    return (error?: Error | boolean) => {
      if (this.#poolRelease === undefined) {
        throw new Error("A statement-bounded connection was released outside its pool.");
      }
      if (!error && !this.#isIdle()) {
        console.warn(
          "[db] a statement-bounded connection was released with an open transaction or a query in flight; closing it.",
        );
        this.#poolRelease(new ConnectionNotIdleError());
        return;
      }
      this.#poolRelease(error);
    };
  }

  /** Idle: the last ReadyForQuery said `I` and nothing is on the wire since. */
  #isIdle(): boolean {
    return this.readyForQuery === true && this.getTransactionStatus() === "I";
  }

  override connect(): Promise<Client>;
  override connect(callback: PgConnectCallback): void;
  override connect(callback?: PgConnectCallback): Promise<Client> | undefined {
    if (isDbShutdownFenceArmed() || this.#pool.quarantined) {
      // Never connects, so no "end" follows: stop tracking it here.
      this.#pool.untrack(this);
      const error = new DbDispatchFenceError();
      if (callback === undefined) return Promise.reject(error);
      process.nextTick(callback, error);
      return undefined;
    }
    if (callback === undefined) return super.connect();
    super.connect(callback);
    return undefined;
  }

  override query<T extends Submittable>(query: T): T;
  override query(
    config: string | QueryConfig | QueryArrayConfig,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
  override query(config: string | QueryConfig | QueryArrayConfig, callback: PgQueryCallback): void;
  override query(
    config: string | QueryConfig,
    values: readonly unknown[] | undefined,
    callback: PgQueryCallback,
  ): void;
  override query(
    config: string | QueryConfig | PgSubmittable,
    values?: readonly unknown[] | PgQueryCallback,
    callback?: PgQueryCallback,
  ): Promise<QueryResult> | PgSubmittable | undefined {
    if (isSubmittable(config)) {
      // A submittable runs as given; its callback is attached the way pg does.
      if (config.callback === undefined) {
        if (typeof values === "function") config.callback = values;
        else if (callback !== undefined) config.callback = callback;
      }
      fenceDispatch(config);
      return super.query(config);
    }
    const query = new PgInternalQuery(config, values, callback);
    fenceDispatch(query);
    if (query.callback !== undefined) {
      super.query(query);
      return undefined;
    }
    return new Promise<QueryResult>((resolve, reject) => {
      query.callback = (error, result) => (error ? reject(error) : resolve(result));
      super.query(query);
    });
  }
}

/** Why the release guard closed a connection instead of pooling it. */
class ConnectionNotIdleError extends Error {
  constructor() {
    super("The connection has an open transaction or a query in flight.");
    this.name = "ConnectionNotIdleError";
  }
}

/**
 * Sets the bound and the name on a new connection at session level (pg-pool
 * `onConnect`: runs once per connection, before its first checkout; a
 * failure closes the connection and fails that checkout), then reads them
 * back and refuses the connection unless they took effect. A session setting
 * beats the connection string's parameters and `options`, `PGOPTIONS`, and
 * role or database defaults; only a later `SET` on the same session changes
 * it again (the job issues none; a drain batch's `SET LOCAL` is
 * transaction-local).
 */
async function enforceSessionSettings(
  client: ClientBase,
  { statementTimeoutMs, applicationName }: { statementTimeoutMs: number; applicationName: string },
) {
  await client.query(
    "SELECT set_config('statement_timeout', $1, false), set_config('application_name', $2, false)",
    [`${statementTimeoutMs}ms`, applicationName],
  );
  const result = await client.query(
    `SELECT (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS statement_timeout_ms,
            current_setting('application_name') AS application_name`,
  );
  const row = result.rows[0] as
    | { statement_timeout_ms: string; application_name: string }
    | undefined;
  if (
    Number(row?.statement_timeout_ms) !== statementTimeoutMs ||
    row?.application_name !== applicationName
  ) {
    throw new Error("A statement-bounded connection did not take its session settings.");
  }
}
