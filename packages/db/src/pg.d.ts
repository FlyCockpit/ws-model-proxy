// Hand-written declarations for the part of node-postgres (pg@8) this code
// uses: pg ships no types, and @types/pg is not a dependency of this
// workspace (installing it, which could replace this file, needs approval).
// Every module here that imports "pg" references this file, so a program in
// another package that type-checks these sources gets the same declarations.
// Being an ambient module, it also stands in for pg inside
// @prisma/adapter-pg's declarations in those programs (`pg.Pool`,
// `pg.PoolConfig`, `pg.PoolClient`), so the pool options passed to `PrismaPg`
// are checked against {@link PoolConfig} below: it lists the options this
// workspace passes, with pg@8.23 / pg-pool@3.14 semantics, and a misspelled
// or unknown option is a type error.
declare module "pg" {
  /**
   * A client's wire connection. Handed to `submit`; its socket is read only
   * to destroy it (`@ws-model-proxy/db/client-factory` quarantine).
   */
  export class Connection {
    private constructor();
    /** The connection's socket (a net.Socket, or a TLS socket over it). */
    readonly stream: { destroy(error?: Error): void };
  }

  /** The result pg resolves a query with (the fields read here). */
  export interface QueryResult {
    rows: unknown[];
    rowCount: number | null;
  }

  /** pg calls it once per query, with an error or the result. */
  export type QueryCallback = (error: Error | null, result: QueryResult) => void;

  /** A query given as an object (`text` plus options). */
  export interface QueryConfig {
    text: string;
    values?: readonly unknown[];
    name?: string;
    rowMode?: "array";
    types?: unknown;
  }

  /**
   * Anything the client runs as is: it calls `submit` when it writes the
   * query to the connection (queued queries only when their turn comes), and
   * a returned Error fails the query without writing anything.
   */
  export interface Submittable {
    submit(connection: Connection): Error | null | undefined;
    callback?: QueryCallback;
  }

  /** pg's own query object (what `Client#query` builds from text or a config). */
  export class Query implements Submittable {
    constructor(
      config: string | QueryConfig,
      values?: readonly unknown[] | QueryCallback,
      callback?: QueryCallback,
    );
    /** The SQL text (undefined for a named statement given without text). */
    readonly text: string | undefined;
    callback: QueryCallback | undefined;
    submit(connection: Connection): Error | null;
  }

  /**
   * Client options (pg-pool passes its whole options object through), the
   * ones this workspace sets. Parameters of `connectionString` are merged
   * over them (pg lib/connection-parameters.js).
   */
  export interface ClientConfig {
    connectionString?: string;
    /** Startup parameter: server-side statement bound, in ms. */
    statement_timeout?: number;
    /** Startup parameter: `application_name`. */
    application_name?: string;
    /** Client-side bound on connection setup, in ms. */
    connectionTimeoutMillis?: number;
    keepAlive?: boolean;
    keepAliveInitialDelayMillis?: number;
  }

  /**
   * The merged connection settings a client connects with. Only the
   * client-side read timeout is read or written here: pg arms it per query
   * when truthy (lib/client.js `query`).
   */
  export interface ConnectionParameters {
    query_timeout: number | false | undefined;
  }

  /** Transaction status of the last ReadyForQuery: idle, in a transaction, failed transaction. */
  export type TransactionStatus = "I" | "T" | "E";

  /** pg calls it once the connection is ready, or with the connect error. */
  export type ConnectCallback = (error: Error | null | undefined) => void;

  export class Client {
    constructor(config?: ClientConfig);
    /** The wire connection (created in the constructor). */
    readonly connection: Connection;
    /** Merged settings (config, connection string, defaults). */
    readonly connectionParameters: ConnectionParameters;
    /**
     * True once a ReadyForQuery arrived and no query is on the wire; false
     * while one is (pg sets it false when it dispatches a query and true on
     * the next ReadyForQuery). Undefined before the first ReadyForQuery.
     */
    readyForQuery: boolean | undefined;
    /** Status of the last ReadyForQuery; null before the first one. */
    getTransactionStatus(): TransactionStatus | null;
    connect(): Promise<void>;
    connect(callback: ConnectCallback): void;
    query(config: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult>;
    query(
      config: string | QueryConfig,
      values: readonly unknown[] | undefined,
      callback: QueryCallback,
    ): undefined;
    query<T extends Submittable>(query: T): T;
    on(
      event: "notification",
      listener: (message: { channel: string; payload?: string }) => void,
    ): this;
    on(event: "error", listener: (error: Error) => void): this;
    off(
      event: "notification",
      listener: (message: { channel: string; payload?: string }) => void,
    ): this;
    off(event: "error", listener: (error: Error) => void): this;
    /** Emitted once the connection's socket closed (after a connect was started). */
    once(event: "end", listener: () => void): this;
    end(): Promise<void>;
  }

  /**
   * A client checked out of a {@link Pool}. pg-pool assigns `release` on
   * every checkout: with no argument it returns the client to the pool
   * (unless the client is dead or ending), with an error it closes it.
   */
  export interface PoolClient extends Client {
    release(error?: Error | boolean): void;
  }

  /** pg-pool options (pg-pool@3.14), the ones this workspace sets. */
  export interface PoolConfig extends ClientConfig {
    /** Pool size. */
    max?: number;
    /** Connections idle eviction keeps open. */
    min?: number;
    /** Idle eviction delay, in ms (default 10 000). */
    idleTimeoutMillis?: number;
    /** Runs once per new connection before its first checkout; a rejection closes it. */
    onConnect?: (client: Client) => void | Promise<void>;
    /** The class every connection of the pool is built with. */
    Client?: new (
      config?: PoolConfig,
    ) => Client;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    readonly options: PoolConfig;
    connect(): Promise<PoolClient>;
    query(config: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult>;
    on(event: "error", listener: (error: Error) => void): this;
    end(): Promise<void>;
  }
}
