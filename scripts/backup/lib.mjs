/**
 * Shared, side-effect-free helpers for scripts/backup/pre-migrate.sh and
 * scripts/backup/restore.mjs. Nothing here touches the network or a database,
 * so every function is unit-tested in lib.test.mjs.
 *
 * CLI (used by the shell scripts):
 *   node lib.mjs pg-env   → prints NAME=value\0 pairs for libpq, parsed from
 *                           DATABASE_URL, so the password never reaches argv.
 */
import { fileURLToPath } from "node:url";

// Prisma Migrate's advisory-lock key and the migration runner's lock key have
// one definition, next to the code that reads them.
export {
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK as PRISMA_MIGRATE_LOCK_KEY,
} from "../db/lib/migration-state.mjs";
/** Dedicated restore lock key: 0x52535452 = "RSTR". Two restores never overlap. */
export const RESTORE_LOCK_KEY = 1381192786;

export class UsageError extends Error {}

/**
 * libpq environment for a postgres:// URL. Only libpq-understood parameters are
 * forwarded; Prisma-only query parameters (`schema`, `connection_limit`, …) are
 * ignored.
 * @param {string | undefined} databaseUrl
 * @returns {Record<string, string>}
 */
export function pgEnvFromUrl(databaseUrl) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new Error("DATABASE_URL must name exactly one database (…/<database-name>).");
  }
  /** @type {Record<string, string>} */
  const env = {
    PGHOST: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    PGPORT: url.port || "5432",
    PGDATABASE: database,
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  /** @type {Array<[string, string]>} */
  const forwarded = [
    ["sslmode", "PGSSLMODE"],
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
  ];
  for (const [param, name] of forwarded) {
    const value = url.searchParams.get(param);
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Identify a backup file from its first bytes.
 *  - `custom`: pg_dump -Fc ("PGDMP" magic) — what pre-migrate.sh writes.
 *  - `tar`:    pg_dump -Ft ("ustar" at offset 257).
 *  - `gzip`:   gzip wrapper (Dokploy writes `pg_dump -Fc | gzip`); decompress
 *              and detect again.
 *  - `plain-sql`: a text dump. Not supported: it cannot be verified before it
 *              touches the target.
 * @param {Uint8Array} head at least the first 262 bytes when available
 * @returns {"custom" | "tar" | "gzip" | "plain-sql" | "unknown"}
 */
export function detectArchiveFormat(head) {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "PGDMP") return "custom";
  if (bytes.length >= 262 && bytes.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  const text = bytes.subarray(0, 512).toString("utf8");
  if (/^(?:﻿)?\s*(?:--|SET |\\restrict |CREATE |SELECT )/.test(text)) return "plain-sql";
  return "unknown";
}

/**
 * @typedef {{ bucket: string, key: string }} S3Location
 * @param {string} source
 * @returns {S3Location | null}
 */
export function parseS3Source(source) {
  if (!source.startsWith("s3://")) return null;
  const rest = source.slice("s3://".length);
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const key = slash === -1 ? "" : rest.slice(slash + 1);
  if (!bucket || !key || key.endsWith("/")) {
    throw new UsageError("An S3 source must be s3://<bucket>/<object-key>.");
  }
  return { bucket, key };
}

/** The one confirmation value: binds the operation to the target database name. */
export function expectedConfirmation(database) {
  return `RESTORE:${database}`;
}

/**
 * The guided restore's question. Replacing a database that holds data needs
 * its name typed back (the confirmation value); an empty target needs only y.
 * @param {string} database
 * @param {boolean} occupied
 */
export function guidedQuestion(database, occupied) {
  return occupied
    ? `This REPLACES everything in "${database}" (a snapshot is taken first).\nType the database name (${database}) to restore, or press Enter to cancel: `
    : `Restore this backup into the empty database "${database}"? [y/N] `;
}

/**
 * Does the owner's answer to {@link guidedQuestion} confirm the restore?
 * @param {string} answer
 * @param {string} database
 * @param {boolean} occupied
 */
export function guidedAnswerConfirms(answer, database, occupied) {
  const trimmed = answer.trim();
  return occupied ? trimmed === database : /^y(es)?$/i.test(trimmed);
}

export const RESTORE_USAGE = `Usage:
  restore <source> [--confirm RESTORE:<target-database>] [options]

  restore --list               List the backups in /backups, newest first.

<source>
  latest                       The newest backup in /backups (daily, manual or
                               pre-migration; never a pre-restore snapshot).
  /backups/<file>              A file inside the container (raw pg_dump -Fc/-Ft
                               archive or a gzip-wrapped one, e.g. Dokploy's .sql.gz).
  s3://<bucket>/<key>          An object in BACKUP_S3_BUCKET (needs BACKUP_S3_*).

Options
  --confirm RESTORE:<db>       Required to change anything. <db> is the database
                               named in DATABASE_URL. Without it, restore only
                               verifies the source and prints a preview.
  --replace                    Allow restoring over a non-empty database. Its
                               current contents are snapshotted first, then every
                               application schema is dropped and the archive is
                               restored, all in one transaction.
  --etag <etag>                S3 only, required: the exact object ETag to restore.
  --version-id <id>            S3 only: pin a specific object version.
  --allow-active-connections   Proceed although other sessions are connected
                               (only when you are certain nothing writes).
  --skip-snapshot              With --replace: do not take the pre-restore
                               snapshot (only when a provider snapshot exists).
  --guided                     After the preview, ask in the terminal and fill in
                               --confirm (and --replace, --etag) for you: y/N for
                               an empty target; replacing a database that holds
                               data needs its name typed. Needs a terminal (-it).
  -h, --help                   Show this help.`;

/**
 * @typedef {{
 *   source: string,
 *   confirm: string | null,
 *   replace: boolean,
 *   allowActiveConnections: boolean,
 *   skipSnapshot: boolean,
 *   etag: string | null,
 *   versionId: string | null,
 *   help: boolean,
 *   list: boolean,
 *   guided: boolean,
 * }} RestoreArgs
 * @param {readonly string[]} argv
 * @returns {RestoreArgs}
 */
export function parseRestoreArgs(argv) {
  const args = [...argv];
  // The image entrypoint may pass its CMD word through; accept and drop it.
  if (args[0] === "restore") args.shift();
  /** @type {RestoreArgs} */
  const parsed = {
    source: "",
    confirm: null,
    replace: false,
    allowActiveConnections: false,
    skipSnapshot: false,
    etag: null,
    versionId: null,
    help: false,
    list: false,
    guided: false,
  };
  /** @param {string} flag @param {string | undefined} inline */
  const takeValue = (flag, inline) => {
    const value = inline ?? args.shift();
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`${flag} needs a value.`);
    }
    return value;
  };
  /** @type {string[]} */
  const positional = [];
  while (args.length > 0) {
    const arg = /** @type {string} */ (args.shift());
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const noValue = () => {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value.`);
    };
    switch (flag) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--confirm":
        parsed.confirm = takeValue(flag, inline);
        break;
      case "--etag":
        parsed.etag = takeValue(flag, inline);
        break;
      case "--version-id":
        parsed.versionId = takeValue(flag, inline);
        break;
      case "--replace":
        noValue();
        parsed.replace = true;
        break;
      case "--allow-active-connections":
        noValue();
        parsed.allowActiveConnections = true;
        break;
      case "--skip-snapshot":
        noValue();
        parsed.skipSnapshot = true;
        break;
      case "--list":
        noValue();
        parsed.list = true;
        break;
      case "--guided":
        noValue();
        parsed.guided = true;
        break;
      case "--":
        positional.push(...args.splice(0));
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  if (parsed.help) return parsed;
  if (parsed.list) {
    if (positional.length || parsed.confirm !== null || parsed.guided)
      throw new UsageError("--list takes no source and no other options.");
    return parsed;
  }
  if (positional.length !== 1) {
    throw new UsageError(
      positional.length === 0
        ? "Missing <source>."
        : `Expected one <source>, got ${positional.length}.`,
    );
  }
  parsed.source = /** @type {string} */ (positional[0]);
  const s3 = parseS3Source(parsed.source);
  if (!s3 && (parsed.etag || parsed.versionId)) {
    throw new UsageError("--etag and --version-id apply only to s3:// sources.");
  }
  if (parsed.skipSnapshot && !parsed.replace) {
    throw new UsageError("--skip-snapshot only applies together with --replace.");
  }
  if (parsed.guided && (parsed.confirm !== null || parsed.replace)) {
    throw new UsageError("--guided asks for the confirmation itself; drop --confirm / --replace.");
  }
  return parsed;
}

/** Files `restore` can read: our pg_dump archives and Dokploy's gzip-wrapped dumps. */
const RESTORABLE = /\.(dump|dump\.gz|sql\.gz)$/;

/**
 * Backups in a directory listing, newest first (hidden and partial files
 * excluded). Every label shares one volume: daily (the scheduled backup),
 * manual, pre-migrate, pre-drop, pre-restore.
 * @param {ReadonlyArray<{ name: string, mtimeMs: number, size: number }>} entries
 */
export function sortBackups(entries) {
  return entries
    .filter((entry) => !entry.name.startsWith(".") && RESTORABLE.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

/**
 * The backup `restore latest` means: the newest one that is not a
 * pre-restore snapshot (that one holds the data a previous restore replaced).
 * @param {ReadonlyArray<{ name: string, mtimeMs: number, size: number }>} entries
 * @returns {string | null}
 */
export function pickLatest(entries) {
  return sortBackups(entries).find((entry) => !entry.name.startsWith("pre-restore-"))?.name ?? null;
}

/**
 * Quote a value for display in a copy-pasteable shell command.
 * @param {string} value
 */
export function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "pg-env") {
    try {
      const env = pgEnvFromUrl(process.env.DATABASE_URL);
      process.stdout.write(
        Object.entries(env)
          .map(([name, value]) => `${name}=${value}\0`)
          .join(""),
      );
    } catch (error) {
      console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.error("usage: node lib.mjs pg-env");
    process.exit(2);
  }
}
