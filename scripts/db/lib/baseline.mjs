/**
 * Adopting a released 0.4.x database into Prisma Migrate (1.0 only).
 *
 * Releases up to 0.4.3 created the schema with `prisma db push` plus
 * packages/db/prisma/schema-hardening.sql and kept no migration history. 1.0
 * ships two migrations instead:
 *
 *   0_init                     exactly the released 0.4.3 schema: Prisma's
 *                              from-empty SQL for the v0.4.3 schema, then the
 *                              v0.4.3 hardening (scripts/db/generate-initial-migrations.mjs)
 *   UPGRADE_MIGRATION          the 0.4.3 → 1.0 change: Prisma's diff, the 1.0
 *                              hardening (idempotent) and its one-time
 *                              backfills, and the removal of the 0.4.x
 *                              hardening version gate
 *
 * A database with tables but no `_prisma_migrations` (`no-history-nonempty`)
 * is adopted only when its schema is exactly what 0_init creates: the runner
 * applies 0_init's body inside a transaction that is always rolled back, in a
 * private temporary schema of the same database, and compares that catalog
 * with the live one (`compareBaseline`). Equal → `prisma migrate resolve
 * --applied 0_init`, and UPGRADE_MIGRATION follows like any pending
 * migration. Different → refused with the differences listed; nothing is
 * changed. Comparing on the same server means no catalog text is committed
 * and the PostgreSQL version cannot cause a false difference.
 *
 * Plain Node, no dependencies beyond the `pg` client passed in: it runs
 * inside the production image.
 */

/** The baseline every 0.4.3 database is adopted at. */
export const BASELINE_MIGRATION = "0_init";
/** The release whose schema 0_init reproduces (git tag). */
export const BASELINE_RELEASE = "v0.4.3";
/**
 * The one-time 0.4.3 → 1.0 migration. It changes a released schema in place
 * (the hardening drops and re-creates its own constraints and triggers), so
 * the runner admits it only on a database whose applied history is exactly
 * [0_init] (a fresh install, or a 0.4.3 database adopted at 0_init); see
 * `upgradeAdmitted`. CI check 5 reports it instead of failing it.
 */
export const UPGRADE_MIGRATION = "20261112000000_upgrade_to_1_0_0";
/** The 0.4.x hardening version gate (a function); never part of the comparison. */
export const LEGACY_HARDENING_STATE_FUNCTION = "wmp_schema_hardening_state";
export const BASELINE_GUIDE = "docs/schema-migrations.md § Upgrading a 0.4.x database";

/** The one-time upgrade migration may run in place when nothing newer than 0_init is applied. */
export function upgradeAdmitted(name, applied) {
  return (
    name === UPGRADE_MIGRATION &&
    (applied.length === 0 || (applied.length === 1 && applied[0] === BASELINE_MIGRATION))
  );
}

/** Folders whose in-place changes CI reports instead of failing (both only ever run once). */
export const ONE_TIME_MIGRATIONS = new Set([BASELINE_MIGRATION, UPGRADE_MIGRATION]);

/**
 * One text row per schema object, schema-independent: the reading session's
 * search_path is the inspected schema, so pg_get_* print names unqualified.
 * $1 = schema name. Column order, ownership, privileges, statistics and
 * sequence positions are deliberately ignored.
 */
const CATALOG_SQL = `
WITH ns AS (SELECT oid, nspname FROM pg_catalog.pg_namespace WHERE nspname = $1),
extension_members AS (
  SELECT classid, objid FROM pg_catalog.pg_depend WHERE deptype = 'e'
)
SELECT item FROM (
  SELECT 'relation ' || c.relname || ' kind=' || c.relkind::text
         || ' persistence=' || c.relpersistence::text || ' rls=' || c.relrowsecurity::text AS item
    FROM pg_catalog.pg_class c JOIN ns ON c.relnamespace = ns.oid
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT IN ('_prisma_migrations')
     AND c.relname NOT LIKE '\\_wmp\\_%'
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || coalesce(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
         || CASE WHEN a.attidentity <> '' THEN ' identity=' || a.attidentity::text ELSE '' END
         || CASE WHEN a.attgenerated <> '' THEN ' generated=' || a.attgenerated::text ELSE '' END
         || CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                 THEN ' collate ' || co.collname ELSE '' END
    FROM pg_catalog.pg_class c JOIN ns ON c.relnamespace = ns.oid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname NOT IN ('_prisma_migrations')
     AND c.relname NOT LIKE '\\_wmp\\_%'
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  SELECT 'constraint ' || coalesce(c.relname, '-') || '.' || k.conname || ' ' || pg_catalog.pg_get_constraintdef(k.oid)
         || CASE WHEN k.convalidated THEN '' ELSE ' not valid' END
    FROM pg_catalog.pg_constraint k JOIN ns ON k.connamespace = ns.oid
    LEFT JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
   WHERE coalesce(c.relname, '') NOT IN ('_prisma_migrations') AND coalesce(c.relname, '') NOT LIKE '\\_wmp\\_%'
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_constraint'::regclass AND x.objid = k.oid)
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  -- pg_get_indexdef always qualifies the table.
  SELECT 'index ' || replace(pg_catalog.pg_get_indexdef(i.indexrelid), ' ON ' || quote_ident($1) || '.', ' ON ')
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN ns ON ic.relnamespace = ns.oid JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
   WHERE tc.relname NOT IN ('_prisma_migrations') AND tc.relname NOT LIKE '\\_wmp\\_%'
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = ic.oid)
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = tc.oid)
  UNION ALL
  SELECT 'trigger ' || replace(pg_catalog.pg_get_triggerdef(t.oid), ' ON ' || quote_ident($1) || '.', ' ON ')
         || ' enabled=' || t.tgenabled::text
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN ns ON c.relnamespace = ns.oid
   WHERE NOT t.tgisinternal
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_trigger'::regclass AND x.objid = t.oid)
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  SELECT 'routine ' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ') '
         || md5(regexp_replace(pg_catalog.pg_get_functiondef(p.oid),
                  '^CREATE OR REPLACE (FUNCTION|PROCEDURE) [^(]*\\(', 'CREATE OR REPLACE \\1 ' || p.proname || '('))
    FROM pg_catalog.pg_proc p JOIN ns ON p.pronamespace = ns.oid
   WHERE p.prokind IN ('f', 'p') AND p.proname <> '${LEGACY_HARDENING_STATE_FUNCTION}'
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_proc'::regclass AND x.objid = p.oid)
  UNION ALL
  SELECT 'enum ' || t.typname || ' (' || string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) || ')'
    FROM pg_catalog.pg_type t JOIN ns ON t.typnamespace = ns.oid
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
   WHERE NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_type'::regclass AND x.objid = t.oid)
   GROUP BY t.typname
  UNION ALL
  SELECT 'type ' || t.typname || ' kind=' || t.typtype::text
    FROM pg_catalog.pg_type t JOIN ns ON t.typnamespace = ns.oid
   WHERE NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_type'::regclass AND x.objid = t.oid)
     AND t.typtype IN ('d', 'c') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
  UNION ALL
  SELECT 'sequence ' || c.relname || ' ' || pg_catalog.format_type(s.seqtypid, NULL)
         || ' start=' || s.seqstart || ' increment=' || s.seqincrement || ' min=' || s.seqmin
         || ' max=' || s.seqmax || ' cycle=' || s.seqcycle::text
         || coalesce(' owned by ' || oc.relname || '.' || oa.attname, '')
    FROM pg_catalog.pg_class c JOIN ns ON c.relnamespace = ns.oid
    JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
    LEFT JOIN pg_catalog.pg_depend dep ON dep.objid = c.oid AND dep.classid = 'pg_catalog.pg_class'::regclass
         AND dep.refclassid = 'pg_catalog.pg_class'::regclass AND dep.deptype IN ('a', 'i')
    LEFT JOIN pg_catalog.pg_class oc ON oc.oid = dep.refobjid
    LEFT JOIN pg_catalog.pg_attribute oa ON oa.attrelid = dep.refobjid AND oa.attnum = dep.refobjsubid
   WHERE NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  SELECT 'policy ' || c.relname || '.' || pol.polname || ' ' || pol.polcmd::text || ' '
         || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' '
         || coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
    FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN ns ON c.relnamespace = ns.oid
   WHERE NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_policy'::regclass AND x.objid = pol.oid)
     AND NOT EXISTS (SELECT 1 FROM extension_members x WHERE x.classid = 'pg_catalog.pg_class'::regclass AND x.objid = c.oid)
  UNION ALL
  SELECT 'extension ' || x.extname
    FROM pg_catalog.pg_extension x JOIN ns ON x.extnamespace = ns.oid
) items ORDER BY item`;

/**
 * Read the catalog rows of `schema`, with search_path set to it for the
 * duration of the caller's transaction (SET LOCAL).
 * @param {import("pg").Client} client inside an open transaction
 */
export async function readSchemaCatalog(client, schema) {
  await client.query(`SET LOCAL search_path TO ${client.escapeIdentifier(schema)}`);
  const { rows } = await client.query(CATALOG_SQL, [schema]);
  return rows.map((row) => row.item);
}

/** Pure: what only one side has. */
export function diffCatalogs(expected, live) {
  const want = new Set(expected);
  const have = new Set(live);
  return {
    missing: expected.filter((item) => !have.has(item)),
    // Provider-installed extensions are allowed; an extension required by the
    // baseline must still be present (the missing side remains strict).
    unexpected: live.filter((item) => !want.has(item) && !item.startsWith("extension ")),
  };
}

/**
 * Compare the live `schema` with what `body` (0_init without its wrapper)
 * creates on an empty schema. Everything runs in one transaction that is
 * always rolled back, so the database is unchanged whatever happens.
 * @param {import("pg").Client} client a dedicated session (not the lock session)
 * @param {{ schema: string, body: string, scratchName: string, timeoutMs?: number }} options
 * @returns {Promise<{ equal: boolean, missing: string[], unexpected: string[], liveCount: number }>}
 */
export async function compareBaseline(client, { schema, body, scratchName, timeoutMs = 120_000 }) {
  if (!/^_wmp_baseline_[a-z0-9]{8,32}$/.test(scratchName))
    throw new Error(`unexpected scratch schema name ${scratchName}`);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL client_min_messages = warning");
    const live = await readSchemaCatalog(client, schema);
    await client.query(`CREATE SCHEMA ${client.escapeIdentifier(scratchName)}`);
    await client.query(`SET LOCAL search_path TO ${client.escapeIdentifier(scratchName)}`);
    await client.query(body);
    const expected = await readSchemaCatalog(client, scratchName);
    const { missing, unexpected } = diffCatalogs(expected, live);
    return {
      equal: missing.length === 0 && unexpected.length === 0,
      missing,
      unexpected,
      liveCount: live.length,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

/** Short operator-facing list of differences (at most `limit` lines per side). */
export function describeDifferences({ missing, unexpected }, limit = 25) {
  const shorten = (item) => (item.length > 220 ? `${item.slice(0, 217)}...` : item);
  const lines = [];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length}):`);
    for (const item of items.slice(0, limit)) lines.push(`  ${shorten(item)}`);
    if (items.length > limit) lines.push(`  … and ${items.length - limit} more`);
  };
  section(`missing from the database (0_init = ${BASELINE_RELEASE} creates them)`, missing);
  section(`in the database but not in ${BASELINE_RELEASE}'s schema`, unexpected);
  return lines;
}
