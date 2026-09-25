/**
 * Applies prisma/schema-hardening.sql (triggers, checks, backfills Prisma
 * cannot express) after `prisma db push`.
 *
 * Deploy lock order (DL-1): the SQL's first statement takes every table it
 * touches in ACCESS EXCLUSIVE mode with NOWAIT, so the hardening transaction
 * never waits on a lock while holding one and cannot close a lock cycle with
 * live capacity work. When a table is busy the LOCK fails at once (55P03) and
 * this wrapper retries the whole transaction with capped, jittered backoff.
 *
 * Version gate: a no-op deploy must not take those locks at all. After a
 * successful apply the wrapper records `<sha256 of the SQL>:<fingerprint of
 * the current schema's catalog>` in the SQL function
 * `wmp_schema_hardening_state()` (a function, because `prisma db push` drops
 * tables it does not know but leaves functions alone). The next run computes
 * the same key before doing anything else and skips when it matches: the SQL
 * is unchanged and nothing (a push, a manual change) altered any table,
 * column, index, constraint, trigger, function or enum since the last apply.
 * Any difference re-applies. SCHEMA_HARDENING_FORCE=1 bypasses the gate.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hardeningSqlBody } from "./hardening-sql.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to apply schema hardening");
}

/** Whole-transaction attempts and total time spent retrying lock conflicts. */
const MAX_ATTEMPTS = 40;
const MAX_RETRY_MS = 60_000;
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5_000;
const STATE_FUNCTION = "wmp_schema_hardening_state";

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const sqlHash = createHash("sha256").update(sql).digest("hex");
// Strict: throws unless the outer BEGIN;/COMMIT; were really removed.
const sqlBody = hardeningSqlBody(sql);
const force = process.env.SCHEMA_HARDENING_FORCE === "1";
const lockTimeoutMs = Number(process.env.SCHEMA_HARDENING_LOCK_TIMEOUT_MS ?? "5000");
if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 300_000) {
  throw new Error("SCHEMA_HARDENING_LOCK_TIMEOUT_MS must be an integer from 1 to 300000");
}

// Catalog fingerprint of current_schema(): every table column (type, default,
// nullability), index, constraint, user trigger, function (except the gate's
// own state function) and enum. It reads raw catalog rows only:
// pg_get_indexdef / pg_get_constraintdef / pg_get_expr open the relation and
// would take an AccessShare lock, so an ACCESS EXCLUSIVE holder (another
// deploy's DDL) could block a run that is about to skip. Expression trees are
// compared as pg_node_tree text without parse locations.
const node = (expression) =>
  `coalesce(regexp_replace(${expression}::text, ' :location -?[0-9]+', '', 'g'), '')`;
const FINGERPRINT_SQL = `
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
SELECT md5(coalesce(string_agg(item, E'\\n' ORDER BY item), '')) AS fingerprint FROM (
  SELECT 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
         || ':' || a.attnotnull::text || ':' || ${node("d.adbin")} AS item
    FROM pg_class c
    JOIN ns ON c.relnamespace = ns.oid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'idx:' || ic.relname || ':' || tc.relname || ':' || am.amname || ':' || i.indisunique::text
         || ':' || i.indkey::text || ':' || i.indclass::text || ':' || i.indoption::text
         || ':' || ${node("i.indexprs")} || ':' || ${node("i.indpred")}
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN ns ON ic.relnamespace = ns.oid
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_am am ON am.oid = ic.relam
  UNION ALL
  SELECT 'con:' || coalesce(tc.relname, '') || '.' || co.conname || ':' || co.contype::text
         || ':' || coalesce(co.conkey::text, '') || ':' || coalesce(fc.relname, '')
         || ':' || coalesce(co.confkey::text, '') || ':' || co.confupdtype::text
         || ':' || co.confdeltype::text || ':' || co.condeferrable::text || ':' || co.convalidated::text
         || ':' || ${node("co.conbin")}
    FROM pg_constraint co
    JOIN ns ON co.connamespace = ns.oid
    LEFT JOIN pg_class tc ON tc.oid = co.conrelid
    LEFT JOIN pg_class fc ON fc.oid = co.confrelid
  UNION ALL
  SELECT 'trg:' || pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN ns ON c.relnamespace = ns.oid
   WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'fn:' || pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN ns ON p.pronamespace = ns.oid
   WHERE p.proname <> '${STATE_FUNCTION}' AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'enum:' || t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN ns ON t.typnamespace = ns.oid JOIN pg_enum e ON e.enumtypid = t.oid
   GROUP BY t.typname
  UNION ALL
  SELECT 'seq:' || c.relname FROM pg_class c JOIN ns ON c.relnamespace = ns.oid WHERE c.relkind = 'S'
) items`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function currentKey(client) {
  const { rows } = await client.query(FINGERPRINT_SQL);
  return `${sqlHash}:${rows[0].fingerprint}`;
}

async function recordedKey(client) {
  const { rows } = await client.query("SELECT to_regprocedure($1) IS NOT NULL AS present", [
    `${STATE_FUNCTION}()`,
  ]);
  if (!rows[0].present) return null;
  const state = await client.query(`SELECT ${STATE_FUNCTION}() AS key`);
  return state.rows[0].key;
}

async function recordKey(client, key) {
  // The key is two lowercase hex digests; validated before inlining.
  if (!/^[0-9a-f]{64}:[0-9a-f]{32}$/.test(key)) throw new Error("unexpected hardening key");
  await client.query(
    `CREATE OR REPLACE FUNCTION ${STATE_FUNCTION}() RETURNS text LANGUAGE sql IMMUTABLE AS $state$ SELECT '${key}'::text $state$`,
  );
}

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query("SELECT set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
  if (!force && (await recordedKey(client)) === (await currentKey(client))) {
    process.stdout.write(
      "Schema hardening is already applied to this schema (SQL and catalog unchanged); skipping.\n",
    );
  } else {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.query("BEGIN");
        await client.query(sqlBody);
        const establishedKey = await currentKey(client);
        await recordKey(client, establishedKey);
        await client.query("COMMIT");
        break;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        const retryable = error?.code === "55P03" || error?.code === "40P01";
        const elapsed = Date.now() - startedAt;
        if (!retryable || attempt >= MAX_ATTEMPTS || elapsed >= MAX_RETRY_MS) throw error;
        const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
        const backoffMs = Math.floor(cap / 2 + Math.random() * (cap / 2));
        process.stderr.write(
          `Schema hardening lock conflict (${error.code}); retrying attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${backoffMs}ms.\n`,
        );
        await delay(backoffMs);
      }
    }
    process.stdout.write("Schema hardening and compatibility backfill complete.\n");
  }
} finally {
  await client.end();
}
