/**
 * Legacy NULL rows that would make `prisma db push` fail (Prisma cannot make
 * a column required over NULLs). Safe mode refuses with a count; dangerous
 * mode (--accept-data-loss) deletes them.
 *
 * Authority per check:
 * - `cache_affinity_record."tenantUserId"` / `"bindingDigest"`: the same
 *   predicates schema-hardening.sql deletes after the push (its
 *   `"tenantUserId" IS NULL` and `"bindingDigest" IS NULL` DELETEs); running
 *   them first only moves that deletion ahead of the push.
 * - `cli_device_credential."cliDeviceId"`: hardening has no equivalent. This
 *   cleanup is the only authority. The rows are credentials `master` left
 *   unbound after a device delete (SET NULL); their CLIs must log in again.
 *
 * Runs under the caller's session limits: push-schema.mjs connects with
 * lock_timeout and statement_timeout and retries lock conflicts. `pg` is
 * imported only by the standalone entry below, so importing this module has
 * no dependency beyond the file itself.
 */
const CHECKS = [
  {
    table: "cache_affinity_record",
    column: "tenantUserId",
    dangerousDelete: `DELETE FROM cache_affinity_record WHERE "tenantUserId" IS NULL`,
  },
  {
    table: "cache_affinity_record",
    column: "bindingDigest",
    dangerousDelete: `DELETE FROM cache_affinity_record WHERE "bindingDigest" IS NULL`,
  },
  {
    table: "cli_device_credential",
    column: "cliDeviceId",
    dangerousDelete: `DELETE FROM cli_device_credential WHERE "cliDeviceId" IS NULL`,
  },
];

export async function runPrePushNullCleanup(client, { dangerous }) {
  for (const check of CHECKS) {
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
      check.table,
    ]);
    if (!exists.rows[0].present) continue;
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [check.table, check.column],
    );
    if (col.rowCount === 0) continue;
    const { rows } = await client.query(
      `SELECT count(*)::bigint AS count FROM ${check.table} WHERE "${check.column}" IS NULL`,
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count === 0) continue;
    if (!dangerous) {
      throw new Error(
        `pre-push-null-cleanup: ${check.table}."${check.column}" has ${count} NULL row(s). ` +
          `Re-run with APPLY_SCHEMA=dangerous (or db:push:dangerous) to delete incompatible legacy rows, ` +
          `or delete them manually before push.`,
      );
    }
    await client.query(check.dangerousDelete);
    process.stderr.write(
      `pre-push-null-cleanup: deleted ${count} legacy NULL row(s) from ${check.table}."${check.column}".\n`,
    );
  }
}

/**
 * Runs the cleanup on a fresh connection per attempt. `connectionString`
 * carries the session limits (push-schema.mjs adds lock_timeout and
 * statement_timeout), so no statement waits unboundedly; a lock timeout
 * (55P03) or deadlock (40P01) re-runs the whole idempotent cleanup after
 * `backoffFor(attempt)` ms, at most `maxAttempts` times. Any other error, a
 * statement timeout (57014) included, is thrown at once.
 */
export async function runPrePushNullCleanupBounded({
  connectionString,
  dangerous,
  maxAttempts,
  backoffFor,
  log = (line) => process.stderr.write(line),
}) {
  const { default: pg } = await import("pg");
  for (let attempt = 1; ; attempt += 1) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await runPrePushNullCleanup(client, { dangerous });
      return;
    } catch (error) {
      const code = error?.code;
      if ((code !== "55P03" && code !== "40P01") || attempt >= maxAttempts) throw error;
      const backoffMs = backoffFor(attempt);
      log(
        `Pre-push cleanup lock conflict (${code}); retrying attempt ${attempt + 1}/${maxAttempts} in ${backoffMs}ms.\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

const isMain =
  process.argv[1] && new URL(`file://${process.argv[1]}`).href === new URL(import.meta.url).href;

if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("pre-push-null-cleanup: DATABASE_URL is required\n");
    process.exit(1);
  }
  const dangerous = process.argv.includes("--dangerous");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await runPrePushNullCleanup(client, { dangerous });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  } finally {
    await client.end();
  }
}
