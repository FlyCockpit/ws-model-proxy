import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
  "pool_fallback_preference_grantee",
  "pool_routing_rule_shape_check",
  "capacity_kv_eviction_session_ids_ok",
  "cli_device_node_budget_check",
  "pool routing rule member must be a PRIMARY member of the pool",
  "enforce_pool_routing_rule_member",
  "pool_routing_rule_on_member_delete",
  'FOREIGN KEY ("memberId") REFERENCES pool_member(id)',
  "own-key preference requires the exact non-owner grant",
  "model_pool_recommended_surface_override_check",
  'UPDATE model_pool\n   SET "recommendedSurfaceOverride" = NULL',
  "execution_target_kind_source_xor_check",
  "inference_capacity_limits_check",
  "execution_target_capacity_policy_check",
  "model_pool_capacity_policy_check",
  "model_pool_affinity_policy_check",
  'AND "affinityResidencyWeight" BETWEEN 0 AND 10000',
  "relay_request_execution_telemetry_check",
  "relay_execution_event_shape_check",
  "relay_execution_event_immutable",
  "relay_execution_attempt_shape_check",
  "relay_execution_attempt_transition",
  "historical-split",
  "cache_affinity_record_shape_check",
  "cache_affinity_scope_shape",
  "cache_affinity_observer_shape",
  "wsmp_affinity_generation_ready",
  "wsmp_affinity_scope_generation",
  '("sharedPrefixTokens" IS NULL OR "sharedPrefixTokens" >= 0)',
  "capacity_kv_eviction_shape_check",
  "engine_load_rollup_minute_shape_check",
  "node_metrics_minute_shape_check",
  '"maxKvOccupancy" IS NULL OR ("maxKvOccupancy" >= 0 AND "maxKvOccupancy" <= 1)',
  '"cutFraction" >= 0 AND "cutFraction" <= 1',
  'length("capacityId") BETWEEN 1 AND 128',
  '"expiresAt" >= "observedAt"',
  "cache_affinity_node_shape_check",
  'AND length("sessionId") BETWEEN 1 AND 128\n  AND ("estimatedTokens" IS NULL OR "estimatedTokens" >= 0)',
  "cache_affinity_node_owner",
  "enforce_cache_affinity_node_immutable",
  'ALTER COLUMN "sessionId" SET NOT NULL',
  "cache_affinity_conversation_unique",
  "cache_affinity_record_residency",
  'ON cache_affinity_record ("userId", "executionTargetId", "expiresAt" DESC, id DESC)',
  "DROP INDEX IF EXISTS cache_affinity_record_residency",
  "enforce_cache_affinity_identity_immutable",
  'DELETE FROM cache_affinity_record\n WHERE "digestVersion" < 5',
  'ALTER COLUMN "tenantUserId" SET NOT NULL',
  'ALTER COLUMN "bindingDigest" SET NOT NULL',
  "pool_member_capacity_policy_check",
  "admission_request_shape_check",
  "capacity_waiter_shape_check",
  "capacity_lease_shape_check",
  "capacity_waiter_one_admitted_winner",
  "capacity_waiter_unique_direct_candidate",
  "capacity_lease_one_live_attempt",
  "enforce_capacity_reference_consistency",
  "create_execution_target_capacity",
  "inference_capacity_auto_label",
  "allocate_auto_capacity_label",
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
  "provider_credential_one_active_per_account",
  "enforce_provider_credential_immutable_identity",
  "enforce_provider_account_endpoint_and_auth",
  "enforce_provider_credential_account_consistency",
  "enforce_provider_budget_graph_consistency",
  "enforce_provider_budget_history_transitions",
  "provider_budget_policy_grant_version_unique",
  "provider_budget_policy_one_active_grant",
  'OR ("scopeType" = \'POOL_GRANT\' AND "granteeUserId" IS NOT NULL',
  "budget policy grant must belong to the pool owner",
  'ALTER TABLE provider_budget_policy ALTER COLUMN "providerAccountId" DROP NOT NULL',
  'ALTER TABLE provider_budget_policy ADD COLUMN IF NOT EXISTS "poolGrantId" TEXT',
  'ALTER TABLE provider_budget_policy ADD COLUMN IF NOT EXISTS "granteeUserId" TEXT',
  "BEFORE INSERT OR UPDATE ON relay_request",
  "NEW.source = 'TRANSFORMER'",
  "budget reservation credential must match the reservation account",
  "enforce_provider_budget_reservation_transition",
  "provider_pricing_version_shape_check",
  "enforce_provider_pricing_version_immutability",
  "response_stickiness_provider_binding_check",
  "response_stickiness_fallback_route_check",
  'DELETE FROM response_stickiness_record\n WHERE "routingVersion" >= 3\n   AND "fallbackRoute" IS NULL',
  "DROP TRIGGER IF EXISTS model_pool_public_disable ON model_pool",
  "primary pool members must be local discovered models",
  "model_pool_external_after_wait_check",
  "model_api_token_external_after_wait_check",
  "relay_request_fallback_route_check",
  // #66: grantee local stickiness and durable relay owner attribution.
  "stickiness pool binding requires the pool owner or the exact grant",
  "stickiness selection must be a local member of its pool",
  "relay request selection must be a member of its pool",
  "stickiness pool grant row=%s",
  "BEFORE INSERT OR UPDATE ON response_stickiness_record",
  "derive_relay_request_resource_owner",
  'BEFORE INSERT OR UPDATE OF "requestedModelPoolId", "resourceOwnerUserId" ON relay_request',
  'WHERE request."resourceOwnerUserId" IS NULL;',
  // DL-1 (d): a request whose pool is gone keeps its ids; its selection is
  // checked against the durable resource owner instead of being erased.
  'consumer_owner := COALESCE(pool_owner, NEW."resourceOwnerUserId");',
  "enforce_response_stickiness_provider_binding_immutable",
  "activated provider pricing billing fields are immutable",
  "provider pricing lifecycle timestamps are immutable",
  "pricing retirement preserves activation and sets retirement",
  'btrim("accountingVersion")',
  'AND br."pricingVersion" IS NOT DISTINCT FROM NEW."pricingVersion"',
  // DL-1 (d): the requester merge moved out of the user-delete trigger (into
  // the drain and the deleted-user purge); the trigger is dropped.
  'DROP TRIGGER IF EXISTS usage_rollup_detach_requester ON "user";',
  // DL-1 (d) writer-class fences (capacity-lock-order.ts).
  "SELECT set_config('wsmp.fences', ',*,', true);",
  "CREATE OR REPLACE FUNCTION wsmp_acquire_fences(",
  "txid_current_if_assigned() IS NOT NULL",
  "CREATE OR REPLACE FUNCTION wsmp_graph_row_owners(",
  "CREATE OR REPLACE FUNCTION enforce_graph_write_fence()",
  "z_graph_write_fence",
  "z_graph_update_fence",
  "capacity_runtime_scheduler_check",
  // DEL-STATE commit point: the session insert reads its owner FOR SHARE (not
  // FOR KEY SHARE, which does not serialize with the deletion mark).
  "CREATE TRIGGER session_refuse_deleting_user BEFORE INSERT ON session",
  'WHERE u.id = NEW."userId"\n     FOR SHARE;',
  // IMP-MARK: an impersonation session is refused for a pending or deleted impersonator.
  'WHERE u.id = NEW."impersonatedBy"\n       FOR SHARE;\n    IF NOT FOUND OR pending THEN',
  "RAISE EXCEPTION 'user deletion pending' USING ERRCODE = 'WMPD1';",
  // Single writer of the deletion marker (parent-deletion.ts abandonUserDeletion).
  'BEFORE UPDATE OF "deletionRequestedAt", "deletionGeneration" ON "user"',
  "current_setting('wsmp.user_deletion_writer', true) IS DISTINCT FROM 'on'",
  // Interactive recipe commands: operator-terminal state, instance need and audit log.
  "deployment step enters AWAITING_OPERATOR only from RUNNING",
  "deployment step leaves AWAITING_OPERATOR only for RUNNING, PENDING, FAILED or SUCCEEDED",
  "only an accepted operator command can succeed",
  "an operator terminal keeps its open time",
  "OLD.state NOT IN ('RUNNING', 'AWAITING_OPERATOR') AND lower(NEW.phase) <> 'stop'",
  "only an open operator terminal can be accepted",
  "deployment_step_operator_shape",
  "deployment_instance_operator_shape",
  "deployment_operator_event_shape",
  "CREATE TRIGGER deployment_operator_event_append_only BEFORE UPDATE ON deployment_operator_event",
];
for (const fragment of requiredFragments) {
  if (!sql.includes(fragment)) throw new Error(`Missing schema-hardening fragment: ${fragment}`);
}

// Legacy user-saved hard limits are recovered from the audit trail as USER.
// The strings must match what capacity-management.ts and
// provider-management.ts write, and the backfill may only move AUTO to USER.
const limitSourceBackfills = sql
  .split(/;\s*\n/)
  .filter((statement) => statement.includes("SET \"hardConcurrencyLimitSource\" = 'USER'"));
if (limitSourceBackfills.length !== 2)
  throw new Error("Expected two audit-based hardConcurrencyLimitSource USER backfills");
const [capacityAuditBackfill, providerAuditBackfill] = limitSourceBackfills;
for (const [name, statement, fragments] of [
  [
    "capacity audit",
    capacityAuditBackfill,
    [
      "UPDATE inference_capacity capacity",
      `WHERE capacity."hardConcurrencyLimitSource" = 'AUTO'`,
      "FROM capacity_audit_event edit",
      `edit."resourceType" = 'INFERENCE_CAPACITY'`,
      `edit."resourceId" = capacity.id`,
      `edit."userId" = capacity."userId"`,
      "edit.after ? 'hardConcurrencyLimit'",
      "edit.action = 'CREATE'",
      "edit.action = 'UPDATE'",
      "NOT (edit.after ? 'hardConcurrencyLimitSource')",
    ],
  ],
  [
    "provider audit",
    providerAuditBackfill,
    [
      "UPDATE inference_capacity capacity",
      `WHERE capacity."hardConcurrencyLimitSource" = 'AUTO'`,
      "FROM provider_audit_event edit",
      `target."providerModelId" = edit."subjectId"`,
      "edit.action = 'MODEL_UPDATED'",
      "edit.metadata ? 'nextConcurrencyLimit'",
      "FROM capacity_audit_event attachment",
      `attachment."resourceType" = 'EXECUTION_TARGET'`,
      "attachment.action = 'UPDATE_POLICY'",
      `attachment."resourceId" = target.id`,
      "attachment.after ? 'inferenceCapacityId'",
      `attachment."createdAt" <= edit."createdAt"`,
      `ORDER BY attachment."createdAt" DESC, attachment.id DESC`,
      ") = capacity.id",
    ],
  ],
]) {
  for (const fragment of fragments) {
    if (!statement.includes(fragment))
      throw new Error(`Missing ${name} limit-source backfill fragment: ${fragment}`);
  }
}
const [capacityRouter, providerRouter] = await Promise.all([
  readFile(new URL("../../api/src/routers/capacity-management.ts", import.meta.url), "utf8"),
  readFile(new URL("../../api/src/routers/provider-management.ts", import.meta.url), "utf8"),
]);
for (const [name, contents, fragment] of [
  [
    "capacity create audit",
    capacityRouter,
    'action: "CREATE",\n          resourceType: "INFERENCE_CAPACITY"',
  ],
  [
    "capacity update audit",
    capacityRouter,
    'action: "UPDATE",\n            resourceType: "INFERENCE_CAPACITY"',
  ],
  ["capacity update audit row", capacityRouter, "after: updated,"],
  [
    "direct policy audit",
    capacityRouter,
    'action: "UPDATE_POLICY",\n          resourceType: "EXECUTION_TARGET"',
  ],
  ["provider model audit", providerRouter, 'action: "MODEL_UPDATED"'],
  ["provider model audit metadata", providerRouter, "nextConcurrencyLimit:"],
]) {
  if (!contents.includes(fragment))
    throw new Error(`Limit-source backfill no longer matches the ${name}: ${fragment}`);
}
if (/SET\s+"hardConcurrencyLimitSource"\s*=\s*'AUTO'/.test(sql))
  throw new Error("Schema hardening must never move hardConcurrencyLimitSource back to AUTO");
const commitIndex = sql.lastIndexOf("COMMIT;");
if (
  sql.indexOf(providerAuditBackfill) > commitIndex ||
  sql.indexOf(capacityAuditBackfill) < sql.indexOf("BEGIN;")
)
  throw new Error("Limit-source backfills must run inside the hardening transaction");
for (const fragment of [
  "model InferenceCapacity",
  "runtimeIdentityKey",
  "schedulerDeficits",
  "nextFencingToken",
  "model CapacityRuntime",
  "model AdmissionRequest",
  "model CapacityWaiter",
  "model CapacityLease",
  "directPriority",
  "capacityPriority",
]) {
  if (!forwarderSchema.includes(fragment))
    throw new Error(`Missing capacity schema fragment: ${fragment}`);
}
for (const fragment of [
  'error?.code === "40P01"',
  'error?.code === "55P03"',
  "MAX_ATTEMPTS",
  "SCHEMA_HARDENING_FORCE",
  "wmp_schema_hardening_state",
]) {
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
// Every deploy-time push goes through the lock_timeout + retry wrapper.
for (const [name, contents, fragment] of [
  ["package db:push", packageJson, "node scripts/push-schema.mjs &&"],
  ["container entrypoint", entrypoint, "node scripts/push-schema.mjs $push_flags"],
  ["dangerous local wrapper", dangerousWrapper, "node scripts/push-schema.mjs --accept-data-loss"],
]) {
  if (!contents.includes(fragment)) throw new Error(`${name} bypasses push-schema.mjs`);
}

// DL-1 deploy lock order: the hardening transaction's first statement locks
// every table the file touches, in ACCESS EXCLUSIVE mode with NOWAIT, so it
// never waits on a lock while holding one. "Touches" is over-approximated as
// every repository table (Prisma @@map) named anywhere outside comments and
// string literals, including trigger/function bodies that backfill writes
// fire.
function stripSqlCommentsAndLiterals(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}
function hardeningLockCoverage(source, tables) {
  const code = stripSqlCommentsAndLiterals(source);
  const locks = [
    ...code.matchAll(/\bLOCK\s+(?:TABLE\s+)?([\s\S]*?)\s+IN\s+([A-Z ]+?)\s+MODE(\s+NOWAIT)?\s*;/gi),
  ];
  const problems = [];
  if (locks.length !== 1)
    problems.push(`expected exactly one LOCK TABLE statement, found ${locks.length}`);
  const lock = locks[0];
  if (!lock) return { problems, missing: [] };
  if (lock[2].trim().toUpperCase() !== "ACCESS EXCLUSIVE" || !lock[3])
    problems.push(`LOCK TABLE must be IN ACCESS EXCLUSIVE MODE NOWAIT, found ${lock[0]}`);
  const begin = code.search(/\bBEGIN\s*;/i);
  if (
    begin < 0 ||
    code
      .slice(begin)
      .replace(/^BEGIN\s*;\s*/i, "")
      .indexOf(lock[0]) !== 0
  )
    problems.push("LOCK TABLE must be the first statement after BEGIN");
  const locked = new Set(lock[1].split(",").map((name) => name.trim().replace(/^"|"$/g, "")));
  for (const name of locked)
    if (!tables.has(name)) problems.push(`LOCK TABLE names a non-repository table: ${name}`);
  const rest = code.replace(lock[0], " ");
  // "user" is a reserved word, so as a table it only ever appears quoted.
  const mentions = (table) =>
    table === "user"
      ? rest.includes('"user"')
      : new RegExp(`(?<![A-Za-z0-9_$])"?${table}"?(?![A-Za-z0-9_$])`).test(rest);
  const missing = [...tables].filter((table) => !locked.has(table) && mentions(table));
  return { problems, missing };
}
const repositoryTables = new Set();
const schemaDirectory = new URL("../prisma/schema/", import.meta.url);
for (const file of (await readdir(schemaDirectory)).filter((name) => name.endsWith(".prisma"))) {
  const text = await readFile(new URL(file, schemaDirectory), "utf8");
  for (const match of text.matchAll(/@@map\("([^"]+)"\)/g)) repositoryTables.add(match[1]);
}
{
  const sample = `BEGIN;\nLOCK TABLE pool_member IN ACCESS EXCLUSIVE MODE NOWAIT;\nUPDATE "user" SET name = 'relay_request' WHERE false; -- model_pool\nCOMMIT;`;
  const result = hardeningLockCoverage(sample, repositoryTables);
  if (result.problems.length > 0 || result.missing.join() !== "user")
    throw new Error(
      `hardening lock-coverage guard misclassified its sample: ${JSON.stringify(result)}`,
    );
  const weak = hardeningLockCoverage(
    "BEGIN;\nUPDATE pool_member SET weight = 1;\nLOCK TABLE pool_member IN SHARE MODE;\nCOMMIT;",
    repositoryTables,
  );
  if (weak.problems.length !== 2)
    throw new Error(
      `hardening lock-coverage guard accepted a weak or late lock: ${JSON.stringify(weak)}`,
    );
}
{
  const { problems, missing } = hardeningLockCoverage(sql, repositoryTables);
  if (missing.length > 0)
    problems.push(
      `tables touched by schema-hardening.sql but not locked up front: ${missing.join(", ")}`,
    );
  if (problems.length > 0) throw new Error(`Schema hardening lock order:\n${problems.join("\n")}`);
}
// The apply script runs the SQL body inside its own transaction and records
// the gate key before COMMIT; that holds only if the body really lost the
// file's own BEGIN;/COMMIT;. Strip the real file with the same function and
// check the result, and prove the parser fails closed.
{
  const { hardeningSqlBody } = await import("./hardening-sql.mjs");
  if (!applyScript.includes("const sqlBody = hardeningSqlBody(sql);"))
    throw new Error("apply-schema-hardening.mjs must derive its SQL body with hardeningSqlBody");
  const body = hardeningSqlBody(sql);
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(body))
    throw new Error("stripped schema-hardening.sql body still has a transaction statement");
  if (!/^\s*LOCK TABLE\b/m.test(body.replace(/^\s*--.*$/gm, "").trimStart()))
    throw new Error("stripped schema-hardening.sql body must start with its LOCK TABLE");
  for (const [label, text] of [
    ["no BEGIN", "LOCK TABLE a;\nCOMMIT;\n"],
    ["statement after COMMIT", "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n"],
    ["nested COMMIT", "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;\n"],
  ]) {
    let refused = false;
    try {
      hardeningSqlBody(text);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`hardeningSqlBody accepted a malformed file (${label})`);
  }
  if (hardeningSqlBody("-- c\nBEGIN;\nSELECT 1;\nCOMMIT;\n-- tail\n") !== "SELECT 1;")
    throw new Error("hardeningSqlBody must strip only the outer BEGIN;/COMMIT; lines");
}
if (!applyScript.includes("await recordKey(client, establishedKey);"))
  throw new Error("apply-schema-hardening.mjs must record the catalog fingerprint before COMMIT");

// Invariant: no hardening statement may move relay_request out of PENDING.
// Every terminal transition must go through the application's status-guarded
// path, which writes the usage rollup in the same transaction; a SQL backfill
// would finalize requests that are then counted zero times (or finalize a live
// mid-retry request during a rolling deploy).
function relayRequestStatusWrites(source) {
  return source
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((statement) => {
      const writesRelayRequest =
        /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?relay_request"?(?![\w"])/i.test(statement) ||
        /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?relay_request"?(?![\w"])/i.test(statement) ||
        /\bMERGE\s+INTO\s+(?:"?public"?\.)?"?relay_request"?(?![\w"])/i.test(statement);
      if (!writesRelayRequest) return false;
      const setIndex = statement.search(/\bSET\b/i);
      const assignsStatus =
        setIndex >= 0 && /(^|[\s,(])"?status"?\s*=/i.test(statement.slice(setIndex));
      const insertsStatus =
        /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?relay_request"?\s*\([^)]*(^|[\s,(])"?status"?[\s,)]/i.test(
          statement,
        );
      return assignsStatus || insertsStatus;
    });
}
for (const [sample, expected] of [
  [
    `WITH t AS (SELECT 1) UPDATE relay_request request\n   SET status = t."terminalState"::"RelayRequestStatus" FROM t;`,
    1,
  ],
  ['UPDATE "relay_request" SET "completedAt" = now(), "status" = \'FAILED\';', 1],
  ["INSERT INTO relay_request (id, \"userId\", status) VALUES ('a', 'b', 'FAILED');", 1],
  ['UPDATE relay_request AS consumer\n   SET "requestedDiscoveredModelId" = t.id FROM t;', 0],
  ["UPDATE relay_request_other SET status = 'FAILED';", 0],
]) {
  if (relayRequestStatusWrites(sample).length !== expected)
    throw new Error(`relay_request status-write guard misclassified: ${sample}`);
}
const statusWrites = relayRequestStatusWrites(sql);
if (statusWrites.length > 0)
  throw new Error(
    `schema-hardening.sql must not write relay_request.status (rollup-accounted path only):\n${statusWrites.join(";\n")}`,
  );

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

// R1 node behavioral cases: shared verbatim with the inverse-check runner.
async function verifyAffinityNodeHardening() {
  const shapeCases = [
    { name: "negative-estimate", estimate: "-1" },
    { name: "zero-depth", depth: "0" },
    { name: "negative-depth", depth: "-1" },
    { name: "short-root", root: "repeat('r', 31)" },
    { name: "long-root", root: "repeat('r', 129)" },
    { name: "short-node", node: "repeat('n', 31)" },
    { name: "long-node", node: "repeat('n', 129)" },
    { name: "empty-session", session: "''" },
    { name: "long-session", session: "repeat('s', 129)" },
    // Nodes have no creation timestamp: expired timestamps are legitimate sweep
    // inputs. A missing expiry violates the existing NOT NULL contract instead.
    { name: "missing-expiry", expiry: "NULL", code: "23502" },
  ];
  for (const row of shapeCases) {
    await expectConstraintFailure(
      `
      INSERT INTO cache_affinity_node
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest",
         "nodeDigest", depth, "sessionId", "isTip", "estimatedTokens", "expiresAt")
      SELECT 'affinity-node-${row.name}', 'owner-a', 'owner-b', 'pool-a', id,
        ${row.root ?? "repeat('r', 43)"}, ${row.node ?? "repeat('n', 43)"},
        ${row.depth ?? "1"}, ${row.session ?? `'session-${row.name}'`}, false,
        ${row.estimate ?? "NULL"},
        ${row.expiry ?? "NOW() + interval '1 hour'"}
        FROM execution_target WHERE "discoveredModelId" = 'model-a'
    `,
      row.code ?? "23514",
    );
  }
  await client.query(`
    INSERT INTO cache_affinity_node
      (id, "userId", "tenantUserId", "poolId", "executionTargetId", "rootDigest",
       "nodeDigest", depth, "sessionId", "isTip", "expiresAt")
    SELECT 'affinity-node-valid', 'owner-a', 'owner-b', 'pool-a', id,
      repeat('r', 43), repeat('n', 43), 1, 'node-session', false,
      NOW() + interval '1 hour' FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `);
  const identityCases = [
    ['"userId"', "'owner-b'"],
    ['"tenantUserId"', "'owner-a'"],
    ['"poolId"', "'other-pool'"],
    ['"executionTargetId"', "'other-target'"],
    ['"rootDigest"', "repeat('x', 43)"],
    ['"nodeDigest"', "repeat('x', 43)"],
    ["depth", "2"],
    ['"sessionId"', "'changed-session'"],
  ];
  for (const [column, value] of identityCases) {
    await expectConstraintFailure(`
      UPDATE cache_affinity_node SET ${column} = ${value}
       WHERE id = 'affinity-node-valid'
    `);
  }
  await expectConstraintFailure(`UPDATE cache_affinity_node
    SET "estimatedTokens" = -1 WHERE id = 'affinity-node-valid'`);
  // Mutable warmth/provenance columns remain refreshable under the identity trigger.
  await client.query(`UPDATE cache_affinity_node
    SET "isTip" = true, "estimatedTokens" = 12000, "expiresAt" = NOW() + interval '2 hours'
    WHERE id = 'affinity-node-valid'`);
  for (const estimate of [0, 2147483647, null]) {
    await client.query(
      `UPDATE cache_affinity_node SET "estimatedTokens" = $1
      WHERE id = 'affinity-node-valid'`,
      [estimate],
    );
    const { rows } = await client.query(`SELECT "estimatedTokens" FROM cache_affinity_node
      WHERE id = 'affinity-node-valid'`);
    if (rows[0].estimatedTokens !== estimate)
      throw new Error("Node footprint must remain mutable, including NULL");
  }
  process.stdout.write(
    "Affinity node hardening: 11 shape/expiry/estimate and 8 identity negatives passed.\n",
  );
}
async function verifyKvEvictionHardening() {
  const cases = [
    {
      capacity: "''",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "repeat('c', 129)",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'negative-cut'",
      cut: "-0.01",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'oversized-cut'",
      cut: "1.01",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'nan-cut'",
      cut: "'NaN'::double precision",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'invalid-expiry'",
      cut: "0.1",
      expires: "NOW() - interval '1 second'",
      sessions: "ARRAY['session-a']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'too-many-sessions'",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY(SELECT generate_series(1,17)::text)",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'miss-over-cont'",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['session-a']",
      miss: 2,
      cont: 1,
    },
    {
      capacity: "'empty-session-id'",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY['']",
      miss: 0,
      cont: 0,
    },
    {
      capacity: "'long-session-id'",
      cut: "0.1",
      expires: "NOW() + interval '1 hour'",
      sessions: "ARRAY[repeat('s', 129)]",
      miss: 0,
      cont: 0,
    },
  ];
  for (const row of cases)
    await expectConstraintFailure(`
    INSERT INTO capacity_kv_eviction ("capacityId", "userId", "cutFraction", "observedAt", "expiresAt", "sessionIds", "missCount", "continuationCount")
    VALUES (${row.capacity}, 'owner-a', ${row.cut}, NOW(), ${row.expires}, ${row.sessions}, ${row.miss}, ${row.cont})`);
  await client.query(`INSERT INTO capacity_kv_eviction
    ("capacityId", "userId", "cutFraction", "observedAt", "expiresAt", "sessionIds", "missCount", "continuationCount")
    VALUES ('orphan-capacity', 'absent-owner', 0.5, NOW(), NOW(), ARRAY['session-a'], 1, 1)`);
  process.stdout.write(
    "KV eviction hardening: 10 shape negatives and FK-free orphan insert passed.\n",
  );
}

// End R1 node behavioral cases.

// Interactive recipe commands: AWAITING_OPERATOR transitions, operator column
// shape, the instance's operator need and the append-only operator audit log.
async function verifyDeploymentOperatorHardening() {
  const intent = (fields) =>
    `'${JSON.stringify({ type: "deployment.job", rank: 0, ...fields })}'::jsonb`;
  await client.query(`
    INSERT INTO deployment_config (id, "userId", "poolId", slug, name)
    VALUES ('op-config', 'owner-a', 'pool-a', 'op-config', 'Operator');
    INSERT INTO deployment_config_revision
      (id, "configId", revision, "editorId", "editorKind", "contentHash", spec)
    VALUES ('op-revision', 'op-config', 1, 'owner-a', 'USER', 'hash', '{}'::jsonb);
    INSERT INTO deployment_plan
      (id, "userId", "requesterId", "requesterKind", "expiresAt", state, fingerprint, contents)
    VALUES ('op-plan', 'owner-a', 'owner-a', 'USER', NOW() + interval '1 hour', 'APPLIED', 'fp', '{}'::jsonb);
    INSERT INTO deployment_run (id, "planId") VALUES ('op-run', 'op-plan');
    INSERT INTO deployment_instance
      (id, "userId", "configId", "revisionId", "runId", "variantKey", "endpointSlug", "startedBy")
    VALUES ('op-instance', 'owner-a', 'op-config', 'op-revision', 'op-run', 'default', 'op-endpoint', 'USER');
    -- The shared deployment_integrity trigger must not read step-only columns on a node row.
    INSERT INTO deployment_instance_node
      (id, "instanceId", "cliDeviceId", rank, resources, port, "claimHeld", "stoppedAt")
    VALUES ('op-node', 'op-instance', 'cli-a', 0, '{}'::jsonb, 30001, false, NOW());
    UPDATE deployment_instance_node SET port = 30002 WHERE id = 'op-node';
    INSERT INTO deployment_step
      (id, "runId", "instanceId", "cliDeviceId", rank, phase, sequence, intent, "intentHash")
    VALUES
      ('op-step', 'op-run', 'op-instance', 'cli-a', 0, 'start', 0,
        ${intent({ action: "start", interactive: true })}, 'h1'),
      ('op-plain', 'op-run', 'op-instance', 'cli-a', 0, 'start', 1,
        ${intent({ action: "start" })}, 'h2'),
      ('op-health', 'op-run', 'op-instance', 'cli-a', 0, 'health', 2,
        ${intent({ action: "health", interactive: true })}, 'h3'),
      ('op-false', 'op-run', 'op-instance', 'cli-a', 0, 'start', 3,
        ${intent({ action: "start", interactive: false })}, 'h4'),
      ('op-sites', 'op-run', 'op-instance', 'cli-a', 0, 'start', 4,
        ${intent({ action: "start", interactive: true })}, 'h5'),
      ('op-prepare', 'op-run', 'op-instance', 'cli-a', 0, 'prepare', 5,
        ${intent({ action: "prepare", interactive: true })}, 'h6'),
      ('op-after-join', 'op-run', 'op-instance', 'cli-a', 0, 'start', 6,
        ${intent({ action: "after_join", interactive: true })}, 'h7'),
      ('op-ban-start', 'op-run', 'op-instance', 'cli-a', 0, 'start', 7,
        ${intent({ action: "start", interactive: true })}, 'h8'),
      ('op-ban-stop', 'op-run', 'op-instance', 'cli-a', 0, 'stop', 8,
        ${intent({ action: "stop", interactive: true })}, 'h9'),
      ('op-ban-dispatch', 'op-run', 'op-instance', 'cli-a', 0, 'start', 9,
        ${intent({ action: "start", interactive: true })}, 'h10');
  `);
  const step = (sets, id = "op-step") =>
    client.query(`UPDATE deployment_step SET ${sets} WHERE id = '${id}'`);
  const row = async (id = "op-step") =>
    (await client.query(`SELECT * FROM deployment_step WHERE id = '${id}'`)).rows[0];
  const expectRow = async (id, expected, label) => {
    const actual = await row(id);
    for (const [column, value] of Object.entries(expected)) {
      const got =
        actual[column] === null ? null : actual[column] instanceof Date ? "set" : actual[column];
      if (got !== value) throw new Error(`${label}: ${id}.${column} is ${got}, expected ${value}`);
    }
  };
  const awaiting = `state = 'AWAITING_OPERATOR', deadline = NULL, "operatorTerminalId" = 'term-1', "operatorSince" = NOW()`;
  /** PENDING -> RUNNING (dispatch with a terminal id) -> AWAITING_OPERATOR. */
  const open = async (id, terminal = "term-1") => {
    await step(
      `state = 'RUNNING', deadline = NOW() + interval '1 minute', "operatorTerminalId" = '${terminal}'`,
      id,
    );
    await step(`state = 'AWAITING_OPERATOR', deadline = NULL, "operatorSince" = NOW()`, id);
  };
  const accept = (id) =>
    step(
      `state = 'RUNNING', "operatorAcceptedAt" = NOW(), deadline = NOW() + interval '15 minutes'`,
      id,
    );
  let negatives = 0;
  let positives = 0;
  const refuse = async (statement) => {
    await expectConstraintFailure(statement);
    negatives += 1;
  };
  // Never inserted awaiting; never PENDING/SUCCEEDED/FAILED -> AWAITING_OPERATOR.
  await refuse(`
    INSERT INTO deployment_step
      (id, "runId", "instanceId", "cliDeviceId", rank, phase, sequence, intent, "intentHash",
       state, "operatorSince")
    VALUES ('op-inserted', 'op-run', 'op-instance', 'cli-a', 0, 'stop', 99,
      ${intent({ action: "stop", interactive: true })}, 'h99', 'AWAITING_OPERATOR', NOW())`);
  await refuse(`UPDATE deployment_step SET ${awaiting} WHERE id = 'op-step'`);
  // PENDING carries no operator state: an explicit write of one fails (the trigger only
  // clears values carried over from the old row).
  await refuse(`UPDATE deployment_step SET "operatorLastExit" = 1 WHERE id = 'op-step'`);
  // Operator columns are refused on non-interactive intents (missing key, explicit false,
  // an action that can never be interactive).
  for (const id of ["op-plain", "op-false", "op-health"]) {
    await step(`state = 'RUNNING', deadline = NOW() + interval '1 minute'`, id);
    await refuse(
      `UPDATE deployment_step SET "operatorTerminalId" = 'x', "operatorSince" = NOW() WHERE id = '${id}'`,
    );
    await refuse(`UPDATE deployment_step SET ${awaiting} WHERE id = '${id}'`);
  }
  // RUNNING -> AWAITING_OPERATOR needs an open time and no deadline.
  await step(
    `state = 'RUNNING', deadline = NOW() + interval '1 minute', "operatorTerminalId" = 'term-1'`,
  );
  await refuse(
    `UPDATE deployment_step SET state = 'AWAITING_OPERATOR', deadline = NULL WHERE id = 'op-step'`,
  );
  await refuse(
    `UPDATE deployment_step SET state = 'AWAITING_OPERATOR', "operatorSince" = NOW() WHERE id = 'op-step'`,
  );
  await step(awaiting);
  // While awaiting: no unaccepted success, no new terminal, no rewritten open time, no deadline.
  await refuse(`UPDATE deployment_step SET state = 'SUCCEEDED' WHERE id = 'op-step'`);
  await refuse(`UPDATE deployment_step SET "operatorTerminalId" = 'term-2' WHERE id = 'op-step'`);
  await refuse(
    `UPDATE deployment_step SET "operatorSince" = NOW() - interval '1 hour' WHERE id = 'op-step'`,
  );
  await refuse(`UPDATE deployment_step SET deadline = NOW() WHERE id = 'op-step'`);
  // Accept requires the open terminal and an acceptance time.
  await refuse(`UPDATE deployment_step SET state = 'RUNNING' WHERE id = 'op-step'`);
  await refuse(
    `UPDATE deployment_step SET state = 'RUNNING', "operatorAcceptedAt" = NOW(), "operatorTerminalId" = 'term-2' WHERE id = 'op-step'`,
  );
  await accept("op-step");
  // A retry cycle in the same terminal keeps its open time.
  await refuse(
    `UPDATE deployment_step SET state = 'AWAITING_OPERATOR', deadline = NULL, "operatorSince" = NOW() + interval '1 second' WHERE id = 'op-step'`,
  );
  await step(`state = 'AWAITING_OPERATOR', deadline = NULL`);
  await accept("op-step");
  // Closed after a failed run: back to awaiting with the terminal gone and the exit kept.
  await step(
    `state = 'AWAITING_OPERATOR', deadline = NULL, "operatorTerminalId" = NULL, "operatorLastExit" = 2`,
  );
  // A closed terminal cannot be accepted or silently reopened.
  await refuse(
    `UPDATE deployment_step SET state = 'RUNNING', "operatorAcceptedAt" = NOW() WHERE id = 'op-step'`,
  );
  await refuse(`UPDATE deployment_step SET "operatorTerminalId" = 'term-3' WHERE id = 'op-step'`);
  // Reopen through PENDING: the trigger clears every operator column.
  await step(`state = 'PENDING'`);
  await expectRow(
    "op-step",
    {
      operatorTerminalId: null,
      operatorSince: null,
      operatorAcceptedAt: null,
      operatorLastExit: null,
    },
    "reopen",
  );
  // A final result that overtakes "operator running": AWAITING -> SUCCEEDED with the
  // acceptance in the same update; the terminal id is dropped, the history kept.
  await open("op-step", "term-3");
  await step(
    `state = 'SUCCEEDED', "operatorAcceptedAt" = NOW(), "operatorLastExit" = 0, "leaseExpiresAt" = NULL`,
  );
  await expectRow(
    "op-step",
    {
      state: "SUCCEEDED",
      operatorTerminalId: null,
      operatorSince: "set",
      operatorAcceptedAt: "set",
    },
    "out-of-order success",
  );
  await refuse(`UPDATE deployment_step SET ${awaiting} WHERE id = 'op-step'`);
  positives += 4;
  // Existing generic write sites (apps/server/src/deployments/reconciler.ts, which knows
  // nothing about operator terminals) on a RUNNING interactive step carrying every operator
  // column: none may throw, and the trigger normalises what becomes invalid.
  const sites = [
    [
      "acceptResult :209 success",
      `state = 'SUCCEEDED', "leaseExpiresAt" = NULL, "errorCode" = NULL`,
      "SUCCEEDED",
    ],
    [
      "acceptResult :209 failure",
      `state = 'FAILED', "leaseExpiresAt" = NULL, "errorCode" = 'job_failed'`,
      "FAILED",
    ],
    [
      "result lost :407",
      `state = 'FAILED', "errorCode" = 'result_lost', "leaseExpiresAt" = NULL`,
      "FAILED",
    ],
    [
      "stop deadline reset :662",
      `state = 'PENDING', "ownerEpoch" = NULL, "leaseExpiresAt" = NULL`,
      "PENDING",
    ],
    [
      "job deadline :667/673/682",
      `state = 'FAILED', "errorCode" = 'job_deadline', "leaseExpiresAt" = NULL`,
      "FAILED",
    ],
    [
      "undeliver :829",
      `state = 'PENDING', "ownerEpoch" = NULL, "leaseExpiresAt" = NULL, deadline = NULL`,
      "PENDING",
    ],
  ];
  for (const [label, sets, state] of sites) {
    await step(`state = 'PENDING'`, "op-sites");
    await open("op-sites", "term-sites");
    await accept("op-sites");
    await step(`"operatorLastExit" = 1`, "op-sites");
    await step(sets, "op-sites");
    await expectRow(
      "op-sites",
      state === "PENDING"
        ? {
            state,
            operatorTerminalId: null,
            operatorSince: null,
            operatorAcceptedAt: null,
            operatorLastExit: null,
          }
        : {
            state,
            operatorTerminalId: null,
            operatorSince: "set",
            operatorAcceptedAt: "set",
            operatorLastExit: 1,
          },
      label,
    );
    positives += 1;
    if (state === "FAILED") {
      // Inventory adoption :357/:380 settles a FAILED (or RUNNING) step as SUCCEEDED.
      await step(`state = 'SUCCEEDED', "leaseExpiresAt" = NULL, "errorCode" = NULL`, "op-sites");
      await expectRow(
        "op-sites",
        { state: "SUCCEEDED", operatorTerminalId: null },
        `${label} + adoption`,
      );
      positives += 1;
    }
  }
  // Explicit operator values that contradict the new state fail instead of being dropped.
  await step(`state = 'PENDING'`, "op-sites");
  await open("op-sites", "term-explicit");
  await refuse(
    `UPDATE deployment_step SET state = 'PENDING', "operatorSince" = NOW() + interval '1 second' WHERE id = 'op-sites'`,
  );
  await refuse(
    `UPDATE deployment_step SET state = 'PENDING', "operatorTerminalId" = 'term-new' WHERE id = 'op-sites'`,
  );
  await refuse(
    `UPDATE deployment_step SET state = 'FAILED', "operatorTerminalId" = 'term-other' WHERE id = 'op-sites'`,
  );
  // ... including on a non-interactive step (op-health is RUNNING with no operator state).
  await refuse(
    `UPDATE deployment_step SET state = 'PENDING', "operatorSince" = NOW(), "operatorTerminalId" = 'new' WHERE id = 'op-health'`,
  );
  await refuse(
    `UPDATE deployment_step SET state = 'FAILED', "operatorTerminalId" = 'zzz' WHERE id = 'op-health'`,
  );
  // prepare and after_join are interactive actions too: the full happy path.
  for (const id of ["op-prepare", "op-after-join"]) {
    await open(id);
    await accept(id);
    await step(`state = 'SUCCEEDED', "operatorLastExit" = 0`, id);
    await expectRow(id, { state: "SUCCEEDED", operatorTerminalId: null, operatorLastExit: 0 }, id);
    positives += 1;
  }
  // An inactive (banned) owner: dispatch PENDING -> RUNNING of a start is refused, but an
  // operator's accept (a command already running) is recorded for a start and a stop.
  await open("op-ban-start");
  await open("op-ban-stop");
  const { rows: banRows } = await client.query(
    `SELECT banned, "banExpires" FROM "user" WHERE id = 'owner-a'`,
  );
  await client.query(`UPDATE "user" SET banned = true, "banExpires" = NULL WHERE id = 'owner-a'`);
  try {
    await refuse(
      `UPDATE deployment_step SET state = 'RUNNING', deadline = NOW() + interval '1 minute' WHERE id = 'op-ban-dispatch'`,
    );
    await accept("op-ban-start");
    await accept("op-ban-stop");
    await expectRow(
      "op-ban-start",
      { state: "RUNNING", operatorTerminalId: "term-1" },
      "banned accept start",
    );
    await expectRow(
      "op-ban-stop",
      { state: "RUNNING", operatorTerminalId: "term-1" },
      "banned accept stop",
    );
    positives += 2;
  } finally {
    await client.query(`UPDATE "user" SET banned = $1, "banExpires" = $2 WHERE id = 'owner-a'`, [
      banRows[0].banned,
      banRows[0].banExpires,
    ]);
  }
  // Instance: need and its timestamp together; RESTART only for a stopped instance meant to
  // run. Generic writers that stop or start the instance clear a RESTART need.
  const instance = async () =>
    (await client.query(`SELECT * FROM deployment_instance WHERE id = 'op-instance'`)).rows[0];
  const expectNeed = async (need, label) => {
    const current = await instance();
    if (current.needsOperator !== need || (need === null) !== (current.needsOperatorSince === null))
      throw new Error(
        `${label}: needsOperator ${current.needsOperator}/${current.needsOperatorSince}`,
      );
  };
  await refuse(`UPDATE deployment_instance SET "needsOperator" = 'STEP' WHERE id = 'op-instance'`);
  // Explicit contradictory writes fail; only carried-over needs are cleared.
  await refuse(
    `UPDATE deployment_instance SET "needsOperatorSince" = NOW() WHERE id = 'op-instance'`,
  );
  await refuse(
    `UPDATE deployment_instance SET "needsOperator" = 'RESTART', "needsOperatorSince" = NOW() WHERE id = 'op-instance'`,
  );
  // e.g. gangStop setting RESTART before its stops settled.
  for (const observed of ["STOPPING", "STOP_PENDING"]) {
    await refuse(
      `UPDATE deployment_instance SET "observedState" = '${observed}', "needsOperator" = 'RESTART', "needsOperatorSince" = NOW() WHERE id = 'op-instance'`,
    );
  }
  await client.query(
    `UPDATE deployment_instance SET "needsOperator" = 'STEP', "needsOperatorSince" = NOW() WHERE id = 'op-instance'`,
  );
  await expectNeed("STEP", "STEP");
  await client.query(
    `UPDATE deployment_instance SET "observedState" = 'STOPPED', "needsOperator" = 'RESTART' WHERE id = 'op-instance'`,
  );
  await expectNeed("RESTART", "RESTART");
  // Maintenance restartAttempts>=3 -> FAILED keeps the need.
  await client.query(
    `UPDATE deployment_instance SET "observedState" = 'FAILED' WHERE id = 'op-instance'`,
  );
  await expectNeed("RESTART", "RESTART survives FAILED");
  // deployment-service.ts:656 human stop.
  await client.query(
    `UPDATE deployment_instance SET "desiredState" = 'STOPPED', "observedState" = 'STOPPING' WHERE id = 'op-instance'`,
  );
  await expectNeed(null, "human stop clears RESTART");
  await client.query(`UPDATE deployment_instance SET "desiredState" = 'RUNNING', "observedState" = 'STOPPED',
    "needsOperator" = 'RESTART', "needsOperatorSince" = NOW() WHERE id = 'op-instance'`);
  // reconciler.ts:796 dispatch of a start.
  await client.query(
    `UPDATE deployment_instance SET "observedState" = 'STARTING', "operatorRestartRequestedAt" = NOW() WHERE id = 'op-instance'`,
  );
  await expectNeed(null, "STARTING clears RESTART");
  // A writer that ends a need explicitly clears both columns.
  await client.query(`UPDATE deployment_instance SET "observedState" = 'STOPPED',
    "needsOperator" = 'RESTART', "needsOperatorSince" = NOW() WHERE id = 'op-instance'`);
  await refuse(`UPDATE deployment_instance SET "needsOperator" = NULL WHERE id = 'op-instance'`);
  await client.query(`UPDATE deployment_instance SET "needsOperator" = NULL,
    "needsOperatorSince" = NULL WHERE id = 'op-instance'`);
  await expectNeed(null, "explicit clear");
  positives += 6;
  // Audit log: shape-checked, append-only, deletable (user drain), no foreign keys.
  const event = (overrides = {}) => {
    const row = { rank: "0", action: "'start'", outcome: "'opened'", exit: "NULL", ...overrides };
    return `INSERT INTO deployment_operator_event
      (id, "userId", "instanceId", "stepId", "cliDeviceId", rank, action, outcome, "exitCode")
      VALUES ('${row.id ?? `op-event-${negatives}`}', 'owner-a', 'op-instance', 'op-step', 'cli-a',
        ${row.rank}, ${row.action}, ${row.outcome}, ${row.exit})`;
  };
  await refuse(event({ rank: "64" }));
  await refuse(event({ action: "'health'" }));
  await refuse(event({ outcome: "'opened'", exit: "1" }));
  await client.query(event({ id: "op-event-ok", outcome: "'closed'", exit: "1" }));
  await refuse(`UPDATE deployment_operator_event SET "exitCode" = 0 WHERE id = 'op-event-ok'`);
  await refuse(
    `UPDATE deployment_operator_event SET "userId" = 'owner-b' WHERE id = 'op-event-ok'`,
  );
  const { rows: fks } = await client.query(`SELECT count(*)::int AS n FROM pg_constraint
    WHERE conrelid = 'deployment_operator_event'::regclass AND contype = 'f'`);
  if (fks[0].n !== 0) throw new Error("deployment_operator_event must have no foreign keys");
  await client.query(`DELETE FROM deployment_operator_event WHERE id = 'op-event-ok'`);
  // Clean up the fixture so later checks see the original graph.
  await client.query(`
    DELETE FROM deployment_step WHERE "runId" = 'op-run';
    DELETE FROM deployment_instance_node WHERE id = 'op-node';
    DELETE FROM deployment_instance WHERE id = 'op-instance';
    DELETE FROM deployment_run WHERE id = 'op-run';
    DELETE FROM deployment_plan WHERE id = 'op-plan';
    DELETE FROM deployment_config WHERE id = 'op-config';
  `);
  process.stdout.write(
    `Deployment operator hardening: ${negatives} transition/shape/append-only negatives and ${positives} normalisation/write-site positives passed.\n`,
  );
}

const schemaUrl = new URL(baseUrl);
schemaUrl.searchParams.set("options", `-c search_path=${schema}`);

async function waitForHardeningRetry(hardening, onTimeout) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (hardening.output().stderr.includes("retrying attempt")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await onTimeout();
  throw new Error(
    `Schema apply wrapper did not retry its lock conflict: ${hardening.output().stderr}`,
  );
}

async function databaseDeadlocks() {
  const { rows } = await admin.query(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(rows[0].deadlocks);
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
  // Fixture connection: the DL-1 graph-write fence triggers accept its writes
  // (the deploy/fixture marker; writer-classes.postgres suite proves them).
  await client.query("SET wsmp.fences = ',*,'");
  await client.query(`
    INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug)
    VALUES ('owner-a', NOW(), NOW(), 'A', 'a@example.test', 'owner-a'),
           ('owner-b', NOW(), NOW(), 'B', 'b@example.test', 'owner-b');
    INSERT INTO cli_device (id, "createdAt", "updatedAt", "userId", slug)
    VALUES ('cli-a', NOW(), NOW(), 'owner-a', 'cli'),
           ('cli-b', NOW(), NOW(), 'owner-b', 'cli');
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
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "endpointVersion", "authType")
    VALUES ('pre-provider-account', NOW(), NOW(), 'owner-a', 'openai', 'Pre provider',
      'https://pre.example.test/v1', 'https://pre.example.test/v1', 1, 'BEARER');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('pre-provider-model', NOW(), NOW(), 'owner-a', 'pre-provider-account', 'pre-model'),
           ('pre-other-provider-model', NOW(), NOW(), 'owner-a', 'pre-provider-account',
             'pre-other-model');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('pre-provider-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
              'pre-provider-model'),
           ('pre-other-provider-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
              'pre-other-provider-model');
    INSERT INTO model_pool
      (id, "createdAt", "updatedAt", "userId", slug, name,
       "publicEgressEnabled")
    VALUES ('pre-provider-pool', NOW(), NOW(), 'owner-a', 'pre-provider', 'Pre provider',
      TRUE);
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId", tier, "publicOrder")
    VALUES ('pre-provider-member', NOW(), NOW(), 'pre-provider-pool',
      'pre-provider-target', 'PUBLIC_OVERFLOW', 0);
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('pre-primary-provider-model', NOW(), NOW(), 'owner-a', 'pre-provider-account',
              'pre-primary-model'),
           ('pre-primary-second-model', NOW(), NOW(), 'owner-a', 'pre-provider-account',
              'pre-primary-second');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('pre-primary-provider-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
              'pre-primary-provider-model'),
           ('pre-primary-second-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
              'pre-primary-second-model');
    -- A provider-only pool from the previous release: fallback off, two
    -- provider-backed PRIMARY members (the heavier one must keep order 0).
    INSERT INTO model_pool
      (id, "createdAt", "updatedAt", "userId", slug, name,
       "publicEgressEnabled")
    VALUES ('pre-primary-pool', NOW(), NOW(), 'owner-a', 'pre-primary', 'Pre primary',
      FALSE);
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId", tier, weight)
    VALUES ('pre-primary-provider-member', NOW(), NOW(), 'pre-primary-pool',
              'pre-primary-provider-target', 'PRIMARY', 5),
           ('pre-primary-second-member', NOW(), NOW(), 'pre-primary-pool',
              'pre-primary-second-target', 'PRIMARY', 1);
    INSERT INTO pool_grant
      (id, "createdAt", "updatedAt", "poolId", "ownerUserId", "granteeUserId")
    VALUES ('pre-provider-grant', NOW(), NOW(), 'pre-provider-pool', 'owner-a', 'owner-b');
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('pre-provider-token', NOW(), NOW(), 'owner-b', 'Pre provider token',
      'pre-provider-prefix', 'pre-provider-digest');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "poolGrantId", "nativeSurface",
       "upstreamResponseIdDigest", "expiresAt")
    VALUES ('pre-valid-grantee-binding', NOW(), NOW(), 'owner-b', 'pre-provider-token',
      'pre-valid-grantee-digest', 3, 'pre-provider-pool', 'pre-provider-target',
      'pre-provider-account', 'pre-provider-model', 'https://pre.example.test/v1', 1,
      'pre-model', NULL, 'OPENAI_RESPONSES',
      'fghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcde',
      NOW() + INTERVAL '1 hour'),
    -- Cross-wired graph: the target serves a different provider model than
    -- the binding records. (A target that is merely not, or no longer, a
    -- member of the pool is not an audit failure: membership is checked when
    -- a binding is written, and follow-ups re-list the members live.)
    ('pre-invalid-cross-wire', NOW(), NOW(), 'owner-b', 'pre-provider-token',
      'pre-invalid-cross-wire-digest', 3, 'pre-provider-pool', 'pre-other-provider-target',
      'pre-provider-account', 'pre-provider-model', 'https://pre.example.test/v1', 1,
      'pre-model', NULL, 'OPENAI_RESPONSES',
      'ghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdef',
      NOW() + INTERVAL '1 hour');

    -- Reproduce an upgrade from the previous release: the historical v3
    -- immutability trigger exists, but exact pool-grant identity has not yet
    -- been backfilled. Hardening must temporarily remove this trigger inside
    -- its locked transaction, populate the grant, and recreate enforcement.
    CREATE OR REPLACE FUNCTION enforce_response_stickiness_provider_binding_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $historical_provider_binding$
    BEGIN
      IF NEW."routingVersion" >= 3 AND
         NEW."poolGrantId" IS DISTINCT FROM OLD."poolGrantId" THEN
        RAISE EXCEPTION 'historical provider Responses binding is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $historical_provider_binding$;
    CREATE TRIGGER response_stickiness_provider_binding_immutable
    BEFORE UPDATE ON response_stickiness_record
    FOR EACH ROW EXECUTE FUNCTION enforce_response_stickiness_provider_binding_immutable();
  `);

  await expectConstraintFailure(`
    UPDATE response_stickiness_record
       SET "poolGrantId" = 'pre-provider-grant'
     WHERE id = 'pre-valid-grantee-binding'
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
  await client.query(`DELETE FROM pool_member WHERE id = 'conflict-legacy-row'`); // policy: bounded-delete

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
    DELETE FROM model_api_token_allowlist_entry WHERE id = 'conflict-legacy-access'; -- policy: bounded-delete
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
    -- Local (v2) pool bindings predating the triggers: the owner without a
    -- grant and a grantee with the exact grant are valid; a grantee without a
    -- grant, or with a grant for another pool, is not.
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest", "routingVersion",
       "targetModelPoolId", "poolGrantId", "selectedDiscoveredModelId",
       "selectedExecutionTargetId", "expiresAt")
    VALUES
      ('pre-v2-owner-binding', NOW(), NOW(), 'owner-a', 'pre-v2-owner', 2,
        'conflict-pool', NULL, 'model-a', 'preexisting-target-a', NOW() + INTERVAL '1 hour'),
      ('pre-v2-grantee-binding', NOW(), NOW(), 'owner-b', 'pre-v2-grantee', 2,
        'pre-provider-pool', 'pre-provider-grant', 'model-a', 'preexisting-target-a',
        NOW() + INTERVAL '1 hour'),
      ('pre-v2-ungranted-binding', NOW(), NOW(), 'owner-b', 'pre-v2-ungranted', 2,
        'conflict-pool', NULL, 'model-a', 'preexisting-target-a', NOW() + INTERVAL '1 hour'),
      ('pre-v2-foreign-grant-binding', NOW(), NOW(), 'owner-b', 'pre-v2-foreign-grant', 2,
        'conflict-pool', 'pre-provider-grant', 'model-a', 'preexisting-target-a',
        NOW() + INTERVAL '1 hour');
    -- Another grantee's grant on the same pool, a grant row whose owner is
    -- not the pool owner, and a pool binding that also names a direct target.
    INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug)
    VALUES ('owner-c', NOW(), NOW(), 'C', 'c@example.test', 'owner-c');
    INSERT INTO model_pool (id, "createdAt", "updatedAt", "userId", slug, name)
    VALUES ('pre-v2-pool', NOW(), NOW(), 'owner-a', 'pre-v2', 'Pre v2');
    INSERT INTO pool_grant
      (id, "createdAt", "updatedAt", "poolId", "ownerUserId", "granteeUserId")
    VALUES ('pre-v2-c-grant', NOW(), NOW(), 'conflict-pool', 'owner-a', 'owner-c'),
           ('pre-v2-misowned-grant', NOW(), NOW(), 'pre-v2-pool', 'owner-b', 'owner-c');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest", "routingVersion",
       "targetModelPoolId", "poolGrantId", "targetDiscoveredModelId",
       "targetExecutionTargetId", "selectedDiscoveredModelId",
       "selectedExecutionTargetId", "expiresAt")
    VALUES
      ('pre-v2-other-grantee-binding', NOW(), NOW(), 'owner-b', 'pre-v2-other-grantee', 2,
        'conflict-pool', 'pre-v2-c-grant', NULL, NULL, 'model-a', 'preexisting-target-a',
        NOW() + INTERVAL '1 hour'),
      ('pre-v2-misowned-grant-binding', NOW(), NOW(), 'owner-c', 'pre-v2-misowned', 2,
        'pre-v2-pool', 'pre-v2-misowned-grant', NULL, NULL, 'model-a', 'preexisting-target-a',
        NOW() + INTERVAL '1 hour'),
      ('pre-v2-mixed-binding', NOW(), NOW(), 'owner-a', 'pre-v2-mixed', 2,
        'conflict-pool', NULL, 'model-a', 'preexisting-target-a', 'model-a',
        'preexisting-target-a', NOW() + INTERVAL '1 hour');
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
        "pre-invalid-cross-wire",
        "stickiness pool grant row=pre-v2-ungranted-binding",
        "stickiness pool grant row=pre-v2-foreign-grant-binding",
        "stickiness pool grant row=pre-v2-other-grantee-binding",
        "stickiness pool grant row=pre-v2-misowned-grant-binding",
        "stickiness mixed target row=pre-v2-mixed-binding",
      ].every((id) => error?.detail?.includes(id)) ||
      ["pre-v2-owner-binding", "pre-v2-grantee-binding"].some((id) => error?.detail?.includes(id))
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
    DELETE FROM pool_member WHERE id = 'invalid-preexisting-member'; -- policy: bounded-delete
    DELETE FROM model_api_token_allowlist_entry WHERE id = 'invalid-preexisting-access'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'invalid-preexisting-stickiness'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-invalid-cross-wire'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-v2-ungranted-binding'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-v2-foreign-grant-binding'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-v2-other-grantee-binding'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-v2-misowned-grant-binding'; -- policy: bounded-delete
    DELETE FROM response_stickiness_record WHERE id = 'pre-v2-mixed-binding'; -- policy: bounded-delete
    DELETE FROM pool_grant WHERE id = 'pre-v2-misowned-grant'; -- policy: bounded-delete
    DELETE FROM relay_request WHERE id = 'invalid-preexisting-relay'; -- policy: bounded-delete
  `);

  await client.query(sql);
  await client.query(sql);
  const preservedV2Bindings = await client.query(`
    SELECT COUNT(*)::int AS count FROM response_stickiness_record
     WHERE id IN ('pre-v2-owner-binding', 'pre-v2-grantee-binding')
  `);
  if (preservedV2Bindings.rows[0]?.count !== 2) {
    throw new Error("Hardening did not keep valid pre-existing local pool bindings");
  }
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
  const preservedGranteeBinding = await client.query(`
    SELECT COUNT(*)::int AS count FROM response_stickiness_record
     WHERE id = 'pre-valid-grantee-binding' AND "userId" = 'owner-b'
       AND "selectedExecutionTargetId" = 'pre-provider-target'
       AND "poolGrantId" = 'pre-provider-grant'
  `);
  // Provider bindings written before caller consent existed (automatic
  // overflow or provider-backed PRIMARY) are invalidated by the fallback
  // redesign even when their graph is otherwise valid.
  if (preservedGranteeBinding.rows[0]?.count !== 0) {
    throw new Error("Hardening kept a provider binding that predates caller consent");
  }
  const migratedProviderPrimary = await client.query(`
    SELECT member.tier::text AS tier, member."publicOrder" AS "publicOrder",
           pool."publicEgressEnabled" AS enabled
      FROM pool_member member
      JOIN model_pool pool ON pool.id = member."poolId"
     WHERE member.id IN ('pre-primary-provider-member', 'pre-primary-second-member')
     ORDER BY member.id
  `);
  if (
    migratedProviderPrimary.rowCount !== 2 ||
    migratedProviderPrimary.rows.some((row) => row.tier !== "PUBLIC_OVERFLOW" || !row.enabled) ||
    migratedProviderPrimary.rows[0].publicOrder !== 0 ||
    migratedProviderPrimary.rows[1].publicOrder !== 1
  ) {
    throw new Error("Provider PRIMARY members were not moved to ordered external fallback");
  }
  // PRIMARY is local-only after the redesign.
  await expectConstraintFailure(`
    UPDATE pool_member SET tier = 'PRIMARY', "publicOrder" = NULL
     WHERE id = 'pre-primary-provider-member'
  `);
  // Disabling fallback no longer requires removing configured members.
  await client.query(`
    UPDATE model_pool SET "publicEgressEnabled" = FALSE
     WHERE id = 'pre-primary-pool'
  `);

  // Exercise the provider Responses v3 binding on real PostgreSQL. Endpoint
  // versions are snapshots (base-URL changes invalidate at runtime), while
  // target identity cannot be rewritten and deleting its token removes it.
  await client.query(`
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "endpointVersion", "authType")
    VALUES ('sticky-provider-account', NOW(), NOW(), 'owner-a', 'openai', 'Sticky provider',
      'https://api.example.test/v1', 'https://api.example.test/v1', 1, 'BEARER');
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "endpointVersion", "authType")
    VALUES ('other-provider-account', NOW(), NOW(), 'owner-a', 'openai', 'Other provider',
      'https://other.example.test/v1', 'https://other.example.test/v1', 1, 'BEARER');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('sticky-provider-model', NOW(), NOW(), 'owner-a', 'sticky-provider-account',
      'gpt-responses');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('other-provider-model', NOW(), NOW(), 'owner-a', 'sticky-provider-account',
      'gpt-other');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('sticky-provider-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
      'sticky-provider-model');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('other-provider-target', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL',
      'other-provider-model');
    INSERT INTO model_pool
      (id, "createdAt", "updatedAt", "userId", slug, name,
       "publicEgressEnabled")
    VALUES ('sticky-provider-pool', NOW(), NOW(), 'owner-a', 'sticky-provider',
      'Sticky provider', TRUE);
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId", tier, "publicOrder")
    VALUES ('sticky-provider-member', NOW(), NOW(), 'sticky-provider-pool',
      'sticky-provider-target', 'PUBLIC_OVERFLOW', 0);
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('sticky-provider-token', NOW(), NOW(), 'owner-a', 'Sticky token',
      'sticky-provider-prefix', 'sticky-provider-secret-digest');
    INSERT INTO model_api_token
      (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest")
    VALUES ('grantee-provider-token', NOW(), NOW(), 'owner-b', 'Grantee sticky token',
      'grantee-provider-prefix', 'grantee-provider-secret-digest');
    INSERT INTO pool_grant
      (id, "createdAt", "updatedAt", "poolId", "ownerUserId", "granteeUserId")
    VALUES ('sticky-provider-grant', NOW(), NOW(), 'sticky-provider-pool', 'owner-a', 'owner-b');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "poolGrantId", "nativeSurface",
       "upstreamResponseIdDigest", "fallbackRoute", "expiresAt")
    VALUES ('sticky-provider-binding', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'sticky-routing-digest', 3, 'sticky-provider-pool', 'sticky-provider-target',
      'sticky-provider-account', 'sticky-provider-model', 'https://api.example.test/v1', 1,
      'gpt-responses', NULL, 'OPENAI_RESPONSES',
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-', 'pool-external', NOW() + INTERVAL '1 hour');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "poolGrantId", "nativeSurface",
       "upstreamResponseIdDigest", "fallbackRoute", "expiresAt")
    VALUES ('grantee-provider-binding', NOW(), NOW(), 'owner-b', 'grantee-provider-token',
      'grantee-sticky-routing-digest', 3, 'sticky-provider-pool', 'sticky-provider-target',
      'sticky-provider-account', 'sticky-provider-model', 'https://api.example.test/v1', 1,
      'gpt-responses', 'sticky-provider-grant', 'OPENAI_RESPONSES',
      'efghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd', 'pool-external',
      NOW() + INTERVAL '1 hour');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetDiscoveredModelId", "selectedDiscoveredModelId", "expiresAt")
    VALUES ('legacy-sticky-collision', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'legacy-sticky-routing-digest', 1, 'model-a', 'model-a', NOW() + INTERVAL '1 hour');
  `);
  await expectConstraintFailure(`
    UPDATE response_stickiness_record
       SET "providerEndpointVersion" = 2
     WHERE id = 'sticky-provider-binding'
  `);
  await expectConstraintFailure(`
    UPDATE response_stickiness_record
       SET "routingVersion" = 3,
           "targetDiscoveredModelId" = NULL,
           "selectedDiscoveredModelId" = NULL,
           "targetModelPoolId" = 'sticky-provider-pool',
           "selectedExecutionTargetId" = 'sticky-provider-target',
           "providerAccountId" = 'sticky-provider-account',
           "providerModelId" = 'sticky-provider-model',
           "providerEndpointIdentity" = 'https://api.example.test/v1',
           "providerEndpointVersion" = 1,
           "providerUpstreamModelId" = 'gpt-responses',
           "nativeSurface" = 'OPENAI_RESPONSES',
           "upstreamResponseIdDigest" =
             'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
     WHERE id = 'legacy-sticky-collision'
  `);
  await expectConstraintFailure(`
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "nativeSurface",
       "upstreamResponseIdDigest", "fallbackRoute", "expiresAt")
    VALUES ('cross-wired-provider-model', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'cross-wired-provider-model-digest', 3, 'sticky-provider-pool',
      'sticky-provider-target', 'sticky-provider-account', 'other-provider-model',
      'https://api.example.test/v1', 1, 'gpt-other', 'OPENAI_RESPONSES',
      'bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-a', 'pool-external',
      NOW() + INTERVAL '1 hour')
  `);
  await expectConstraintFailure(`
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "nativeSurface",
       "upstreamResponseIdDigest", "fallbackRoute", "expiresAt")
    VALUES ('cross-wired-provider-account', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'cross-wired-provider-account-digest', 3, 'sticky-provider-pool',
      'sticky-provider-target', 'other-provider-account', 'sticky-provider-model',
      'https://other.example.test/v1', 1, 'gpt-responses', 'OPENAI_RESPONSES',
      'cdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-ab', 'pool-external',
      NOW() + INTERVAL '1 hour')
  `);
  await expectConstraintFailure(`
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "nativeSurface",
       "upstreamResponseIdDigest", "fallbackRoute", "expiresAt")
    VALUES ('cross-wired-provider-pool', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'cross-wired-provider-pool-digest', 3, 'sticky-provider-pool',
      'other-provider-target', 'sticky-provider-account', 'other-provider-model',
      'https://api.example.test/v1', 1, 'gpt-other', 'OPENAI_RESPONSES',
      'defghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abc', 'pool-external',
      NOW() + INTERVAL '1 hour')
  `);
  // A provider binding must record the consented route that created it.
  await expectConstraintFailure(`
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "modelApiTokenId", "routingKeyDigest",
       "routingVersion", "targetModelPoolId", "selectedExecutionTargetId",
       "providerAccountId", "providerModelId", "providerEndpointIdentity",
       "providerEndpointVersion", "providerUpstreamModelId", "nativeSurface",
       "upstreamResponseIdDigest", "expiresAt")
    VALUES ('unconsented-provider-binding', NOW(), NOW(), 'owner-a', 'sticky-provider-token',
      'unconsented-provider-binding-digest', 3, 'sticky-provider-pool',
      'sticky-provider-target', 'sticky-provider-account', 'sticky-provider-model',
      'https://api.example.test/v1', 1, 'gpt-responses', 'OPENAI_RESPONSES',
      'hijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdefg',
      NOW() + INTERVAL '1 hour')
  `);
  await expectConstraintFailure(`
    UPDATE response_stickiness_record
       SET "fallbackRoute" = 'local'
     WHERE id = 'sticky-provider-binding'
  `);
  await client.query(`
    UPDATE provider_account
       SET "baseUrl" = 'https://replacement.example.test/v1',
           "endpointIdentity" = 'https://replacement.example.test/v1',
           "endpointVersion" = 2
     WHERE id = 'sticky-provider-account'
  `);
  const invalidatedBinding = await client.query(`
    SELECT record."providerEndpointVersion" AS bound_version,
           account."endpointVersion" AS current_version
      FROM response_stickiness_record record
      JOIN provider_account account ON account.id = record."providerAccountId"
     WHERE record.id = 'sticky-provider-binding'
  `);
  if (
    invalidatedBinding.rows[0]?.bound_version !== 1 ||
    invalidatedBinding.rows[0]?.current_version !== 2
  ) {
    throw new Error("Provider endpoint change did not preserve an invalidated binding snapshot");
  }
  // Pool membership is a write-time invariant of a v3 binding: removing the
  // member it was written against is a normal operation (follow-ups re-list
  // members live), so it must not block the next hardening apply.
  await client.query(`DELETE FROM pool_member WHERE id = 'sticky-provider-member'`); // policy: bounded-delete
  await client.query(sql);
  const bindingsAfterMemberRemoval = await client.query(`
    SELECT COUNT(*)::int AS count FROM response_stickiness_record
     WHERE id IN ('sticky-provider-binding', 'grantee-provider-binding')
  `);
  if (bindingsAfterMemberRemoval.rows[0]?.count !== 2) {
    throw new Error("Re-applied hardening changed v3 bindings after their member was removed");
  }
  // DL-1 (d): stickiness records are hot-path history without foreign keys,
  // so deleting a token or revoking a grant leaves the binding row behind as
  // an orphan (the retention sweep removes it at expiry). It can never be
  // served again: a follow-up must present the exact token id (ids are never
  // reused) and the exact live grant (routes.ts resolveStickyRoute).
  const bindingAnchors = async (id) =>
    (
      await client.query(
        `SELECT record."poolGrantId" AS grant_id,
                EXISTS (SELECT 1 FROM model_api_token token
                         WHERE token.id = record."modelApiTokenId") AS token_live,
                EXISTS (SELECT 1 FROM pool_grant grant_row
                         WHERE grant_row.id = record."poolGrantId") AS grant_live
           FROM response_stickiness_record record WHERE record.id = $1`,
        [id],
      )
    ).rows[0];
  await client.query(`DELETE FROM model_api_token WHERE id = 'sticky-provider-token'`); // policy: bounded-delete
  if ((await bindingAnchors("sticky-provider-binding"))?.token_live !== false) {
    throw new Error("Deleted model API token still anchors a provider Responses binding");
  }
  await client.query(`DELETE FROM pool_grant WHERE id = 'sticky-provider-grant'`); // policy: bounded-delete
  if ((await bindingAnchors("grantee-provider-binding"))?.grant_live !== false) {
    throw new Error("Revoked pool grant still anchors a provider Responses binding");
  }
  await client.query(`
    INSERT INTO pool_grant
      (id, "createdAt", "updatedAt", "poolId", "ownerUserId", "granteeUserId")
    VALUES ('replacement-sticky-provider-grant', NOW(), NOW(), 'sticky-provider-pool',
      'owner-a', 'owner-b')
  `);
  const afterReplacement = await bindingAnchors("grantee-provider-binding");
  if (
    afterReplacement?.grant_live !== false ||
    afterReplacement?.grant_id === "replacement-sticky-provider-grant"
  ) {
    throw new Error("Replacement pool grant resurrected an old provider Responses binding");
  }
  await client.query(`DELETE FROM model_api_token WHERE id = 'grantee-provider-token'`); // policy: bounded-delete
  if ((await bindingAnchors("grantee-provider-binding"))?.token_live !== false) {
    throw new Error("Deleted grantee token still anchors a provider Responses binding");
  }
  // Orphaned hot-path rows (bindings whose token, grant or pool is gone) are
  // legitimate under DL-1 (d): the next hardening apply must accept them,
  // including a pre-v3 binding whose pool was deleted.
  await client.query(`
    INSERT INTO model_pool (id, "createdAt", "updatedAt", "userId", slug, name)
    VALUES ('orphan-binding-pool', NOW(), NOW(), 'owner-a', 'orphan-binding', 'Orphan binding');
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest", "routingVersion",
       "targetModelPoolId", "expiresAt")
    VALUES ('orphan-pool-binding', NOW(), NOW(), 'owner-a', 'orphan-pool-binding-digest', 2,
      'orphan-binding-pool', NOW() + INTERVAL '1 hour');
    DELETE FROM model_pool WHERE id = 'orphan-binding-pool'; -- policy: bounded-delete
  `);
  await client.query(sql);
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
  await client.query(`
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "conversationDigest", "prefixDepth", "sessionId")
    SELECT 'affinity-a', NOW(), NOW(), NOW() + interval '1 hour', 'owner-a', 'owner-b',
      'pool-a', id, repeat('t', 32), 5, repeat('d', 43), repeat('p', 43), NULL, 1, 'affinity-a-session'
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "conversationDigest", "prefixDepth", "sessionId")
    SELECT 'affinity-b', NOW(), NOW(), NOW() + interval '1 hour', 'owner-a', 'owner-b',
      'pool-a', id, repeat('t', 32), 5, repeat('d', 43), NULL, repeat('b', 43), 0, 'affinity-b-session'
      FROM execution_target WHERE "discoveredModelId" = 'model-a';
  `);
  const conversationRows = await client.query(`
    SELECT COUNT(*)::int AS count FROM cache_affinity_record
     WHERE "tenantUserId" = 'owner-b' AND "poolId" = 'pool-a'
  `);
  if (conversationRows.rows[0].count !== 2) {
    throw new Error("Affinity prefix and conversation records did not coexist");
  }
  await expectConstraintFailure(
    `
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "conversationDigest", "prefixDepth", "sessionId")
    SELECT 'affinity-conversation-duplicate', NOW(), NOW(), NOW() + interval '1 hour',
      'owner-a', 'owner-b', 'pool-a', id, repeat('t', 32), 5, repeat('d', 43), NULL,
      repeat('b', 43), 0, 'duplicate-session'
      FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `,
    "23505",
  );
  await expectConstraintFailure(`
    UPDATE cache_affinity_record SET "prefixDigest" = repeat('x', 43)
     WHERE id = 'affinity-a'
  `);
  await expectConstraintFailure(
    `
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "conversationDigest", "prefixDepth", "sessionId")
    SELECT 'affinity-cross-owner', NOW(), NOW(), NOW() + interval '1 hour', 'owner-b',
      'owner-b', 'pool-a', id, repeat('t', 32), 5, repeat('d', 43), repeat('q', 43), NULL, 1, 'test-session'
      FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `,
    // DL-1 (d): the cache_affinity_owner trigger, not a foreign key.
    "23514",
  );
  await expectConstraintFailure(`
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "conversationDigest", "prefixDepth", "sessionId")
    SELECT 'affinity-expired', NOW(), NOW(), NOW(), 'owner-a', 'owner-a', 'pool-a', id,
      repeat('t', 32), 5, repeat('d', 43), repeat('q', 43), NULL, 1, 'test-session'
      FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `);
  await verifyAffinityNodeHardening();
  await verifyKvEvictionHardening();
  await verifyDeploymentOperatorHardening();
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
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "authType")
    VALUES ('provider-account-a', NOW(), NOW(), 'owner-a', 'test', 'Test',
      'https://provider.invalid', 'https://provider.invalid', 'BEARER');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('provider-model-a', NOW(), NOW(), 'owner-a', 'provider-account-a', 'provider-model');
    INSERT INTO execution_target
      (id, "createdAt", "updatedAt", "userId", kind, "providerModelId")
    VALUES ('provider-target-a', NOW(), NOW(), 'owner-a', 'PROVIDER_MODEL', 'provider-model-a');
    UPDATE model_pool
       SET "publicEgressEnabled" = TRUE
     WHERE id = 'pool-a';
    INSERT INTO pool_member
      (id, "createdAt", "updatedAt", "poolId", "executionTargetId", tier, "publicOrder")
    VALUES ('provider-member', NOW(), NOW(), 'pool-a', 'provider-target-a', 'PUBLIC_OVERFLOW', 0);
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
    INSERT INTO response_stickiness_record
      (id, "createdAt", "updatedAt", "userId", "routingKeyDigest",
       "targetExecutionTargetId", "selectedExecutionTargetId")
    VALUES ('provider-stickiness-second', NOW(), NOW(), 'owner-a', 'provider-second',
      'provider-target-a', 'provider-target-a');
    UPDATE relay_request
       SET "requestedExecutionTargetId" = 'provider-target-a',
           "selectedExecutionTargetId" = 'provider-target-a'
     WHERE id = 'old-relay';
  `);
  await expectConstraintFailure(`
    UPDATE response_stickiness_record
       SET "targetExecutionTargetId" = 'provider-target-a',
           "selectedExecutionTargetId" = 'provider-target-a'
     WHERE id = 'dual-stickiness'
  `);
  const preservedLocalBinding = await client.query(`
    SELECT "selectedDiscoveredModelId", "selectedExecutionTargetId"
      FROM response_stickiness_record WHERE id = 'dual-stickiness'
  `);
  const localTarget = await client.query(`
    SELECT id FROM execution_target WHERE "discoveredModelId" = 'model-a'
  `);
  if (
    preservedLocalBinding.rows[0].selectedDiscoveredModelId !== "model-a" ||
    preservedLocalBinding.rows[0].selectedExecutionTargetId !== localTarget.rows[0].id
  ) {
    throw new Error("Refused stickiness retarget changed its original local binding");
  }
  const providerCompatibility = await client.query(`
    SELECT "discoveredModelId" FROM pool_member WHERE id = 'provider-member'
  `);
  if (providerCompatibility.rows[0].discoveredModelId !== null) {
    throw new Error("Provider target incorrectly populated a legacy discovered-model FK");
  }
  const providerTelemetry = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM response_stickiness_record
        WHERE id IN ('provider-stickiness', 'provider-stickiness-second')
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

  // Provider configuration is a security/accounting graph, not a collection
  // of independently valid foreign keys. Prove PostgreSQL rejects mismatched
  // ownership, endpoint generations, auth envelopes, budget rules, and links.
  await expectConstraintFailure(`
    UPDATE provider_account SET "baseUrl" = 'https://changed.invalid'
     WHERE id = 'provider-account-a'
  `);
  await expectConstraintFailure(
    `
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('provider-model-wrong-owner', NOW(), NOW(), 'owner-b', 'provider-account-a', 'bad')
  `,
    "23503",
  );
  await client.query("BEGIN");
  await client.query(`
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix")
    VALUES ('credential-a', NOW(), 'owner-a', 'provider-account-a', 'BEARER', 'v1',
      decode('01', 'hex'), decode('000000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'tail');
    UPDATE provider_account SET "currentCredentialId" = 'credential-a'
     WHERE id = 'provider-account-a';
  `);
  await client.query("COMMIT");
  for (const mutation of [
    `id = 'credential-a-renamed'`,
    `"userId" = 'owner-b'`,
    `"providerAccountId" = 'missing-account'`,
    `"credentialType" = 'API_KEY'`,
    `"aadVersion" = 2`,
  ]) {
    await expectConstraintFailure(
      `UPDATE provider_credential SET ${mutation} WHERE id = 'credential-a'`,
      "55000",
    );
  }
  // Cipher material and operational timestamps are deliberately mutable so
  // key rotation and usage tracking remain possible without changing the AAD.
  await client.query(`
    UPDATE provider_credential
       SET "keyVersion" = 'v2', ciphertext = decode('0a', 'hex'),
           nonce = decode('0a0000000000000000000000', 'hex'),
           "authTag" = decode('01000000000000000000000000000000', 'hex'),
           "displaySuffix" = 'next', "lastUsedAt" = NOW()
     WHERE id = 'credential-a'
  `);
  await expectConstraintFailure(`
    UPDATE provider_account SET "currentCredentialId" = NULL
     WHERE id = 'provider-account-a'
  `);
  await expectConstraintFailure(
    `
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix")
    VALUES ('credential-a-duplicate', NOW(), 'owner-a', 'provider-account-a', 'BEARER', 'v1',
      decode('02', 'hex'), decode('010000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'tail')
  `,
    "23505",
  );
  await expectConstraintFailure(`
    UPDATE provider_account SET "authType" = 'API_KEY' WHERE id = 'provider-account-a'
  `);
  await client.query(`
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "authType")
    VALUES ('provider-account-b', NOW(), NOW(), 'owner-b', 'test', 'Test B',
      'https://provider-b.invalid', 'https://provider-b.invalid', 'API_KEY');
    INSERT INTO provider_account
      (id, "createdAt", "updatedAt", "userId", "providerType", label, "baseUrl",
       "endpointIdentity", "authType")
    VALUES ('provider-account-c', NOW(), NOW(), 'owner-a', 'test', 'Test C',
      'https://provider-c.invalid', 'https://provider-c.invalid', 'BEARER');
    INSERT INTO provider_model
      (id, "createdAt", "updatedAt", "userId", "providerAccountId", "upstreamModelId")
    VALUES ('provider-model-b', NOW(), NOW(), 'owner-b', 'provider-account-b', 'provider-model-b');
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix", status, "revokedAt")
    VALUES ('credential-b-revoked', NOW(), 'owner-b', 'provider-account-b', 'API_KEY', 'v1',
      decode('04', 'hex'), decode('030000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'tail', 'REVOKED', NOW());
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix", status, "revokedAt")
    VALUES ('credential-c-revoked', NOW(), 'owner-a', 'provider-account-c', 'BEARER', 'v1',
      decode('05', 'hex'), decode('040000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'tail', 'REVOKED', NOW());
  `);
  await expectConstraintFailure(`
    UPDATE provider_credential
       SET status = 'REPLACED', "replacedAt" = NOW(), "replacedById" = 'credential-c-revoked'
     WHERE id = 'credential-a'
  `);
  // A valid same-account replacement lifecycle remains allowed by both the
  // immutable-AAD trigger and the deferred graph constraints.
  await client.query("BEGIN");
  await client.query(`
    UPDATE provider_credential SET status = 'REVOKED', "revokedAt" = NOW()
     WHERE id = 'credential-a';
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix")
    VALUES ('credential-a-next', NOW(), 'owner-a', 'provider-account-a', 'BEARER', 'v2',
      decode('06', 'hex'), decode('050000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'next');
    UPDATE provider_credential
       SET status = 'REPLACED', "replacedAt" = NOW(), "replacedById" = 'credential-a-next',
           "revokedAt" = NULL
     WHERE id = 'credential-a';
    UPDATE provider_account SET "currentCredentialId" = 'credential-a-next'
     WHERE id = 'provider-account-a';
  `);
  await client.query("COMMIT");
  await expectConstraintFailure(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "providerAccountId", "poolId", "providerModelId")
    VALUES ('bad-attached-policy', NOW(), NOW(), 'owner-a', 'POOL_PROVIDER_MODEL',
      'provider-account-a', 'pool-a', 'provider-model-b')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_audit_event
      (id, "createdAt", "userId", "providerAccountId", action, "subjectId")
    VALUES ('bad-audit', NOW(), 'owner-b', 'provider-account-a', 'ACCOUNT_UPDATED', 'provider-account-a')
  `);
  await client.query(`
    INSERT INTO provider_pricing_version
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", version,
       currency, status, "accountingVersion", pricing, "chargeRules", "effectiveAt", "activatedAt")
    VALUES ('pricing-lifecycle-a', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'lifecycle-v1', 'USD', 'DRAFT', 'usage-v1', '{"ratesPerMillion":{"input":"1","output":"2"}}',
      '{"unknownCategories":"FAIL_CLOSED"}', NOW() + interval '1 hour', NULL)
  `);
  await expectConstraintFailure(
    `
    UPDATE provider_pricing_version SET "activatedAt" = NOW()
     WHERE id = 'pricing-lifecycle-a'
  `,
    "55000",
  );
  await client.query(`
    UPDATE provider_pricing_version SET status = 'ACTIVE', "activatedAt" = NOW()
     WHERE id = 'pricing-lifecycle-a'
  `);
  await expectConstraintFailure(
    `
    UPDATE provider_pricing_version SET "activatedAt" = "activatedAt" + interval '1 second'
     WHERE id = 'pricing-lifecycle-a'
  `,
    "55000",
  );
  await expectConstraintFailure(
    `
    UPDATE provider_pricing_version SET status = 'RETIRED',
      "activatedAt" = "activatedAt" + interval '1 second',
      "retiredAt" = "effectiveAt" + interval '1 hour'
     WHERE id = 'pricing-lifecycle-a'
  `,
    "55000",
  );
  await client.query(`
    UPDATE provider_pricing_version SET status = 'RETIRED',
      "retiredAt" = "effectiveAt" + interval '1 hour'
     WHERE id = 'pricing-lifecycle-a'
  `);
  await expectConstraintFailure(
    `
    UPDATE provider_pricing_version SET "retiredAt" = "retiredAt" + interval '1 second'
     WHERE id = 'pricing-lifecycle-a'
  `,
    "55000",
  );
  await client.query("BEGIN");
  await client.query(`
    INSERT INTO provider_credential
      (id, "createdAt", "userId", "providerAccountId", "credentialType", "keyVersion",
       ciphertext, nonce, "authTag", "displaySuffix")
    VALUES ('credential-wrong-auth', NOW(), 'owner-b', 'provider-account-b', 'BEARER', 'v1',
      decode('03', 'hex'), decode('020000000000000000000000', 'hex'),
      decode('00000000000000000000000000000000', 'hex'), 'tail');
    UPDATE provider_account SET "currentCredentialId" = 'credential-wrong-auth'
     WHERE id = 'provider-account-b';
  `);
  try {
    await client.query("COMMIT");
    throw new Error("Expected provider credential auth mismatch failure");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error?.code !== "23514") throw error;
  }
  await client.query(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "providerAccountId")
    VALUES ('budget-policy-a', NOW(), NOW(), 'owner-a', 'PROVIDER_ACCOUNT', 'provider-account-a')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "poolId", "poolGrantId")
    VALUES ('bad-grant-policy-account', NOW(), NOW(), 'owner-a', 'POOL_GRANT',
      'pool-a', 'sticky-provider-grant')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "providerAccountId", "poolId")
    VALUES ('bad-grant-policy-keys', NOW(), NOW(), 'owner-a', 'POOL_GRANT',
      'provider-account-a', 'pool-a')
  `);
  await client.query(`
    INSERT INTO pool_grant
      (id, "createdAt", "updatedAt", "poolId", "ownerUserId", "granteeUserId")
    VALUES ('budget-grant-a', NOW(), NOW(), 'pool-a', 'owner-a', 'owner-b')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "poolId", "granteeUserId", "poolGrantId")
    VALUES ('bad-grant-policy-owner', NOW(), NOW(), 'owner-b', 'POOL_GRANT',
      'pool-a', 'owner-b', 'budget-grant-a')
  `);
  await client.query(`
    INSERT INTO provider_budget_policy
      (id, "createdAt", "updatedAt", "userId", "scopeType", "poolId", "granteeUserId", "poolGrantId")
    VALUES ('budget-grant-policy-a', NOW(), NOW(), 'owner-a', 'POOL_GRANT',
      'pool-a', 'owner-b', 'budget-grant-a')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_rule
      (id, "createdAt", "policyId", metric, period, mode, "limitValue")
    VALUES ('fractional-token-rule', NOW(), 'budget-policy-a', 'TOKENS', 'UTC_DAY',
      'LIMITED', 1.5)
  `);
  await client.query(`
    INSERT INTO provider_budget_rule
      (id, "createdAt", "policyId", metric, period, mode, "limitValue")
    VALUES ('token-rule', NOW(), 'budget-policy-a', 'TOKENS', 'UTC_DAY', 'LIMITED', 10)
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_reservation
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "policyId", "ruleId",
       "requestId", "attemptId", "fencingToken", metric, period, "policyVersion", "windowStart",
       "windowEnd", "reservedValue", "accountingVersion")
    VALUES ('bad-reservation', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'budget-policy-a', 'token-rule', 'r', 'a', 1, 'SPEND', 'UTC_DAY', 1,
      date_trunc('day', NOW()), date_trunc('day', NOW()) + interval '1 day', 1, 'usage-v1')
  `);
  // Simulate a reservation written by the immediately previous application
  // version before provider_attempt anchors existed. The next idempotent
  // hardening pass must preserve it and synthesize its durable attempt anchor.
  await client.query(
    `DROP TRIGGER provider_budget_reservation_graph_consistency ON provider_budget_reservation`,
  );
  await client.query(`
    INSERT INTO provider_budget_reservation
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "policyId", "ruleId",
       "requestId", "attemptId", "fencingToken", metric, period, "policyVersion", "windowStart",
       "windowEnd", "reservedValue", "liabilityTokens", "accountingVersion", "expiresAt")
    VALUES ('legacy-reservation', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'budget-policy-a', 'token-rule', 'legacy-request', 'legacy-attempt', 7, 'TOKENS', 'UTC_DAY', 1,
      date_trunc('day', NOW()), date_trunc('day', NOW()) + interval '1 day', 4, 4, 'usage-v1',
      NOW() + interval '1 hour')
  `);
  // A real previous-schema upgrade also arrives with legacy accounting rows
  // and the old append-only triggers already installed. The compatibility
  // transaction must temporarily remove only the triggers guarding rows it
  // rewrites, then restore them before commit.
  await client.query(
    `ALTER TABLE provider_budget_settlement DROP CONSTRAINT provider_budget_settlement_shape_check`,
  );
  await client.query(
    `ALTER TABLE provider_usage_ledger DROP CONSTRAINT provider_usage_ledger_shape_check`,
  );
  await client.query(
    `DROP TRIGGER provider_budget_settlement_graph_consistency ON provider_budget_settlement`,
  );
  await client.query(`
    INSERT INTO provider_attempt
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "requestId",
       "attemptId", "fencingToken", "expiresAt", "liabilityTokens", "accountingVersion",
       state, "terminalAt", "terminalReason")
    VALUES ('legacy-history-attempt', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'legacy-history-request', 'legacy-history', 8, NOW() + interval '1 hour', 4, 'usage-v1',
      'EXPIRED', NOW(), 'CRASH_RECOVERY');
    INSERT INTO provider_budget_reservation
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "policyId", "ruleId",
       "requestId", "attemptId", "fencingToken", metric, period, "policyVersion", "windowStart",
       "windowEnd", "reservedValue", "liabilityTokens", "accountingVersion", "expiresAt")
    VALUES ('legacy-history-reservation', NOW(), 'owner-a', 'provider-account-a',
      'provider-model-a', 'budget-policy-a', 'token-rule', 'legacy-history-request',
      'legacy-history', 8, 'TOKENS', 'UTC_DAY', 1, date_trunc('day', NOW()),
      date_trunc('day', NOW()) + interval '1 day', 4, 4, 'usage-v1', NOW() + interval '1 hour');
    INSERT INTO provider_usage_ledger
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "reservationId",
       "requestId", "attemptId", "fencingToken", "accountingVersion", "sourceVersion",
       "usageSource", "revisionSequence", "revisionKind", "payloadHash", "usageKnown",
       "costKnown", "terminalReason", confidence, "billableTotal", "categoriesComplete")
    VALUES ('legacy-history-ledger', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'legacy-history-reservation', 'legacy-history-request', 'legacy-history', 8, 'usage-v1',
      'legacy-history-v1', 'legacy', 1, 'SNAPSHOT', 'legacy-pending', true, false,
      'FAILED', 'REPORTED', 4, true);
    INSERT INTO provider_budget_settlement
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "requestId",
       "reservationId", "attemptId", "fencingToken", "sourceVersion", "revisionSequence",
       "revisionKind", "payloadHash", "accountingVersion", "settledValue", confidence, reason)
    VALUES ('legacy-history-settlement', NOW(), 'owner-a', '', '', '',
      'legacy-history-reservation', 'legacy-history', 8, 'legacy-history-v1', 1,
      'SNAPSHOT', 'legacy-pending', '', 4, 'ESTIMATED', 'FAILED')
  `);

  // Recreate the deployment boundary and prove a transaction from an old
  // instance cannot slip a discovered model between trigger install/backfill.
  await client.query(`DROP TRIGGER discovered_model_create_execution_target ON discovered_model`);
  await oldWriter.connect();
  await hardeningClient.connect();
  await oldWriter.query(`SET search_path TO ${schema}`);
  await oldWriter.query("SET wsmp.fences = ',*,'");
  await hardeningClient.query(`SET search_path TO ${schema}`);
  await oldWriter.query("BEGIN");
  await oldWriter.query(`
    INSERT INTO discovered_model
      (id, "createdAt", "updatedAt", "userId", "endpointId", "upstreamModelId", "encodedModelId")
    VALUES ('model-during-rollout', NOW(), NOW(), 'owner-a', 'endpoint-a',
      'during-rollout', 'owner-a/cli/local/during-rollout')
  `);
  // The hardening transaction never waits while the old writer holds its
  // table: its up-front NOWAIT lock fails and the production wrapper retries
  // the whole transaction until the writer has committed.
  const rolloutHardening = runHardeningProcess(schemaUrl.toString(), {
    SCHEMA_HARDENING_FORCE: "1",
  });
  await waitForHardeningRetry(rolloutHardening, async () => {
    await oldWriter.query("ROLLBACK");
  });
  await oldWriter.query("COMMIT");
  const rolloutResult = await rolloutHardening.completion;
  if (rolloutResult.code !== 0)
    throw new Error(`Rollout hardening failed: ${rolloutHardening.output().stderr}`);
  const upgradedHistory = await client.query(`
    SELECT ledger."payloadHash" AS ledger_hash, settlement."payloadHash" AS settlement_hash,
           settlement."providerAccountId" AS account_id, settlement."requestId" AS request_id,
           ledger."observationComplete" AS observation_complete,
           attempt.state AS attempt_state, attempt."terminalReason" AS attempt_reason
      FROM provider_usage_ledger ledger
      JOIN provider_budget_settlement settlement
        ON settlement."attemptId" = ledger."attemptId"
      JOIN provider_attempt attempt
        ON attempt."attemptId" = ledger."attemptId" AND attempt."fencingToken" = ledger."fencingToken"
     WHERE ledger.id = 'legacy-history-ledger'
  `);
  if (
    upgradedHistory.rows[0]?.ledger_hash === "legacy-pending" ||
    upgradedHistory.rows[0]?.settlement_hash !== upgradedHistory.rows[0]?.ledger_hash ||
    upgradedHistory.rows[0]?.account_id !== "provider-account-a" ||
    upgradedHistory.rows[0]?.request_id !== "legacy-history-request" ||
    upgradedHistory.rows[0]?.observation_complete !== true ||
    upgradedHistory.rows[0]?.attempt_state !== "FAILED" ||
    upgradedHistory.rows[0]?.attempt_reason !== "FAILED"
  ) {
    throw new Error("Previous-schema accounting history was not upgraded atomically");
  }
  const restoredHistoryTriggers = await client.query(`
    SELECT tgname FROM pg_trigger
     WHERE tgrelid IN ('provider_usage_ledger'::regclass, 'provider_budget_settlement'::regclass)
       AND tgname IN ('provider_usage_ledger_immutable', 'provider_budget_settlement_immutable')
       AND tgenabled <> 'D'
  `);
  if (restoredHistoryTriggers.rowCount !== 2) {
    throw new Error("Accounting immutability triggers were not restored before commit");
  }
  const legacyAttempt = await client.query(`
    SELECT "requestId", "liabilityTokens", "accountingVersion"
      FROM provider_attempt WHERE "attemptId" = 'legacy-attempt' AND "fencingToken" = 7
  `);
  if (legacyAttempt.rowCount !== 1 || legacyAttempt.rows[0].requestId !== "legacy-request") {
    throw new Error("Provider attempt compatibility backfill did not preserve the legacy row");
  }
  await expectConstraintFailure(`
    INSERT INTO provider_usage_ledger
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "requestId",
       "attemptId", "fencingToken", "accountingVersion", "sourceVersion", "usageSource",
       "revisionSequence", "revisionKind", "payloadHash", "usageKnown", "costKnown",
       "terminalReason", confidence)
    VALUES ('bad-ledger-anchor', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'wrong-request', 'legacy-attempt', 7, 'usage-v1', 'bad-ledger-v1', 'test', 1,
      'SNAPSHOT', 'bad-ledger-hash', false, false, 'FAILED', 'ESTIMATED')
  `);
  await expectConstraintFailure(`
    INSERT INTO provider_budget_settlement
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "requestId",
       "reservationId", "attemptId", "fencingToken", "sourceVersion", "revisionSequence",
       "revisionKind", "payloadHash", "accountingVersion", "settledValue", confidence, reason)
    VALUES ('bad-settlement-anchor', NOW(), 'owner-a', 'provider-account-c', 'provider-model-a',
      'legacy-request', 'legacy-reservation', 'legacy-attempt', 7, 'bad-settlement-v1', 1,
      'SNAPSHOT', 'bad-settlement-hash', 'usage-v1', 1, 'ESTIMATED', 'FAILED')
  `);
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

  // Prove a failed compatibility validation rolls back both row rewrites and
  // trigger DDL, leaving the previously installed protection active.
  await client.query(
    `ALTER TABLE provider_usage_ledger DROP CONSTRAINT provider_usage_ledger_shape_check`,
  );
  await client.query(`
    INSERT INTO provider_usage_ledger
      (id, "createdAt", "userId", "providerAccountId", "providerModelId", "requestId",
       "attemptId", "fencingToken", "accountingVersion", "sourceVersion", "usageSource",
       "revisionSequence", "revisionKind", "payloadHash", "usageKnown", "costKnown",
       "terminalReason", confidence)
    VALUES ('invalid-upgrade-ledger', NOW(), 'owner-a', 'provider-account-a', 'provider-model-a',
      'legacy-history-request', 'legacy-history', 8, 'usage-v1', 'invalid-v1', 'legacy', -1,
      'SNAPSHOT', 'invalid-hash', false, false, 'FAILED', 'ESTIMATED')
  `);
  try {
    await client.query(sql);
    throw new Error("Expected compatibility validation failure");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error?.code !== "23514") throw error;
  }
  await expectConstraintFailure(
    `UPDATE provider_usage_ledger SET "payloadHash" = 'mutated' WHERE id = 'legacy-history-ledger'`,
    "55000",
  );
  await client.query(`DROP TRIGGER provider_usage_ledger_immutable ON provider_usage_ledger`);
  await client.query(`DELETE FROM provider_usage_ledger WHERE id = 'invalid-upgrade-ledger'`); // policy: bounded-delete
  await client.query(sql);

  // A child-first application transaction can conflict with hardening's
  // parent-first lock order. Force a lock timeout and prove the production
  // apply wrapper retries the complete transaction and then converges.
  await oldWriter.query("BEGIN");
  await oldWriter.query("LOCK TABLE pool_member IN ACCESS EXCLUSIVE MODE");
  const retryingHardening = runHardeningProcess(schemaUrl.toString(), {
    SCHEMA_HARDENING_LOCK_TIMEOUT_MS: "100",
    SCHEMA_HARDENING_FORCE: "1",
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

  // DL-1 cycle 5: a lease release mid-flight holds an inference_capacity row
  // FOR UPDATE and RowExclusive on capacity_lease. Hardening must never wait
  // on it (it would then hold its other tables while the release waits on
  // them): it retries, the release finishes without ever being blocked, and
  // no deadlock is detected.
  const capacityRow = await client.query("SELECT id FROM inference_capacity ORDER BY id LIMIT 1");
  const capacityId = capacityRow.rows[0]?.id;
  if (!capacityId) throw new Error("Hardening fixture has no inference_capacity row");
  const deadlocksBefore = await databaseDeadlocks();
  const releasePid = (await hardeningClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await hardeningClient.query("BEGIN");
  await hardeningClient.query("SELECT id FROM inference_capacity WHERE id = $1 FOR UPDATE", [
    capacityId,
  ]);
  await hardeningClient.query("UPDATE capacity_lease SET state = state WHERE false");
  const releaseRace = runHardeningProcess(schemaUrl.toString(), { SCHEMA_HARDENING_FORCE: "1" });
  await waitForHardeningRetry(releaseRace, async () => {
    await hardeningClient.query("ROLLBACK");
  });
  const blockers = await admin.query("SELECT pg_blocking_pids($1::int) AS pids", [releasePid]);
  if (blockers.rows[0].pids.length > 0)
    throw new Error(`Lease release was blocked by ${blockers.rows[0].pids.join(",")}`);
  await hardeningClient.query("SET LOCAL lock_timeout = '2s'");
  await hardeningClient.query(
    'UPDATE inference_capacity SET "hardConcurrencyLimit" = "hardConcurrencyLimit" WHERE id = $1',
    [capacityId],
  );
  await hardeningClient.query("UPDATE capacity_lease SET state = state WHERE false");
  await hardeningClient.query("COMMIT");
  const releaseRaceResult = await releaseRace.completion;
  if (releaseRaceResult.code !== 0)
    throw new Error(`Hardening did not converge after the release: ${releaseRace.output().stderr}`);
  const deadlocksAfter = await databaseDeadlocks();
  if (deadlocksAfter !== deadlocksBefore)
    throw new Error(
      `Hardening vs lease release detected ${deadlocksAfter - deadlocksBefore} deadlock(s)`,
    );

  // Version gate: an unchanged SQL file on an unchanged catalog is skipped
  // without taking any table lock (the held ACCESS EXCLUSIVE lock would make
  // any hardening attempt fail and retry).
  async function unforcedHardening() {
    const run = runHardeningProcess(schemaUrl.toString(), {
      SCHEMA_HARDENING_LOCK_TIMEOUT_MS: "100",
    });
    const result = await run.completion;
    if (result.code !== 0) throw new Error(`Unforced hardening failed: ${run.output().stderr}`);
    return run.output();
  }
  await oldWriter.query("BEGIN");
  await oldWriter.query("LOCK TABLE pool_member IN ACCESS EXCLUSIVE MODE");
  const skipped = await unforcedHardening();
  await oldWriter.query("ROLLBACK");
  if (!skipped.stdout.includes("skipping") || skipped.stderr.includes("retrying"))
    throw new Error(`Unchanged hardening was not skipped lock-free: ${JSON.stringify(skipped)}`);
  // Any catalog drift (here: a hardening trigger dropped) re-applies.
  await client.query("DROP TRIGGER relay_request_execution_target_consistency ON relay_request");
  const reapplied = await unforcedHardening();
  if (reapplied.stdout.includes("skipping"))
    throw new Error("Hardening skipped although its trigger was missing");
  const restored = await client.query(
    "SELECT 1 FROM pg_trigger WHERE tgname = 'relay_request_execution_target_consistency' AND tgrelid = 'relay_request'::regclass",
  );
  if (restored.rowCount !== 1) throw new Error("Re-applied hardening did not restore its trigger");
  // A `prisma db push` of the unchanged schema leaves the fingerprint alone.
  execFileSync("pnpm", ["exec", "prisma", "db", "push"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: prismaUrl.toString() },
    stdio: "pipe",
  });
  const afterPush = await unforcedHardening();
  if (!afterPush.stdout.includes("skipping"))
    throw new Error("A no-op prisma db push changed the catalog fingerprint");

  // Pre-push NULL cleanup: safe mode refuses legacy rows; dangerous mode deletes
  // exactly the rows schema-hardening.sql removes before NOT NULL (lines 122-126).
  const { runPrePushNullCleanup } = await import("./pre-push-null-cleanup.mjs");
  const unboundCredentialId = `verify-null-credential-${randomBytes(6).toString("hex")}`;
  const ownerRow = await client.query(`SELECT id FROM "user" ORDER BY id LIMIT 1`);
  const ownerId = ownerRow.rows[0]?.id;
  if (!ownerId) throw new Error("Hardening fixture has no user row");
  await client.query(`
    INSERT INTO cache_affinity_record
      (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
       "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
       "prefixDepth", "sessionId")
      SELECT 'affinity-null-session', "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
        "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", repeat('s', 43), 1, 'legacy-session'
      FROM cache_affinity_record WHERE id = 'affinity-a'`);
  await client.query(`ALTER TABLE cache_affinity_record DISABLE TRIGGER USER`);
  await client.query(`ALTER TABLE cache_affinity_record ALTER COLUMN "sessionId" DROP NOT NULL`);
  await client.query(
    `UPDATE cache_affinity_record SET "sessionId" = NULL WHERE id = 'affinity-null-session'`,
  );
  await client.query(`ALTER TABLE cache_affinity_record ALTER COLUMN "tenantUserId" DROP NOT NULL`);
  await client.query(
    `ALTER TABLE cache_affinity_record ALTER COLUMN "bindingDigest" DROP NOT NULL`,
  );
  await client.query(
    `UPDATE cache_affinity_record SET "tenantUserId" = NULL WHERE id = 'affinity-a'`,
  );
  await client.query(
    `UPDATE cache_affinity_record SET "bindingDigest" = NULL WHERE id = 'affinity-b'`,
  );
  await client.query(`ALTER TABLE cache_affinity_record ENABLE TRIGGER USER`);
  await client.query(`ALTER TABLE cli_device_credential ALTER COLUMN "cliDeviceId" DROP NOT NULL`);
  await client.query(
    `INSERT INTO cli_device_credential (id, "userId", "cliDeviceId", "lookupPrefix", "secretDigest")
     VALUES ($1, $2, NULL, $3, 'fixture-digest')`,
    [unboundCredentialId, ownerId, `prefix-${unboundCredentialId}`],
  );
  let safeFailed = false;
  try {
    await runPrePushNullCleanup(client, { dangerous: false });
  } catch (error) {
    safeFailed = /pre-push-null-cleanup/i.test(String(error));
  }
  if (!safeFailed) throw new Error("Safe pre-push NULL cleanup did not refuse legacy rows");
  const beforeDangerous = await client.query(`
    SELECT count(*)::int AS count FROM cache_affinity_record
     WHERE id IN ('affinity-a', 'affinity-b', 'affinity-null-session')
       AND ("tenantUserId" IS NULL OR "bindingDigest" IS NULL OR "sessionId" IS NULL)
  `);
  if (beforeDangerous.rows[0].count !== 3)
    throw new Error("Safe mode must not delete incompatible affinity rows");
  await runPrePushNullCleanup(client, { dangerous: true });
  const affinityLeft = await client.query(`
    SELECT count(*)::int AS count FROM cache_affinity_record
     WHERE id IN ('affinity-a', 'affinity-b', 'affinity-null-session')
       AND ("tenantUserId" IS NULL OR "bindingDigest" IS NULL OR "sessionId" IS NULL)
  `);
  const credentialLeft = await client.query(
    `SELECT count(*)::int AS count FROM cli_device_credential WHERE id = $1`,
    [unboundCredentialId],
  );
  if (affinityLeft.rows[0].count !== 0 || credentialLeft.rows[0].count !== 0) {
    throw new Error("Dangerous pre-push cleanup did not delete the legacy NULL rows");
  }

  // The cleanup's waits are bounded (r2 P4): behind an ACCESS EXCLUSIVE lock
  // each attempt fails at lock_timeout (55P03) and is retried within the
  // attempt budget, then the error surfaces; it never waits indefinitely.
  const { runPrePushNullCleanupBounded } = await import("./pre-push-null-cleanup.mjs");
  const boundedUrl = new URL(schemaUrl);
  boundedUrl.searchParams.set(
    "options",
    `${boundedUrl.searchParams.get("options")} -c lock_timeout=200ms -c statement_timeout=5000ms`,
  );
  boundedUrl.search = boundedUrl.searchParams.toString().replace(/\+/g, "%20");
  await oldWriter.query("BEGIN");
  await oldWriter.query("LOCK TABLE cli_device_credential IN ACCESS EXCLUSIVE MODE");
  const retries = [];
  const boundedStarted = Date.now();
  let boundedError = null;
  try {
    await runPrePushNullCleanupBounded({
      connectionString: boundedUrl.toString(),
      dangerous: false,
      maxAttempts: 3,
      backoffFor: () => 10,
      log: (line) => retries.push(line),
    });
  } catch (error) {
    boundedError = error;
  } finally {
    await oldWriter.query("ROLLBACK");
  }
  const boundedMs = Date.now() - boundedStarted;
  if (boundedError?.code !== "55P03" || retries.length !== 2 || boundedMs > 10_000) {
    throw new Error(
      `Pre-push cleanup did not bound its lock wait: ${JSON.stringify({
        code: boundedError?.code ?? null,
        retries: retries.length,
        boundedMs,
      })}`,
    );
  }

  // DEL-STATE commit point: a session insert for a user whose deletion is
  // pending is refused by the trigger; other users are unaffected.
  await client.query(`
    INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug, "deletionRequestedAt")
    VALUES ('session-live', NOW(), NOW(), 'L', 'session-live@example.test', 'session-live', NULL),
           ('session-deleting', NOW(), NOW(), 'D', 'session-deleting@example.test',
            'session-deleting', NOW())`);
  await client.query(`
    INSERT INTO session (id, "createdAt", "updatedAt", "expiresAt", token, "userId")
    VALUES ('session-live-1', NOW(), NOW(), NOW() + interval '1 hour', 'session-live-1', 'session-live')`);
  await expectConstraintFailure(
    `INSERT INTO session (id, "createdAt", "updatedAt", "expiresAt", token, "userId")
     VALUES ('session-deleting-1', NOW(), NOW(), NOW() + interval '1 hour', 'session-deleting-1',
             'session-deleting')`,
    "WMPD1",
  );

  process.stdout.write("Schema-hardening PostgreSQL integration validation complete.\n");
} finally {
  await oldWriter.end().catch(() => undefined);
  await hardeningClient.end().catch(() => undefined);
  await client.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
