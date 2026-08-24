import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const [packageJson, agentCompose, entrypoint, dangerousWrapper] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../../../docker-compose.agent.yml", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/docker-entrypoint.sh", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/db-push-dangerous-local.sh", import.meta.url), "utf8"),
]);
const requiredFragments = [
  "execution_target_kind_source_xor_check",
  "pg_get_constraintdef",
  'ON CONFLICT ("discoveredModelId") DO NOTHING',
  "enforce_execution_target_consumer_consistency",
  "UPDATE pool_member",
  "UPDATE model_api_token_allowlist_entry",
  "UPDATE response_stickiness_record",
  "UPDATE relay_request",
];
for (const fragment of requiredFragments) {
  if (!sql.includes(fragment)) throw new Error(`Missing schema-hardening fragment: ${fragment}`);
}
for (const [name, contents, fragment] of [
  ["package db:push", packageJson, "node scripts/apply-schema-hardening.mjs"],
  ["agent compose", agentCompose, "pnpm -F @ws-model-proxy/db db:push"],
  ["container entrypoint", entrypoint, "schema-hardening.sql"],
  ["dangerous local wrapper", dangerousWrapper, "apply-schema-hardening.mjs"],
]) {
  if (!contents.includes(fragment)) throw new Error(`${name} bypasses schema hardening`);
}

const baseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (!baseUrl) {
  process.stdout.write(
    "Schema-hardening source validation complete; PostgreSQL integration skipped (set SCHEMA_VALIDATION_DATABASE_URL).\n",
  );
  process.exit(0);
}

const schema = `schema_validation_${randomBytes(8).toString("hex")}`;
const prismaUrl = new URL(baseUrl);
prismaUrl.searchParams.set("schema", schema);
const admin = new pg.Client({ connectionString: baseUrl });
const client = new pg.Client({ connectionString: baseUrl });

async function expectConstraintFailure(statement) {
  try {
    await client.query(statement);
  } catch (error) {
    if (error?.code === "23514") return;
    throw error;
  }
  throw new Error("Expected PostgreSQL constraint failure");
}

try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  execFileSync("pnpm", ["exec", "prisma", "db", "push"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: prismaUrl.toString() },
    stdio: "pipe",
  });
  await client.connect();
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`
    INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug)
    VALUES ('owner-a', NOW(), NOW(), 'A', 'a@example.test', 'owner-a'),
           ('owner-b', NOW(), NOW(), 'B', 'b@example.test', 'owner-b');
    INSERT INTO cli_device (id, "createdAt", "updatedAt", "userId", slug, label)
    VALUES ('cli-a', NOW(), NOW(), 'owner-a', 'cli', 'CLI'),
           ('cli-b', NOW(), NOW(), 'owner-b', 'cli', 'CLI');
    INSERT INTO endpoint (id, "createdAt", "updatedAt", "userId", "cliDeviceId", slug, label)
    VALUES ('endpoint-a', NOW(), NOW(), 'owner-a', 'cli-a', 'local', 'Local'),
           ('endpoint-b', NOW(), NOW(), 'owner-b', 'cli-b', 'local', 'Local');
    INSERT INTO discovered_model
      (id, "createdAt", "updatedAt", "userId", "endpointId", "upstreamModelId", "encodedModelId")
    VALUES ('model-a', NOW(), NOW(), 'owner-a', 'endpoint-a', 'a', 'owner-a/cli/local/a'),
           ('model-b', NOW(), NOW(), 'owner-b', 'endpoint-b', 'b', 'owner-b/cli/local/b');
    INSERT INTO relay_request
      (id, "createdAt", "updatedAt", "userId", "requestedDiscoveredModelId", status, "startedAt")
    VALUES ('old-relay', NOW(), NOW(), 'owner-a', 'model-a', 'PENDING', NOW());
  `);

  await client.query(sql);
  await client.query(sql);
  const constraint = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'execution_target'::regclass
       AND conname = 'execution_target_kind_source_xor_check'
  `);
  if (constraint.rowCount !== 1 || !constraint.rows[0].definition.includes("CHECK")) {
    throw new Error("Named execution-target XOR constraint was not installed");
  }
  const backfill = await client.query(`
    SELECT (SELECT COUNT(*)::int FROM execution_target
             WHERE "discoveredModelId" IN ('model-a', 'model-b')) AS targets,
           (SELECT COUNT(*)::int FROM relay_request
             WHERE id = 'old-relay' AND "requestedExecutionTargetId" IS NOT NULL) AS relays
  `);
  if (backfill.rows[0].targets !== 2 || backfill.rows[0].relays !== 1) {
    throw new Error("Backfill was not idempotent or did not preserve old rows");
  }
  await expectConstraintFailure(`
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "discoveredModelId")
    VALUES ('invalid-xor', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL', 'model-a')
  `);
  await expectConstraintFailure(`
    INSERT INTO relay_request
      (id, "createdAt", "updatedAt", "userId", "requestedDiscoveredModelId",
       "requestedExecutionTargetId", status, "startedAt")
    SELECT 'cross-owner', NOW(), NOW(), 'owner-a', 'model-b', id, 'PENDING', NOW()
      FROM execution_target WHERE "discoveredModelId" = 'model-b'
  `);
  await expectConstraintFailure(`
    UPDATE relay_request SET "requestedDiscoveredModelId" = 'model-b' WHERE id = 'old-relay'
  `);
  await client.query(`
    INSERT INTO model_pool (id, "createdAt", "updatedAt", "userId", slug, name)
    VALUES ('pool-a', NOW(), NOW(), 'owner-a', 'pool', 'Pool')
  `);
  await expectConstraintFailure(`
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "discoveredModelId", "executionTargetId")
    SELECT 'cross-owner-member', NOW(), NOW(), 'pool-a', 'model-b', id
      FROM execution_target WHERE "discoveredModelId" = 'model-b'
  `);
  process.stdout.write("Schema-hardening PostgreSQL integration validation complete.\n");
} finally {
  await client.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
