import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to apply schema hardening");
}

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const client = new pg.Client({ connectionString: databaseUrl });
const maxAttempts = 5;
const lockTimeoutMs = Number(process.env.SCHEMA_HARDENING_LOCK_TIMEOUT_MS ?? "5000");
if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 300_000) {
  throw new Error("SCHEMA_HARDENING_LOCK_TIMEOUT_MS must be an integer from 1 to 300000");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  await client.connect();
  await client.query("SELECT set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.query(sql);
      break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const retryable = error?.code === "40P01" || error?.code === "55P03";
      if (!retryable || attempt === maxAttempts) throw error;
      const backoffMs = 50 * 2 ** (attempt - 1);
      process.stderr.write(
        `Schema hardening lock conflict (${error.code}); retrying attempt ${attempt + 1}/${maxAttempts}.\n`,
      );
      await delay(backoffMs);
    }
  }
  process.stdout.write("Schema hardening and compatibility backfill complete.\n");
} finally {
  await client.end();
}
