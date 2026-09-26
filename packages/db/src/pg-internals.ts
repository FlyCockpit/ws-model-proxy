// Local type extension for the node-postgres internals that @types/pg does
// not declare and the statement-bounded client (./client-factory.ts) relies
// on. Each member names the pg@8.23.0 / pg-pool@3.14.0 source it relies on;
// check those lines again when bumping pg or pg-pool.
//
// The instance members are a module augmentation of "pg": it only adds
// members pg really sets (TypeScript rejects a declaration that conflicts
// with @types/pg), and it is in scope in every program that includes
// client-factory.ts. The one cast is the Query constructor at the bottom.
import { type Connection, Query, type QueryConfig, type QueryResult } from "pg";

declare module "pg" {
  interface Client {
    /**
     * lib/client.js: true on each ReadyForQuery (line 391), false while a
     * query is on the wire (lines 625 and 661), back to true when `submit`
     * refused a query (line 632). Undefined before the first ReadyForQuery.
     */
    readyForQuery: boolean | undefined;
    /**
     * lib/client.js line 54 (`new ConnectionParameters(config)`). Only the
     * client-side read timeout is used: lib/connection-parameters.js line
     * 124 (`val('query_timeout', config, false)`), read per query at
     * lib/client.js line 702 and armed only when truthy.
     */
    readonly connectionParameters: { query_timeout: number | false | undefined };
  }

  interface Query {
    /** lib/query.js line 14 (`this.text = config.text`); read by `submit` (line 153). */
    readonly text: string | undefined;
    /**
     * lib/query.js line 23 (`this.callback = config.callback`); called once
     * with an error or the result (lines 130 and 140). lib/client.js reads
     * and assigns it (lines 679-690).
     */
    callback: PgQueryCallback | undefined;
  }
}

/**
 * pg calls a query's callback once, with an error or the result
 * (lib/query.js `handleError` / `handleReadyForQuery`, lines 130 and 140).
 */
export type PgQueryCallback = (error: Error | null | undefined, result: QueryResult) => void;

/**
 * pg calls a `connect` callback once, with the connect error or nothing
 * (lib/client.js `connect(callback)`, line 232, via `_connect`).
 */
export type PgConnectCallback = (error: Error | null | undefined) => void;

/**
 * What pg's client runs as is (`typeof config.submit === "function"`,
 * lib/client.js line 677). Unlike @types/pg's `Submittable` (whose `submit`
 * returns void), `submit` may return an Error: the client then fails the
 * query without writing anything to the wire (lib/client.js lines 628-633
 * and 650-655). The client reads and attaches `callback` (lines 679-685);
 * client-factory's dispatch fence reads `text`.
 */
export interface PgSubmittable {
  // biome-ignore lint/suspicious/noConfusingVoidType: pg's own Query is declared by @types/pg with a void-returning submit, so the union must admit void.
  submit(connection: Connection): Error | null | undefined | void;
  readonly text?: string | undefined;
  callback?: PgQueryCallback | undefined;
}

/**
 * The function pg-pool assigns to a client's `release` on every checkout
 * (pg-pool index.js line 342, `client.release = this._releaseOnce(...)`):
 * with no argument (or a falsy one) it returns the client to the pool unless
 * the client is dead or ending; with an error (or `true`) it closes it.
 */
export type PgPoolRelease = (error?: Error | boolean) => void;

/**
 * pg's `Query` constructor as it really is (lib/query.js line 9, via
 * lib/utils.js `normalizeQueryConfig`, lines 144-158): `values` may be the
 * callback, and a `callback` argument wins over it. @types/pg's overloads
 * accept neither a callback in `values` nor a union of the two, so this is
 * the one cast of the pg internals.
 */
export const PgInternalQuery = Query as new (
  config: string | QueryConfig,
  values?: readonly unknown[] | PgQueryCallback,
  callback?: PgQueryCallback,
) => Query;
