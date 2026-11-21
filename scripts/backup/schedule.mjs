#!/usr/bin/env node
/**
 * The optional daily backup — the `backup` service of compose.backups.yaml
 * (image command `backup-schedule`). OFF unless BACKUP_SCHEDULE=daily.
 *
 *   node schedule.mjs run      the long-running loop (the service's command)
 *   node schedule.mjs health   the service's healthcheck (exit 0 healthy)
 *
 * Each run is `pre-migrate.sh --label daily --required --keep 0`: the same
 * verified `pg_dump -Fc` archive as the pre-migration backup, written to the
 * /backups volume and, when BACKUP_S3_BUCKET is set, uploaded with the
 * BACKUP_S3_* key. So `restore`, `restore --list` / `restore latest` and the
 * restore drill (host.sh) read it like any other dump.
 *
 * Settings (read here only, never by the app):
 *   BACKUP_SCHEDULE   off (default) | daily
 *   BACKUP_HOUR_UTC   hour of the daily run, 0-23 (default 3)
 *   BACKUP_KEEP       days of daily dumps kept in /backups, one (the newest)
 *                     per UTC day (default 14; S3 keeps all, expire them with a
 *                     bucket lifecycle rule)
 *
 * On start it backs up, after a short delay, when the last success is a day
 * old (or there is none), once the app has migrated the database (a new
 * install's empty database is not backed up). A failed run is retried every
 * hour; when only the upload failed, the retry uploads the dump already on
 * disk instead of taking a new one (a fresh dump is taken once that day is
 * over). Old dumps are pruned after every attempt, successful or not, so a
 * failing upload cannot fill the disk. A run counts as a success only once
 * the dump is uploaded (when S3 is configured); the last success and any
 * pending upload are remembered in /backups across restarts.
 *
 * Migrations: before dumping it waits while the migration runner (or Prisma
 * Migrate) holds its advisory lock and refuses while a migration is recorded
 * as unfinished. Residual race: a deploy that starts while a dump is running
 * can hit its lock_timeout on a table the dump reads; the runner then stops and
 * the next deploy (or container restart) migrates normally.
 *
 * The healthcheck turns unhealthy when the last run failed or the last success
 * is older than 26 hours, so Docker / Dokploy show a missed backup. With
 * BACKUP_SCHEDULE=daily a missing or unreadable status file is unhealthy too:
 * the loop writes it before anything else, so its absence means the loop is
 * not running or cannot record what it did.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MIGRATION_RUNNER_LOCK_KEY, PRISMA_MIGRATE_LOCK_KEY, pgEnvFromUrl } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABEL = "daily";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 26 * HOUR_MS;
/** A start is usually a deploy: let the server's startup migration go first. */
const START_DELAY_MS = 5 * 60 * 1000;
const MIGRATION_POLL_MS = 15_000;
const MIGRATION_WAIT_MAX_MS = 30 * 60 * 1000;
/** Where the loop records its status for the healthcheck (a parameter in tests). */
export const STATUS_FILE = "/tmp/wmp-backup-status.json";
const LOCAL_DIR = "/backups";
/** Hidden (never listed or restored); survives restarts with the volume. */
const STATE_FILE = path.join(LOCAL_DIR, ".backup-schedule.json");
/** pre-migrate.sh: the dump is on disk and verified, only the upload failed. */
const EXIT_UPLOAD_FAILED = 3;
const DAILY_NAME = /^daily-(\d{8})T\d{6}Z(?:-\d+)?\.dump$/;

const log = (message) => console.log(`[backup] ${message}`);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ enabled: false } | { enabled: true, hourUtc: number, keep: number }}
 */
export function scheduleConfig(env) {
  const mode = (env.BACKUP_SCHEDULE ?? "").trim() || "off";
  if (mode === "off") return { enabled: false };
  if (mode !== "daily")
    throw new Error(`BACKUP_SCHEDULE must be "off" or "daily" (got "${mode}").`);
  const hourUtc = Number((env.BACKUP_HOUR_UTC ?? "").trim() || 3);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23)
    throw new Error("BACKUP_HOUR_UTC must be a whole hour from 0 to 23.");
  const keep = Number((env.BACKUP_KEEP ?? "").trim() || 14);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365)
    throw new Error("BACKUP_KEEP must be a whole number from 1 to 365.");
  return { enabled: true, hourUtc, keep };
}

/** The next run strictly after `nowMs`, at `hourUtc`:00 UTC. */
export function nextRunAt(nowMs, hourUtc) {
  const next = new Date(nowMs);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= nowMs) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

/**
 * Back up at start? Yes when there is no success yet, or the most recent
 * scheduled time (today's or yesterday's `hourUtc`) passed after it, so a
 * restart just after the hour never skips that day's run.
 */
export function dueAtStart(lastSuccessMs, nowMs, hourUtc) {
  if (lastSuccessMs === null) return true;
  const lastScheduled = nextRunAt(nowMs, hourUtc) - DAY_MS;
  return lastSuccessMs < lastScheduled;
}

/** `YYYYMMDD` (UTC) of a daily dump's name, or null for any other file. */
export function dumpDay(name) {
  return DAILY_NAME.exec(name)?.[1] ?? null;
}

/** `YYYYMMDD` of `nowMs` in UTC. */
function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Which daily dumps to delete: keep the newest dump of each of the newest
 * `keepDays` UTC days. Hourly retries on one day collapse to one dump, so
 * failed runs never push older days out. Other files are never touched.
 * @param {readonly string[]} names
 * @param {number} keepDays
 * @returns {string[]}
 */
export function dailyPrunePlan(names, keepDays) {
  const days = new Map();
  // Sort on the stem: a same-second `-<pid>` name is the later one.
  const stem = (name) => name.replace(/\.dump$/, "");
  const newestFirst = names
    .filter((name) => dumpDay(name) !== null)
    .sort((a, b) => (stem(a) < stem(b) ? 1 : stem(a) > stem(b) ? -1 : 0));
  for (const name of newestFirst) {
    const day = /** @type {string} */ (dumpDay(name));
    days.set(day, [...(days.get(day) ?? []), name]);
  }
  const doomed = [];
  [...days.keys()]
    .sort()
    .reverse()
    .forEach((day, index) => {
      const [newest, ...rest] = days.get(day);
      doomed.push(...rest);
      if (index >= keepDays) doomed.push(newest);
    });
  return doomed.sort();
}

/**
 * May the backup dump now? `busy` while a migration runs (wait); `failed`
 * when a migration is recorded as unfinished with no one working on it (a
 * person must resolve it first); `new-install` before the first migration.
 * @param {{ runnerHeld: boolean, prismaHeld: boolean, hasHistory: boolean,
 *   unfinished: number }} facts
 * @returns {"ready" | "busy" | "failed" | "new-install"}
 */
export function migrationGate({ runnerHeld, prismaHeld, hasHistory, unfinished }) {
  if (runnerHeld || prismaHeld) return "busy";
  if (!hasHistory) return "new-install";
  if (unfinished > 0) return "failed";
  return "ready";
}

/**
 * What the next attempt does: re-upload today's dump that is already on disk,
 * or take a new one (no pending upload, or it is from an earlier UTC day).
 * @param {string | null} pending
 * @param {number} nowMs
 * @returns {"upload" | "dump"}
 */
export function nextAction(pending, nowMs) {
  return pending !== null && dumpDay(pending) === utcDay(nowMs) ? "upload" : "dump";
}

/**
 * @param {{ enabled: boolean, startedAt: number, lastSuccess: number | null,
 *   lastFailure: number | null }} status
 * @param {number} nowMs
 * @returns {{ healthy: boolean, reason: string }}
 */
export function healthOf(status, nowMs) {
  if (!status.enabled) return { healthy: true, reason: "scheduled backups are off" };
  if (status.lastFailure !== null && (status.lastSuccess ?? 0) < status.lastFailure)
    return { healthy: false, reason: "the last scheduled backup failed (see this service's log)" };
  if (status.lastSuccess === null)
    return nowMs - status.startedAt < HOUR_MS
      ? { healthy: true, reason: "first backup in progress" }
      : { healthy: false, reason: "no scheduled backup has succeeded yet" };
  if (nowMs - status.lastSuccess > STALE_AFTER_MS)
    return { healthy: false, reason: "the last successful backup is more than 26 hours old" };
  return { healthy: true, reason: "last backup succeeded" };
}

const isTime = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The healthcheck's verdict from this service's settings and the status file's
 * text (null when it cannot be read). Off is healthy whatever the file says;
 * daily needs a valid status the loop wrote.
 * @param {string | null} text
 * @param {NodeJS.ProcessEnv} env
 * @param {number} nowMs
 * @param {string} [file] the status file `text` came from (for the reason)
 * @returns {{ healthy: boolean, reason: string }}
 */
export function healthFromStatus(text, env, nowMs, file = STATUS_FILE) {
  let config;
  try {
    config = scheduleConfig(env);
  } catch (error) {
    return { healthy: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!config.enabled) return { healthy: true, reason: "scheduled backups are off" };
  if (text === null)
    return {
      healthy: false,
      reason: `no backup status in ${file}: the scheduler is not running or cannot write it (see this service's log)`,
    };
  let status;
  try {
    status = JSON.parse(text);
  } catch {
    status = null;
  }
  if (
    status?.enabled !== true ||
    !isTime(status.startedAt) ||
    !(status.lastSuccess === null || isTime(status.lastSuccess)) ||
    !(status.lastFailure === null || isTime(status.lastFailure))
  )
    return { healthy: false, reason: `the backup status in ${file} is not valid` };
  return healthOf(status, nowMs);
}

/**
 * The success to report after a restart: the remembered one; without a state
 * file (a volume from before it existed) the newest local daily dump, but only
 * when no upload was required for it to count.
 * @param {{ lastSuccess?: unknown } | null} state
 * @param {number | null} newestLocalMs
 * @param {boolean} uploads
 */
export function recoveredLastSuccess(state, newestLocalMs, uploads) {
  if (state && typeof state.lastSuccess === "number") return state.lastSuccess;
  return uploads ? null : newestLocalMs;
}

/** @returns {string[]} */
function localDailyNames() {
  try {
    return readdirSync(LOCAL_DIR).filter((name) => dumpDay(name) !== null);
  } catch {
    return [];
  }
}

/** Newest local daily dump (ms), or null. */
function newestLocalDaily() {
  const times = localDailyNames().flatMap((name) => {
    try {
      return [statSync(path.join(LOCAL_DIR, name)).mtimeMs];
    } catch {
      return [];
    }
  });
  return times.length ? Math.max(...times) : null;
}

/** @param {number} keep */
function prune(keep) {
  for (const name of dailyPrunePlan(localDailyNames(), keep)) {
    try {
      unlinkSync(path.join(LOCAL_DIR, name));
      log(`pruned old dump ${name}`);
    } catch (error) {
      log(`WARNING: could not prune ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** @returns {{ lastSuccess?: unknown, pending?: unknown } | null} */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** @param {{ lastSuccess: number | null, pending: string | null }} state */
function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // No writable backups volume (S3-only): nothing on disk to remember.
  }
}

/**
 * @param {{ enabled: boolean, startedAt: number, lastSuccess: number | null, lastFailure: number | null }} status
 * @param {string} [file]
 * @param {{ writeFileSync: typeof writeFileSync, renameSync: typeof renameSync, unlinkSync: typeof unlinkSync }} [io] the fs calls (a seam for tests)
 */
export function writeStatus(
  status,
  file = STATUS_FILE,
  io = { writeFileSync, renameSync, unlinkSync },
) {
  // Write then rename, so the healthcheck never reads a half-written file.
  const partial = `${file}.${process.pid}.tmp`;
  try {
    io.writeFileSync(partial, JSON.stringify(status));
    io.renameSync(partial, file);
  } catch (error) {
    try {
      io.unlinkSync(partial);
    } catch {
      // Nothing was written.
    }
    log(`WARNING: could not write ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

/** @param {string} sql @returns {string | null} null when the database cannot be asked */
function psql(sql) {
  try {
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PG"))),
      ...pgEnvFromUrl(process.env.DATABASE_URL),
      PGCONNECT_TIMEOUT: "10",
    };
    const result = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-c", sql], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

const advisoryHeld = (key) =>
  `EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND objsubid = 1 AND granted AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))`;

/** The migration facts for {@link migrationGate}, or null when unreachable. */
function migrationFacts() {
  const row = psql(
    `SELECT ${advisoryHeld(MIGRATION_RUNNER_LOCK_KEY)}, ${advisoryHeld(PRISMA_MIGRATE_LOCK_KEY)}, coalesce((SELECT format('%I.%I', n.nspname, c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '_prisma_migrations' AND c.relkind = 'r' ORDER BY n.nspname = 'public' DESC LIMIT 1), '')`,
  );
  if (row === null) return null;
  const [runner, prisma, table = ""] = row.split("\t");
  let unfinished = 0;
  if (table) {
    const count = psql(
      `SELECT count(*) FROM ${table} WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
    if (count === null) return null;
    unfinished = Number(count);
  }
  return {
    runnerHeld: runner === "t",
    prismaHeld: prisma === "t",
    hasHistory: !!table,
    unfinished,
  };
}

/**
 * Wait until no migration is running. A database that cannot be asked is
 * "ready": the dump itself then fails and reports why.
 * @returns {Promise<"ready" | "failed" | "new-install" | "busy">}
 */
async function waitForMigrations() {
  const deadline = Date.now() + MIGRATION_WAIT_MAX_MS;
  let said = false;
  for (;;) {
    const facts = migrationFacts();
    const gate = facts ? migrationGate(facts) : "ready";
    if (gate !== "busy" || Date.now() >= deadline) return gate;
    if (!said) log("a migration is running; waiting for it to finish before dumping.");
    said = true;
    await delay(MIGRATION_POLL_MS);
  }
}

/** @type {import("node:child_process").ChildProcess | null} */
let running = null;

/** @param {string} command @param {string[]} args @returns {Promise<{ code: number, stdout: string }>} */
function runChild(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    running = child;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", () => resolve({ code: 1, stdout }));
    child.on("close", (code) => {
      running = null;
      resolve({ code: code ?? 1, stdout });
    });
  });
}

async function runLoop() {
  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"]))
    process.once(signal, () => {
      running?.kill("SIGTERM");
      process.exit(0);
    });
  let config;
  try {
    config = scheduleConfig(process.env);
  } catch (error) {
    console.error(`[backup] FATAL: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  const status = {
    enabled: config.enabled,
    startedAt: Date.now(),
    lastSuccess: /** @type {number | null} */ (null),
    lastFailure: /** @type {number | null} */ (null),
  };
  writeStatus(status);
  if (!config.enabled) {
    log("scheduled backups are OFF. Set BACKUP_SCHEDULE=daily on this service to turn them on.");
    // Idle (a stopped service would be restarted by its restart policy).
    await new Promise(() => setInterval(() => {}, DAY_MS));
    return 0;
  }
  const uploads = Boolean(process.env.BACKUP_S3_BUCKET);
  log(
    `daily backups ON at ${String(config.hourUtc).padStart(2, "0")}:00 UTC, keeping one dump a day for ${config.keep} day(s) in ${LOCAL_DIR}${uploads ? " and uploading each to BACKUP_S3_BUCKET" : ""}.`,
  );
  const saved = readState();
  status.lastSuccess = recoveredLastSuccess(saved, newestLocalDaily(), uploads);
  /** @type {string | null} today's dump on disk whose upload failed */
  let pending =
    uploads && typeof saved?.pending === "string" && localDailyNames().includes(saved.pending)
      ? saved.pending
      : null;
  writeStatus(status);
  writeState({ lastSuccess: status.lastSuccess, pending });
  let nextAt =
    pending !== null || dueAtStart(status.lastSuccess, Date.now(), config.hourUtc)
      ? Date.now() + START_DELAY_MS
      : nextRunAt(Date.now(), config.hourUtc);
  for (;;) {
    const wait = nextAt - Date.now();
    if (wait > 0) {
      log(`next backup at ${new Date(nextAt).toISOString()}.`);
      await delay(wait);
    }
    const gate = await waitForMigrations();
    if (gate === "new-install") {
      log(
        "the database has no migrations applied yet (a new install); checking again in 10 minutes.",
      );
      nextAt = Date.now() + 10 * 60 * 1000;
      continue;
    }
    let ok = false;
    if (gate === "busy") {
      console.error(
        `[backup] a migration has been running for ${MIGRATION_WAIT_MAX_MS / 60_000} minutes; no backup was taken.`,
      );
    } else if (gate === "failed") {
      console.error(
        "[backup] a migration is recorded as unfinished (failed) and needs a person: see the Recovery runbook in docs/schema-migrations.md. No backup until it is resolved.",
      );
    } else if (nextAction(pending, Date.now()) === "upload" && pending !== null) {
      log(`uploading ${pending} again (it is already on disk and verified).`);
      const result = await runChild(process.execPath, [
        path.join(HERE, "s3.mjs"),
        "upload",
        path.join(LOCAL_DIR, pending),
      ]);
      ok = result.code === 0;
    } else {
      const result = await runChild("bash", [
        path.join(HERE, "pre-migrate.sh"),
        "--label",
        LABEL,
        "--required",
        "--keep",
        "0",
      ]);
      ok = result.code === 0;
      const written = /\[backup\] Verified (\S+)/.exec(result.stdout)?.[1];
      pending = result.code === EXIT_UPLOAD_FAILED && written ? path.basename(written) : null;
    }
    if (ok) {
      pending = null;
      status.lastSuccess = Date.now();
      nextAt = nextRunAt(Date.now(), config.hourUtc);
    } else {
      status.lastFailure = Date.now();
      console.error(
        "[backup] SCHEDULED BACKUP FAILED (see the lines above). Retrying in 1 hour; the healthcheck reports unhealthy until a backup succeeds.",
      );
      nextAt = Date.now() + HOUR_MS;
    }
    prune(config.keep);
    writeState({ lastSuccess: status.lastSuccess, pending });
    writeStatus(status);
  }
}

/**
 * The healthcheck's verdict from the status file on disk.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} nowMs
 * @param {string} [file]
 */
export function healthFromFile(env, nowMs, file = STATUS_FILE) {
  let text = null;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Missing or unreadable: healthFromStatus decides what that means.
  }
  return healthFromStatus(text, env, nowMs, file);
}

function health() {
  const verdict = healthFromFile(process.env, Date.now());
  console.log(verdict.reason);
  return verdict.healthy ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "run") process.exitCode = await runLoop();
  else if (command === "health") process.exitCode = health();
  else {
    console.error("usage: node schedule.mjs run|health");
    process.exitCode = 2;
  }
}
