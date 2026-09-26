/**
 * `prisma db push` with a short lock_timeout and bounded retry.
 *
 * Deploy-only exception to the DL-1 lock order. Schema hardening takes every
 * table it touches up front with NOWAIT (see apply-schema-hardening.mjs), but
 * Prisma issues its own DDL statement by statement and cannot lock up front.
 * Instead every statement Prisma runs gets `lock_timeout` (PUSH_LOCK_TIMEOUT),
 * so a push never queues behind live application work for long; a push that
 * hits the timeout (55P03) or is picked as a deadlock victim (40P01) is
 * re-run as a whole. `db push` is declarative, so re-running after a partial
 * apply converges on the same schema.
 *
 * Before the push, pre-push-null-cleanup.mjs checks (safe) or deletes
 * (--accept-data-loss) legacy NULL rows Prisma cannot make NOT NULL. It runs
 * under the same bounded-wait discipline: lock_timeout and statement_timeout
 * on its session, and a lock conflict (55P03) or deadlock (40P01) re-runs the
 * whole idempotent cleanup within the same attempt budget as the push; any
 * other failure (including a statement timeout) stops the deploy with the
 * error.
 *
 * Usage: node scripts/push-schema.mjs [--accept-data-loss]
 * The only accepted flag is --accept-data-loss; the caller decides it
 * (APPLY_SCHEMA=dangerous in docker-entrypoint.sh, db:push:dangerous locally).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Static import: a runtime image without the helper fails at load, in every
// mode (including the entrypoint test), instead of only on a real deploy.
import { runPrePushNullCleanupBounded } from "./pre-push-null-cleanup.mjs";

const PUSH_LOCK_TIMEOUT = "5000ms";
/** Upper bound for one cleanup statement (a count or a legacy-row DELETE). */
const CLEANUP_STATEMENT_TIMEOUT = "120000ms";
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

const flags = process.argv.slice(2);
const acceptDataLoss = flags.includes("--accept-data-loss");
for (const flag of flags) {
  if (flag !== "--accept-data-loss") {
    process.stderr.write(`push-schema: unsupported argument ${flag}\n`);
    process.exit(2);
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("push-schema: DATABASE_URL is required\n");
  process.exit(1);
}

/** Adds `-c lock_timeout=…` to the URL's libpq `options`, keeping existing options. */
function withLockTimeout(url, timeout = PUSH_LOCK_TIMEOUT, extra = "") {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  const setting = `-c lock_timeout=${timeout}${extra}`;
  parsed.searchParams.set("options", existing ? `${existing} ${setting}` : setting);
  // URLSearchParams writes spaces as "+"; spell them %20 so no URL parser can
  // read them as literal plus signs (a literal "+" is already %2B here).
  parsed.search = parsed.searchParams.toString().replace(/\+/g, "%20");
  return parsed.toString();
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const prismaBin = fileURLToPath(new URL("../node_modules/.bin/prisma", import.meta.url));

function runPush() {
  return new Promise((resolve, reject) => {
    const child = spawn(prismaBin, ["db", "push", ...flags], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: withLockTimeout(databaseUrl) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

function isLockConflict(output) {
  return /lock timeout|55P03|deadlock detected|40P01/i.test(output);
}

function backoffFor(attempt) {
  const cap = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}

if (!process.env.ENTRYPOINT_TEST_EVENTS) {
  try {
    await runPrePushNullCleanupBounded({
      connectionString: withLockTimeout(
        databaseUrl,
        PUSH_LOCK_TIMEOUT,
        ` -c statement_timeout=${CLEANUP_STATEMENT_TIMEOUT}`,
      ),
      dangerous: acceptDataLoss,
      maxAttempts: MAX_ATTEMPTS,
      backoffFor,
    });
  } catch (error) {
    process.stderr.write(
      `pre-push cleanup failed${error?.code ? ` (${error.code})` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}

for (let attempt = 1; ; attempt += 1) {
  const result = await runPush();
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.code === 0) process.exit(0);
  if (!isLockConflict(result.output) || attempt >= MAX_ATTEMPTS) process.exit(result.code);
  const backoffMs = backoffFor(attempt);
  process.stderr.write(
    `Schema push lock conflict; retrying attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${backoffMs}ms.\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, backoffMs));
}
