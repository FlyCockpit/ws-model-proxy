/**
 * Classify a database's Prisma Migrate state against a migrations folder.
 *
 * Deliberately does NOT trust `prisma migrate status`'s exit code (it exits 1
 * for several unrelated states). It reads `_prisma_migrations` directly with
 * `pg` and compares it with the folder shipped next to this code.
 *
 * States (shared vocabulary — docs/schema-migrations.md uses the same):
 *   up-to-date           every folder migration is applied, nothing extra
 *   pending              some folder migrations are not applied yet
 *   db-ahead             the database has applied migrations this folder
 *                        does not contain (stale image / rollback)
 *   failed               a migration is recorded as started but never
 *                        finished nor rolled back (`inProgress` when Prisma's
 *                        advisory lock is currently held by another session)
 *   no-history-nonempty  no `_prisma_migrations` table, but the schema already
 *                        holds tables (a database Prisma Migrate never managed)
 *   unreachable          cannot connect / query
 *
 * Every state also reports `runnerActive`: some session holds the migration
 * runner lock (MIGRATION_RUNNER_LOCK_KEY), i.e. a `migrate-runtime.mjs apply`
 * (or a restore) is working on this database right now. The reading session
 * never holds it itself, so a runner that reads the state while holding the
 * lock sees its own lock here.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACT_FILE } from "./sql.mjs";

/** Prisma's migrate advisory lock key (verified against Prisma 7 pg_locks). */
export const PRISMA_ADVISORY_LOCK = 72707369;
/**
 * Session advisory lock held by `migrate-runtime.mjs apply` for its whole
 * classify → recover → backup → deploy → final check, so two leaders (Dokploy
 * app + worker) never interleave. Prisma's own lock covers only `migrate
 * deploy` itself. restore.mjs takes this lock too.
 */
export const MIGRATION_RUNNER_LOCK_KEY = 72707370;

/**
 * Is a single-key (bigint) session advisory lock granted to any session in the
 * current database? For keys below 2^32: classid 0, objid = key, objsubid 1.
 */
const ADVISORY_HELD_SQL = `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted
            AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
       ) AS held`;

/**
 * `contract` is the folder's optional `contract.sql` (applied by the runner
 * after the soak; Prisma never reads it), or null.
 * @returns {Array<{ name: string, file: string, sql: string, checksum: string,
 *   contract: { sql: string, checksum: string } | null }>} sorted like Prisma
 */
export function readMigrationsFolder(dir) {
  if (!existsSync(dir)) return [];
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "migration.sql")),
    )
    .map((entry) => {
      const file = path.join(dir, entry.name, "migration.sql");
      const bytes = readFileSync(file);
      const contractFile = path.join(dir, entry.name, CONTRACT_FILE);
      const contractBytes = existsSync(contractFile) ? readFileSync(contractFile) : null;
      return {
        name: entry.name,
        file,
        sql: bytes.toString("utf8"),
        checksum: sha256(bytes),
        contract: contractBytes
          ? { sql: contractBytes.toString("utf8"), checksum: sha256(contractBytes) }
          : null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Postgres schema Prisma uses for this URL (`?schema=`, default public). */
export function prismaSchemaName(url) {
  try {
    return new URL(url).searchParams.get("schema") || "public";
  } catch {
    return "public";
  }
}

/** Strip Prisma-only URL params that `pg` would misread. */
export function pgConnectionString(url) {
  const parsed = new URL(url);
  for (const key of [
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
  ])
    parsed.searchParams.delete(key);
  return parsed.toString();
}

/**
 * @param {{ databaseUrl: string, migrationsDir: string, pg: typeof import("pg"),
 *   connectTimeoutMs?: number }} options
 */
export async function readMigrationState({
  databaseUrl,
  migrationsDir,
  pg,
  connectTimeoutMs = 10_000,
}) {
  const local = readMigrationsFolder(migrationsDir);
  const base = {
    local: local.map((m) => m.name),
    applied: /** @type {string[]} */ ([]),
    pending: /** @type {string[]} */ ([]),
    ahead: /** @type {string[]} */ ([]),
    failed:
      /** @type {Array<{ name: string, logs: string | null, checksum: string | null }>} */ ([]),
    checksumMismatch: /** @type {string[]} */ ([]),
    inProgress: false,
    runnerActive: false,
    error: /** @type {string | null} */ (null),
  };
  const schema = prismaSchemaName(databaseUrl);
  const client = new pg.Client({
    connectionString: pgConnectionString(databaseUrl),
    connectionTimeoutMillis: connectTimeoutMs,
    application_name: "wmp-migrate-state",
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    // Never echo the driver error object: it can carry connection parameters.
    return { ...base, state: "unreachable", error: safeError(error) };
  }
  try {
    const runner = await client.query(ADVISORY_HELD_SQL, [MIGRATION_RUNNER_LOCK_KEY]);
    base.runnerActive = Boolean(runner.rows[0].held);
    const table = await client.query(
      "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) AS t",
      [schema],
    );
    if (!table.rows[0].t) {
      const tables = await client.query(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = $1
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_catalog.pg_class'::regclass
                AND d.objid = format('%I.%I', schemaname, tablename)::regclass
                AND d.deptype = 'e'
           )`,
        [schema],
      );
      if (tables.rows[0].n > 0) return { ...base, state: "no-history-nonempty" };
      return {
        ...base,
        pending: base.local,
        state: base.local.length ? "pending" : "up-to-date",
      };
    }
    const rows = (
      await client.query(
        `SELECT migration_name, checksum, finished_at, rolled_back_at, logs
           FROM ${client.escapeIdentifier(schema)}._prisma_migrations
          ORDER BY started_at, migration_name`,
      )
    ).rows;
    const lock = await client.query(ADVISORY_HELD_SQL, [PRISMA_ADVISORY_LOCK]);
    return classify(base, local, rows, lock.rows[0].held);
  } catch (error) {
    return { ...base, state: "unreachable", error: safeError(error) };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Why touching a `failed` row right now would be unsafe, or null. A row with
 * no finished_at is only a failure when nobody is still applying it: while
 * Prisma's lock is held its migration is mid-flight, and while the runner lock
 * is held a deploy runner (or a restore) owns the history. Marking such a row
 * rolled back would let a second `migrate deploy` re-run a migration that is
 * still executing. `db:migrate:apply` refuses on it; the production runner
 * applies the same rule to Prisma's lock (it waits, then refuses) and is itself
 * the runner-lock holder.
 * @param {{ inProgress: boolean, runnerActive: boolean }} state
 */
export function migrationInFlight(state) {
  if (state.inProgress)
    return "another session holds Prisma's migration lock (Prisma Migrate is applying a migration right now)";
  if (state.runnerActive)
    return "another session holds the migration runner lock (a deploy runner or a restore is working on this database)";
  return null;
}

/**
 * Take the migration runner lock without waiting, on a dedicated session, for
 * a local wrapper that resolves or deploys migrations. Production runners and
 * restore.mjs take the same key, so while it is held none of them can start.
 * @param {{ databaseUrl: string, pg: typeof import("pg"), applicationName?: string,
 *   connectTimeoutMs?: number }} options
 * @returns {Promise<{ release: () => Promise<void> } | null>} null when another session holds it
 */
export async function tryHoldRunnerLock({
  databaseUrl,
  pg,
  applicationName = "wmp-db-apply",
  connectTimeoutMs = 10_000,
}) {
  const client = new pg.Client({
    connectionString: pgConnectionString(databaseUrl),
    connectionTimeoutMillis: connectTimeoutMs,
    application_name: applicationName,
  });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT pg_try_advisory_lock(${MIGRATION_RUNNER_LOCK_KEY}) AS acquired`,
    );
    if (!result.rows[0]?.acquired) {
      await client.end().catch(() => {});
      return null;
    }
  } catch (error) {
    await client.end().catch(() => {});
    throw new Error(`cannot take the migration runner lock (${safeError(error)})`);
  }
  return {
    release: async () => {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_RUNNER_LOCK_KEY})`).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}

/** Pure classification, exported for unit tests. */
export function classify(base, local, rows, lockHeld) {
  const localNames = new Set(local.map((m) => m.name));
  const byName = new Map(local.map((m) => [m.name, m]));
  const applied = new Set();
  const failed = [];
  const mismatch = [];
  for (const row of rows) {
    if (row.rolled_back_at) continue;
    if (row.finished_at) {
      applied.add(row.migration_name);
      const file = byName.get(row.migration_name);
      if (file && file.checksum !== row.checksum) mismatch.push(row.migration_name);
    } else
      failed.push({
        name: row.migration_name,
        logs: row.logs ?? null,
        checksum: row.checksum ?? null,
      });
  }
  // A failure that was later re-run successfully is history, not a failure.
  const openFailures = failed.filter((f) => !applied.has(f.name));
  const ahead = [...applied, ...openFailures.map((f) => f.name)].filter(
    (name) => !localNames.has(name),
  );
  const pending = local
    .map((m) => m.name)
    .filter((name) => !applied.has(name) && !openFailures.some((f) => f.name === name));
  const result = {
    ...base,
    applied: [...applied],
    pending,
    ahead: [...new Set(ahead)],
    failed: openFailures,
    checksumMismatch: mismatch,
    inProgress: Boolean(lockHeld),
  };
  if (result.ahead.length) return { ...result, state: "db-ahead" };
  if (openFailures.length) return { ...result, state: "failed" };
  if (pending.length) return { ...result, state: "pending" };
  return { ...result, state: "up-to-date" };
}

export function safeError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  // Keep the class of failure, never a URL.
  return `${code ? `${code}: ` : ""}${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>")}`;
}
