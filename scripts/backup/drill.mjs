#!/usr/bin/env node
/**
 * Image command `restore-drill <source>` — proves a backup restores.
 *
 * Restores <source> (`latest`, a /backups file, or s3://… with --etag and
 * optionally --version-id — the only options it accepts) into
 * DATABASE_URL, which must be a THROWAWAY EMPTY database: scripts/backup/host.sh
 * `drill` starts a temporary Postgres container for it and removes it after.
 * Production is never touched: the database must be named `restore_drill`,
 * and `restore` without --replace refuses any non-empty target.
 *
 * Then it checks the result:
 *   - every table the archive has data for exists in the restored database;
 *   - Prisma's history has applied migrations and none unfinished;
 * and prints each table's row count and the backup's age. Exit 0 = PASS.
 *
 * The archive's table list is read for every source kind the restore accepts:
 * a local raw archive directly, a gzip-wrapped one after unwrapping it, and an
 * s3:// object after downloading the same pinned object again. A drill that
 * cannot read the list FAILS: it never reports PASSED without the comparison.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { detectArchiveFormat, parseS3Source, pgEnvFromUrl, pickLatest } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRILL_DATABASE = "restore_drill";

/**
 * Tables with a TABLE DATA entry in `pg_restore --list` output.
 * @param {string} listing
 * @returns {string[]} `schema.table`
 */
export function archiveTables(listing) {
  const tables = new Set();
  for (const line of listing.split("\n")) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line);
    if (match) tables.add(`${match[1]}.${match[2]}`);
  }
  return [...tables].sort();
}

/** `Archive created at` from `pg_restore --list` output, or null. */
export function archiveCreatedAt(listing) {
  // `2026-11-11 03:00:01 UTC`; the images run in UTC, so other zones (rare)
  // are read as UTC too: the age is only a hint.
  const match = /^;\s*Archive created at:?\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/im.exec(
    listing,
  );
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * @param {{ expected: string[] | null, counts: Map<string, number>,
 *   migrations: { applied: number, unfinished: number } | null,
 *   listingError?: string | null }} result
 *   expected: the archive's tables with data, or null when the list could not be read.
 * @returns {{ pass: boolean, problems: string[] }}
 */
export function drillVerdict({ expected, counts, migrations, listingError = null }) {
  const problems = [];
  if (!expected)
    problems.push(
      `could not read the archive's table list${listingError ? ` (${listingError})` : ""}, so the restored data was not checked`,
    );
  else if (!expected.length)
    problems.push("the archive holds no table data: this is not a backup of this app's data");
  else {
    const missing = expected.filter((table) => !counts.has(table));
    if (missing.length) problems.push(`tables missing after the restore: ${missing.join(", ")}`);
  }
  if (!migrations) problems.push("no _prisma_migrations table: this is not a backup of this app");
  else {
    if (migrations.applied < 1) problems.push("Prisma's history lists no applied migration");
    if (migrations.unfinished > 0)
      problems.push(`${migrations.unfinished} unfinished (failed) migration(s) in the history`);
  }
  return { pass: problems.length === 0, problems };
}

/** @param {NodeJS.ProcessEnv} env @param {string} sql */
function psql(env, sql) {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

const DRILL_USAGE =
  "usage: restore-drill <latest | /backups/<file> | s3://bucket/key --etag <etag> [--version-id <id>]>";

/**
 * The drill's arguments: one source plus, for s3:// only, the options that pin
 * the exact object. Anything else is refused: the drill confirms the restore
 * itself, so it must never pass through an option that widens it (--replace,
 * --allow-active-connections, --skip-snapshot, --confirm, …).
 * @param {readonly string[]} argv
 * @returns {{ source: string, pins: string[] }}
 */
export function parseDrillArgs(argv) {
  const [source, ...rest] = argv;
  if (!source || source.startsWith("-")) throw new Error(DRILL_USAGE);
  /** @type {Map<string, string>} */
  const pins = new Map();
  while (rest.length) {
    const arg = /** @type {string} */ (rest.shift());
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== "--etag" && flag !== "--version-id")
      throw new Error(`restore-drill does not accept ${arg}.\n${DRILL_USAGE}`);
    const value = eq === -1 ? rest.shift() : arg.slice(eq + 1);
    if (!value || value.startsWith("-") || pins.has(flag))
      throw new Error(`${flag} needs one value.\n${DRILL_USAGE}`);
    pins.set(flag, value);
  }
  if (pins.size && !source.startsWith("s3://"))
    throw new Error(`--etag and --version-id apply only to s3:// sources.\n${DRILL_USAGE}`);
  return { source, pins: [...pins].flat() };
}

const ident = (name) => `"${name.replaceAll('"', '""')}"`;

async function main(argv) {
  let source;
  let pins;
  try {
    ({ source, pins } = parseDrillArgs(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const pgEnv = pgEnvFromUrl(process.env.DATABASE_URL);
  if (pgEnv.PGDATABASE !== DRILL_DATABASE) {
    console.error(
      `REFUSED: the drill restores only into a throwaway database named "${DRILL_DATABASE}" (DATABASE_URL names "${pgEnv.PGDATABASE}"). Run it with host.sh drill.`,
    );
    return 1;
  }
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PG"))),
    ...pgEnv,
    PGCONNECT_TIMEOUT: "10",
  };

  // Pick `latest` ONCE: restore and the table check below must read the same
  // archive even if a scheduled or pre-migration dump lands in between.
  if (source === "latest") {
    const newest = resolveLocal("latest");
    if (!newest) {
      console.log(
        "DRILL FAILED: there is no backup in /backups to drill (is the volume mounted?).",
      );
      return 1;
    }
    source = newest;
    console.log(`Newest backup: ${source}`);
  }
  console.log(`== Restore drill: ${source} → throwaway database "${DRILL_DATABASE}" ==`);
  const restoreArgs = [
    path.join(HERE, "restore.mjs"),
    source,
    ...pins,
    "--confirm",
    `RESTORE:${DRILL_DATABASE}`,
  ];
  const code = await new Promise((resolve) => {
    // RESTORE_DRILL=1: restore skips its production "Next steps" (start the app, …).
    const child = spawn(process.execPath, restoreArgs, {
      env: { ...process.env, RESTORE_DRILL: "1" },
      stdio: "inherit",
    });
    child.on("close", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    console.log("\nDRILL FAILED: the restore itself failed (see above).");
    return 1;
  }

  const counts = new Map();
  for (const row of psql(
    env,
    "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY 1",
  )
    .split("\n")
    .filter(Boolean)) {
    const [schema, table] = row.split(/\.(.*)/s);
    counts.set(row, Number(psql(env, `SELECT count(*) FROM ${ident(schema)}.${ident(table)}`)));
  }
  // The tables the archive has data for, for every source kind.
  /** @type {string[] | null} */
  let expected = null;
  let createdAt = null;
  let listingError = null;
  try {
    const listing = await archiveListing(source, pins, env);
    expected = archiveTables(listing);
    createdAt = archiveCreatedAt(listing);
  } catch (error) {
    listingError = error instanceof Error ? error.message : String(error);
  }
  const hasHistory =
    psql(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL") === "t";
  const migrations = hasHistory
    ? (() => {
        const [applied, unfinished] = psql(
          env,
          "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM public._prisma_migrations",
        ).split("\t");
        return { applied: Number(applied), unfinished: Number(unfinished) };
      })()
    : null;

  console.log("\nRows per table in the restored copy:");
  for (const [table, rows] of counts) console.log(`  ${table.padEnd(48)} ${rows}`);
  if (migrations)
    console.log(`Applied migrations: ${migrations.applied} (unfinished: ${migrations.unfinished})`);
  if (createdAt !== null) {
    const hours = Math.round((Date.now() - createdAt) / 3_600_000);
    console.log(`Backup age: about ${hours} hour(s)`);
    if (hours > 26)
      console.log(
        "WARNING: the newest backup is more than a day old. Check that scheduled backups are running.",
      );
  }
  const verdict = drillVerdict({ expected, counts, migrations, listingError });
  if (verdict.pass) {
    console.log(
      "\nDRILL PASSED: the backup restores and holds this app's data. Record the date, the backup and this result where you keep operations notes.",
    );
    return 0;
  }
  console.log(`\nDRILL FAILED:\n  - ${verdict.problems.join("\n  - ")}`);
  return 1;
}

/** `--etag` / `--version-id` values from parseDrillArgs' flat pins. */
function pinValues(pins) {
  const map = new Map();
  for (let i = 0; i + 1 < pins.length; i += 2) map.set(pins[i], pins[i + 1]);
  return { etag: map.get("--etag") ?? null, versionId: map.get("--version-id") ?? null };
}

/**
 * `pg_restore --list` of the archive the restore read: a local file as is, an
 * s3:// object downloaded again by its pinned ETag (and version), and a gzip
 * wrapper unwrapped first — the same unwrapping restore.mjs does.
 * @param {string} source @param {string[]} pins @param {NodeJS.ProcessEnv} env
 * @param {{ download?: (args: { location: { bucket: string, key: string }, eTag: string,
 *   versionId: string | null, dest: string }) => Promise<unknown>,
 *   list?: (file: string) => { status: number | null, stdout: string, stderr: string } }} [deps]
 * @returns {Promise<string>}
 */
export async function archiveListing(source, pins, env, deps = {}) {
  const workDir = await mkdtemp(path.join(tmpdir(), "restore-drill-"));
  try {
    let file;
    const location = parseS3Source(source);
    if (location) {
      const { etag, versionId } = pinValues(pins);
      if (!etag) throw new Error("an s3:// source needs --etag");
      file = path.join(workDir, "source.download");
      const download =
        deps.download ??
        (async (args) => {
          const s3 = await import("./s3.mjs");
          return s3.downloadObject({ ...args, versionId: args.versionId ?? undefined });
        });
      await download({ location, eTag: etag, versionId, dest: file });
    } else {
      file = resolveLocal(source);
      if (!file) throw new Error("no backup file found for latest in /backups");
    }
    if (detectArchiveFormat(await readHead(file)) === "gzip") {
      const unwrapped = path.join(workDir, "source.unwrapped");
      await pipeline(
        createReadStream(file),
        createGunzip(),
        createWriteStream(unwrapped, { mode: 0o600 }),
      );
      file = unwrapped;
    }
    const listing = deps.list
      ? deps.list(file)
      : spawnSync("pg_restore", ["--list", file], { env, encoding: "utf8" });
    if (listing.status !== 0)
      throw new Error(
        `pg_restore --list failed: ${(listing.stderr || "").trim() || `exit ${listing.status}`}`,
      );
    return listing.stdout;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** @param {string} file */
async function readHead(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The local file `restore` read for <source> (the same pick for `latest`). */
function resolveLocal(source) {
  if (source !== "latest") return path.resolve(source);
  try {
    const entries = readdirSync("/backups").map((name) => {
      const info = statSync(path.join("/backups", name));
      return { name, mtimeMs: info.mtimeMs, size: info.isFile() ? info.size : -1 };
    });
    const latest = pickLatest(entries.filter((entry) => entry.size >= 0));
    return latest ? path.join("/backups", latest) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
