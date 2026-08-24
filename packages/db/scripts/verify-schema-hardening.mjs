import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const [sql, forwarderSchema] = await Promise.all([
  readFile(sqlPath, "utf8"),
  readFile(new URL("../prisma/schema/forwarder.prisma", import.meta.url), "utf8"),
]);
const [packageJson, agentCompose, entrypoint, dangerousWrapper, applyScript] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../../../docker-compose.agent.yml", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/docker-entrypoint.sh", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/db-push-dangerous-local.sh", import.meta.url), "utf8"),
  readFile(new URL("./apply-schema-hardening.mjs", import.meta.url), "utf8"),
]);
const requiredFragments = [
  "model_pool_recommended_surface_override_check",
  'UPDATE model_pool\n   SET "recommendedSurfaceOverride" = NULL',
  "execution_target_kind_source_xor_check",
  "inference_capacity_limits_check",
  "execution_target_capacity_policy_check",
  "model_pool_capacity_policy_check",
  "pool_member_capacity_policy_check",
  "admission_request_shape_check",
  "capacity_waiter_shape_check",
  "capacity_lease_shape_check",
  "capacity_waiter_one_admitted_winner",
  "capacity_waiter_unique_direct_candidate",
  "capacity_lease_one_live_attempt",
  "enforce_capacity_reference_consistency",
  "create_execution_target_capacity",
  "execution-target:' || target.id",
  "pg_get_constraintdef",
  'ON CONFLICT ("discoveredModelId") DO NOTHING',
  "enforce_execution_target_consumer_consistency",
  "enforce_execution_target_identity_immutable",
  "canonicalize_execution_target_consumer",
  "create_discovered_model_execution_target",
  "execution-target hardening found duplicate pool members",
  "UPDATE pool_member",
  "UPDATE model_api_token_allowlist_entry",
  "UPDATE response_stickiness_record",
  "UPDATE relay_request",
];
for (const fragment of requiredFragments) {
  if (!sql.includes(fragment)) throw new Error(`Missing schema-hardening fragment: ${fragment}`);
}
for (const fragment of [
  "model InferenceCapacity",
  "runtimeIdentityKey",
  "schedulerDeficits",
  "nextFencingToken",
  "model AdmissionRequest",
  "model CapacityWaiter",
  "model CapacityLease",
  "directPriority",
  "capacityPriority",
]) {
  if (!forwarderSchema.includes(fragment))
    throw new Error(`Missing capacity schema fragment: ${fragment}`);
}
for (const fragment of ['error?.code === "40P01"', 'error?.code === "55P03"', "maxAttempts"]) {
  if (!applyScript.includes(fragment))
    throw new Error(`Missing schema retry fragment: ${fragment}`);
}
for (const [name, contents, fragment] of [
  ["package db:push", packageJson, "node scripts/apply-schema-hardening.mjs"],
  ["agent compose", agentCompose, "pnpm -F @ws-model-proxy/db db:push"],
  ["container entrypoint", entrypoint, "apply-schema-hardening.mjs"],
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
const oldWriter = new pg.Client({ connectionString: baseUrl });
const hardeningClient = new pg.Client({ connectionString: baseUrl });

async function expectConstraintFailure(statement, expectedCode = "23514") {
  try {
    await client.query(statement);
  } catch (error) {
    if (error?.code === expectedCode) return;
    throw error;
  }
  throw new Error("Expected PostgreSQL constraint failure");
}

function runHardeningProcess(databaseUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ["scripts/apply-schema-hardening.mjs"], {
    cwd: packageRoot,
    env: { ...process.env, ...extraEnv, DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    output: () => ({ stdout, stderr }),
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
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
    INSERT INTO model_pool (
      id, "createdAt", "updatedAt", "userId", slug, name, "recommendedSurfaceOverride"
    ) VALUES (
      'conflict-pool', NOW(), NOW(), 'owner-a', 'conflict', 'Conflict', 'INVALID_SURFACE'
    );
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "discoveredModelId")
    VALUES ('preexisting-target-a', NOW(), NOW(), 'owner-a', 'DISCOVERED_MODEL', 'model-a');
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "discoveredModelId", weight)
    VALUES ('conflict-legacy-row', NOW(), NOW(), 'conflict-pool', 'model-a', 3);
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId", weight)
    VALUES ('conflict-target-row', NOW(), NOW(), 'conflict-pool', 'preexisting-target-a', 9);
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('conflict-token', NOW(), NOW(), 'owner-a', 'Conflict Token',
      'conflict-prefix', 'conflict-digest');
    INSERT INTO model_api_token_allowlist_entry
      (id, "createdAt", "updatedAt", "modelApiTokenId", target, "discoveredModelId")
    VALUES ('conflict-legacy-access', NOW(), NOW(), 'conflict-token', 'DIRECT_MODEL', 'model-a');
    INSERT INTO model_api_token_allowlist_entry
      (id, "createdAt", "updatedAt", "modelApiTokenId", target, "executionTargetId")
    VALUES ('conflict-target-access', NOW(), NOW(), 'conflict-token', 'DIRECT_MODEL',
      'preexisting-target-a');
  `);

  try {
    await client.query(sql);
    throw new Error("Expected duplicate compatibility rows to abort hardening");
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      error?.code !== "23505" ||
      !error?.message?.includes("duplicate pool members") ||
      !error?.detail?.includes("conflict-legacy-row") ||
      !error?.detail?.includes("conflict-target-row")
    ) {
      throw error;
    }
  }
  const preservedConflicts = await client.query(`
    SELECT id, weight FROM pool_member
     WHERE id IN ('conflict-legacy-row', 'conflict-target-row') ORDER BY id
  `);
  if (
    preservedConflicts.rowCount !== 2 ||
    preservedConflicts.rows[0].weight !== 3 ||
    preservedConflicts.rows[1].weight !== 9
  ) {
    throw new Error("Failed hardening modified or merged conflicting configured rows");
  }
  // Simulate the operator choosing the target-backed configuration after
  // inspecting the diagnostic. The hardening script itself must not choose.
  await client.query(`DELETE FROM pool_member WHERE id = 'conflict-legacy-row'`);

  try {
    await client.query(sql);
    throw new Error("Expected duplicate allowlist rows to abort hardening");
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      error?.code !== "23505" ||
      !error?.message?.includes("duplicate token allowlist entries") ||
      !error?.detail?.includes("conflict-legacy-access") ||
      !error?.detail?.includes("conflict-target-access")
    ) {
      throw error;
    }
  }
  const preservedAllowlistConflicts = await client.query(`
    SELECT id FROM model_api_token_allowlist_entry
     WHERE id IN ('conflict-legacy-access', 'conflict-target-access')
  `);
  if (preservedAllowlistConflicts.rowCount !== 2) {
    throw new Error("Failed hardening deleted or merged conflicting allowlist rows");
  }
  await client.query(`
    DELETE FROM model_api_token_allowlist_entry WHERE id = 'conflict-legacy-access';
    INSERT INTO model_pool (id, "createdAt", "updatedAt", "userId", slug, name)
    VALUES ('invalid-pool', NOW(), NOW(), 'owner-b', 'invalid', 'Invalid');
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "discoveredModelId", "executionTargetId")
    VALUES ('invalid-preexisting-member', NOW(), NOW(), 'invalid-pool', 'model-b',
      'preexisting-target-a');
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('invalid-token', NOW(), NOW(), 'owner-b', 'Invalid Token',
      'invalid-prefix', 'invalid-digest');
    INSERT INTO model_api_token_allowlist_entry
      (id, "createdAt", "updatedAt", "modelApiTokenId", target,
       "discoveredModelId", "executionTargetId")
    VALUES ('invalid-preexisting-access', NOW(), NOW(), 'invalid-token', 'DIRECT_MODEL',
      'model-b', 'preexisting-target-a');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "targetDiscoveredModelId", "targetExecutionTargetId",
       "selectedDiscoveredModelId", "selectedExecutionTargetId")
    VALUES ('invalid-preexisting-stickiness', NOW(), NOW(), 'owner-b', 'invalid',
      'model-b', 'preexisting-target-a', 'model-b', 'preexisting-target-a');
    INSERT INTO relay_request
      (id, "createdAt", "updatedAt", "userId", "requestedDiscoveredModelId",
       "requestedExecutionTargetId", "selectedDiscoveredModelId",
       "selectedExecutionTargetId", status, "startedAt")
    VALUES ('invalid-preexisting-relay', NOW(), NOW(), 'owner-b', 'model-b',
      'preexisting-target-a', 'model-b', 'preexisting-target-a', 'PENDING', NOW());
  `);

  try {
    await client.query(sql);
    throw new Error("Expected invalid pre-existing consumer reference to abort hardening");
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      error?.code !== "23514" ||
      !error?.message?.includes("invalid pre-existing consumer references") ||
      ![
        "invalid-preexisting-member",
        "invalid-preexisting-access",
        "invalid-preexisting-stickiness",
        "invalid-preexisting-relay",
      ].every((id) => error?.detail?.includes(id))
    ) {
      throw error;
    }
  }
  const preservedInvalid = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pool_member WHERE id = 'invalid-preexisting-member') AS members,
      (SELECT COUNT(*)::int FROM model_api_token_allowlist_entry
        WHERE id = 'invalid-preexisting-access') AS allowlist,
      (SELECT COUNT(*)::int FROM response_stickiness_record
        WHERE id = 'invalid-preexisting-stickiness') AS stickiness,
      (SELECT COUNT(*)::int FROM relay_request
        WHERE id = 'invalid-preexisting-relay'
          AND "requestedDiscoveredModelId" = 'model-b'
          AND "requestedExecutionTargetId" = 'preexisting-target-a') AS relays
  `);
  if (
    preservedInvalid.rows[0].members !== 1 ||
    preservedInvalid.rows[0].allowlist !== 1 ||
    preservedInvalid.rows[0].stickiness !== 1 ||
    preservedInvalid.rows[0].relays !== 1
  ) {
    throw new Error("Failed hardening modified invalid pre-existing consumer rows");
  }
  await client.query(`
    DELETE FROM pool_member WHERE id = 'invalid-preexisting-member';
    DELETE FROM model_api_token_allowlist_entry WHERE id = 'invalid-preexisting-access';
    DELETE FROM response_stickiness_record WHERE id = 'invalid-preexisting-stickiness';
    DELETE FROM relay_request WHERE id = 'invalid-preexisting-relay';
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
  const surfaceConstraint = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'model_pool'::regclass
       AND conname = 'model_pool_recommended_surface_override_check'
  `);
  const normalizedSurface = await client.query(`
    SELECT "recommendedSurfaceOverride" FROM model_pool WHERE id = 'conflict-pool'
  `);
  if (
    surfaceConstraint.rowCount !== 1 ||
    !surfaceConstraint.rows[0].definition.includes("CHECK") ||
    normalizedSurface.rows[0]?.recommendedSurfaceOverride !== null
  ) {
    throw new Error("Recommended surface constraint or compatibility backfill is missing");
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
  const reverseBackfill = await client.query(`
    SELECT "discoveredModelId" FROM pool_member WHERE id = 'conflict-target-row'
  `);
  if (reverseBackfill.rows[0].discoveredModelId !== "model-a") {
    throw new Error("Target-only pre-hardening row was not reverse-backfilled");
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
  await expectConstraintFailure(`
    UPDATE execution_target SET "discoveredModelId" = 'model-b'
     WHERE "discoveredModelId" = 'model-a'
  `);
  await expectConstraintFailure(`
    UPDATE execution_target SET "userId" = 'owner-b'
     WHERE "discoveredModelId" = 'model-a'
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
  await client.query(`
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId")
    SELECT 'new-only-member', NOW(), NOW(), 'pool-a', id
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
  `);
  const poolCompatibility = await client.query(`
    SELECT "discoveredModelId" FROM pool_member WHERE id = 'new-only-member'
  `);
  if (poolCompatibility.rows[0].discoveredModelId !== "model-a") {
    throw new Error("Target-only pool write did not populate its legacy model FK");
  }
  await expectConstraintFailure(
    `
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId")
    SELECT 'duplicate-new-only-member', NOW(), NOW(), 'pool-a', id
      FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `,
    "23505",
  );
  await expectConstraintFailure(
    `
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "discoveredModelId")
    VALUES ('duplicate-legacy-member', NOW(), NOW(), 'pool-a', 'model-a')
  `,
    "23505",
  );
  await client.query(`
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('token-a', NOW(), NOW(), 'owner-a', 'Token', 'prefix-a', 'digest-a');
    INSERT INTO model_api_token_allowlist_entry
      (id, "createdAt", "updatedAt", "modelApiTokenId", target, "executionTargetId")
    SELECT 'target-only-access', NOW(), NOW(), 'token-a', 'DIRECT_MODEL', id
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
  `);
  const allowlistCompatibility = await client.query(`
    SELECT "discoveredModelId" FROM model_api_token_allowlist_entry
     WHERE id = 'target-only-access'
  `);
  if (allowlistCompatibility.rows[0].discoveredModelId !== "model-a") {
    throw new Error("Target-only allowlist write did not populate its legacy model FK");
  }
  await expectConstraintFailure(
    `
    INSERT INTO model_api_token_allowlist_entry
      (id, "createdAt", "updatedAt", "modelApiTokenId", target, "discoveredModelId")
    VALUES ('duplicate-legacy-access', NOW(), NOW(), 'token-a', 'DIRECT_MODEL', 'model-a')
  `,
    "23505",
  );
  await expectConstraintFailure(`
    INSERT INTO pool_member (id, "createdAt", "updatedAt", "poolId")
    VALUES ('empty-member', NOW(), NOW(), 'pool-a')
  `);
  await client.query(`
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "selectedExecutionTargetId")
    SELECT 'new-only-stickiness', NOW(), NOW(), 'owner-a', 'new-only', id
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "selectedDiscoveredModelId")
    VALUES ('legacy-only-stickiness', NOW(), NOW(), 'owner-a', 'legacy-only', 'model-a');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "selectedDiscoveredModelId", "selectedExecutionTargetId")
    SELECT 'dual-stickiness', NOW(), NOW(), 'owner-a', 'dual', 'model-a', id
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
    INSERT INTO relay_request
      (id, "createdAt", "updatedAt", "userId", "requestedExecutionTargetId", status, "startedAt")
    SELECT 'new-only-relay', NOW(), NOW(), 'owner-a', id, 'PENDING', NOW()
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
  `);
  const stickinessCompatibility = await client.query(`
    SELECT "selectedDiscoveredModelId" FROM response_stickiness_record
     WHERE id = 'new-only-stickiness'
  `);
  if (stickinessCompatibility.rows[0].selectedDiscoveredModelId !== "model-a") {
    throw new Error("Target-only stickiness write did not populate its legacy model FK");
  }
  const relayCompatibility = await client.query(`
    SELECT "requestedDiscoveredModelId" FROM relay_request WHERE id = 'new-only-relay'
  `);
  if (relayCompatibility.rows[0].requestedDiscoveredModelId !== "model-a") {
    throw new Error("Target-only relay write did not populate its legacy model FK");
  }

  await client.query(`
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl", "authType")
    VALUES ('provider-account-a', NOW(), NOW(), 'owner-a', 'test', 'Test',
      'https://provider.invalid', 'BEARER');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('provider-model-a', NOW(), NOW(), 'owner-a', 'provider-account-a', 'provider-model');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('provider-target-a', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL', 'provider-model-a');
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId")
    VALUES ('provider-member', NOW(), NOW(), 'pool-a', 'provider-target-a');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "targetExecutionTargetId", "selectedExecutionTargetId")
    VALUES ('provider-stickiness', NOW(), NOW(), 'owner-a', 'provider',
      'provider-target-a', 'provider-target-a');
    INSERT INTO relay_request
      (id, "createdAt", "updatedAt", "userId", "requestedExecutionTargetId",
       "selectedExecutionTargetId", status, "startedAt")
    VALUES ('provider-relay', NOW(), NOW(), 'owner-a', 'provider-target-a',
      'provider-target-a', 'PENDING', NOW());
    UPDATE response_stickiness_record
       SET "targetExecutionTargetId" = 'provider-target-a',
           "selectedExecutionTargetId" = 'provider-target-a'
     WHERE id = 'dual-stickiness';
    UPDATE relay_request
       SET "requestedExecutionTargetId" = 'provider-target-a',
           "selectedExecutionTargetId" = 'provider-target-a'
     WHERE id = 'old-relay';
  `);
  const providerCompatibility = await client.query(`
    SELECT "discoveredModelId" FROM pool_member WHERE id = 'provider-member'
  `);
  if (providerCompatibility.rows[0].discoveredModelId !== null) {
    throw new Error("Provider target incorrectly populated a legacy discovered-model FK");
  }
  const providerTelemetry = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM response_stickiness_record
        WHERE id IN ('provider-stickiness', 'dual-stickiness')
          AND "targetDiscoveredModelId" IS NULL
          AND "selectedDiscoveredModelId" IS NULL) AS stickiness,
      (SELECT COUNT(*)::int FROM relay_request
        WHERE id IN ('provider-relay', 'old-relay')
          AND "requestedDiscoveredModelId" IS NULL
          AND "selectedDiscoveredModelId" IS NULL) AS relays
  `);
  if (providerTelemetry.rows[0].stickiness !== 2 || providerTelemetry.rows[0].relays !== 2) {
    throw new Error("Provider telemetry did not keep legacy discovered-model FKs null");
  }
  await client.query(`
    UPDATE model_api_token_allowlist_entry
       SET "executionTargetId" = 'provider-target-a'
     WHERE id = 'target-only-access'
  `);
  const providerUpdateCompatibility = await client.query(`
    SELECT "discoveredModelId" FROM model_api_token_allowlist_entry
     WHERE id = 'target-only-access'
  `);
  if (providerUpdateCompatibility.rows[0].discoveredModelId !== null) {
    throw new Error("Switching to a provider target did not clear the legacy model FK");
  }
  await client.query(`
    UPDATE model_api_token_allowlist_entry
       SET "discoveredModelId" = 'model-a'
     WHERE id = 'target-only-access'
  `);
  const legacyUpdateCompatibility = await client.query(`
    SELECT target."discoveredModelId"
      FROM model_api_token_allowlist_entry entry
      JOIN execution_target target ON target.id = entry."executionTargetId"
     WHERE entry.id = 'target-only-access'
  `);
  if (legacyUpdateCompatibility.rows[0].discoveredModelId !== "model-a") {
    throw new Error("Legacy-only update did not replace its execution target");
  }

  // Recreate the deployment boundary and prove a transaction from an old
  // instance cannot slip a discovered model between trigger install/backfill.
  await client.query(`DROP TRIGGER discovered_model_create_execution_target ON discovered_model`);
  await oldWriter.connect();
  await hardeningClient.connect();
  await oldWriter.query(`SET search_path TO ${schema}`);
  await hardeningClient.query(`SET search_path TO ${schema}`);
  await oldWriter.query("BEGIN");
  await oldWriter.query(`
    INSERT INTO discovered_model
      (id, "createdAt", "updatedAt", "userId", "endpointId", "upstreamModelId", "encodedModelId")
    VALUES ('model-during-rollout', NOW(), NOW(), 'owner-a', 'endpoint-a',
      'during-rollout', 'owner-a/cli/local/during-rollout')
  `);
  const hardeningPid = (await hardeningClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const concurrentHardening = hardeningClient.query(sql);
  let observedLockWait = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await admin.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [hardeningPid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") {
      observedLockWait = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!observedLockWait) throw new Error("Hardening did not lock out the concurrent old writer");
  await oldWriter.query("COMMIT");
  await concurrentHardening;
  const racedTarget = await client.query(`
    SELECT id FROM execution_target WHERE "discoveredModelId" = 'model-during-rollout'
  `);
  if (racedTarget.rowCount !== 1) {
    throw new Error("Backfill missed an old-writer insert committed during rollout");
  }
  await oldWriter.query(`
    INSERT INTO discovered_model
      (id, "createdAt", "updatedAt", "userId", "endpointId", "upstreamModelId", "encodedModelId")
    VALUES ('model-after-rollout', NOW(), NOW(), 'owner-a', 'endpoint-a',
      'after-rollout', 'owner-a/cli/local/after-rollout')
  `);
  const postRolloutTarget = await client.query(`
    SELECT id FROM execution_target WHERE "discoveredModelId" = 'model-after-rollout'
  `);
  if (postRolloutTarget.rowCount !== 1) {
    throw new Error("Old-writer insert after rollout did not create an execution target");
  }

  // A child-first application transaction can conflict with hardening's
  // parent-first lock order. Force a lock timeout and prove the production
  // apply wrapper retries the complete transaction and then converges.
  await oldWriter.query("BEGIN");
  await oldWriter.query("LOCK TABLE pool_member IN ACCESS EXCLUSIVE MODE");
  const retryUrl = new URL(prismaUrl);
  retryUrl.searchParams.set("options", `-c search_path=${schema}`);
  const retryingHardening = runHardeningProcess(retryUrl.toString(), {
    SCHEMA_HARDENING_LOCK_TIMEOUT_MS: "100",
  });
  let observedRetry = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (retryingHardening.output().stderr.includes("retrying attempt")) {
      observedRetry = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!observedRetry) {
    await oldWriter.query("ROLLBACK");
    throw new Error("Schema apply wrapper did not retry its lock conflict");
  }
  await oldWriter.query("COMMIT");
  const retryResult = await retryingHardening.completion;
  if (retryResult.code !== 0) {
    throw new Error(
      `Schema hardening did not recover after lock retry: ${retryingHardening.output().stderr}`,
    );
  }
  process.stdout.write("Schema-hardening PostgreSQL integration validation complete.\n");
} finally {
  await oldWriter.end().catch(() => undefined);
  await hardeningClient.end().catch(() => undefined);
  await client.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
