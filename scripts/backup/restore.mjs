#!/usr/bin/env node
/**
 * The single database restore command. Runs INSIDE the target network as the
 * app image's `restore` command (a one-shot ACA job / ECS task, or a one-off
 * container on the Docker host) — never from a developer machine.
 *
 *   restore <source> [--confirm RESTORE:<target-database>] [--replace] [...]
 *
 * See RESTORE_USAGE in lib.mjs for every option. The target is DATABASE_URL.
 *
 * Safeguards, in order (nothing changes before step 6):
 *   1. Source: local file or s3:// object pinned by --etag (and --version-id);
 *      gzip wrappers (Dokploy) are unwrapped; the archive must be pg_dump
 *      custom or tar format and must read completely with pg_restore.
 *   2. Target: reachable, primary (not a read replica), pg_restore client major
 *      ≥ server major; empty unless --replace.
 *   3. Confirmation: --confirm must equal RESTORE:<database named in DATABASE_URL>.
 *      Without it this command only prints a preview.
 *   4. Locks: a dedicated restore advisory lock (no concurrent restore),
 *      Prisma Migrate's own advisory lock, and the migration runner's lock
 *      (migrate-runtime.mjs apply), held for the whole restore, so no
 *      migration or migration runner can work meanwhile. The target is
 *      re-inspected under the locks; a recorded unfinished migration is reported.
 *   5. Writers: refuses while other sessions are connected (stop app + worker
 *      first) unless --allow-active-connections.
 *   6. Snapshot: a non-empty target is dumped first (pre-migrate.sh --label
 *      pre-restore --required → /backups and/or S3) unless --skip-snapshot.
 *   7. Restore: schema drop (replace only) + the whole archive run in ONE
 *      transaction; any error rolls everything back and leaves the target as it was.
 *      The same transaction holds scheduled deletions for 7 days (a `restore`
 *      row in `_wmp_hold`, scripts/db/lib/contracts.mjs) when the restored
 *      database has Prisma history, so a deletion the dump predates is not
 *      re-run while the restored data is checked or recovered.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdtemp, open, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { HOLD_DDL } from "../db/lib/contracts.mjs";
import { prismaSchemaName } from "../db/lib/migration-state.mjs";
import {
  detectArchiveFormat,
  expectedConfirmation,
  guidedAnswerConfirms,
  guidedQuestion,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_MIGRATE_LOCK_KEY,
  parseRestoreArgs,
  parseS3Source,
  pgEnvFromUrl,
  pickLatest,
  RESTORE_LOCK_KEY,
  RESTORE_USAGE,
  shellQuote,
  sortBackups,
  UsageError,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = "/backups";
const LOCK_APP_NAME = "wmp-restore-lock";

class Refusal extends Error {}

/**
 * Exit status of a refused restore — nothing was changed: a usage error,
 * preview only, a cancelled prompt (or a stop signal before the restore
 * transaction started), a failed check, or a failed pre-restore snapshot.
 *
 * The whole contract (docs/backup-and-restore.md):
 *   0   committed, even when a signal then cut the closing summary short
 *       ("restore completed; then interrupted").
 *   3   REFUSED_EXIT: refused or cancelled before the restore transaction started.
 *   4   ROLLED_BACK_EXIT: the restore transaction started and provably did not
 *       commit — the target is unchanged. Only when COMMIT was never sent, when
 *       psql stopped on an SQL error (ON_ERROR_STOP, exit 3) before printing
 *       the confirmation that follows COMMIT, or when the server reports the
 *       transaction aborted (pg_xact_status).
 *   1   failed with the outcome uncertain (COMMIT may have been sent), or the
 *       restore committed and a later step failed (the output says which).
 *   129/130/143  a signal after COMMIT was sent, before it was confirmed:
 *       uncertain. (A signal before COMMIT was sent is a rollback: 4.)
 * Callers treat 0/3/4 as definite; anything else means "inspect the target".
 */
export const REFUSED_EXIT = 3;
/** Exit status of a restore that started and rolled back: the target is unchanged. */
export const ROLLED_BACK_EXIT = 4;
/** psql's exit status for an SQL error that stopped the script (ON_ERROR_STOP). */
const PSQL_SCRIPT_ERROR = 3;
/** How long an "in progress" restore transaction is waited for before "uncertain". */
const XACT_STATUS_WAIT_MS = 15_000;

/** @type {Set<import("node:child_process").ChildProcess>} */
const children = new Set();

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, capture?: boolean }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(command, args, { env, capture = true, timeoutMs = 0 }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    children.add(child);
    // Optional hard bound: a stalled connection cannot hold the caller past it.
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolvePromise({ code: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
  });
}

/**
 * One read-only query with short timeouts; returns trimmed unaligned output.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} sql
 */
async function query(env, sql) {
  const result = await run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: { ...env, PGOPTIONS: "-c lock_timeout=5s -c statement_timeout=60s" },
  });
  if (result.code !== 0) {
    throw new Refusal(
      `database query failed: ${result.stderr.trim() || `psql exited ${result.code}`}`,
    );
  }
  return result.stdout.trim();
}

/** @param {string} path */
async function readHead(path) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, 512, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** @param {string} path */
async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Resolve the source to a verified local pg_dump archive.
 * @param {import("./lib.mjs").RestoreArgs} args
 * @param {string} workDir
 */
async function prepareSource(args, workDir) {
  /** @type {string[]} */
  const identity = [];
  let path;
  const s3Location = parseS3Source(args.source);
  if (s3Location) {
    const s3 = await import("./s3.mjs");
    let config;
    try {
      config = s3.backupS3Config();
    } catch (error) {
      throw new Refusal(
        `S3 source needs the backup bucket settings: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
    const head = await s3.describeObject({
      location: s3Location,
      versionId: args.versionId,
      config,
    });
    const where = `s3://${s3Location.bucket}/${s3Location.key}`;
    identity.push(
      `object:   ${where}`,
      `etag:     ${head.eTag ?? "(none)"}${head.versionId ? `   version: ${head.versionId}` : ""}`,
      `modified: ${head.lastModified ?? "unknown"}   size: ${head.size ?? "unknown"} bytes`,
    );
    if (!args.etag && args.guided && head.eTag) {
      // Guided: pin the object shown in the preview; the owner confirms it below.
      args.etag = head.eTag;
      if (head.versionId) args.versionId = head.versionId;
    }
    if (!args.etag) {
      console.log(`Source\n  ${identity.join("\n  ")}`);
      throw new Refusal(
        `An S3 source must be pinned to its exact ETag. If the object above is the one you mean, re-run with:\n  --etag ${shellQuote(head.eTag ?? "")}${head.versionId ? ` --version-id ${shellQuote(head.versionId)}` : ""}`,
      );
    }
    if (!s3.sameETag(head.eTag, args.etag)) {
      throw new Refusal(
        `--etag ${args.etag} does not match the object's current ETag ${head.eTag}. Nothing was changed.`,
      );
    }
    if (args.versionId && head.versionId !== args.versionId) {
      throw new Refusal("The object's version does not match --version-id. Nothing was changed.");
    }
    path = join(workDir, "source.download");
    console.log(`Downloading ${where} ...`);
    await s3.downloadObject({
      location: s3Location,
      eTag: head.eTag ?? args.etag,
      versionId: head.versionId,
      dest: path,
      config,
    });
  } else {
    path = resolve(args.source);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Refusal(
        `source file not found: ${path} (is the backup volume mounted into this container?)`,
      );
    }
    if (!info.isFile()) throw new Refusal(`source is not a regular file: ${path}`);
    identity.push(
      `file:     ${path}`,
      `modified: ${info.mtime.toISOString()}   size: ${info.size} bytes`,
    );
  }

  let format = detectArchiveFormat(await readHead(path));
  let wrapped = false;
  if (format === "gzip") {
    wrapped = true;
    const unwrapped = join(workDir, "source.unwrapped");
    console.log("Source is gzip-wrapped; decompressing ...");
    try {
      await pipeline(
        createReadStream(path),
        createGunzip(),
        createWriteStream(unwrapped, { mode: 0o600 }),
      );
    } catch (error) {
      throw new Refusal(
        `the gzip wrapper is corrupt or truncated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    path = unwrapped;
    format = detectArchiveFormat(await readHead(path));
  }
  if (format === "plain-sql") {
    throw new Refusal(
      "this is a plain-SQL dump. Restore accepts pg_dump custom (-Fc) or tar (-Ft) archives, raw or gzip-wrapped, because only those can be verified before they touch the target.",
    );
  }
  if (format !== "custom" && format !== "tar") {
    throw new Refusal(
      "unrecognized source format (expected a pg_dump -Fc/-Ft archive, optionally gzip-wrapped).",
    );
  }
  identity.push(
    `format:   pg_dump ${format}${wrapped ? " (gzip-wrapped)" : ""}`,
    `sha256:   ${await sha256(path)}`,
  );
  return { path, format, identity };
}

/**
 * Verify the archive reads completely (catalog + every data block).
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 */
async function verifyArchive(path, env) {
  const list = await run("pg_restore", ["--list", path], { env });
  if (list.code !== 0)
    throw new Refusal(`pg_restore --list rejected the archive: ${list.stderr.trim()}`);
  const header = (/** @type {string} */ field) =>
    new RegExp(`^;\\s*${field}:?\\s*(.*)$`, "im").exec(list.stdout)?.[1]?.trim() ?? "unknown";
  const entries = list.stdout.split("\n").filter((line) => /^\d+;/.test(line)).length;
  // pg_restore writes large objects (BLOB / BLOBS / BLOB METADATA entries)
  // inside their own BEGIN … COMMIT when it writes a script, and that COMMIT
  // would commit the restore's single transaction halfway (with --replace,
  // after the schema drop). This app's schema has none; refuse rather than
  // restore one in pieces.
  if (/^\d+;\s+\d+\s+\d+\s+BLOB(S| METADATA)?\s/m.test(list.stdout)) {
    throw new Refusal(
      "the archive contains large objects (BLOB entries). pg_restore restores those in their own transaction, which would break this command's single-transaction restore. Nothing was changed; restore this archive by hand with pg_restore.",
    );
  }
  const full = await run("pg_restore", ["--file=/dev/null", path], { env });
  if (full.code !== 0) {
    throw new Refusal(
      `the archive is incomplete or corrupt (pg_restore could not read it all): ${full.stderr.trim()}`,
    );
  }
  return {
    database: header("Dbname"),
    createdAt: header("Archive created at"),
    dumpVersion: header("Dumped from database version"),
    entries,
  };
}

/** @param {NodeJS.ProcessEnv} env */
async function inspectTarget(env) {
  const serverNum = Number(await query(env, "SHOW server_version_num"));
  if (!Number.isInteger(serverNum)) throw new Refusal("could not read the target server version.");
  const versionOut = (await run("pg_restore", ["--version"], { env })).stdout;
  const clientMajor = Number(/(\d+)/.exec(versionOut)?.[1] ?? Number.NaN);
  const serverMajor = Math.floor(serverNum / 10000);
  const inRecovery = (await query(env, "SELECT pg_is_in_recovery()")) === "t";
  // Everything an application could own: any non-system schema other than an
  // empty public, any object in public, any extension besides plpgsql.
  const occupied =
    (await query(
      env,
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
         UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')`,
    )) === "t";
  const tables = Number(
    await query(
      env,
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('information_schema') AND n.nspname !~ '^pg_'",
    ),
  );
  return { serverMajor, clientMajor, inRecovery, occupied, tables };
}

/**
 * Hold a dedicated session for the restore's lifetime with all three advisory
 * locks (restore, Prisma Migrate, migration runner).
 * Closing its stdin ends the session and releases them.
 * @param {NodeJS.ProcessEnv} env
 */
async function openLockSession(env) {
  const child = spawn("psql", ["-X", "-q", "-A", "-t", "-F", ",", "-v", "ON_ERROR_STOP=1"], {
    env: { ...env, PGAPPNAME: LOCK_APP_NAME },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let closing = false;
  const state = { lost: false };
  const exited = new Promise((resolveExit) => {
    child.on("close", (code) => {
      children.delete(child);
      clearInterval(heartbeat);
      if (!closing && acquired) {
        // The session holding the advisory locks ended (backend terminated,
        // connection dropped): the locks are gone. Stop everything at once;
        // killing psql mid-transaction makes PostgreSQL roll the restore back.
        state.lost = true;
        console.error(
          "FATAL: the lock session ended unexpectedly, so the restore no longer holds its locks. Aborting.",
        );
        for (const other of children) other.kill("SIGTERM");
      }
      resolveExit(code ?? 1);
    });
  });
  let acquired = false;
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // A spawn failure (no psql in PATH) also emits "close", which ends the
  // reply wait below as "could not open the lock session" (a refusal); the
  // refusal names the cause ("spawn psql ENOENT").
  child.on("error", (error) => {
    stderr ||= error.message;
  });
  /** @type {NodeJS.Timeout | undefined} */
  let heartbeat;
  const close = async () => {
    closing = true;
    clearInterval(heartbeat);
    child.stdin.end();
    await exited;
  };
  const reply = await new Promise((resolveReply) => {
    let buffered = "";
    const timer = setTimeout(() => resolveReply(null), 30_000);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const match = /^([tf]),([tf]),([tf]),(\d+)$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolveReply(match);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolveReply(null);
    });
    child.stdin.write(
      `SELECT pg_try_advisory_lock(${RESTORE_LOCK_KEY}), pg_try_advisory_lock(${PRISMA_MIGRATE_LOCK_KEY}), pg_try_advisory_lock(${MIGRATION_RUNNER_LOCK_KEY}), pg_backend_pid();\n`,
    );
  });
  if (!reply) {
    await close();
    throw new Refusal(
      `could not open the lock session: ${stderr.trim() || "no reply from the database"}`,
    );
  }
  const match = /** @type {RegExpExecArray} */ (reply);
  // Later output (the restore's own query results) is not needed.
  child.stdout.removeAllListeners("data");
  child.stdout.resume();
  acquired = match[1] === "t" && match[2] === "t" && match[3] === "t";
  if (acquired) {
    // An idle psql never notices its backend being terminated; a cheap query
    // every second makes it exit, which fires the lock-loss abort above.
    heartbeat = setInterval(() => {
      if (!child.stdin.destroyed) child.stdin.write("SELECT 1;\n");
    }, 1_000);
    heartbeat.unref();
  }
  return {
    restoreLock: match[1] === "t",
    migrateLock: match[2] === "t",
    runnerLock: match[3] === "t",
    pid: Number(match[4]),
    get lost() {
      return state.lost;
    },
    /**
     * Turn this session into the one that applies the restore, so the same
     * backend holds the locks from the checks through COMMIT.
     * @returns {{ psql: import("node:child_process").ChildProcess, exited: Promise<number> }}
     */
    handOver() {
      closing = true;
      clearInterval(heartbeat);
      // From here on, psql errors are the restore's errors: show them.
      child.stderr.removeAllListeners("data");
      child.stderr.pipe(process.stderr);
      return { psql: child, exited: /** @type {Promise<number>} */ (exited) };
    },
    close,
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {number} lockPid
 */
async function otherConnections(env, lockPid) {
  const out = await query(
    env,
    `SELECT count(*) || '|' || coalesce(string_agg(DISTINCT coalesce(nullif(application_name, ''), '(no application_name)') || ' from ' || coalesce(client_addr::text, 'local socket'), '; '), '')
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> ${lockPid}`,
  );
  const [count, who] = out.split("|");
  return { count: Number(count), who: who ?? "" };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {number} lockPid
 * @param {boolean} allow
 */
async function assertNoWriters(env, lockPid, allow) {
  const { count, who } = await otherConnections(env, lockPid);
  if (count === 0) return;
  if (allow) {
    console.warn(
      `WARNING: ${count} other connection(s) (${who}) — continuing because of --allow-active-connections.`,
    );
    return;
  }
  throw new Refusal(
    `${count} other connection(s) are using ${env.PGDATABASE}: ${who}.\n` +
      "Stop the app and worker (Dokploy: stop the service; container platforms: scale app + worker to zero) and any\n" +
      "other client, then re-run. If a connection is a pooler or provider monitor you cannot stop and you are\n" +
      "certain nothing writes, add --allow-active-connections. Nothing was changed.",
  );
}

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Hold scheduled deletions for 7 days, inside the restore transaction (§1.12
 * source 1). Only where the restored database has Prisma history; an existing
 * longer hold is never shortened.
 * @param {string} schema Prisma's schema (`?schema=` of DATABASE_URL)
 */
function restoreHoldSql(schema) {
  const name = sqlLiteral(schema);
  return `DO $restore_hold$ BEGIN IF to_regclass(format('%I._prisma_migrations', ${name}::text)) IS NOT NULL THEN
  EXECUTE format(${sqlLiteral(HOLD_DDL)}, ${name}::text);
  EXECUTE format('INSERT INTO %I."_wmp_hold" AS h (reason, until) VALUES (''restore'', now() + interval ''7 days'')
                  ON CONFLICT (reason) DO UPDATE SET until = greatest(h.until, EXCLUDED.until), set_at = now()', ${name}::text);
END IF; END $restore_hold$;
`;
}

/**
 * Stream the archive as SQL into ONE transaction. COMMIT is sent only after
 * pg_restore has produced the whole script successfully; any failure ends
 * psql's input without COMMIT, so PostgreSQL rolls everything back.
 * The transaction runs IN the lock session (its backend has held the
 * advisory locks since before the checks and the snapshot), so no other
 * restore or migration can run at any point between validation and COMMIT.
 * If that backend dies, the transaction dies with it.
 * @param {string} archive
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} replace
 * @param {{ psql: import("node:child_process").ChildProcess, exited: Promise<number> }} session
 * @param {string} holdSql written after the archive, before COMMIT
 */
function applyArchive(archive, env, replace, session, holdSql) {
  return new Promise((resolvePromise) => {
    const psql = session.psql;
    const dump = spawn("pg_restore", ["--no-owner", "--no-privileges", "--file=-", archive], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    // A spawn failure also emits "close" with a non-zero code: COMMIT is then
    // never sent and the transaction rolls back.
    dump.on("error", () => {});
    children.add(dump);
    let psqlDone = false;
    let psqlCode = 0;
    let dumpCode = /** @type {number | null} */ (null);
    // COMMIT counts as done only once the session confirms it: the marker is
    // a client-side \echo written after COMMIT, so it prints only if COMMIT
    // succeeded (ON_ERROR_STOP), and nothing after COMMIT can raise an SQL
    // error. That is what makes "psql exit 3 without the marker" provably a
    // rollback: the failed statement came at or before COMMIT.
    // A COMMIT written into a session that was already gone never confirms.
    const nonce = randomBytes(8).toString("hex");
    const marker = `wmp-restore-committed-${nonce}`;
    // The transaction's id, printed right after BEGIN: when the outcome is
    // otherwise uncertain, the server's pg_xact_status() for it decides.
    const xidPrefix = `wmp-restore-xid-${nonce}:`;
    // The newline makes a line split across chunks match only once complete.
    const xidPattern = new RegExp(`${xidPrefix}(\\d+)\\n`);
    let confirmed = false;
    /** @type {string | null} */
    let xid = null;
    let tail = "";
    psql.stdout.on("data", (chunk) => {
      if (confirmed) return;
      const seen = tail + chunk;
      if (xid === null) xid = xidPattern.exec(seen)?.[1] ?? null;
      confirmed = seen.includes(marker);
      if (confirmed) commitConfirmed = true;
      // Keep enough for a marker or an xid line split across chunks.
      tail = seen.slice(-(xidPrefix.length + 24));
    });
    psql.stdin.on("error", () => {
      dump.kill("SIGTERM");
    });
    psql.stdin.write(
      `BEGIN;\nSET LOCAL client_min_messages = warning;\nSELECT '${xidPrefix}' || pg_current_xact_id();\n`,
    );
    if (replace) {
      // The schema drop runs in the same transaction as the restore: either
      // the archive fully replaces the old contents or nothing changes.
      psql.stdin.write(`DO $restore$
DECLARE target_schema text;
BEGIN
  FOR target_schema IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', target_schema);
  END LOOP;
END
$restore$;
CREATE SCHEMA public;
`);
    }
    dump.stdout.pipe(psql.stdin, { end: false });
    dump.on("close", (code) => {
      children.delete(dump);
      dumpCode = code ?? 1;
      // psql may already have exited (ON_ERROR_STOP) before its exit was
      // observed: then COMMIT never reaches the server and nothing committed.
      if (!psqlDone && psql.exitCode === null && psql.signalCode === null && dumpCode === 0) {
        // From here on the server may commit at any moment: neither a psql
        // failure nor a signal may be reported as "rolled back" any more.
        commitSent = true;
        psql.stdin.write(`${holdSql}COMMIT;\n\\echo ${marker}\n`);
      }
      psql.stdin.end();
    });
    session.exited.then((code) => {
      psqlDone = true;
      psqlCode = code;
      if (dumpCode === null) dump.kill("SIGTERM");
      // Committed only if COMMIT was sent and confirmed: a psql that exited 0
      // before it (its input ended early) left the transaction to roll back.
      const finish = () =>
        resolvePromise({
          ok: commitSent && confirmed && psqlCode === 0 && dumpCode === 0,
          confirmed,
          psqlCode,
          dumpCode,
          xid,
        });
      if (dumpCode === null) dump.once("close", finish);
      else finish();
    });
  });
}

/**
 * Decide what a restore that did not end cleanly did to the target. Reports
 * "rolled-back" only when that is provable; otherwise asks the server, and
 * stays "uncertain" when even the server cannot say.
 * @param {{ confirmed: boolean, psqlCode: number, xid: string | null }} result
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ outcome: "committed" | "rolled-back" | "uncertain", reason: string }>}
 */
async function settleOutcome(result, env) {
  if (result.confirmed)
    return { outcome: "committed", reason: "the restore session confirmed COMMIT" };
  if (!commitSent) return { outcome: "rolled-back", reason: "COMMIT was never sent" };
  if (result.psqlCode === PSQL_SCRIPT_ERROR) {
    // ON_ERROR_STOP: psql stopped at the first failing statement, and nothing
    // after COMMIT can fail (the confirmation is a client-side \echo). So the
    // failure was at or before COMMIT, and a failed COMMIT rolls back too.
    return {
      outcome: "rolled-back",
      reason: "psql stopped on an SQL error (ON_ERROR_STOP) before confirming COMMIT",
    };
  }
  const status = await serverXactStatus(env, result.xid);
  if (status === "committed")
    return { outcome: "committed", reason: "the server reports the restore transaction committed" };
  if (status === "aborted")
    return { outcome: "rolled-back", reason: "the server reports the restore transaction aborted" };
  return {
    outcome: "uncertain",
    reason: result.xid
      ? `the server reports the restore transaction as ${status}`
      : "the restore transaction's id was never seen",
  };
}

/**
 * The server's pg_xact_status() for the restore transaction, from a fresh
 * session. Waits while it is still "in progress" (the dead session's backend
 * may still be finishing its COMMIT or its rollback), up to XACT_STATUS_WAIT_MS.
 * Each status query is bounded by what is left of that wait (at least 1 s), so
 * a stalled connection ends in "unavailable", never in a restore that hangs.
 * @param {NodeJS.ProcessEnv} env
 * @param {string | null} xid digits only (parsed from the session's output)
 * @returns {Promise<string>} committed | aborted | in progress | unknown | unavailable
 */
async function serverXactStatus(env, xid) {
  if (!xid || !/^\d+$/.test(xid)) return "unknown";
  const deadline = Date.now() + XACT_STATUS_WAIT_MS;
  for (;;) {
    let result;
    try {
      result = await run(
        "psql",
        [
          "-X",
          "-q",
          "-A",
          "-t",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `SELECT coalesce(pg_xact_status('${xid}'::xid8), 'unknown')`,
        ],
        {
          env: { ...env, PGOPTIONS: "-c lock_timeout=5s -c statement_timeout=5s" },
          timeoutMs: Math.max(1000, deadline - Date.now()),
        },
      );
    } catch {
      return "unavailable (the status query failed)";
    }
    if (result.timedOut) return "unavailable (the status query timed out)";
    if (result.code !== 0) return "unavailable (the status query failed)";
    const status = result.stdout.trim();
    if (status === "committed" || status === "aborted") return status;
    if (status !== "in progress") return "unknown";
    if (Date.now() >= deadline) return "still in progress";
    await delay(250);
  }
}

/** @param {NodeJS.ProcessEnv} env */
async function migrationSummary(env) {
  const exists = await query(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL");
  if (exists !== "t")
    return "no _prisma_migrations table in the restored data (pre-Migrate backup?)";
  const out = await query(
    env,
    "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '|' || coalesce((SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1), '(none)') FROM public._prisma_migrations",
  );
  const [count, latest] = out.split("|");
  return `${count} applied migration(s); latest: ${latest}`;
}

/** Backups in /backups, newest first. */
async function localBackups() {
  let names;
  try {
    names = await readdir(BACKUPS_DIR);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const info = await stat(join(BACKUPS_DIR, name));
      if (info.isFile()) entries.push({ name, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Removed while listing (a prune); skip it.
    }
  }
  return entries;
}

/**
 * Ask on the terminal. Ctrl-C / Ctrl-D at the prompt (readline closes the
 * interface in raw mode instead of raising SIGINT) is a cancel: nothing has
 * changed yet, so it is a Refusal (REFUSED_EXIT), not a failed restore.
 * @param {string} question
 */
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } catch (error) {
    const code = /** @type {{ code?: string, name?: string }} */ (error)?.code;
    if (code === "ABORT_ERR" || code === "ERR_USE_AFTER_CLOSE" || error?.name === "AbortError")
      throw new Refusal("cancelled — nothing was changed.");
    throw error;
  } finally {
    prompt.close();
  }
}

/**
 * Set just before the restore transaction starts (the lock session's BEGIN):
 * until then every stop signal or error leaves the target untouched.
 */
let applyStarted = false;
/**
 * Set when COMMIT is written to psql: the server may commit at any moment, so
 * a failure or signal from now until `committed` has an uncertain outcome.
 */
let commitSent = false;
/**
 * Set once the restore transaction has committed: from then on no error or
 * signal may be reported as "nothing was changed" or "rolled back".
 */
let committed = false;
/**
 * Set as soon as the restore session confirms COMMIT (its marker query
 * printed): the restore has committed, even before psql's exit is observed.
 */
let commitConfirmed = false;
/**
 * Set to the exit status once a failure has been reported (1 or
 * ROLLED_BACK_EXIT): a signal while the process winds down keeps that status
 * instead of reporting another outcome.
 * @type {number | null}
 */
let reportedExit = null;

async function main() {
  let args;
  try {
    args = parseRestoreArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      // Nothing was touched: a refusal, like every other "nothing changed" exit.
      console.error(`REFUSED: ${error.message}\n\n${RESTORE_USAGE}`);
      return REFUSED_EXIT;
    }
    throw error;
  }
  if (args.help) {
    console.log(RESTORE_USAGE);
    return 0;
  }
  // Signal handlers first: everything from here on (even scanning /backups
  // for --list or `latest`, which can stall on a slow mount) is a cancellable
  // step that changes nothing until the restore transaction starts.
  /** @type {string | null} */
  let workDir = null;
  const cleanup = () => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  };
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.once(signal, () => {
      // Killing psql before COMMIT rolls the restore back.
      for (const child of children) child.kill("SIGTERM");
      cleanup();
      if (reportedExit !== null) process.exit(reportedExit);
      if (committed || commitConfirmed) {
        // The restore itself finished; only the closing summary was cut short.
        // Report it as done (exit 0, owner decision 2026-11-14): host.sh then
        // starts the app, which applies any pending migrations, exactly as
        // after an uninterrupted restore.
        console.error(
          `\nRestore completed; then interrupted by ${signal}. The restored data is in place; only the closing summary was cut short.`,
        );
        process.exit(0);
      }
      if (!applyStarted) {
        // Verifying, downloading, checking or the pre-restore snapshot: the
        // target was never touched.
        console.error(
          `\nREFUSED: cancelled by ${signal} before the restore started — nothing was changed.`,
        );
        process.exit(REFUSED_EXIT);
      }
      if (!commitSent) {
        // COMMIT was never written: killing psql makes PostgreSQL roll back.
        console.error(
          `\nROLLED BACK: interrupted by ${signal} before COMMIT; the unfinished restore transaction is rolled back and the target is unchanged.`,
        );
        process.exit(ROLLED_BACK_EXIT);
      }
      console.error(
        `\nFATAL: interrupted by ${signal} after COMMIT was sent; the outcome for the target is uncertain (the restore may have committed). Keep every writer stopped and inspect the database before trusting it.`,
      );
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    });
  }
  if (args.list) {
    const backups = sortBackups(await localBackups());
    if (!backups.length) {
      console.log(
        `No backups in ${BACKUPS_DIR} (is the backups volume mounted into this container?).`,
      );
      return 0;
    }
    console.log(`Backups in ${BACKUPS_DIR}, newest first:`);
    for (const backup of backups)
      console.log(
        `  ${backup.name}   ${new Date(backup.mtimeMs).toISOString()}   ${backup.size} bytes`,
      );
    return 0;
  }
  if (args.guided && !process.stdin.isTTY) {
    throw new Refusal(
      "--guided asks before changing anything, so it needs a terminal: run the container with -it. Nothing was changed.",
    );
  }
  if (args.source === "latest") {
    const latest = pickLatest(await localBackups());
    if (!latest)
      throw new Refusal(
        `there is no backup in ${BACKUPS_DIR} to restore (is the backups volume mounted?). Nothing was changed.`,
      );
    args.source = join(BACKUPS_DIR, latest);
    console.log(`Newest backup: ${args.source}`);
  }

  let pgEnv;
  try {
    pgEnv = pgEnvFromUrl(process.env.DATABASE_URL);
  } catch (error) {
    throw new Refusal(`target: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** @type {NodeJS.ProcessEnv} */
  // The target is exactly DATABASE_URL: inherited libpq variables (PGHOSTADDR,
  // PGSERVICE, …) could silently redirect the connection, so drop them all.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PG")),
  );
  const env = { ...inherited, ...pgEnv, PGCONNECT_TIMEOUT: "10" };
  const database = pgEnv.PGDATABASE;
  const expected = expectedConfirmation(database);

  console.log("== Restore ==");
  console.log(
    "Before a real restore: stop and drain every writer of the target (app, worker, cron",
  );
  console.log("jobs, other clients). Restore refuses while other sessions are connected.\n");

  workDir = await mkdtemp(join(tmpdir(), "wmp-restore-"));
  try {
    console.log("Verifying source ...");
    const source = await prepareSource(args, workDir);
    const archive = await verifyArchive(source.path, env);
    const target = await inspectTarget(env);

    console.log(`\nSource\n  ${source.identity.join("\n  ")}`);
    console.log(
      `  dumped:   ${archive.createdAt} from database "${archive.database}" (PostgreSQL ${archive.dumpVersion}), ${archive.entries} catalog entries`,
    );
    console.log(
      `\nTarget\n  database: ${database} on ${pgEnv.PGHOST}:${pgEnv.PGPORT} (PostgreSQL ${target.serverMajor})\n  contents: ${target.occupied ? `NOT EMPTY (${target.tables} table(s))` : "empty"}\n`,
    );

    if (!Number.isFinite(target.clientMajor) || target.clientMajor < target.serverMajor) {
      throw new Refusal(
        `pg_restore is version ${target.clientMajor} but the server is ${target.serverMajor}. Install a newer postgresql-client in the Dockerfile and rebuild.`,
      );
    }
    if (target.inRecovery)
      throw new Refusal(
        "the target is a read-only replica (pg_is_in_recovery). Point DATABASE_URL at the primary.",
      );

    const rerun = [
      "restore",
      shellQuote(args.source),
      ...(args.etag ? ["--etag", shellQuote(args.etag)] : []),
      ...(args.versionId ? ["--version-id", shellQuote(args.versionId)] : []),
      ...(target.occupied ? ["--replace"] : []),
      "--confirm",
      expected,
    ].join(" ");
    if (args.confirm === null && args.guided) {
      const answer = await ask(guidedQuestion(database, target.occupied));
      if (!guidedAnswerConfirms(answer, database, target.occupied))
        throw new Refusal(
          target.occupied && answer.trim()
            ? `cancelled — "${answer.trim()}" is not the database name. Nothing was changed.`
            : "cancelled — nothing was changed.",
        );
      args.confirm = expected;
      args.replace = target.occupied;
    }
    if (args.confirm === null) {
      throw new Refusal(
        `preview only — nothing was changed.\nTo restore this source into "${database}"${target.occupied ? ", replacing its current contents" : ""}, run:\n  ${rerun}`,
      );
    }
    if (args.confirm !== expected) {
      throw new Refusal(
        `--confirm must be exactly ${expected} for this target (got ${args.confirm}). Nothing was changed.`,
      );
    }
    if (target.occupied && !args.replace) {
      throw new Refusal(
        `the target database "${database}" is not empty (${target.tables} table(s)). Restore into a new empty database,\nor add --replace to snapshot and then replace its contents:\n  ${rerun}`,
      );
    }

    const lock = await openLockSession(env);
    try {
      if (!lock.restoreLock) throw new Refusal("another restore is running against this database.");
      if (!lock.migrateLock) {
        throw new Refusal(
          "a Prisma migration is running against this database (its advisory lock is held). Wait for it to finish.",
        );
      }
      if (!lock.runnerLock) {
        throw new Refusal(
          "the migration runner (migrate-runtime.mjs apply: MIGRATE_ON_START=true or the `migrate` job) is working on this database (its advisory lock is held). Wait for it to finish, then stop the app and worker. Nothing was changed.",
        );
      }
      // The target was inspected before the locks were taken; a migration or
      // another restore may have changed it in between. Decide on what is
      // there now, under the locks.
      const recheck = await inspectTarget(env);
      if (recheck.occupied !== target.occupied) {
        throw new Refusal(
          `the target database "${database}" changed while the restore was preparing (it is now ${recheck.occupied ? "NOT EMPTY" : "empty"}). Nothing was changed; re-run to see a fresh preview.`,
        );
      }
      if (target.occupied) {
        // Two queries: PostgreSQL resolves a table reference while parsing,
        // so a CASE guard cannot protect a database that has no history table.
        const hasHistory =
          (await query(env, "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")) === "t";
        const unfinished = hasHistory
          ? await query(
              env,
              "SELECT coalesce(string_agg(migration_name, ', '), '') FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL",
            )
          : "";
        if (unfinished) {
          console.warn(
            `WARNING: the target records unfinished (failed) migration(s): ${unfinished}. No migration is running (lock is free); the restore replaces this history.`,
          );
        }
      }
      await assertNoWriters(env, lock.pid, args.allowActiveConnections);

      if (target.occupied) {
        if (args.skipSnapshot) {
          console.warn(
            "WARNING: --skip-snapshot: the current contents are NOT backed up by this command. Make sure a provider snapshot exists.",
          );
        } else {
          console.log("Snapshotting the current target before replacing it ...");
          const snapshot = await run(
            "bash",
            [join(HERE, "pre-migrate.sh"), "--label", "pre-restore", "--required"],
            {
              env,
              capture: false,
            },
          );
          if (snapshot.code !== 0) {
            throw new Refusal(
              "the pre-restore snapshot failed, so the target was not touched. Mount a writable /backups volume or set BACKUP_S3_*,\nor, only if a provider snapshot exists, add --skip-snapshot.",
            );
          }
        }
        // A writer may have connected while the snapshot ran.
        await assertNoWriters(env, lock.pid, args.allowActiveConnections);
      }

      console.log(`Restoring into "${database}" in a single transaction ...`);
      if (lock.lost)
        throw new Refusal(
          "the lock session ended before the restore started; nothing was changed.",
        );
      // The lock session itself runs the restore transaction: the locks are
      // never released between the checks and COMMIT.
      applyStarted = true;
      const result = await applyArchive(
        source.path,
        env,
        target.occupied,
        lock.handOver(),
        restoreHoldSql(prismaSchemaName(process.env.DATABASE_URL ?? "")),
      );
      if (!result.ok) {
        const { outcome, reason } = await settleOutcome(result, env);
        if (outcome === "rolled-back") {
          reportedExit = ROLLED_BACK_EXIT;
          console.error(
            `ROLLED BACK: restore failed (psql exit ${result.psqlCode}, pg_restore exit ${result.dumpCode}). ${reason}, so the transaction was rolled back; "${database}" is unchanged.`,
          );
          return ROLLED_BACK_EXIT;
        }
        reportedExit = 1;
        console.error(
          outcome === "committed"
            ? `FATAL: ${result.confirmed ? "the restore session confirmed COMMIT, then failed" : "the restore session failed before confirming COMMIT, but the server reports the restore transaction committed"} (psql exit ${result.psqlCode}). "${database}" is restored (the transaction committed), but the session did not end cleanly. Keep every writer stopped and inspect the database before trusting it.`
            : `FATAL: restore failed after COMMIT was sent (psql exit ${result.psqlCode}, COMMIT not confirmed; ${reason}). The outcome for "${database}" is uncertain: the restore may have committed before the failure. Keep every writer stopped and inspect the database before trusting it.`,
        );
        return 1;
      }
      committed = true;
      // The data is restored; a summary query that fails now must not turn a
      // finished restore into "refused" or "failed".
      let summary;
      try {
        summary = await migrationSummary(env);
      } catch (error) {
        summary = `migration summary unavailable (${error instanceof Error ? error.message : String(error)})`;
      }
      console.log(`\nRestore complete. ${summary}.`);
    } finally {
      await lock.close();
    }
    if (process.env.RESTORE_DRILL === "1") {
      // restore-drill (drill.mjs) restored a throwaway copy; it checks it next.
      return 0;
    }
    console.log(`Next steps:
  1. Check the restored data with read-only queries.
  2. Deploy an image whose packages/db/prisma/migrations includes that latest migration.
     A newer image applies its pending migrations on start; an older one starts only if
     every newer migration can be rolled back — otherwise deploy the matching or a newer commit.
  3. Start (or redeploy) the app and worker again, and confirm backups are running for this
     database. Scheduled deletions wait 7 days after a restore; to get back data a deletion
     already removed, ship the recover change within those 7 days.
See docs/backup-and-restore.md.`);
    return 0;
  } finally {
    cleanup();
  }
}

/** An error's message as a sentence, so a verdict can follow it. */
const sentence = (/** @type {unknown} */ error) =>
  `${error instanceof Error ? error.message : String(error)}`.replace(/\.?\s*$/, ".");

try {
  process.exitCode = await main();
} catch (error) {
  if (committed) {
    // After COMMIT nothing is "refused" any more: the restore itself succeeded.
    reportedExit = 1;
    console.error(
      `FATAL: the restore was committed, then: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } else if (!applyStarted) {
    // Every Refusal is raised before the target changes (preview, cancel at a
    // prompt, failed checks, a failed snapshot), and so is any other error
    // before the restore transaction started: its own exit code lets callers
    // (host.sh) tell "nothing was changed" from a failed or uncertain restore.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `\nREFUSED: ${message}${error instanceof Refusal ? "" : " Nothing was changed."}`,
    );
    process.exitCode = REFUSED_EXIT;
  } else if (!commitSent) {
    // The restore transaction started but COMMIT was never written; main's
    // `finally` already ended the session's input, so PostgreSQL rolled it back.
    reportedExit = ROLLED_BACK_EXIT;
    console.error(
      `ROLLED BACK: ${sentence(error)} COMMIT was never sent, so the restore transaction was rolled back; the target is unchanged.`,
    );
    process.exitCode = ROLLED_BACK_EXIT;
  } else {
    reportedExit = 1;
    console.error(
      `FATAL: ${sentence(error)} COMMIT had been sent: the outcome for the target is uncertain; inspect it before trusting it.`,
    );
    process.exitCode = 1;
  }
}
