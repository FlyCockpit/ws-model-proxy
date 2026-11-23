#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
/**
 * Container migration runner (the app image).
 *
 *   node scripts/db/migrate-runtime.mjs apply   (default)
 *     The `migrate` image command and MIGRATE_ON_START=true. Classifies the
 *     database, refuses unsafe states, runs the optional pre-migration backup,
 *     then `prisma migrate deploy`. Exits 0 only when the DB is up to date.
 *
 *     Everything from the first classification to the final check runs while
 *     this process holds the migration runner lock (a session advisory lock,
 *     MIGRATION_RUNNER_LOCK_KEY), so two leaders (two containers both
 *     with MIGRATE_ON_START=true) never interleave: the second waits, then
 *     re-reads the state and normally finds it up to date. If the lock is
 *     still held after WAIT_TIMEOUT_MS it exits 1 and the platform restarts
 *     it, which is expected when the other leader's backup + deploy is longer.
 *
 *     After the database is up to date (also when nothing was pending) it
 *     records the image's migrations in `_wmp_migration`, registers this
 *     instance (WMP_INSTANCE_ID, set by the entrypoint), then runs the
 *     scheduled deletions phase: each folder's optional `contract.sql`, once
 *     no release that still uses what it deletes can be running
 *     (scripts/db/lib/contracts.mjs). That phase never fails the start: its
 *     errors are logged and the runner still exits 0.
 *
 *     A database with tables but no migration history (a released 0.4.3
 *     deployment, created by `prisma db push`) is adopted under the lock when
 *     its schema is exactly 0_init's: 0_init is recorded as applied and the
 *     one-time 0.4.3 → 1.0 migration follows. Any other schema is refused
 *     with the differences listed (scripts/db/lib/baseline.mjs).
 *
 *   node scripts/db/migrate-runtime.mjs wait
 *     Followers (MIGRATE_ON_START=false). Read-only except for registering
 *     this instance: waits up to a fixed 300 s for `up-to-date` (also while a
 *     database without history waits to be adopted); refuses a failed
 *     migration that no runner is working on.
 *
 *   --role server|worker names this instance in the registry (both modes).
 *
 *   node scripts/db/migrate-runtime.mjs hold [days]      (default 7, 1..90)
 *   node scripts/db/migrate-runtime.mjs hold --clear
 *     The `hold-deletions` image command (owner, one-shot). Pauses every
 *     scheduled deletion for `days` (the `owner` row in `_wmp_hold`; an
 *     existing later hold is never shortened), or removes that row. Takes
 *     the runner lock and creates the runner-owned tables if needed. Use it
 *     after a restore the runner cannot detect, before starting the app.
 *
 * Every pending migration must be safe for the release that is still
 * running. An in-place drop, rename or type change, unattested unreadable
 * SQL, or the retired `-- requires: maintenance-deploy` marker is refused
 * outright (no override) unless the database is brand new; the fix is the
 * expand/contract recipes in docs/schema-changes-recipe.md.
 *
 * db-ahead (this image is older than the database, a rollback): admitted
 * only when every migration the image lacks is recorded as rollback-safe and
 * its scheduled deletion has not run (`admit`); the instance then registers,
 * which pauses scheduled deletions while it runs. Otherwise refused.
 *
 * Auto-recovery applies only to files with the generator's intact wrapper
 * (`-- wmp:transactional`, BEGIN … commit marker, COMMIT). The commit
 * marker is the wrapper's last statement inside the transaction, so it shows
 * which side of COMMIT an interrupted attempt died on:
 *   - marker recorded → the transaction COMMITTED (e.g. the process was killed
 *     before Prisma recorded success): mark it applied
 *     (`prisma migrate resolve --applied`). It is never run a second time.
 *   - marker absent → PostgreSQL rolled the whole file back: mark it rolled
 *     back (`prisma migrate resolve --rolled-back`) and retry ONCE.
 * Anything else stops for a person: docs/schema-migrations.md § Recovery
 * runbook.
 *
 * An applied migration whose file changed since (checksum mismatch) is a
 * refusal in both modes: the running schema is not what the image describes.
 *
 * Release migrations (scripts/db/lib/replaces.mjs): a folder with a
 * `replaces.json` stands for the per-PR migrations it squashed. A database
 * that applied some or all of them (a test deployment that tracked the
 * default branch) is reconciled first, under the runner lock and in one
 * transaction: the missing ones run from `replaced/`, the release is recorded
 * as applied, the replaced rows are removed. A tampered `replaced/` copy, a
 * checksum mismatch, or an applied migration that is neither in the image nor
 * replaced is refused (both modes). Followers wait while the leader does it.
 *
 * Never prints DATABASE_URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BASELINE_GUIDE,
  BASELINE_MIGRATION,
  BASELINE_RELEASE,
  BASELINE_VARIANTS,
  BASELINES_DIR,
  compareBaseline,
  describeDifferences,
  upgradeAdmitted,
} from "./lib/baseline.mjs";
import {
  admit,
  applyContract,
  checkClusterIdentity,
  ensureRuntimeTables,
  holdUpsertSql,
  imageContains,
  lateRecoveries,
  nameReuseLive,
  planContracts,
  pruneInstances,
  readLiveCatalog,
  readPlanInputs,
  recordApplied,
  runtimeTablesExist,
  scheduleLines,
  validateContract,
} from "./lib/contracts.mjs";
import {
  MIGRATION_RUNNER_LOCK_KEY,
  pgConnectionString,
  prismaSchemaName,
  readMigrationState,
  readMigrationsFolder,
  safeError,
} from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, prisma, ROOT, SCHEMA_DIR } from "./lib/prisma.mjs";
import {
  applyReconcile,
  needsReconcile,
  planReconcile,
  READ_HISTORY_SQL,
  REPLACED_DIR,
  readReleases,
  remainingContract,
} from "./lib/replaces.mjs";
import {
  analyzeMigration,
  COMMIT_SENTINEL,
  catalogFromSql,
  checkWrapper,
  emptyCatalog,
  findNameReuse,
  markers,
  RETIRED_MAINTENANCE_MARKER,
  summarizeEffects,
  typeOfFromCatalog,
  unwrapBody,
} from "./lib/sql.mjs";

// Startup budget. scripts/check-docker-copy.ts parses every constant below
// (and REGISTER_TIMEOUT_MS / CONTRACT_PREAMBLE_TIMEOUT_MS from
// lib/contracts.mjs) and requires the images' HEALTHCHECK start-period to
// exceed their sum, so every timed step of a start is counted once.

/** Connection retries plus the runner lock wait (apply), or the follower wait (wait), from process start. */
export const WAIT_TIMEOUT_MS = 300_000;
/** The pre-deploy gate's catalog read (readLiveCatalog without defaults), all queries together. */
export const PREDEPLOY_CATALOG_TIMEOUT_MS = 10_000;
/**
 * Clock for the scheduled deletions phase, started after its backup. A
 * contract starts only with ≥ CONTRACT_START_MIN_MS (20 s) of it left, and
 * every contract statement ends by it; only the bookkeeping of the contract
 * running at the deadline (≤ CONTRACT_PREAMBLE_TIMEOUT_MS) runs past it.
 */
export const CONTRACT_RUN_BUDGET_MS = 30_000;
/**
 * The one-time adoption of a database without migration history
 * (adoptBaseline): 0_init applied and rolled back in a temporary schema, and
 * both catalogs read. Typically 1–3 s.
 */
export const BASELINE_COMPARE_TIMEOUT_MS = 30_000;
/** Child timeout of the image-schema diff (`prisma migrate diff --from-empty --to-schema`). */
export const IMAGE_SCHEMA_TIMEOUT_MS = 20_000;
/** The scheduled deletions phase's catalog read (readLiveCatalog with defaults), all queries together. */
export const CONTRACTS_CATALOG_TIMEOUT_MS = 5_000;
/**
 * Statement and lock timeout of the scheduled-deletion session's own steps
 * on the runner-owned tables (session defaults; transactions that need
 * another bound set their own).
 */
export const RUNTIME_STEP_TIMEOUT_MS = 2_000;
/**
 * Those steps per start, each counted as one lock wait (the runner-owned
 * tables are written only under the runner lock): record the applied
 * migrations, the identity check, the plan, the prune, the schedule log.
 * Registration has its own REGISTER_TIMEOUT_MS.
 */
// Read by scripts/check-docker-copy.ts to enforce the image startup budget.
export const RUNTIME_STEPS = 5;
/** 0.4.3 schema-sync lock: serialize old replicas with adoption and upgrade. */
const LEGACY_SCHEMA_SYNC_LOCK_KEY = 1145389648;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNBOOK = "docs/schema-migrations.md § Recovery runbook";
const NO_HISTORY = "docs/schema-migrations.md § A database with tables but no migration history";
const RUNNER_APP_NAME = "wmp-migrate-runner";
const TYPE_CHANGE_RECIPE = "docs/schema-changes-recipe.md § Recipe 5 — Backfill or change a type";

const log = (message) => console.log(`[migrate] ${message}`);
const warn = (message) => console.error(`[migrate] WARNING: ${message}`);
const loud = (lines) => {
  const bar = "!".repeat(72);
  console.error([bar, ...lines.map((line) => `[migrate] ${line}`), bar].join("\n"));
};

class Refusal extends Error {}

/**
 * @typedef {{ imageCatalog?: () => Promise<ReturnType<typeof emptyCatalog> | Error>,
 *   budgetMs?: number, now?: () => number }} ContractOptions
 *   Test seams for the scheduled deletions phase; `false` skips the phase.
 */

/**
 * @param {{ mode?: "apply" | "wait", role?: string, env?: NodeJS.ProcessEnv, migrationsDir?: string,
 *   pg?: typeof import("pg"), runPrisma?: typeof prisma, backupHook?: string,
 *   waitTimeoutMs?: number, pollMs?: number, connectRetryMs?: number,
 *   contracts?: ContractOptions | false,
 *   compareBaseline?: (client: import("pg").Client, init: { name: string, sql: string }) =>
 *     Promise<{ equal: boolean, missing: string[], unexpected: string[], liveCount: number }> }} [options]
 *   compareBaseline: test seam for adoptBaseline's catalog comparison.
 * @returns {Promise<number>} exit code
 */
export async function run(options = {}) {
  const mode = options.mode ?? "apply";
  const env = options.env ?? process.env;
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const pg = options.pg ?? loadPg();
  const runPrisma = options.runPrisma ?? prisma;
  const backupHook = options.backupHook ?? path.join(ROOT, "scripts/backup/pre-migrate.sh");
  const databaseUrl = env.DATABASE_URL;
  try {
    if (!databaseUrl) throw new Refusal("DATABASE_URL is not set.");
    if (env.BACKUP_ENABLED && !["true", "false"].includes(env.BACKUP_ENABLED))
      throw new Refusal("BACKUP_ENABLED must be true or false.");
    const role = options.role ?? "server";
    if (role !== "server" && role !== "worker")
      throw new Refusal(`--role must be "server" or "worker" (got "${role}").`);
    const instanceId = env.WMP_INSTANCE_ID || null;
    if (instanceId && !UUID.test(instanceId))
      throw new Refusal("WMP_INSTANCE_ID is not a UUID (the entrypoint sets it; leave it unset).");
    const manifests = readReleases(migrationsDir);
    if (manifests.problems.length)
      throw new Refusal(
        `this image's release manifests are not intact: ${manifests.problems.join("; ")}. ` +
          `A release folder's ${REPLACED_DIR}/ copies must match its replaces.json byte for byte; rebuild the image ` +
          "from the released commit (never edit a release folder by hand).",
      );
    const ctx = {
      env,
      databaseUrl,
      migrationsDir,
      releases: manifests.releases,
      pg,
      runPrisma,
      backupHook,
      schema: prismaSchemaName(databaseUrl),
      role,
      instanceId,
      host: hostname(),
      contracts: options.contracts ?? {},
      compareBaseline: options.compareBaseline,
      state: () => readMigrationState({ databaseUrl, migrationsDir, pg }),
    };
    if (mode === "wait") return await waitMode(ctx, options);
    if (mode !== "apply") throw new Refusal(`unknown mode "${mode}" (use apply or wait).`);
    return await applyMode(ctx, options);
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`[migrate] FATAL: ${error.message}`);
      return 1;
    }
    console.error(`[migrate] FATAL: ${safeError(error)}`);
    return 1;
  }
}

async function readyState(ctx, options, waitDeadline = Number.POSITIVE_INFINITY) {
  // The database may still be starting next to us (Dokploy compose). Retry
  // connection failures briefly; every other state is answered immediately.
  const deadline = Math.min(waitDeadline, Date.now() + (options.connectRetryMs ?? 60_000));
  for (;;) {
    const state = await ctx.state();
    if (state.state !== "unreachable" || Date.now() >= deadline) return state;
    warn(`database unreachable (${state.error}); retrying…`);
    await delay(options.pollMs ?? 3_000);
  }
}

function refuseUnreachable(state) {
  if (state.state === "unreachable") {
    throw new Refusal(
      `cannot reach the database (${state.error}). Check DATABASE_URL and the network. ${RUNBOOK}.`,
    );
  }
}

function refuseCommon(state) {
  refuseUnreachable(state);
  if (state.state === "no-history-nonempty") {
    throw new Refusal(
      "the database already has tables but no Prisma migration history (_prisma_migrations), so this " +
        "runner cannot tell what schema it holds. Check that DATABASE_URL names this app's database. " +
        `See ${NO_HISTORY}.`,
    );
  }
}

/**
 * BASELINE_VARIANTS with their SQL, read from the baselines directory next to
 * the migrations. A missing file only means that variant is never adopted.
 */
export function readBaselineVariants(migrationsDir) {
  return BASELINE_VARIANTS.flatMap(({ label, file }) => {
    const full = path.join(migrationsDir, "..", BASELINES_DIR, file);
    return existsSync(full) ? [{ label, file, sql: readFileSync(full, "utf8") }] : [];
  });
}

/**
 * no-history-nonempty under the runner lock: adopt a released 0.4.3 database,
 * or one of a 0.4.x build after it (BASELINE_VARIANTS; lib/baseline.mjs).
 * Only when its schema is exactly 0_init's (or 0_init's plus a variant's) is
 * 0_init recorded as applied; anything else is refused with the differences,
 * and nothing is changed.
 */
async function adoptBaseline(ctx, lock) {
  const init = readMigrationsFolder(ctx.migrationsDir).find((m) => m.name === BASELINE_MIGRATION);
  if (!init || !checkWrapper(init.sql).ok) refuseCommon({ state: "no-history-nonempty" });
  const variants = readBaselineVariants(ctx.migrationsDir);
  log(
    `the database has tables but no migration history: comparing its schema with ${BASELINE_MIGRATION} (the ${BASELINE_RELEASE} schema)…`,
  );
  let client;
  try {
    client = await openClient(ctx, RUNNER_APP_NAME);
  } catch (error) {
    throw new Refusal(`cannot reach the database (${safeError(error)}). ${RUNBOOK}.`);
  }
  let result;
  let timedOut = false;
  // Ending the session aborts the comparison; its transaction never commits.
  const timer = setTimeout(() => {
    timedOut = true;
    client.end().catch(() => {});
  }, BASELINE_COMPARE_TIMEOUT_MS);
  try {
    result = ctx.compareBaseline
      ? await ctx.compareBaseline(client, init, variants)
      : await compareBaseline(client, {
          schema: ctx.schema,
          body: unwrapBody(init.sql),
          scratchName: `_wmp_baseline_${randomBytes(8).toString("hex")}`,
          timeoutMs: BASELINE_COMPARE_TIMEOUT_MS,
          variants,
        });
  } catch (error) {
    const why = timedOut
      ? `it took longer than ${BASELINE_COMPARE_TIMEOUT_MS / 1000} s`
      : safeError(error);
    throw new Refusal(
      `could not compare the database with ${BASELINE_MIGRATION} (${why}); nothing was changed. ` +
        `The runner needs to create (and roll back) a temporary schema in this database for the comparison. See ${BASELINE_GUIDE}.`,
    );
  } finally {
    clearTimeout(timer);
    await client.end().catch(() => {});
  }
  if (!result.equal) {
    loud([
      `NOT ADOPTED: this database has tables but no migration history, and its schema is not the ${BASELINE_RELEASE} schema (${BASELINE_MIGRATION}).`,
      ...describeDifferences(result),
    ]);
    throw new Refusal(
      `the database's schema differs from ${BASELINE_MIGRATION} (${result.missing.length} missing, ${result.unexpected.length} unexpected; listed above), ` +
        "so it was not adopted and nothing was changed. If DATABASE_URL names another app's database, fix DATABASE_URL. " +
        `A ws-model-proxy database older than ${BASELINE_RELEASE}: start the ${BASELINE_RELEASE} image once with APPLY_SCHEMA=safe, then this image. ` +
        `A ${BASELINE_RELEASE} database that was changed by hand: undo those changes (or restore a backup) and start again. ` +
        (variants.length
          ? `It is not the schema of ${variants.map((v) => `the ${v.label}`).join(" or ")} either. `
          : "") +
        `See ${BASELINE_GUIDE}.`,
    );
  }
  lock.assertHeld(`recording ${BASELINE_MIGRATION} as applied`);
  const resolved = await ctx.runPrisma(["migrate", "resolve", "--applied", BASELINE_MIGRATION], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  if (resolved.code !== 0)
    throw new Refusal(
      `prisma migrate resolve --applied ${BASELINE_MIGRATION} failed (exit ${resolved.code}). ${RUNBOOK}.`,
    );
  const variant = result.variant && variants.find((v) => v.label === result.variant);
  log(
    variant
      ? `adopted a database of the ${variant.label}: its schema matches ${BASELINE_MIGRATION} plus ${BASELINES_DIR}/${variant.file} exactly (${result.liveCount} objects); ${BASELINE_MIGRATION} is now recorded as applied.`
      : `adopted a ${BASELINE_RELEASE} database: its schema matches ${BASELINE_MIGRATION} exactly (${result.liveCount} objects), which is now recorded as applied.`,
  );
}

/** db-ahead where admission does not apply (mid-run, or with pending/failed migrations). */
function refuseAhead(state, why = "") {
  if (state.state !== "db-ahead") return;
  throw new Refusal(
    `the database has applied migration(s) this image does not contain: ${state.ahead.join(", ")}. ` +
      `This image is older than the database (a rollback or stale deploy)${why}. Deploy the newer image, or ` +
      `restore/repair per ${RUNBOOK}. Refusing to start old code against a newer schema. (If they are ` +
      "per-PR migrations that a release squashed, and that release's replaced/ copies have since been removed, " +
      "deploy that release's image first.)",
  );
}

/** A dedicated session for the runner-owned tables. */
async function openClient(ctx, applicationName) {
  const client = new ctx.pg.Client({
    connectionString: pgConnectionString(ctx.databaseUrl),
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
  });
  // An idle client whose backend dies emits "error"; never crash on it.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

/** The image's schema level: its newest migration folder. */
function imageLevel(ctx) {
  return readMigrationsFolder(ctx.migrationsDir).at(-1)?.name ?? null;
}

/** The image's folders that carry a contract.sql (registered with the instance). */
function imageContracts(ctx) {
  return readMigrationsFolder(ctx.migrationsDir)
    .filter((m) => m.contract)
    .map((m) => m.name);
}

/**
 * The database is ahead of this image (a rollback). Admit it only when every
 * migration it lacks is rollback-safe and its scheduled deletion has not run;
 * an admitted instance with an id registers (one transaction, `admit`).
 */
async function admitOlderImage(ctx, state) {
  refuseMismatch(state);
  if (state.pending.length || state.failed.length)
    refuseAhead(state, ", and it also has migrations the database lacks (a diverged branch)");
  let client;
  try {
    client = await openClient(ctx, RUNNER_APP_NAME);
  } catch (error) {
    throw new Refusal(`cannot reach the database (${safeError(error)}). ${RUNBOOK}.`);
  }
  try {
    const result = await admit(client, {
      schema: ctx.schema,
      ahead: state.ahead,
      id: ctx.instanceId,
      role: ctx.role,
      level: imageLevel(ctx),
      host: ctx.host,
      contracts: imageContracts(ctx),
    });
    if (!result.admitted)
      refuseAhead(state, `, and it cannot run against it: ${result.reasons.join("; ")}`);
    if (ctx.instanceId)
      log(
        `older release running against a newer schema (rollback of ${state.ahead.join(", ")}); scheduled deletions are paused while it runs.`,
      );
    else
      log(
        `rollback admitted (${state.ahead.join(", ")} can be rolled back); replicas will register.`,
      );
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Register this instance (up-to-date database). Never fatal. */
async function registerSelf(ctx, client) {
  if (!ctx.instanceId) return;
  try {
    const result = await admit(client, {
      schema: ctx.schema,
      id: ctx.instanceId,
      role: ctx.role,
      level: imageLevel(ctx),
      host: ctx.host,
      contracts: imageContracts(ctx),
    });
    if (result.missingTables)
      warn(
        "the scheduled-deletion tables do not exist yet (no migrating runner has finished on this database); this instance is not registered.",
      );
  } catch (error) {
    warn(
      `could not register this instance (${safeError(error)}); scheduled deletions wait for it.`,
    );
  }
}

function refuseMismatch(state) {
  if (state.checksumMismatch.length) {
    throw new Refusal(
      `applied migration file(s) changed after they were applied: ${state.checksumMismatch.join(", ")}. ` +
        "Applied migrations are immutable, and the database was never migrated for these edits, so this " +
        "image describes a schema the database does not have. Restore the original file contents (from the " +
        "commit that first shipped them) and put any change in a NEW migration. A migration released or " +
        `deployed is never edited (docs/schema-migrations.md rule 1). ${RUNBOOK}.`,
    );
  }
}

/** Did this interrupted attempt commit? (the wrapper's commit marker) */
const committed = (failure) => failure.logs === COMMIT_SENTINEL;

/**
 * Take the migration runner lock on a dedicated session, polling
 * `pg_try_advisory_lock` until `deadline`. The lock lives as long as the
 * session: `release()` ends it, and so does this process dying, so a crashed
 * runner never leaves it behind.
 * @returns {Promise<{ client: import("pg").Client, assertHeld: (before: string) => void, release: () => Promise<void> }>}
 */
async function acquireRunnerLock(ctx, deadline, pollMs, timeoutMs) {
  const client = new ctx.pg.Client({
    connectionString: pgConnectionString(ctx.databaseUrl),
    connectionTimeoutMillis: 10_000,
    application_name: RUNNER_APP_NAME,
  });
  let releasing = false;
  let lost = false;
  const markLost = (why) => {
    if (releasing || lost) return;
    lost = true;
    warn(`the migration runner lock session ended (${why}); stopping before the next step.`);
  };
  // An idle client whose backend is terminated emits "error"; without a
  // listener that would crash the process mid-step.
  client.on("error", (error) => markLost(safeError(error)));
  client.on("end", () => markLost("connection closed"));
  const end = async () => {
    releasing = true;
    await client.end().catch(() => {});
  };
  try {
    await client.connect();
  } catch (error) {
    await end();
    throw new Refusal(
      `cannot open the migration runner lock session (${safeError(error)}). Check DATABASE_URL and the network. ${RUNBOOK}.`,
    );
  }
  const heldKeys = [];
  // Unlock explicitly even on timeout: a pooler's backend can outlive us.
  const unlockAndEnd = async () => {
    if (!lost) {
      for (const key of [...heldKeys].reverse()) {
        await client
          .query(`SELECT pg_advisory_unlock(${key})`)
          .catch((error) =>
            warn(`could not release migration lock ${key} explicitly (${safeError(error)}).`),
          );
      }
    }
    await end();
  };
  try {
    for (const key of [MIGRATION_RUNNER_LOCK_KEY, LEGACY_SCHEMA_SYNC_LOCK_KEY]) {
      let announced = false;
      for (;;) {
        const { rows } = await client.query(`SELECT pg_try_advisory_lock(${key}) AS acquired`);
        if (rows[0]?.acquired === true) {
          heldKeys.push(key);
          break;
        }
        if (lost)
          throw new Refusal(
            "lost the database connection while waiting for the migration runner lock.",
          );
        if (Date.now() >= deadline) {
          throw new Refusal(
            `another migration runner or 0.4.x schema-sync process still holds the migration lock ` +
              `after ${Math.round(timeoutMs / 1000)} s. Exiting so the platform restarts this ` +
              "container and checks again; this is expected when the other runner's pre-migration backup plus " +
              `migrate deploy takes longer than this timeout. If it repeats, find the session holding advisory lock ${key} ` +
              `(pg_locks; runner application_name ${RUNNER_APP_NAME}). ${RUNBOOK}.`,
          );
        }
        if (!announced) {
          log(
            `another migration runner is working on this database (its lock is held; key ${key}); waiting…`,
          );
          announced = true;
        }
        await delay(pollMs);
      }
    }
  } catch (error) {
    await unlockAndEnd();
    throw error;
  }
  return {
    // The release reconciliation runs its transaction on this session, so
    // losing the lock aborts it (reconcileReleases).
    client,
    assertHeld(before) {
      if (lost) {
        throw new Refusal(
          `lost the migration runner lock before ${before}; stopping without changing anything else. ` +
            `The next start retries. ${RUNBOOK}.`,
        );
      }
    },
    release: unlockAndEnd,
  };
}

async function applyMode(ctx, options) {
  const pollMs = options.pollMs ?? 3_000;
  const timeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  // One window from process start covers the connection retries and the
  // lock wait (the startup budget counts WAIT_TIMEOUT_MS once).
  const deadline = Date.now() + timeoutMs;
  // Connection retries first (the database may still be starting), and the
  // states that need no lock are refused (or admitted) before taking it.
  const initial = await readyState(ctx, options, deadline);
  // no-history-nonempty is decided under the lock (adoptBaseline).
  refuseUnreachable(initial);
  if (initial.state === "db-ahead" && !needsReconcile(initial, ctx.releases))
    return await admitOlderImage(ctx, initial);
  const lock = await acquireRunnerLock(ctx, deadline, pollMs, timeoutMs);
  try {
    return await applyLocked(ctx, lock, deadline, pollMs);
  } finally {
    await lock.release();
  }
}

/** applyMode's body; runs only while this process holds the runner lock. */
async function applyLocked(ctx, lock, deadline, pollMs) {
  // Re-read: another runner may have finished everything while we waited.
  let state = await ctx.state();
  if (state.state === "no-history-nonempty") {
    await adoptBaseline(ctx, lock);
    state = await ctx.state();
  }
  refuseCommon(state);
  /** @type {{ ran: boolean, label: string | null } | null} */
  let backup = null;
  if (needsReconcile(state, ctx.releases)) {
    refuseMismatch(state);
    backup = await reconcileReleases(ctx, lock, state);
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
  }
  if (state.state === "db-ahead") return await admitOlderImage(ctx, state);
  // Something other than a runner (an operator's `prisma migrate deploy`)
  // holds Prisma's lock and its migration is mid-flight: wait for it rather
  // than treat its row as a failure.
  let announcedForeignLock = false;
  while (state.state === "failed" && state.inProgress && Date.now() < deadline) {
    if (!announcedForeignLock) {
      log(
        `migration ${state.failed.map((f) => f.name).join(", ")} is being applied by another session; waiting…`,
      );
      announcedForeignLock = true;
    }
    await delay(pollMs);
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
  }
  if (state.state === "failed" && state.inProgress) {
    throw new Refusal(
      `migration ${state.failed.map((f) => f.name).join(", ")} is still being applied by another session ` +
        "(Prisma's migration lock is held); not touching it. The next start checks again. " +
        `If nothing should be migrating, find the session holding the lock (pg_locks). ${RUNBOOK}.`,
    );
  }
  refuseMismatch(state);
  if (state.state === "up-to-date") {
    log(`database is up to date (${state.applied.length} migration(s) applied).`);
    return await afterUpToDate(ctx, lock, { fresh: false, backup });
  }

  const byName = new Map(readMigrationsFolder(ctx.migrationsDir).map((m) => [m.name, m]));
  // Interrupted attempts that provably COMMITTED: record them as applied.
  // They already changed the database, so they are not "to apply" and do not
  // go through the breaking-change gate a second time.
  if (state.state === "failed") {
    for (const failure of state.failed.filter(committed)) {
      lock.assertHeld(`recording ${failure.name} as applied`);
      await markCommitted(ctx, failure, byName.get(failure.name));
    }
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
    refuseMismatch(state);
    if (state.state === "up-to-date") {
      log(`database is up to date (${state.applied.length} migration(s) applied).`);
      return await afterUpToDate(ctx, lock, { fresh: false, backup });
    }
  }
  /** @type {Array<{ name: string, logs: string | null }>} */
  let recoverable = [];
  if (state.state === "failed") {
    recoverable = state.failed.map((failure) => {
      if (committed(failure))
        throw new Refusal(`migration ${failure.name} is still unresolved. ${RUNBOOK}.`);
      assertRecoverable(failure, byName.get(failure.name));
      return failure;
    });
  }

  // Pre-deploy gates, before anything mutates the history (§1.14 step 3).
  const toApply = [...recoverable.map((f) => f.name), ...state.pending];
  // A failed manual 0_init attempt can leave history on a released schema.
  // No successful history alone does not prove that the database is empty.
  let freshDatabase = false;
  if (state.applied.length === 0 && toApply[0] === BASELINE_MIGRATION) {
    const client = await openClient(ctx, RUNNER_APP_NAME);
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_tables
          WHERE schemaname = $1 AND tablename <> '_prisma_migrations'
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_depend d
               WHERE d.classid = 'pg_catalog.pg_class'::regclass
                 AND d.objid = format('%I.%I', schemaname, tablename)::regclass
                 AND d.deptype = 'e'
            )`,
        [ctx.schema],
      );
      freshDatabase = rows[0].n === 0;
    } finally {
      await client.end().catch(() => {});
    }
  }
  warnOutOfOrder(state.applied, toApply);
  await preDeployGates(ctx, { toApply, freshDatabase, byName, appliedNames: state.applied });

  for (const failure of recoverable) {
    lock.assertHeld(`recovering ${failure.name}`);
    await recover(ctx, failure, byName.get(failure.name), "previous deploy");
  }

  log(`pending migration(s): ${toApply.join(", ")}`);
  if (!backup?.ran) {
    lock.assertHeld("the pre-migration backup");
    backup = await preMigrateBackup(ctx);
  }

  lock.assertHeld("migrate deploy");
  let attempt = await deploy(ctx);
  if (attempt !== 0) {
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
    // Our deploy has exited, so a held Prisma lock belongs to someone else
    // who may be applying this very migration: its row is not ours to resolve.
    if (state.inProgress) {
      throw new Refusal(
        `prisma migrate deploy failed (exit ${attempt}) while another session holds Prisma's migration lock; ` +
          `not touching the migration history. The next start checks again. ${RUNBOOK}.`,
      );
    }
    if (state.state !== "failed")
      throw new Refusal(`prisma migrate deploy failed (exit ${attempt}). ${RUNBOOK}.`);
    for (const failure of state.failed) {
      lock.assertHeld(`resolving ${failure.name}`);
      if (committed(failure)) {
        await markCommitted(ctx, failure, byName.get(failure.name));
        continue;
      }
      assertRecoverable(failure, byName.get(failure.name));
      // Never retry something that was already auto-recovered in this run.
      if (recoverable.some((r) => r.name === failure.name)) {
        await reportReplayError(ctx, byName.get(failure.name));
        throw new Refusal(
          `migration ${failure.name} failed again after one automatic retry. Stopping for a person: ${RUNBOOK}.`,
        );
      }
      await recover(ctx, failure, byName.get(failure.name), "this deploy");
      recoverable.push(failure);
    }
    lock.assertHeld("retrying migrate deploy");
    attempt = await deploy(ctx);
    if (attempt !== 0) {
      const after = await ctx.state();
      for (const failure of after.failed) {
        assertAttemptChecksum(failure, byName.get(failure.name));
        await reportReplayError(ctx, byName.get(failure.name));
      }
      throw new Refusal(
        `migration failed again after one automatic retry. Stopping for a person: ${RUNBOOK}.`,
      );
    }
  }

  const final = await ctx.state();
  // Another deployer outside the runner lock (an operator) may have applied
  // different bytes under the same name; Prisma would then skip ours.
  refuseMismatch(final);
  if (final.state !== "up-to-date") {
    throw new Refusal(
      `after migrate deploy the database is "${final.state}", not up to date. ${RUNBOOK}.`,
    );
  }
  log(`database is up to date (${final.applied.length} migration(s) applied).`);
  return await afterUpToDate(ctx, lock, { fresh: freshDatabase, backup });
}

/**
 * Reconcile replaced migrations onto their release (scripts/db/lib/replaces.mjs),
 * before anything else touches the history. Runs on the lock session, so
 * losing the lock aborts the transaction. Returns the pre-migration backup
 * when missing replaced migrations had to be applied (null otherwise).
 */
async function reconcileReleases(ctx, lock, state) {
  if (state.inProgress)
    throw new Refusal(
      "another session holds Prisma's migration lock (a `prisma migrate deploy` is running), so the release " +
        `reconciliation cannot start. The next start checks again. ${RUNBOOK}.`,
    );
  const { rows } = await lock.client.query(READ_HISTORY_SQL(ctx.schema));
  const plan = planReconcile({ rows, releases: ctx.releases, localNames: state.local });
  if (plan.refusals.length) throw new Refusal(plan.refusals.join(" "));
  let backup = null;
  const missing = plan.steps.flatMap((step) => step.missing);
  if (missing.length) {
    const byName = new Map(
      missing.map((e) => [
        e.name,
        {
          name: e.name,
          sql: e.sql ?? "",
          contract: e.contract ? { sql: e.contract, checksum: e.contractChecksum ?? "" } : null,
        },
      ]),
    );
    await preDeployGates(ctx, { toApply: [...byName.keys()], freshDatabase: false, byName });
    lock.assertHeld("the pre-migration backup");
    backup = await preMigrateBackup(ctx);
  }
  for (const step of plan.steps) {
    lock.assertHeld(`reconciling ${step.release.name}`);
    let result;
    try {
      result = await applyReconcile(lock.client, {
        schema: ctx.schema,
        step,
        releases: ctx.releases,
        localNames: state.local,
        log,
      });
    } catch (error) {
      throw new Refusal(
        `could not reconcile release ${step.release.name}: ${safeError(error)}. The transaction was rolled back; nothing changed. ${RUNBOOK}.`,
      );
    }
    const replaced = step.release.replaces.map((e) => e.name);
    log(
      result.applied.length
        ? `release ${step.release.name}: this database had ${step.present.length} of the ${replaced.length} migration(s) it replaces; applied the missing ${result.applied.join(", ")} from ${REPLACED_DIR}/, recorded ${step.release.name} as applied and removed the replaced rows (one transaction).`
        : `release ${step.release.name}: this database had all ${replaced.length} migration(s) it replaces; recorded ${step.release.name} as applied and removed the replaced rows. No schema SQL ran.`,
    );
    if (result.contracts === "all")
      log(
        `release ${step.release.name}: every replaced scheduled deletion already ran; its contract.sql is recorded as applied.`,
      );
    else if (result.contracts === "some")
      log(
        `release ${step.release.name}: some replaced scheduled deletions already ran; only the rest of its contract.sql will run.`,
      );
  }
  return backup;
}

/**
 * A pending folder that sorts before an applied one was merged out of order
 * (CI check 2 blocks this where branch rules are enforced). It is applied
 * normally; its scheduled deletion waits until no running instance's image
 * lacks it (the registry records each image's contract folders).
 */
function warnOutOfOrder(applied, toApply) {
  // Code-unit order, like Prisma's folder order.
  const newest = [...applied].sort().at(-1) ?? "";
  const early = toApply.filter((name) => name < newest);
  if (!early.length) return;
  loud([
    `OUT-OF-ORDER MIGRATION: ${early.join(", ")} sort${early.length === 1 ? "s" : ""} before the already-applied ${newest}.`,
    "It was merged after a newer migration (CI check 2, Ordering, should have blocked it). It is applied now;",
    "any scheduled deletion it carries waits until no running release lacks it. Next time run",
    "`pnpm db:migrate:rebase` on the branch before merging.",
  ]);
}

/** Columns per table, for analyzeMigration's `knownTables`. */
const knownTablesOf = (catalog) =>
  new Map([...catalog.tables].map(([key, table]) => [key, new Set(table.columns.keys())]));

/**
 * §1.14 step 3, over `toApply` (folder order):
 *   - breaking gate: a statement old code cannot run against (`incompatible`:
 *     an in-place drop, rename or type change, with column types from the
 *     live database folded through the earlier pending folders), SQL the
 *     analyzer cannot read that carries no `-- wmp:reviewed <reason>`
 *     (unannotated `notAnalyzed`, incl. unknown template versions), or the
 *     retired `-- requires: maintenance-deploy` marker → refused, no
 *     override, except on a fresh database (nothing can be running on it);
 *   - name reuse: a pending migration recreates something an earlier
 *     contract.sql deletes, while it still exists → refused, no override;
 *   - late recovery: a pending recover block whose source column is already
 *     deleted → a loud log, not a refusal.
 */
async function preDeployGates(ctx, { toApply, freshDatabase, byName, appliedNames }) {
  let live = null;
  /** @type {Array<{ name: string, contract_applied_at: Date | null, contract_backup: string | null }>} */
  let deletedRows = [];
  if (!freshDatabase) {
    const client = await openClient(ctx, RUNNER_APP_NAME);
    try {
      live = await readLiveCatalog(client, ctx.schema, {
        defaults: false,
        timeoutMs: PREDEPLOY_CATALOG_TIMEOUT_MS,
      });
      if (await runtimeTablesExist(client, ctx.schema))
        deletedRows = (
          await client.query(
            `SELECT name, contract_applied_at, contract_backup FROM ${client.escapeIdentifier(ctx.schema)}."_wmp_migration"
              WHERE contract_applied_at IS NOT NULL`,
          )
        ).rows;
    } finally {
      await client.end().catch(() => {});
    }
  }
  let catalog = live ?? emptyCatalog();
  const breaking = [];
  const upgrade = [];
  const analyses = [];
  for (const name of toApply) {
    const sql = byName.get(name)?.sql ?? "";
    const analysis = analyzeMigration(sql, {
      folder: name,
      typeOf: live ? typeOfFromCatalog(catalog) : undefined,
      knownTables: knownTablesOf(catalog),
    });
    analyses.push({ name, templates: analysis.templates });
    const why = [];
    if (analysis.markers.retiredMaintenance)
      why.push(`carries the retired marker "${RETIRED_MAINTENANCE_MARKER}"`);
    for (const item of analysis.incompatible) why.push(`line ${item.line} ${item.what}`);
    // SQL the tooling cannot read (DO, EXECUTE, dollar bodies, unknown
    // template versions…) counts as breaking unless its author attested it
    // with `-- wmp:reviewed <reason>`; CI check 5 fails the same lines.
    for (const item of analysis.notAnalyzed)
      if (item.reviewed === null) why.push(`line ${item.line} not analyzed: ${item.reason}`);
    if (why.length) {
      // The one-time 0.4.3 → 1.0 migration rewrites the released hardening in
      // place; it runs only right after 0_init (lib/baseline.mjs).
      if (upgradeAdmitted(name, appliedNames) || (freshDatabase && name === BASELINE_MIGRATION))
        upgrade.push(name);
      else breaking.push(`${name} (${why.join("; ")})`);
    }
    catalog = catalogFromSql(sql, catalog);
  }
  // A database with no applied migration has never had a schema any release
  // could run against, so no old code can be serving from it: a brand-new
  // environment applies its whole history in one ordinary deploy.
  if (breaking.length && freshDatabase) {
    log(
      `new database: applying in-place breaking migration(s) ${breaking.join(", ")} (no earlier release can be running against it).`,
    );
  } else if (breaking.length) {
    throw new Refusal(
      `pending migration(s) change the schema in place, which would break the release that is still running: ${breaking.join(", ")}. ` +
        "Nothing was applied, and there is no override (CI check 5 should have blocked this before merge). " +
        "Ship a corrected migration instead. " +
        "To delete a column or table: remove it from the schema and regenerate with `pnpm db:migrate`, which " +
        "schedules the deletion in contract.sql. To rename: keep the database name with @map / @@map. " +
        `To change a type: two PRs (${TYPE_CHANGE_RECIPE}). Unreadable SQL needs ` +
        "`-- wmp:reviewed <reason>` on the line above it, only when the running release is truly unaffected.",
    );
  }
  // A brand-new database has no 0.4.3 schema to upgrade: say so plainly.
  if (upgrade.length && freshDatabase)
    log(
      `new database: applying baseline migration(s) ${upgrade.join(", ")} (they carry the database hardening).`,
    );
  else if (upgrade.length)
    log(
      `applying the one-time baseline / 0.4.3 → 1.0 upgrade migration(s) ${upgrade.join(", ")} in place (they carry the database hardening; see ${BASELINE_GUIDE}).`,
    );

  const all = [...byName.values()];
  const reuse = nameReuseLive(findNameReuse(all), {
    toApply,
    fresh: freshDatabase,
    live,
    schema: ctx.schema,
  });
  if (reuse.length) {
    throw new Refusal(
      `pending migration(s) reuse a name that an earlier scheduled deletion removes: ${reuse
        .map((m) => `${m.folder} line ${m.line} (${m.key}, deleted by ${m.droppedBy})`)
        .join(", ")}. ` +
        "The old object may still hold data or be deleted later. Use a new physical name with @map / @@map " +
        "(docs/schema-changes-recipe.md). This cannot be overridden.",
    );
  }

  if (live) {
    const applied = deletedRows.map((row) => ({
      ...row,
      droppedColumns: summarizeEffects(byName.get(row.name)?.contract?.sql ?? "", {
        folder: row.name,
      }).droppedColumns,
    }));
    for (const late of lateRecoveries(analyses, { live, applied, schema: ctx.schema }))
      loud([
        `RECOVERY TOO LATE: ${late.column} was deleted${late.deletedAt ? ` on ${late.deletedAt}` : ""} (backup: ${late.backup ?? "none"}).`,
        `${late.folder} copies nothing. To get the data back, restore that backup (docs/backup-and-restore.md),`,
        "then redeploy within 7 days.",
      ]);
  }
}

/** The image's own Prisma schema as a catalog (7c-4). Errors are returned, not thrown. */
async function imageCatalog(ctx) {
  if (ctx.contracts.imageCatalog) return ctx.contracts.imageCatalog();
  try {
    const result = await ctx.runPrisma(
      ["migrate", "diff", "--from-empty", "--to-schema", SCHEMA_DIR, "--script"],
      { capture: true, env: { DATABASE_URL: ctx.databaseUrl }, timeoutMs: IMAGE_SCHEMA_TIMEOUT_MS },
    );
    if (result.timedOut)
      return new Error(`prisma migrate diff timed out after ${IMAGE_SCHEMA_TIMEOUT_MS / 1000} s`);
    if (result.code !== 0) return new Error(`prisma migrate diff exited ${result.code}`);
    return catalogFromSql(result.stdout ?? "");
  } catch (error) {
    return new Error(safeError(error));
  }
}

/**
 * Steps 5–8 of §1.14, on every successful apply (also when nothing was
 * pending): record, register, scheduled deletions, prune, schedule log.
 * Nothing here fails the start.
 * @param {{ fresh: boolean, backup: { ran: boolean, label: string | null } | null }} run
 */
async function afterUpToDate(ctx, lock, run) {
  let client;
  try {
    client = await openClient(ctx, "wmp-migrate-contracts");
  } catch (error) {
    warn(
      `could not open a session for scheduled deletions (${safeError(error)}); skipped this run.`,
    );
    return 0;
  }
  try {
    const migrations = readMigrationsFolder(ctx.migrationsDir);
    try {
      // Session defaults bound every runner-table step below (RUNTIME_STEPS);
      // transactions that need another bound set their own.
      await client.query(`SET statement_timeout = ${RUNTIME_STEP_TIMEOUT_MS}`);
      await client.query(`SET lock_timeout = ${RUNTIME_STEP_TIMEOUT_MS}`);
      lock.assertHeld("recording the applied migrations");
      await ensureRuntimeTables(client, ctx.schema);
      await recordApplied(client, { schema: ctx.schema, migrations });
    } catch (error) {
      warn(
        `could not record the applied migrations (${error instanceof Refusal ? error.message : safeError(error)}); scheduled deletions skipped this run, and an older image will be refused.`,
      );
      return 0;
    }
    await registerSelf(ctx, client);
    if (ctx.contracts === false) return 0;
    try {
      await contractsPhase(ctx, client, lock, migrations, run);
    } catch (error) {
      if (error instanceof Refusal) {
        warn(`${error.message}`);
        return 0;
      }
      warn(
        `scheduled deletions stopped (${safeError(error)}); the app starts normally and the next start tries again.`,
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** §1.14 step 7 (identity → plan → validate → backup → clock → apply) and step 8. */
async function contractsPhase(ctx, client, lock, migrations, run) {
  const schema = ctx.schema;
  const level = migrations.at(-1)?.name ?? "";
  const now = ctx.contracts.now ?? Date.now;
  lock.assertHeld("the database identity check");
  const identity = await checkClusterIdentity(client, { schema, fresh: run.fresh, log });
  if (identity.skipContracts) return;
  const withContract = migrations.filter((m) => m.contract);
  const plan = async () => {
    const inputs = await readPlanInputs(
      client,
      schema,
      withContract.map((m) => m.name),
    );
    const pending = withContract
      .filter((m) => !inputs.rows.get(m.name)?.contract_applied_at)
      .map((m) => ({ name: m.name, row: inputs.rows.get(m.name) }));
    return {
      inputs,
      plan: planContracts({ ...inputs, fresh: run.fresh, level, pending }),
    };
  };
  if (withContract.length) {
    const { inputs, plan: first } = await plan();
    if (first.due.length)
      await applyDue(ctx, client, lock, { migrations, run, level, now, inputs, due: first.due });
  }
  await pruneInstances(client, schema);
  if (withContract.length) {
    const { plan: after } = await plan();
    for (const line of scheduleLines(after)) log(`scheduled deletion ${line}`);
  }
}

async function applyDue(ctx, client, lock, { migrations, run, level, now, inputs, due }) {
  const schema = ctx.schema;
  // A reconciled release runs only the contract sections that did not run as
  // replaced migrations' contracts (scripts/db/lib/replaces.mjs).
  const byName = new Map(
    migrations.map((m) => [m.name, remainingContract(m, inputs.rows.get(m.name))]),
  );
  const live = await readLiveCatalog(client, schema, { timeoutMs: CONTRACTS_CATALOG_TIMEOUT_MS });
  const image = await imageCatalog(ctx);
  if (image instanceof Error) {
    warn(
      `could not read this image's schema (${image.message}); scheduled deletions skipped this run.`,
    );
    return;
  }
  const valid = [];
  for (const name of due) {
    const migration = byName.get(name);
    const check = validateContract({ migration, row: inputs.rows.get(name), live, image, schema });
    if (!check.ok) {
      loud([
        `SCHEDULED DELETION SKIPPED: ${check.finding}`,
        "It and every later scheduled deletion wait until a release fixes it. Nothing was deleted.",
      ]);
      break;
    }
    valid.push({ migration, analysis: check.analysis });
  }
  if (!valid.length) return;
  let backup = run.backup?.label ?? null;
  if (ctx.env.BACKUP_ENABLED === "true" && !run.fresh && !run.backup?.ran) {
    lock.assertHeld("the pre-drop backup");
    const result = await runBackupHook(ctx, ["--label", "pre-drop", "--keep", "5", "--required"]);
    if (result.missing) {
      loud([
        "BACKUP_ENABLED=true but this image has no backup hook; scheduled deletions skipped this run.",
      ]);
      return;
    }
    if (result.code !== 0) {
      loud([
        `the pre-drop backup failed (exit ${result.code}); scheduled deletions skipped this run.`,
        "BACKUP_ENABLED=true needs a working destination: mount a writable /backups volume and/or set BACKUP_S3_* " +
          "(docs/backup-and-restore.md).",
      ]);
      return;
    }
    backup = result.label;
  }
  const budget = ctx.contracts.budgetMs ?? CONTRACT_RUN_BUDGET_MS;
  const deadline = run.fresh ? Number.POSITIVE_INFINITY : now() + budget;
  for (const { migration, analysis } of valid) {
    const name = migration.name;
    const result = await applyContract(client, {
      schema,
      migration,
      analysis,
      level,
      deadline,
      backup,
      now,
      assertHeld: (before) => lock.assertHeld(before),
      replan: async (session) => {
        const fresh = await readPlanInputs(session, schema, [name]);
        return planContracts({
          ...fresh,
          fresh: run.fresh,
          level,
          pending: [{ name, row: fresh.rows.get(name) }],
          // This attempt is already counted; the limit was checked before it.
          ignoreAttempts: true,
        }).due.includes(name);
      },
    });
    if (result.status === "applied") {
      const released = inputs.instances
        .filter((i) => imageContains(i, name) && i.ready_at)
        .map((i) => new Date(i.ready_at).getTime());
      const row = inputs.rows.get(name);
      loud([
        `DATA DELETED: ${row?.contract_effects ?? name}${result.notes?.length ? `; ${result.notes.join("; ")}` : ""}`,
        `(retired by ${name}${released.length ? `, released ${new Date(Math.min(...released)).toISOString()}` : ""}; backup: ${backup ?? "none configured"})`,
      ]);
      continue;
    }
    if (result.status === "noop") continue;
    if (result.status === "not-started")
      log(`scheduled deletion of ${name} continues on the next start (time budget used).`);
    else if (result.status === "not-due")
      log(`scheduled deletion of ${name} is no longer due; nothing was deleted.`);
    else
      loud([
        `scheduled deletion of ${name} failed and was rolled back (${result.status}): ${result.error}`,
        result.status === "counted"
          ? "It counts as one of 3 tries for this release."
          : "The database was busy; this does not count as a try. The next start tries again.",
      ]);
    return;
  }
}

function assertAttemptChecksum(failure, migration) {
  if (!migration || !failure.checksum || failure.checksum !== migration.checksum) {
    throw new Refusal(
      `failed migration ${failure.name}: its attempt checksum is missing or differs from this image's file. ` +
        "Automatic replay or resolution is unsafe. Restore the exact file that ran, then inspect the database " +
        `before resolving the attempt manually: ${RUNBOOK}.`,
    );
  }
}

function assertRecoverable(failure, migration) {
  const { name } = failure;
  assertAttemptChecksum(failure, migration);
  if (!markers(migration.sql).transactional) {
    throw new Refusal(
      `migration ${name} failed and is not marked "-- wmp:transactional", so PostgreSQL may have kept ` +
        `part of it. A person must inspect the database and resolve it: ${RUNBOOK}.`,
    );
  }
  const wrapper = checkWrapper(migration.sql);
  if (!wrapper.ok) {
    throw new Refusal(
      `migration ${name} failed; it carries the transactional marker but its wrapper is not intact ` +
        `(${wrapper.reason}), so automatic recovery is unsafe. ${RUNBOOK}.`,
    );
  }
}

/**
 * The attempt's transaction committed but Prisma never recorded success (the
 * process died in between). Record it as applied so it is never re-run.
 */
async function markCommitted(ctx, failure, migration) {
  assertAttemptChecksum(failure, migration);
  loud([
    `RECOVERY: migration ${failure.name} was interrupted AFTER its transaction committed`,
    "(the process stopped before Prisma recorded success). Its commit marker proves the",
    "changes are in the database, so it is recorded as applied and NOT run again.",
  ]);
  const resolved = await ctx.runPrisma(["migrate", "resolve", "--applied", failure.name], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  if (resolved.code !== 0)
    throw new Refusal(`prisma migrate resolve --applied ${failure.name} failed.`);
}

async function recover(ctx, failure, migration, when) {
  const original = await reportReplayError(ctx, migration);
  loud([
    `AUTO-RECOVERY: migration ${failure.name} failed (${when}).`,
    `Original error: ${original ?? failure.logs ?? "unavailable"}`,
    "Its intact wrapper never recorded the commit marker, so PostgreSQL rolled it back completely.",
    `Marking it rolled back and retrying ONCE. A second failure stops for a person (${RUNBOOK}).`,
  ]);
  const resolved = await ctx.runPrisma(["migrate", "resolve", "--rolled-back", failure.name], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  if (resolved.code !== 0)
    throw new Refusal(`prisma migrate resolve --rolled-back ${failure.name} failed.`);
}

/**
 * Prisma loses the real error of a wrapped migration (it reports "current
 * transaction is aborted" and stores no logs), so replay the body inside a
 * transaction that is always rolled back and capture what PostgreSQL says.
 * Only called for files whose wrapper was verified intact.
 */
async function reportReplayError(ctx, migration) {
  if (!migration || !checkWrapper(migration.sql).ok) return null;
  const client = new ctx.pg.Client({ connectionString: pgConnectionString(ctx.databaseUrl) });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query(unwrapBody(migration.sql));
      return "(replay in a rolled-back transaction succeeded — the failure was transient, e.g. a lock timeout)";
    } catch (error) {
      const position =
        error && typeof error === "object" && "where" in error && error.where
          ? ` (${error.where})`
          : "";
      return `${safeError(error)}${position}`;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } catch (error) {
    return `could not replay to capture the error: ${safeError(error)}`;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run scripts/backup/pre-migrate.sh with `args`, teeing its output, and read
 * the dump's file name from its "Verified" line. The runner always passes
 * `--required` (it only calls the hook when BACKUP_ENABLED=true), so a missing
 * destination exits non-zero instead of warning.
 * @returns {Promise<{ missing: boolean, code: number, label: string | null }>}
 */
async function runBackupHook(ctx, args = []) {
  if (!existsSync(ctx.backupHook)) return { missing: true, code: 0, label: null };
  let stdout = "";
  const code = await new Promise((resolve) => {
    const child = spawn("bash", [ctx.backupHook, ...args], {
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
  const verified = /\[backup\] Verified (\S+)/.exec(stdout)?.[1];
  return { missing: false, code, label: verified ? path.basename(verified) : null };
}

/** @returns {Promise<{ ran: boolean, label: string | null }>} */
async function preMigrateBackup(ctx) {
  if (ctx.env.BACKUP_ENABLED !== "true") return { ran: false, label: null };
  if (!existsSync(ctx.backupHook)) {
    throw new Refusal(
      `BACKUP_ENABLED=true but the pre-migration backup hook ${path.relative(ROOT, ctx.backupHook)} is not in this image; refusing to migrate without a backup.`,
    );
  }
  log("running the pre-migration backup hook…");
  const { code, label } = await runBackupHook(ctx, ["--required"]);
  if (code !== 0) {
    throw new Refusal(
      `the pre-migration backup failed (exit ${code}); refusing to migrate without it. ` +
        "BACKUP_ENABLED=true needs a working destination: mount a writable /backups volume and/or set BACKUP_S3_*, " +
        "fix the failure above (docs/backup-and-restore.md), or set BACKUP_ENABLED=false deliberately.",
    );
  }
  return { ran: true, label };
}

async function deploy(ctx) {
  log("prisma migrate deploy…");
  const result = await ctx.runPrisma(["migrate", "deploy"], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  return result.code;
}

async function waitMode(ctx, options) {
  const timeout = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const poll = options.pollMs ?? 3_000;
  const deadline = Date.now() + timeout;
  let failedSince = null;
  let last = "";
  for (;;) {
    const state = await ctx.state();
    if (state.state === "up-to-date") {
      refuseMismatch(state);
      log("database is up to date; starting.");
      if (ctx.instanceId) {
        let client;
        try {
          client = await openClient(ctx, RUNNER_APP_NAME);
          await registerSelf(ctx, client);
        } catch (error) {
          warn(
            `could not register this instance (${safeError(error)}); scheduled deletions wait for it.`,
          );
        } finally {
          await client?.end().catch(() => {});
        }
      }
      return 0;
    }
    // Replaced migrations: the leader reconciles them onto their release.
    if (state.state === "db-ahead" && !needsReconcile(state, ctx.releases))
      return await admitOlderImage(ctx, state);
    // no-history-nonempty: the migrating service may be adopting it (adoptBaseline).
    // A runner holding its lock (or Prisma's) is still working on the
    // failure: between a failure and its one automatic retry, or waiting.
    if (state.state === "failed" && !state.inProgress && !state.runnerActive) {
      failedSince ??= Date.now();
      if (Date.now() - failedSince > Math.min(30_000, timeout)) {
        throw new Refusal(
          `migration ${state.failed.map((f) => f.name).join(", ")} is recorded as failed. Not starting. ${RUNBOOK}.`,
        );
      }
    } else failedSince = null;
    if (state.state !== last) {
      log(`waiting for migrations to be applied by the migrating service (state: ${state.state})…`);
      last = state.state;
    }
    if (Date.now() >= deadline) {
      throw new Refusal(
        `timed out after ${Math.round(timeout / 1000)} s waiting for the database to be up to date (state: ${state.state}). ` +
          "Is a migrating service (MIGRATE_ON_START=true, or the `migrate` job) running for this release?",
      );
    }
    await delay(poll);
  }
}

export const HOLD_DEFAULT_DAYS = 7;
export const HOLD_MAX_DAYS = 90;

/**
 * The `hold-deletions` image command: write (or with `clear`, remove) the
 * owner hold. Same row and `greatest` semantics as every other hold source.
 * @param {{ args?: string[], env?: NodeJS.ProcessEnv, pg?: typeof import("pg"),
 *   waitTimeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<number>} exit code
 */
export async function runHold(options = {}) {
  const env = options.env ?? process.env;
  const args = options.args ?? [];
  try {
    if (!env.DATABASE_URL) throw new Refusal("DATABASE_URL is not set.");
    const clear = args[0] === "--clear";
    let days = HOLD_DEFAULT_DAYS;
    if (!clear && args[0] !== undefined) {
      if (!/^\d+$/.test(args[0]) || Number(args[0]) < 1 || Number(args[0]) > HOLD_MAX_DAYS)
        throw new Refusal(
          `hold-deletions takes a whole number of days from 1 to ${HOLD_MAX_DAYS}, or --clear (got "${args[0]}").`,
        );
      days = Number(args[0]);
    }
    if (args.length > 1) throw new Refusal("hold-deletions takes one argument: [days] or --clear.");
    const ctx = {
      databaseUrl: env.DATABASE_URL,
      pg: options.pg ?? loadPg(),
      schema: prismaSchemaName(env.DATABASE_URL),
    };
    const timeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
    const lock = await acquireRunnerLock(
      ctx,
      Date.now() + timeoutMs,
      options.pollMs ?? 3_000,
      timeoutMs,
    );
    let client;
    try {
      client = await openClient(ctx, RUNNER_APP_NAME);
      const { rows } = await client.query(
        "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) IS NOT NULL AS present",
        [ctx.schema],
      );
      if (rows[0]?.present !== true)
        throw new Refusal(
          "this database has no migration history (_prisma_migrations), so there is nothing to hold. " +
            "Check that DATABASE_URL names this app's database.",
        );
      lock.assertHeld("writing the hold");
      if (clear) {
        const exists = await runtimeTablesExist(client, ctx.schema);
        const removed = exists
          ? (
              await client.query(
                `DELETE FROM ${client.escapeIdentifier(ctx.schema)}."_wmp_hold" WHERE reason = 'owner'`,
              )
            ).rowCount
          : 0;
        console.log(
          removed
            ? "[hold-deletions] Removed the owner hold. Scheduled deletions can run again (other holds, if any, still apply)."
            : "[hold-deletions] There was no owner hold; nothing changed.",
        );
        return 0;
      }
      await ensureRuntimeTables(client, ctx.schema);
      const result = await client.query(holdUpsertSql(ctx.schema), [
        "owner",
        days * 24 * 60 * 60 * 1000,
      ]);
      const until = new Date(result.rows[0].until).toISOString().replace(/\.\d{3}Z$/, "Z");
      console.log(
        `[hold-deletions] Scheduled deletions are paused until ${until} (owner hold, ${days} day${days === 1 ? "" : "s"}; a longer existing hold is kept). The app can run (or be started) as usual. Remove it early with \`hold-deletions --clear\`.`,
      );
      return 0;
    } finally {
      await client?.end().catch(() => {});
      await lock.release();
    }
  } catch (error) {
    console.error(
      `[hold-deletions] FATAL: ${error instanceof Refusal ? error.message : safeError(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "hold") process.exitCode = await runHold({ args: args.slice(1) });
  else {
    const roleAt = args.indexOf("--role");
    const role = roleAt >= 0 ? args.splice(roleAt, 2)[1] : undefined;
    const mode = /** @type {"apply" | "wait"} */ (args[0] ?? "apply");
    process.exitCode = await run({ mode, role });
  }
}
