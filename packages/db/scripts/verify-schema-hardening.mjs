/**
 * Verifies prisma/schema-hardening.sql against the 0.4.0 schema.
 *
 * Source checks (always): the file's transaction shape, one up-front LOCK covering every table
 * it names, the generated registry block equal to scripts/registry-checks.mjs output, every
 * hardening object of the plan (docs/contracts/0.4.0-schema-hardening.md) that has landed, and
 * the deploy wiring (every push path runs the retrying push and the hardening).
 *
 * PostgreSQL integration (with SCHEMA_VALIDATION_DATABASE_URL): pushes the schema into a
 * throwaway schema, applies the hardening (twice: the second run must skip, a forced third must
 * succeed), then exercises each object: ownership, shapes, uniques, fences, and the delete-rule
 * cases of the plan. The schema is dropped afterwards.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hardeningSqlBody } from "./hardening-sql.mjs";
import { currentBlock, registryChecksSql } from "./registry-checks.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const schemaDir = fileURLToPath(new URL("../prisma/schema/", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const prismaSources = (
  await Promise.all(
    (
      await readdir(schemaDir)
    )
      .filter((name) => name.endsWith(".prisma"))
      .map((name) => readFile(`${schemaDir}${name}`, "utf8")),
  )
).join("\n");
const [packageJson, agentCompose, entrypoint, dangerousWrapper, applyScript] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../../../docker-compose.agent.yml", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/docker-entrypoint.sh", import.meta.url), "utf8"),
  readFile(new URL("../../../scripts/db-push-dangerous-local.sh", import.meta.url), "utf8"),
  readFile(new URL("./apply-schema-hardening.mjs", import.meta.url), "utf8"),
]);

// ── Source checks ──

hardeningSqlBody(sql);

const generated = currentBlock(sql);
if (generated === null) throw new Error("schema-hardening.sql lost its generated registry block");
if (generated !== registryChecksSql())
  throw new Error(
    "The registry block is stale: run `node scripts/registry-checks.mjs --write` in packages/db",
  );

/** Objects the plan lands in S0a (shapes, ownership, fences, delete rules). */
const REQUIRED_OBJECTS = [
  // shared and auth
  "wsmp_registry_ok",
  "reject_immutable_history_mutation",
  "session_refuse_deleting_user",
  "user_deletion_marker_guard",
  // nodes
  "node_shape_check",
  "node_port_range_check",
  "node_trust_lower_shape",
  "node_frozen_fabrics_shape",
  "node_temporary_shape",
  "node_hold_shape",
  "node_hold_profile_owner",
  "node_command_max_check",
  "node_command_shape",
  "node_command_transition",
  "profile_node_hold_shape",
  "wsmp_is_fabric_ip",
  "fabric_member_in_use",
  "fabric_shape",
  "fabric_member_shape",
  "node_metric_commands_shape",
  "node_credential_one_active",
  "node_enrollment_code_shape",
  "node_enrollment_code_use",
  "node_enrollment_use_shape",
  "node_delete_release",
  "node_audit_event_shape",
  "node_audit_event_append_only",
  "queued_node_command_shape",
  "queued_node_command_transition",
  // runtimes
  "runtime_kind_shape_check",
  "runtime_version_derived_columns",
  "runtime_version_immutable",
  "runtime_current_version_consistency",
  "runtime_version_advanced_check",
  "runtime_version_limits_check",
  "runtime_one_always_on_instance",
  "runtime_instance_shape",
  "runtime_instance_notify_failures",
  "runtime_instance_operator_shape",
  "runtime_instance_launch_version",
  "runtime_operation_profile",
  "instance_rank_bounds",
  "instance_rank_reserved_port",
  "instance_rank_claim_shape",
  "instance_rank_held_unknown_id",
  "instance_step_shape",
  "instance_step_operator_shape",
  "instance_step_operator_hold",
  "execution_target_kind_source_xor_check",
  "execution_target_identity_immutable",
  // profiles
  "profile_owner_consistency",
  // pools
  "pool_create_children",
  "pool_owner_immutable",
  "pool_routing_policy_check",
  "pool_advanced_overrides_check",
  "pool_member_kind_shape_check",
  "pool_member_cloud_order_unique",
  "pool_member_source",
  "pool_sidecar_target_check",
  "pool_routing_rule_shape_check",
  "pool_routing_rule_member",
  "pool_routing_rule_on_member_delete",
  // access
  "share_shape",
  "share_permission_shape",
  "share_consistency",
  "share_delete_cleanup",
  "share_invite_shape",
  "share_invite_transition",
  "share_invite_one_pending",
  "share_invite_expiry",
  "api_key_pool_access",
  // providers and spend
  "provider_account_shape_check",
  "provider_credential_one_active_per_account",
  "provider_pricing_version_immutable",
  "provider_credential_account_consistency",
  "provider_account_current_credential_consistency",
  "spend_cap_shape_check",
  "spend_cap_scope_check",
  "spend_reservation_transition",
  "spend_settlement_immutable",
  "usage_ledger_immutable",
  // hot path (S0d)
  "wsmp_priority_class_rank",
  "capacity_scheduler_check",
  "admission_request_shape_check",
  "admission_request_priority_share_check",
  "capacity_waiter_shape_check",
  "capacity_lease_shape_check",
  "capacity_waiter_one_admitted_winner",
  "capacity_waiter_unique_test_candidate",
  "capacity_lease_one_live_attempt",
  "enforce_capacity_reference_consistency",
  "admission_history_identity",
  "capacity_lease_history_identity",
  "capacity_kv_eviction_shape_check",
  "cache_affinity_record_shape_check",
  "cache_affinity_node_shape_check",
  "cache_affinity_observer_shape",
  "cache_affinity_residency_bound",
  "wsmp_affinity_generation",
  "wsmp_affinity_generation_ready",
  "cache_affinity_owner",
  "cache_affinity_identity_immutable",
  "cache_affinity_generation_insert",
  "cache_affinity_residency_insert",
  "response_stickiness_provider_binding_check",
  "response_stickiness_provider_binding_immutable",
  "relay_request_execution_telemetry_check",
  "a_relay_request_resource_owner",
  "relay_request_execution_target_consistency",
  // telemetry and misc
  "attempt_event_immutable",
  "runtime_load_minute_shape_check",
  "node_metrics_minute_shape_check",
  "audit_event_immutable",
  // fences
  "wsmp_acquire_fences",
  "wsmp_require_fence",
  "wsmp_graph_row_owners",
  "enforce_graph_write_fence",
  "install_graph_write_fences",
];
for (const name of REQUIRED_OBJECTS)
  if (!new RegExp(`\\b${name}\\b`).test(sql))
    throw new Error(`schema-hardening.sql is missing ${name}`);

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
  ["package db:push", packageJson, "node scripts/push-schema.mjs &&"],
  ["container entrypoint", entrypoint, "node scripts/push-schema.mjs $push_flags"],
  ["dangerous local wrapper", dangerousWrapper, "node scripts/push-schema.mjs --accept-data-loss"],
]) {
  if (!contents.includes(fragment)) throw new Error(`${name} bypasses ${fragment}`);
}

// DL-1: the first statement locks every repository table named outside comments and literals.
function stripSqlCommentsAndLiterals(source) {
  return source
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, (body) => body.replace(/'(?:[^']|'')*'/g, "''"))
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}
const tables = [...prismaSources.matchAll(/@@map\("([a-z_]+)"\)/g)].map((match) => match[1]);
const code = stripSqlCommentsAndLiterals(sql);
const locks = [
  ...code.matchAll(/\bLOCK\s+TABLE\s+([\s\S]*?)\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s+NOWAIT\s*;/gi),
];
if (locks.length !== 1)
  throw new Error(`expected one LOCK TABLE ... NOWAIT, found ${locks.length}`);
const firstStatement = code.slice(code.search(/\bBEGIN\s*;/i) + 6).trimStart();
if (!/^LOCK\s+TABLE\b/i.test(firstStatement))
  throw new Error("the LOCK TABLE must be the first statement after BEGIN");
const locked = new Set(
  (locks[0]?.[1] ?? "").split(",").map((name) => name.trim().replace(/^"|"$/g, "")),
);
const missing = tables.filter(
  (table) =>
    new RegExp(`(?<![A-Za-z0-9_."])"?${table}"?(?![A-Za-z0-9_"])`).test(code) && !locked.has(table),
);
if (missing.length > 0) throw new Error(`LOCK TABLE misses: ${missing.join(", ")}`);
for (const table of locked)
  if (!tables.includes(table)) throw new Error(`LOCK TABLE names an unknown table: ${table}`);

const baseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (!baseUrl) {
  process.stdout.write(
    "Schema-hardening source validation complete; PostgreSQL integration skipped (set SCHEMA_VALIDATION_DATABASE_URL).\n",
  );
  process.exit(0);
}

// ── PostgreSQL integration ──

const schema = `schema_validation_${randomBytes(8).toString("hex")}`;
const prismaUrl = new URL(baseUrl);
prismaUrl.searchParams.set("schema", schema);
const schemaUrl = new URL(baseUrl);
schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
schemaUrl.search = schemaUrl.searchParams.toString().replace(/\+/g, "%20");
const admin = new pg.Client({ connectionString: baseUrl });
const client = new pg.Client({ connectionString: schemaUrl.toString() });
const app = new pg.Client({ connectionString: schemaUrl.toString() });

function runHardening(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/apply-schema-hardening.mjs"], {
      cwd: packageRoot,
      env: { ...process.env, ...extraEnv, DATABASE_URL: schemaUrl.toString() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`hardening exited ${code}:\n${output}`)),
    );
  });
}

let failures = 0;
async function expectFailure(name, statement, code) {
  try {
    await client.query(statement);
  } catch (error) {
    if (error?.code === code) return;
    failures += 1;
    process.stderr.write(`✗ ${name}: expected ${code}, got ${error?.code} ${error?.message}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`✗ ${name}: expected ${code}, but it succeeded\n`);
}
async function expectValue(name, statement, expected) {
  const { rows } = await client.query(statement);
  const actual = rows[0] ? Object.values(rows[0])[0] : undefined;
  if (String(actual) !== String(expected)) {
    failures += 1;
    process.stderr.write(`✗ ${name}: expected ${expected}, got ${actual}\n`);
  }
}

const HEX = (char) => `repeat('${char}', 64)`;
const STARTABLE = `'{"api":"openai","engine":"vllm","modelType":"llm","launch":{}}'::jsonb`;
const ALWAYS_ON = `'{"api":"openai","engine":"llama_cpp","modelType":"llm","address":{"baseUrl":"http://127.0.0.1:8080/v1"}}'::jsonb`;

try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  execFileSync("pnpm", ["exec", "prisma", "db", "push"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: prismaUrl.toString() },
    stdio: "pipe",
  });
  await runHardening();
  const second = await runHardening();
  if (!second.includes("skipping")) throw new Error(`second apply did not skip:\n${second}`);
  await runHardening({ SCHEMA_HARDENING_FORCE: "1" });

  await client.connect();
  // Fixture writer: the deploy/fixture marker satisfies every graph-write fence.
  await client.query("SET wsmp.fences = ',*,'");
  await client.query(`
    INSERT INTO "user" (id, name, email, slug) VALUES
      ('owner-a', 'A', 'a@example.test', 'owner-a'),
      ('owner-b', 'B', 'b@example.test', 'owner-b');
    INSERT INTO node (id, "userId", slug, trust) VALUES
      ('node-a1', 'owner-a', 'a1', 'FULL'), ('node-a2', 'owner-a', 'a2', 'FULL'),
      ('node-a3', 'owner-a', 'a3', 'FULL'), ('node-b1', 'owner-b', 'b1', 'FULL');
    -- startable runtime with two versions sharing a launch hash, one with another
    INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES
      ('rt-s', 'owner-a', 'qwen', 'Qwen', 'STARTABLE', 'SERVER');
    INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType") VALUES
      ('v-s1', 'rt-s', 1, 'USER', 'owner-a', ${HEX("1")}, ${HEX("a")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM'),
      ('v-s2', 'rt-s', 2, 'USER', 'owner-a', ${HEX("2")}, ${HEX("a")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM'),
      ('v-s3', 'rt-s', 3, 'USER', 'owner-a', ${HEX("3")}, ${HEX("b")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM');
    UPDATE runtime SET "currentVersionId" = 'v-s3' WHERE id = 'rt-s';
    INSERT INTO runtime_model (id, "userId", "runtimeId", "upstreamModelId", type) VALUES
      ('rm-s', 'owner-a', 'rt-s', 'Qwen/Qwen3-32B', 'LLM');
    -- a second startable runtime whose version is current nowhere
    INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES
      ('rt-c', 'owner-a', 'other', 'Other', 'STARTABLE', 'SERVER');
    INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType") VALUES
      ('v-c1', 'rt-c', 1, 'USER', 'owner-a', ${HEX("0")}, ${HEX("0")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM');
    -- always-on runtime on node-a1
    INSERT INTO runtime (id, "userId", slug, name, kind, origin, "nodeId") VALUES
      ('rt-a', 'owner-a', 'llama', 'Llama', 'ALWAYS_ON', 'SERVER', 'node-a1');
    INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType") VALUES
      ('v-a1', 'rt-a', 1, 'USER', 'owner-a', ${HEX("4")}, ${HEX("c")}, ${ALWAYS_ON}, 'OPENAI', 'LLAMA_CPP', 'LLM');
    UPDATE runtime SET "currentVersionId" = 'v-a1' WHERE id = 'rt-a';
    INSERT INTO runtime_model (id, "userId", "runtimeId", "upstreamModelId", type) VALUES
      ('rm-a', 'owner-a', 'rt-a', 'llama3', 'LLM');
    INSERT INTO runtime_instance (id, "userId", "runtimeId", "versionId", "launchVersionId", handle,
      "startedBy", phase) VALUES
      ('inst-a', 'owner-a', 'rt-a', 'v-a1', 'v-a1', 'llama', 'USER', 'READY');
    -- a two-node startable instance: head on node-a2, worker on node-a3
    INSERT INTO runtime_instance (id, "userId", "runtimeId", "versionId", "launchVersionId", handle,
      "startedBy", "desiredState", phase) VALUES
      ('inst-m', 'owner-a', 'rt-s', 'v-s2', 'v-s1', 'i-aaaaaaaaaaaa', 'USER', 'RUNNING', 'READY'),
      ('inst-w', 'owner-a', 'rt-s', 'v-s1', 'v-s1', 'i-bbbbbbbbbbbb', 'USER', 'RUNNING', 'READY');
    INSERT INTO instance_rank (id, "instanceId", "nodeId", "unitName", rank, resources, port) VALUES
      ('rank-m0', 'inst-m', 'node-a2', 'wsmp-i-aaaaaaaaaaaa-r0', 0, '{}', 30001),
      ('rank-m1', 'inst-m', 'node-a3', 'wsmp-i-aaaaaaaaaaaa-r1', 1, '{}', 30001),
      ('rank-w0', 'inst-w', 'node-a3', 'wsmp-i-bbbbbbbbbbbb-r0', 0, '{}', 30002);
    INSERT INTO instance_step (id, "instanceId", "nodeId", rank, phase, sequence, generation, intent,
      "intentHash") VALUES
      ('step-m1', 'inst-m', 'node-a3', 1, 'HEALTH', 1000000, 1, '{}', ${HEX("d")});
    INSERT INTO execution_target (id, "userId", kind, "instanceId", "runtimeModelId") VALUES
      ('t-m', 'owner-a', 'INSTANCE_MODEL', 'inst-m', 'rm-s'),
      ('t-a', 'owner-a', 'INSTANCE_MODEL', 'inst-a', 'rm-a');
    -- pools
    INSERT INTO pool (id, "userId", slug, name, "modelType") VALUES
      ('pool-a', 'owner-a', 'chat', 'Chat', 'LLM'),
      ('pool-vision', 'owner-a', 'vision', 'Vision', 'LLM'),
      ('pool-stt', 'owner-a', 'stt', 'STT', 'TRANSCRIPTION');
    INSERT INTO pool_member (id, "poolId", kind, "runtimeModelId") VALUES
      ('member-a', 'pool-a', 'LOCAL', 'rm-s');
  `);

  // pool children exist
  await expectValue(
    "pool_create_children",
    'SELECT count(*) FROM pool_routing r JOIN pool_fallback f USING ("poolId") JOIN pool_advanced a USING ("poolId") WHERE "poolId" = \'pool-a\'',
    1,
  );

  // ── nodes ──
  await expectFailure(
    "node_port_range_check",
    `UPDATE node SET "portStart" = 80 WHERE id = 'node-a1'`,
    "23514",
  );
  await expectFailure(
    "node_frozen_fabrics_shape",
    `UPDATE node SET "frozenFabrics" = '[]' WHERE id = 'node-a1'`,
    "23514",
  );
  await expectFailure(
    "node_command_max_check",
    `UPDATE node SET "commandMaxMs" = 90000000 WHERE id = 'node-a1'`,
    "23514",
  );
  await client.query(`
    INSERT INTO node_command (id, "userId", "nodeId", actor, subject, "startedAt", "endsBy")
    VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'owner-a', 'node-a1', 'USER', 'hmac-sha256:00 ls', now(), now() + interval '1 hour')`);
  await expectFailure(
    "node_command_shape exit code while running",
    `UPDATE node_command SET "exitCode" = 0 WHERE id = 'AAAAAAAAAAAAAAAAAAAAAA'`,
    "23514",
  );
  await client.query(`UPDATE node_command SET state = 'SUCCEEDED', "exitCode" = 0, "finishedAt" = now()
    WHERE id = 'AAAAAAAAAAAAAAAAAAAAAA'`);
  await expectFailure(
    "node_command_transition finished stays finished",
    `UPDATE node_command SET state = 'RUNNING', "exitCode" = NULL, "finishedAt" = NULL WHERE id = 'AAAAAAAAAAAAAAAAAAAAAA'`,
    "55000",
  );
  await expectFailure(
    "node_command_shape agent without a credential",
    `INSERT INTO node_command (id, "userId", "nodeId", actor, subject, "startedAt", "endsBy")
     VALUES ('CCCCCCCCCCCCCCCCCCCCCC', 'owner-a', 'node-a1', 'AGENT', 'x', now(), now() + interval '1 hour')`,
    "23514",
  );
  await expectFailure(
    "node_command_shape agent with both credentials",
    `INSERT INTO node_command (id, "userId", "nodeId", actor, "agentTokenId", "mcpGrantId", subject, "startedAt", "endsBy")
     VALUES ('CCCCCCCCCCCCCCCCCCCCCC', 'owner-a', 'node-a1', 'AGENT', 'tok-1', 'grant-1', 'x', now(), now() + interval '1 hour')`,
    "23514",
  );
  await client.query(`
    INSERT INTO node_command (id, "userId", "nodeId", actor, "mcpGrantId", subject, "startedAt", "endsBy")
    VALUES ('DDDDDDDDDDDDDDDDDDDDDD', 'owner-a', 'node-a1', 'AGENT', 'grant-1', 'x', now(), now() + interval '1 hour')`);
  await expectFailure(
    "node_audit_event_shape agent with both credentials",
    `INSERT INTO node_audit_event (id, "userId", "nodeId", actor, "agentTokenId", "mcpGrantId", kind, subject, outcome, "startedAt")
     VALUES ('nae-both', 'owner-a', 'node-a1', 'AGENT', 'tok-1', 'grant-1', 'command', 'x', 'completed', now())`,
    "23514",
  );
  await expectFailure(
    "node_command_shape lifetime over 24 h",
    `INSERT INTO node_command (id, "userId", "nodeId", actor, subject, "startedAt", "endsBy")
     VALUES ('BBBBBBBBBBBBBBBBBBBBBB', 'owner-a', 'node-a1', 'USER', 'x', now(), now() + interval '25 hours')`,
    "23514",
  );
  await expectFailure(
    "node_hold_shape",
    `UPDATE node SET "holdNote" = 'switching to the sandbox agent' WHERE id = 'node-a1'`,
    "23514",
  );
  await client.query(
    `UPDATE node SET "holdAt" = now(), "holdNote" = 'sandbox agent' WHERE id = 'node-a3'`,
  );
  await client.query(`UPDATE node SET "holdAt" = NULL, "holdNote" = NULL WHERE id = 'node-a3'`);
  await expectFailure(
    "node_temporary_shape",
    `UPDATE node SET "removeAfterOfflineMs" = 1000 WHERE id = 'node-a1'`,
    "23514",
  );
  await client.query(`
    INSERT INTO fabric (id, "userId", name) VALUES ('fab-a', 'owner-a', 'qsfp-1');
    INSERT INTO fabric_member (id, "userId", "fabricId", "nodeId", ip) VALUES
      ('fm-1', 'owner-a', 'fab-a', 'node-a1', '10.0.0.1'),
      ('fm-2', 'owner-a', 'fab-a', 'node-a2', 'fd00::2')`);
  await expectFailure(
    "fabric_member_shape not an IP literal",
    `INSERT INTO fabric_member (id, "userId", "fabricId", "nodeId", ip) VALUES ('fm-x', 'owner-a', 'fab-a', 'node-a3', 'host.local')`,
    "23514",
  );
  await expectFailure(
    "fabric_member_shape unspecified",
    `INSERT INTO fabric_member (id, "userId", "fabricId", "nodeId", ip) VALUES ('fm-y', 'owner-a', 'fab-a', 'node-a3', '0.0.0.0')`,
    "23514",
  );
  await expectFailure(
    "fabric_member other owner's node",
    `INSERT INTO fabric_member (id, "userId", "fabricId", "nodeId", ip) VALUES ('fm-z', 'owner-a', 'fab-a', 'node-b1', '10.0.0.9')`,
    "23503",
  );
  await expectFailure(
    "fabric_shape",
    `INSERT INTO fabric (id, "userId", name) VALUES ('fab-bad', 'owner-a', 'Bad Name')`,
    "23514",
  );
  // The shared fabric-IP vectors (TS isFabricIp, Rust is_fabric_ip) agree with the database.
  const fabricVectors = JSON.parse(
    await readFile(
      new URL("../../../apps/cli/tests/fixtures/relay-3.0/rules/fabric-ip.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [list, expected] of [
    [fabricVectors.valid, true],
    [fabricVectors.invalid, false],
  ])
    for (const value of list) {
      const { rows } = await client.query("SELECT wsmp_is_fabric_ip($1) AS ok", [value]);
      if (rows[0]?.ok !== expected) {
        failures += 1;
        process.stderr.write(`✗ wsmp_is_fabric_ip(${JSON.stringify(value)}) is not ${expected}\n`);
      }
    }
  // A running multi-node instance pins its fabric and its members' addresses.
  await client.query(`UPDATE runtime_instance SET "fabricId" = 'fab-a' WHERE id = 'inst-m'`);
  await expectFailure(
    "fabric_member_in_use address",
    `UPDATE fabric_member SET ip = '10.0.0.22' WHERE id = 'fm-2'`,
    "WMPP1",
  );
  await expectFailure(
    "fabric_member_in_use leave",
    `DELETE FROM fabric_member WHERE id = 'fm-2'`,
    "WMPP1",
  );
  await expectFailure(
    "runtime_instance fabric restrict",
    `DELETE FROM fabric WHERE id = 'fab-a'`,
    "WMPP1",
  );
  await expectFailure(
    "runtime_instance_shape fabric while stopped",
    `UPDATE runtime_instance SET phase = 'STOPPED' WHERE id = 'inst-m'`,
    "23514",
  );
  // A member the instance does not use (no rank of it on node-a1) may change.
  await client.query(`UPDATE fabric_member SET ip = '10.0.0.11' WHERE id = 'fm-1'`);
  await client.query(`UPDATE runtime_instance SET "fabricId" = NULL WHERE id = 'inst-m'`);
  await client.query(`UPDATE fabric_member SET ip = 'fd00::22' WHERE id = 'fm-2'`);
  // Temporary nodes up to 30 days (beyond int4 milliseconds).
  await client.query(`UPDATE node SET "removeAfterOfflineMs" = 2592000000 WHERE id = 'node-a3'`);
  await client.query(`UPDATE node SET "removeAfterOfflineMs" = NULL WHERE id = 'node-a3'`);
  await expectFailure(
    "node_hold_profile_owner unknown profile",
    `UPDATE node SET "holdAt" = now(), "holdProfileId" = 'no-such-profile' WHERE id = 'node-a3'`,
    "23514",
  );
  await expectFailure(
    "node_trust_lower_shape",
    `UPDATE node SET "trustLowerRequestedAt" = now() WHERE id = 'node-a1'`,
    "23514",
  );
  await client.query(`
    INSERT INTO node_enrollment_code (id, "userId", "codePrefix", "codeDigest", "expiresAt") VALUES
      ('code-1', 'owner-a', 'ABCDEFGH', ${HEX("e")}, now() + interval '1 hour')`);
  await expectFailure(
    "node_enrollment_use_shape owner",
    `INSERT INTO node_enrollment_use (id, "userId", "codeId", "nodeId") VALUES ('use-x', 'owner-a', 'code-1', 'node-b1')`,
    "23514",
  );
  await client.query(`
    UPDATE node_enrollment_code SET "usedCount" = 1, "lastUsedAt" = now() WHERE id = 'code-1';
    INSERT INTO node_enrollment_use (id, "userId", "codeId", "nodeId") VALUES ('use-1', 'owner-a', 'code-1', 'node-a1')`);
  await expectFailure(
    "node_enrollment_code_shape max uses",
    `UPDATE node_enrollment_code SET "usedCount" = 2 WHERE id = 'code-1'`,
    "23514",
  );
  await client.query(`
    INSERT INTO node_enrollment_code (id, "userId", "codePrefix", "codeDigest", "expiresAt", "maxUses", labels) VALUES
      ('code-m', 'owner-a', 'ABCDEFGH', ${HEX("d")}, now() + interval '1 hour', 3, '{gpu}')`);
  await expectFailure(
    "node_enrollment_code_use one at a time",
    `UPDATE node_enrollment_code SET "usedCount" = 2, "lastUsedAt" = now() WHERE id = 'code-m'`,
    "55000",
  );
  await client.query(`UPDATE node_enrollment_code SET "revokedAt" = now() WHERE id = 'code-m'`);
  await expectFailure(
    "node_enrollment_code_use revoked",
    `UPDATE node_enrollment_code SET "usedCount" = 1, "lastUsedAt" = now() WHERE id = 'code-m'`,
    "55000",
  );
  await expectFailure(
    "node_enrollment_code_shape replace is single-use",
    `INSERT INTO node_enrollment_code (id, "userId", "codePrefix", "codeDigest", "expiresAt", "maxUses", "replaceNodeId") VALUES
      ('code-r', 'owner-a', 'ABCDEFGH', ${HEX("c")}, now() + interval '1 hour', 2, 'node-a1')`,
    "23514",
  );
  await expectFailure(
    "node_enrollment_code_shape max 50",
    `INSERT INTO node_enrollment_code (id, "userId", "codePrefix", "codeDigest", "expiresAt", "maxUses") VALUES
      ('code-51', 'owner-a', 'ABCDEFGH', ${HEX("b")}, now() + interval '1 hour', 51)`,
    "23514",
  );
  await expectFailure(
    "node_enrollment_code_shape ttl",
    `INSERT INTO node_enrollment_code (id, "userId", "codePrefix", "codeDigest", "expiresAt") VALUES
      ('code-2', 'owner-a', 'ABCDEFGH', ${HEX("f")}, now() + interval '8 days')`,
    "23514",
  );
  await client.query(`
    INSERT INTO node_credential (id, "userId", "nodeId", "lookupPrefix", "secretDigest", "identityPublicKey")
    VALUES ('cred-1', 'owner-a', 'node-a1', 'lp-1', 'sd-1', 'key')`);
  await expectFailure(
    "node_credential_one_active",
    `INSERT INTO node_credential (id, "userId", "nodeId", "lookupPrefix", "secretDigest", "identityPublicKey")
     VALUES ('cred-2', 'owner-a', 'node-a1', 'lp-2', 'sd-2', 'key')`,
    "23505",
  );
  await expectFailure(
    "queued_node_command_shape without the agent's credential",
    `INSERT INTO queued_node_command (id, "userId", "nodeId", command, "expiresAt")
     VALUES ('q-0', 'owner-a', 'node-a1', 'sudo apt install x', now() + interval '1 day')`,
    "23514",
  );
  await expectFailure(
    "queued_node_command_shape with both credentials",
    `INSERT INTO queued_node_command (id, "userId", "nodeId", "agentTokenId", "mcpGrantId", command, "expiresAt")
     VALUES ('q-0', 'owner-a', 'node-a1', 'tok-1', 'grant-1', 'sudo apt install x', now() + interval '1 day')`,
    "23514",
  );
  await client.query(`
    INSERT INTO queued_node_command (id, "userId", "nodeId", "mcpGrantId", command, "expiresAt")
    VALUES ('q-1', 'owner-a', 'node-a1', 'grant-1', 'sudo apt install x', now() + interval '1 day')`);
  await client.query(
    `UPDATE queued_node_command SET state = 'DISMISSED', "decidedAt" = now(), "decidedBy" = 'owner-a' WHERE id = 'q-1'`,
  );
  await expectFailure(
    "queued_node_command_transition",
    `UPDATE queued_node_command SET state = 'RUN' WHERE id = 'q-1'`,
    "55000",
  );

  // ── runtimes ──
  await expectFailure(
    "runtime_kind_shape_check",
    `INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES ('rt-x', 'owner-a', 'x', 'X', 'ALWAYS_ON', 'SERVER')`,
    "23514",
  );
  await expectFailure(
    "runtime slug shaped like a handle",
    `INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES ('rt-y', 'owner-a', 'i-abcdefabcdef', 'Y', 'STARTABLE', 'SERVER')`,
    "23514",
  );
  await expectFailure(
    "runtime_version_derived_columns",
    `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType") VALUES
      ('v-bad', 'rt-s', 9, 'USER', 'owner-a', ${HEX("9")}, ${HEX("9")}, ${STARTABLE}, 'OPENAI', 'SGLANG', 'LLM')`,
    "23514",
  );
  // a service: startable, no api/engine/modelType/models
  await client.query(`
    INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES
      ('rt-svc', 'owner-a', 'sandbox-agent', 'Sandbox agent', 'STARTABLE', 'SERVER');
    INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec) VALUES
      ('v-svc1', 'rt-svc', 1, 'USER', 'owner-a', ${HEX("5")}, ${HEX("5")}, '{"launch":{}}')`);
  await expectFailure(
    "runtime_version_derived_columns service with a model type",
    `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, "modelType") VALUES
      ('v-svc2', 'rt-svc', 2, 'USER', 'owner-a', ${HEX("5")}, ${HEX("5")}, '{"launch":{}}', 'LLM')`,
    "23514",
  );
  await expectFailure(
    "runtime_version_immutable",
    `UPDATE runtime_version SET note = 'edited' WHERE id = 'v-s1'`,
    "55000",
  );
  await expectFailure(
    "version numbers increase",
    `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType") VALUES
      ('v-old', 'rt-s', 2, 'USER', 'owner-a', ${HEX("8")}, ${HEX("8")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM')`,
    "23514",
  );
  await expectFailure(
    "runtime_version_advanced_check",
    `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType", advanced) VALUES
      ('v-adv', 'rt-s', 10, 'USER', 'owner-a', ${HEX("7")}, ${HEX("7")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM',
       '{"restartBudget": 1000}')`,
    "23514",
  );
  await expectFailure(
    "runtime_version_limits_check",
    `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
      "launchHash", spec, api, engine, "modelType", "kvFullThreshold") VALUES
      ('v-lim', 'rt-s', 11, 'USER', 'owner-a', ${HEX("6")}, ${HEX("6")}, ${STARTABLE}, 'OPENAI', 'VLLM', 'LLM', 1.5)`,
    "23514",
  );
  await expectFailure(
    "runtime_current_version_consistency",
    `UPDATE runtime SET "currentVersionId" = 'v-c1' WHERE id = 'rt-s'`,
    "23514",
  );
  await expectFailure(
    "runtime_one_always_on_instance",
    `INSERT INTO runtime_instance (id, "userId", "runtimeId", "versionId", "launchVersionId", handle,
      "startedBy", phase) VALUES ('inst-a2', 'owner-a', 'rt-a', 'v-a1', 'v-a1', 'llama-two', 'USER', 'READY')`,
    "23505",
  );
  await expectFailure(
    "runtime_instance_launch_version",
    `UPDATE runtime_instance SET "versionId" = 'v-s3' WHERE id = 'inst-m'`,
    "23514",
  );
  await expectFailure(
    "instance_rank_reserved_port",
    `INSERT INTO instance_rank (id, "instanceId", "nodeId", "unitName", rank, resources, port) VALUES
      ('rank-x', 'inst-w', 'node-a2', 'wsmp-i-bbbbbbbbbbbb-r1', 1, '{}', 30001)`,
    "23505",
  );
  await expectFailure(
    "instance_rank_claim_shape",
    `UPDATE instance_rank SET claim = 'HELD_UNKNOWN' WHERE id = 'rank-w0'`,
    "23514",
  );
  await expectFailure(
    "instance_step_shape cancelled after dispatch",
    `UPDATE instance_step SET attempts = 1, state = 'CANCELLED' WHERE id = 'step-m1'`,
    "23514",
  );
  await expectFailure(
    "instance_step_operator_shape",
    `UPDATE instance_step SET "operatorTerminalId" = 'term' WHERE id = 'step-m1'`,
    "23514",
  );
  await expectFailure(
    "execution_target_kind_source_xor_check",
    `INSERT INTO execution_target (id, "userId", kind, "instanceId") VALUES ('t-bad', 'owner-a', 'INSTANCE_MODEL', 'inst-m')`,
    "23514",
  );
  await expectFailure(
    "execution_target_identity_immutable",
    `UPDATE execution_target SET "runtimeModelId" = 'rm-a' WHERE id = 't-m'`,
    "55000",
  );
  await expectFailure(
    "execution_target pairs a model of the instance's runtime",
    `INSERT INTO execution_target (id, "userId", kind, "instanceId", "runtimeModelId") VALUES
      ('t-cross', 'owner-a', 'INSTANCE_MODEL', 'inst-m', 'rm-a')`,
    "23514",
  );

  // ── profiles ──
  await client.query(`
    INSERT INTO profile (id, "userId", slug, name, editor, "editorUserId") VALUES
      ('prof-a', 'owner-a', 'day', 'Day', 'USER', 'owner-a');
    INSERT INTO profile_node ("profileId", "nodeId") VALUES ('prof-a', 'node-a2');`);
  await client.query(`
    INSERT INTO profile (id, "userId", slug, name, editor, "editorUserId") VALUES
      ('prof-b-hold', 'owner-b', 'night', 'Night', 'USER', 'owner-b')`);
  await expectFailure(
    "node_hold_profile_owner another owner's profile",
    `UPDATE node SET "holdAt" = now(), "holdProfileId" = 'prof-b-hold' WHERE id = 'node-a3'`,
    "23514",
  );
  await client.query(
    `UPDATE node SET "holdAt" = now(), "holdProfileId" = 'prof-a' WHERE id = 'node-a3'`,
  );
  await client.query(
    `UPDATE node SET "holdAt" = NULL, "holdProfileId" = NULL WHERE id = 'node-a3'`,
  );
  await expectFailure(
    "profile_owner_consistency node",
    `INSERT INTO profile_node ("profileId", "nodeId") VALUES ('prof-a', 'node-b1')`,
    "23514",
  );
  await expectFailure(
    "profile_owner_consistency item version",
    `INSERT INTO profile_item (id, "profileId", position, "runtimeId", "versionId") VALUES
      ('item-bad', 'prof-a', 0, 'rt-s', 'v-a1')`,
    "23514",
  );
  await client.query(`
    INSERT INTO profile_item (id, "profileId", position, "runtimeId", "versionId", "nodeIds") VALUES
      ('item-a', 'prof-a', 0, 'rt-a', 'v-a1', ARRAY['node-a2'])`);

  // ── pools ──
  await expectFailure(
    "pool_advanced_overrides_check key",
    `UPDATE pool_advanced SET overrides = '{"unknownKey": true}' WHERE "poolId" = 'pool-a'`,
    "23514",
  );
  await expectFailure(
    "pool_advanced_overrides_check bound",
    `UPDATE pool_advanced SET overrides = '{"affinity": {"ttlSeconds": 5}}' WHERE "poolId" = 'pool-a'`,
    "23514",
  );
  await client.query(
    `UPDATE pool_advanced SET overrides = '{"affinity": {"ttlSeconds": 600, "enabled": null}, "protocolAdaptation": true}', "maxWaitMs" = 5000 WHERE "poolId" = 'pool-a'`,
  );
  await expectFailure(
    "pool_routing_policy_check",
    `UPDATE pool_routing SET "keptSlots" = -1 WHERE "poolId" = 'pool-a'`,
    "23514",
  );
  await expectFailure(
    "pool_member_kind_shape_check",
    `INSERT INTO pool_member (id, "poolId", kind) VALUES ('m-bad', 'pool-a', 'LOCAL')`,
    "23514",
  );
  await expectFailure(
    "pool_owner_immutable",
    `UPDATE pool SET "userId" = 'owner-b' WHERE id = 'pool-a'`,
    "55000",
  );
  // contributed members: owner-b's served model needs a can-contribute share
  await client.query(`
    INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES
      ('rt-b', 'owner-b', 'mistral', 'Mistral', 'STARTABLE', 'SERVER');
    INSERT INTO runtime_model (id, "userId", "runtimeId", "upstreamModelId", type) VALUES
      ('rm-b', 'owner-b', 'rt-b', 'mistral', 'LLM'),
      ('rm-b-stt', 'owner-b', 'rt-b', 'whisper', 'TRANSCRIPTION');`);
  await expectFailure(
    "pool_member_source without share",
    `INSERT INTO pool_member (id, "poolId", kind, "runtimeModelId") VALUES ('m-b', 'pool-a', 'LOCAL', 'rm-b')`,
    "23514",
  );
  await client.query(`
    INSERT INTO share (id, "poolId", "ownerUserId", "granteeUserId", "canUse", "canContribute")
    VALUES ('share-b', 'pool-a', 'owner-a', 'owner-b', true, true);
    INSERT INTO pool_member (id, "poolId", kind, "runtimeModelId", "shareId")
    VALUES ('m-b', 'pool-a', 'LOCAL', 'rm-b', 'share-b');`);
  await expectFailure(
    "pool_member_source type",
    `INSERT INTO pool_member (id, "poolId", kind, "runtimeModelId", "shareId") VALUES
      ('m-b-stt', 'pool-a', 'LOCAL', 'rm-b-stt', 'share-b')`,
    "23514",
  );
  await client.query(
    `UPDATE pool_routing SET "ownHardwareOnly" = true WHERE "poolId" = 'pool-vision'`,
  );
  await client.query(`
    INSERT INTO share (id, "poolId", "ownerUserId", "granteeUserId", "canContribute", "canUse")
    VALUES ('share-v', 'pool-vision', 'owner-a', 'owner-b', true, false)`);
  await expectFailure(
    "pool_member_source own hardware only",
    `INSERT INTO pool_member (id, "poolId", kind, "runtimeModelId", "shareId") VALUES
      ('m-v', 'pool-vision', 'LOCAL', 'rm-b', 'share-v')`,
    "23514",
  );
  await expectFailure(
    "share_permission_shape",
    `UPDATE share SET "canUse" = false, "canContribute" = false WHERE id = 'share-b'`,
    "23514",
  );
  await expectFailure(
    "share_shape",
    `INSERT INTO share (id, "poolId", "ownerUserId", "granteeUserId") VALUES ('share-self', 'pool-a', 'owner-a', 'owner-a')`,
    "23514",
  );
  // share invites
  await expectFailure(
    "share_invite_shape e-mail",
    `INSERT INTO share_invite (id, "poolId", "ownerUserId", email, "tokenDigest", "expiresAt")
     VALUES ('inv-bad', 'pool-a', 'owner-a', 'New@Example.test', ${HEX("a")}, now() + interval '7 days')`,
    "23514",
  );
  await client.query(`
    INSERT INTO share_invite (id, "poolId", "ownerUserId", email, "tokenDigest", "expiresAt")
    VALUES ('inv-1', 'pool-a', 'owner-a', 'b@example.test', ${HEX("a")}, now() + interval '7 days')`);
  await expectFailure(
    "share_invite_transition identity",
    `UPDATE share_invite SET email = 'c@example.test' WHERE id = 'inv-1'`,
    "55000",
  );
  await expectFailure(
    "share_invite_transition accepted share",
    `UPDATE share_invite SET "acceptedAt" = now(), "shareId" = 'share-v' WHERE id = 'inv-1'`,
    "23514",
  );
  await client.query(
    `UPDATE share_invite SET "acceptedAt" = now(), "shareId" = 'share-b' WHERE id = 'inv-1'`,
  );
  await expectFailure(
    "share_invite_transition final",
    `UPDATE share_invite SET "canContribute" = true WHERE id = 'inv-1'`,
    "55000",
  );
  await expectFailure(
    "share_invite_transition final token",
    `UPDATE share_invite SET "tokenDigest" = ${HEX("b")} WHERE id = 'inv-1'`,
    "55000",
  );
  // The accepted invite is history: the same e-mail may be invited again, once while pending,
  // and resend rotates the token and expiry of the pending one.
  await client.query(`
    INSERT INTO share_invite (id, "poolId", "ownerUserId", email, "tokenDigest", "expiresAt")
    VALUES ('inv-2', 'pool-a', 'owner-a', 'b@example.test', ${HEX("c")}, now() + interval '7 days')`);
  await expectFailure(
    "share_invite_one_pending",
    `INSERT INTO share_invite (id, "poolId", "ownerUserId", email, "tokenDigest", "expiresAt")
     VALUES ('inv-3', 'pool-a', 'owner-a', 'b@example.test', ${HEX("d")}, now() + interval '7 days')`,
    "23505",
  );
  await expectFailure(
    "share_invite_transition expiry without a new link",
    `UPDATE share_invite SET "expiresAt" = now() + interval '14 days' WHERE id = 'inv-2'`,
    "55000",
  );
  await expectFailure(
    "share_invite_expiry beyond 30 days",
    `UPDATE share_invite SET "tokenDigest" = ${HEX("f")}, "expiresAt" = now() + interval '31 days' WHERE id = 'inv-2'`,
    "23514",
  );
  await client.query(
    `UPDATE share_invite SET "tokenDigest" = ${HEX("e")}, "expiresAt" = now() + interval '14 days' WHERE id = 'inv-2'`,
  );
  await client.query(`UPDATE share_invite SET "revokedAt" = now() WHERE id = 'inv-2'`);
  await client.query(`
    INSERT INTO share_invite (id, "poolId", "ownerUserId", email, "tokenDigest", "expiresAt")
    VALUES ('inv-3', 'pool-a', 'owner-a', 'b@example.test', ${HEX("d")}, now() + interval '7 days')`);
  // sidecars
  await expectFailure(
    "pool_sidecar_target_check self",
    `INSERT INTO pool_sidecar (id, "poolId", input, "targetPoolId") VALUES ('sc-self', 'pool-a', 'IMAGE', 'pool-a')`,
    "23514",
  );
  await expectFailure(
    "pool_sidecar_target_check type",
    `INSERT INTO pool_sidecar (id, "poolId", input, "targetPoolId") VALUES ('sc-type', 'pool-a', 'AUDIO', 'pool-vision')`,
    "23514",
  );
  await client.query(`
    INSERT INTO pool_sidecar (id, "poolId", input, "targetPoolId") VALUES
      ('sc-img', 'pool-a', 'IMAGE', 'pool-vision'),
      ('sc-stt', 'pool-a', 'AUDIO', 'pool-stt')`);
  await expectFailure(
    "pool_sidecar_target_check chain",
    `INSERT INTO pool_sidecar (id, "poolId", input, "targetPoolId") VALUES ('sc-chain', 'pool-stt', 'IMAGE', 'pool-a')`,
    "23514",
  );
  // routing rules
  await client.query(`
    INSERT INTO pool_routing_rule (id, "poolId", position, metric, op, threshold, effect, "memberId", exclude)
    VALUES ('rule-target', 'pool-a', 0, 'node.cpu', '>', 90, 'avoid', 'member-a', false),
           ('rule-exclude', 'pool-a', 1, 'node.cpu', '>', 95, 'full', 'member-a', true)`);
  // API keys
  await client.query(`
    INSERT INTO api_key (id, "userId", name, "lookupPrefix", "secretDigest") VALUES
      ('key-b', 'owner-b', 'B', 'wsmp_b_lookup', ${HEX("5")});
    INSERT INTO api_key_pool ("apiKeyId", "poolId") VALUES ('key-b', 'pool-a');`);
  await expectFailure(
    "api_key_pool_access",
    `INSERT INTO api_key_pool ("apiKeyId", "poolId") VALUES ('key-b', 'pool-stt')`,
    "23514",
  );

  // ── fences (writer class M) ──
  await app.connect();
  await app.query("SET wsmp.fences = ''");
  try {
    await app.query(
      `INSERT INTO pool (id, "userId", slug, name, "modelType") VALUES ('pool-f', 'owner-a', 'f', 'F', 'LLM')`,
    );
    failures += 1;
    process.stderr.write("✗ graph write without the owner fence succeeded\n");
  } catch (error) {
    if (error?.code !== "WMPF4") {
      failures += 1;
      process.stderr.write(`✗ owner fence: expected WMPF4, got ${error?.code}\n`);
    }
  }
  await app.query("BEGIN");
  await app.query("SELECT wsmp_acquire_fences(ARRAY['00:owner:owner-a'], true)");
  await app.query(
    `INSERT INTO pool (id, "userId", slug, name, "modelType") VALUES ('pool-f', 'owner-a', 'f', 'F', 'LLM')`,
  );
  await app.query(`UPDATE pool_routing SET "keptSlots" = 2 WHERE "poolId" = 'pool-f'`);
  await app.query("COMMIT");
  await app.query("BEGIN");
  await app.query("SELECT wsmp_acquire_fences(ARRAY['00:owner:owner-a'], true)");
  try {
    await app.query(`UPDATE pool_routing SET "keptSlots" = 3 WHERE "poolId" = 'pool-a'`);
    failures += 1;
    process.stderr.write("✗ pool policy change without the capacity-policy fence succeeded\n");
  } catch (error) {
    if (error?.code !== "WMPF4") {
      failures += 1;
      process.stderr.write(`✗ policy fence: expected WMPF4, got ${error?.code}\n`);
    }
  }
  await app.query("ROLLBACK");
  await app.query("BEGIN");
  await app.query(
    "SELECT wsmp_acquire_fences(ARRAY['00:owner:owner-a', '06:capacity-policy:t-m'], true)",
  );
  await app.query(`UPDATE pool_routing SET "keptSlots" = 3 WHERE "poolId" = 'pool-a'`);
  await app.query("COMMIT");

  // ── hot path (admission, scheduler, affinity, stickiness, requests) ──
  const waiterColumns = `(id, "userId", "admissionRequestId", "requestId", "attemptId", "enqueueSequence",
      "capacityId", "executionTargetId", "poolId", "poolMemberId", "candidateOrder", "effectivePriority",
      "effectiveConcurrencyLimit", "effectiveConcurrencyScope", "effectiveConcurrencyScopeId",
      "effectiveReservedSlots", "effectiveBorrowReserved", "effectivePoolConcurrencyLimit")`;
  await client.query(`
    INSERT INTO admission_request (id, "userId", "requestId", "attemptId", "sourceKind", "poolId",
      "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt")
    VALUES ('adm-1', 'owner-a', 'req-1', 'att-1', 'POOL', 'pool-a', 1, 1, 'srv', now())`);
  await expectFailure(
    "admission_request_shape_check",
    `INSERT INTO admission_request (id, "userId", "requestId", "attemptId", "sourceKind", "poolId",
      "testTargetId", "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt")
     VALUES ('adm-bad', 'owner-a', 'req-2', 'att-2', 'TEST', 'pool-a', 't-m', 1, 2, 'srv', now())`,
    "23514",
  );
  await expectFailure(
    "capacity waiter snapshot must match the pool policy",
    `INSERT INTO capacity_waiter ${waiterColumns} VALUES ('w-bad', 'owner-a', 'adm-1', 'req-1', 'att-1', 1,
      'inst-m', 't-m', 'pool-a', 'member-a', 0, 2, NULL, 'POOL', 'pool-a', 3, true, NULL)`,
    "23514",
  );
  await expectFailure(
    "capacity waiter capacity is the target's instance",
    `INSERT INTO capacity_waiter ${waiterColumns} VALUES ('w-cap', 'owner-a', 'adm-1', 'req-1', 'att-1', 1,
      'inst-w', 't-m', 'pool-a', 'member-a', 0, 1, NULL, 'POOL', 'pool-a', 3, true, NULL)`,
    "23514",
  );
  await client.query(`
    INSERT INTO capacity_waiter ${waiterColumns} VALUES ('w-1', 'owner-a', 'adm-1', 'req-1', 'att-1', 1,
      'inst-m', 't-m', 'pool-a', 'member-a', 0, 1, NULL, 'POOL', 'pool-a', 3, true, NULL)`);
  await expectFailure(
    "capacity waiter snapshot is immutable",
    `UPDATE capacity_waiter SET "effectiveReservedSlots" = 0 WHERE id = 'w-1'`,
    "23514",
  );
  await expectFailure(
    "capacity_scheduler_check",
    `INSERT INTO capacity_scheduler ("capacityId", "userId", "schedulerDeficits") VALUES ('inst-m', 'owner-a', '[0,0]')`,
    "23514",
  );
  await expectFailure(
    "admission_history_identity",
    `UPDATE admission_request SET "poolId" = 'pool-stt' WHERE id = 'adm-1'`,
    "23514",
  );
  // affinity rows: the pool principal owns them, and the generation must be current
  await client.query(`INSERT INTO cache_affinity_scope ("poolId", "userId", generation)
    VALUES ('pool-a', 'owner-a', '00000000-0000-0000-0000-000000000000')`);
  const affinityColumns = `(id, "expiresAt", "userId", "tenantUserId", "poolId", "executionTargetId",
      "cacheGeneration", "targetIdentity", "bindingDigest", "conversationDigest", "sessionId", "prefixDepth")`;
  await expectFailure(
    "cache_affinity_owner",
    `INSERT INTO cache_affinity_record ${affinityColumns} VALUES ('ca-bad', now() + interval '1 hour',
      'owner-b', 'owner-b', 'pool-a', 't-m', '', 'target', repeat('b', 43), repeat('c', 43), 's-1', 0)`,
    "23514",
  );
  await expectFailure(
    "cache affinity generation has reset",
    `INSERT INTO cache_affinity_record ${affinityColumns} VALUES ('ca-old', now() + interval '1 hour',
      'owner-a', 'owner-a', 'pool-a', 't-m', 'stale', 'target', repeat('b', 43), repeat('c', 43), 's-1', 0)`,
    "23514",
  );
  await client.query(`
    INSERT INTO cache_affinity_record ${affinityColumns} VALUES ('ca-1', now() + interval '1 hour',
      'owner-a', 'owner-a', 'pool-a', 't-m', wsmp_affinity_scope_generation('t-m', 'pool-a'),
      'target', repeat('b', 43), repeat('c', 43), 's-1', 0)`);
  await expectValue(
    "residency published",
    `SELECT jsonb_array_length(entries) FROM cache_affinity_residency WHERE "executionTargetId" = 't-m'`,
    1,
  );
  // stickiness and request telemetry
  await expectFailure(
    "response_stickiness_provider_binding_check",
    `INSERT INTO response_stickiness_record (id, "userId", "routingKeyDigest", route)
     VALUES ('st-bad', 'owner-a', repeat('d', 43), 'cloud')`,
    "23514",
  );
  await expectFailure(
    "relay_request sidecar needs a parent",
    `INSERT INTO relay_request (id, "userId", source, "poolId") VALUES ('rr-bad', 'owner-a', 'SIDECAR', 'pool-a')`,
    "23514",
  );
  await client.query(
    `INSERT INTO relay_request (id, "userId", source, "poolId") VALUES ('rr-1', 'owner-b', 'API_KEY', 'pool-a')`,
  );
  await expectValue(
    "relay request resource owner is the pool owner",
    `SELECT "resourceOwnerUserId" FROM relay_request WHERE id = 'rr-1'`,
    "owner-a",
  );

  // ── auth ──
  await client.query(`INSERT INTO "user" (id, name, email, slug, "deletionRequestedAt") VALUES
    ('deleting', 'D', 'd@example.test', 'deleting', now())`);
  await expectFailure(
    "session_refuse_deleting_user",
    `INSERT INTO session (id, "expiresAt", token, "userId") VALUES ('s-1', now() + interval '1 hour', 't-1', 'deleting')`,
    "WMPD1",
  );
  await expectFailure(
    "user_deletion_marker_guard",
    `UPDATE "user" SET "deletionRequestedAt" = NULL WHERE id = 'deleting'`,
    "WMPD2",
  );

  // ── delete rules (plan cases 1-6) ──
  // 4. a pinned runtime cannot be deleted; a node holding one gives a clean reason.
  await expectFailure("pinned runtime delete", `DELETE FROM runtime WHERE id = 'rt-a'`, "23503");
  await expectFailure(
    "node delete with a pinned always-on runtime",
    `DELETE FROM node WHERE id = 'node-a1'`,
    "WMPP1",
  );
  await client.query(`DELETE FROM profile_item WHERE id = 'item-a'`);
  // 2. the node holding the head of a multi-node instance (and a worker of nothing else)
  await client.query(`DELETE FROM node WHERE id = 'node-a2'`);
  await expectValue(
    "head node delete releases its part",
    `SELECT claim FROM instance_rank WHERE id = 'rank-m0'`,
    "RELEASED",
  );
  await expectValue(
    "head node delete keeps the rank row",
    `SELECT count(*) FROM instance_rank WHERE id = 'rank-m0' AND "nodeId" IS NULL`,
    1,
  );
  await expectValue(
    "head node delete stops the instance",
    `SELECT phase FROM runtime_instance WHERE id = 'inst-m'`,
    "STOPPING",
  );
  await expectValue(
    "surviving worker stays held",
    `SELECT claim FROM instance_rank WHERE id = 'rank-m1'`,
    "HELD",
  );
  // 3. the node holding only workers: its open step ends, its parts are released
  await client.query(`DELETE FROM node WHERE id = 'node-a3'`);
  await expectValue(
    "worker node delete releases",
    `SELECT count(*) FROM instance_rank WHERE claim <> 'RELEASED'`,
    0,
  );
  await expectValue(
    "worker node delete ends open steps",
    `SELECT state FROM instance_step WHERE id = 'step-m1'`,
    "CANCELLED",
  );
  // always-on runtimes leave with their node (instance first)
  await client.query(`DELETE FROM node WHERE id = 'node-a1'`);
  await expectValue(
    "always-on runtime removed with its node",
    `SELECT count(*) FROM runtime WHERE id = 'rt-a'`,
    0,
  );
  // a running runtime cannot be deleted before its instances
  await expectFailure(
    "runtime delete with instances",
    `DELETE FROM runtime WHERE id = 'rt-s'`,
    "23503",
  );
  // 5. a pool used as another pool's sidecar
  await client.query(`DELETE FROM pool WHERE id = 'pool-vision'`);
  await expectValue(
    "sidecar link removed with its target",
    `SELECT count(*) FROM pool_sidecar WHERE id = 'sc-img'`,
    0,
  );
  // routing rules follow their member
  await client.query(`DELETE FROM pool_member WHERE id = 'member-a'`);
  await expectValue(
    "targeted rule removed with its member",
    `SELECT count(*) FROM pool_routing_rule WHERE id = 'rule-target'`,
    0,
  );
  await expectValue(
    "exclude rule becomes pool-wide",
    `SELECT count(*) FROM pool_routing_rule WHERE id = 'rule-exclude' AND "memberId" IS NULL AND NOT exclude`,
    1,
  );
  // 6. clearing can-contribute, then deleting a share
  await client.query(`UPDATE share SET "canContribute" = false WHERE id = 'share-b'`);
  await expectValue(
    "clearing canContribute removes contributed members",
    `SELECT count(*) FROM pool_member WHERE "shareId" = 'share-b'`,
    0,
  );
  await client.query(`DELETE FROM share WHERE id = 'share-b'`);
  await expectValue(
    "share delete removes the grantee's API-key entries",
    `SELECT count(*) FROM api_key_pool WHERE "apiKeyId" = 'key-b'`,
    0,
  );
  // 1. a user with running instances: the sweeper's order (instances, profiles, runtimes,
  //    nodes, pools, providers, user) succeeds.
  await client.query(`
    DELETE FROM runtime_instance WHERE "userId" = 'owner-a';
    DELETE FROM profile WHERE "userId" = 'owner-a';
    UPDATE runtime SET "currentVersionId" = NULL WHERE "userId" = 'owner-a';
    DELETE FROM runtime WHERE "userId" = 'owner-a';
    DELETE FROM node WHERE "userId" = 'owner-a';
    DELETE FROM pool WHERE "userId" = 'owner-a';
    DELETE FROM "user" WHERE id = 'owner-a';`);
  await expectValue("ordered user deletion", `SELECT count(*) FROM "user" WHERE id = 'owner-a'`, 0);

  if (failures > 0) throw new Error(`${failures} schema-hardening case(s) failed`);
  process.stdout.write("Schema-hardening PostgreSQL integration validation complete.\n");
} finally {
  await app.end().catch(() => undefined);
  await client.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
