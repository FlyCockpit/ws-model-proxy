/**
 * Duplicate account-key preflight (MCP plan Phase 0b).
 *
 * Better Auth's account table enforces one row per (providerId, accountId).
 * Deployments that ran Better Auth 1.7.0–1.7.2 used a temporary `issuer` field
 * and could accumulate duplicates; this repo never ran those releases, so the
 * check is a pre-deploy guard, not a migration. It connects to DATABASE_URL,
 * reports duplicate (provider_id, account_id) rows in the account table, and
 * exits non-zero when any are found.
 *
 * Run: `pnpm preflight:accounts` (requires a reachable PostgreSQL database).
 */

import "@ws-model-proxy/env/load-dotenv";

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Fail fast on a missing/empty DATABASE_URL (same guard pattern as
// scripts/doctor.ts checkDatabase): without it, `pg` falls back to PG*/libpq
// defaults and could inspect an unintended database.
if (!process.env.DATABASE_URL) {
  console.error("preflight:accounts: DATABASE_URL is not set");
  console.error("Set DATABASE_URL in .env or run `pnpm setup`.");
  process.exit(1);
}

// Runs inside @ws-model-proxy/db so `pg` resolves without adding it to the
// root package.json (same pattern as scripts/doctor.ts).
const script = `
  import pg from "pg";
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT "providerId", "accountId", COUNT(*)::int AS rows FROM "account" GROUP BY "providerId", "accountId" HAVING COUNT(*) > 1 ORDER BY rows DESC, "providerId", "accountId"',
    );
    if (result.rowCount === 0) {
      console.log("preflight:accounts: no duplicate (providerId, accountId) rows.");
      await client.end();
      process.exit(0);
    }
    console.error("preflight:accounts: duplicate (providerId, accountId) rows found:");
    for (const row of result.rows) {
      console.error(\`  providerId=\${row.providerId} accountId=\${row.accountId} rows=\${row.rows}\`);
    }
    console.error("Resolve duplicates (keep exactly one row per key) before deploying Better Auth 1.7.");
    await client.end();
    process.exit(1);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
`;

const result = spawnSync(
  "pnpm",
  ["--silent", "-F", "@ws-model-proxy/db", "exec", "node", "--input-type=module", "-e", script],
  {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
if (output) console.log(output);
process.exit(result.status ?? 1);
