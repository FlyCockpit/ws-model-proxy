import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_TABLES, HOT_PATH_TABLES } from "@ws-model-proxy/db/capacity-lock-order";
import { describe, expect, it } from "vitest";

// Static guard for DL-1 design (d) (packages/db/src/capacity-lock-order.ts,
// #78). The deadlock-freedom argument is structural and mostly enforced by
// PostgreSQL (fence protocol WMPF1/WMPF2, graph-write fence triggers WMPF4,
// no foreign key across the hot-path boundary; proven in
// packages/api/src/lib/writer-classes.postgres.integration.test.ts). This
// file pins the parts only the source can show:
//
// 1. `acquireFences` is the only way to take an advisory lock: nothing but
//    the fence module, the hardening SQL that defines `wsmp_acquire_fences`,
//    and the deploy entrypoint's session lock names an advisory function or
//    the fence setting.
// 2. Writer classes: only hot-path (H) and sweeper (S) modules write H
//    tables, so a management (M) transaction never holds an H row.
// 3. Every module that writes graph tables is classified (a census): a new
//    writer module needs a review of its class.
// 4. Reviewed FOR SHARE locks on graph parents (the E0 send-claim order).
//
// F2-05: the old lexical L7 position check is gone with the ordered delete
// it checked. What a lexical scan cannot see (a closure defined before a lock
// and called after it, a lock the caller takes before calling a helper) is
// refused at run time: a fence after the transaction's first row lock or
// write raises WMPF1 wherever the code sits (PostgreSQL tests "a deferred
// closure..." and "a caller-side lock..."). The negative cases below pin what
// the scan itself must still catch.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../..");
const scannedRoots = [
  "apps/server/src",
  "packages/api/src",
  "packages/auth/src",
  "packages/db/src",
  "packages/db/scripts",
  "packages/db/prisma",
  "scripts",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "generated", "e2e"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(tsx?|mjs|sql|sh)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function productionSources(): Array<{ file: string; source: string }> {
  return scannedRoots.flatMap((root) =>
    sourceFiles(join(repoRoot, root)).map((path) => ({
      file: relative(repoRoot, path),
      source: readFileSync(path, "utf8"),
    })),
  );
}

// ---------------------------------------------------------------------------
// 1. Fences
// ---------------------------------------------------------------------------

/** Files allowed to name an advisory-lock function, and why. */
const ADVISORY_SITES: Record<string, string> = {
  "packages/db/src/capacity-lock-order.ts":
    "The fence module: acquireFences calls wsmp_acquire_fences (its docs name pg_advisory*).",
  "packages/db/prisma/schema-hardening.sql":
    "Defines wsmp_acquire_fences, the only function that takes a fence's advisory lock.",
  "scripts/docker-entrypoint.sh":
    "Writer class D: the deploy's session-level lock serializing schema applies on a dedicated connection that holds nothing else.",
  "scripts/test-docker-entrypoint-schema.sh": "Test double for the entrypoint's deploy lock.",
};

/** Files allowed to name the fence protocol (function or setting), and why. */
const FENCE_PROTOCOL_SITES: Record<string, string> = {
  "packages/db/src/capacity-lock-order.ts":
    "acquireFences, the only caller of wsmp_acquire_fences.",
  "packages/db/prisma/schema-hardening.sql":
    "Defines the protocol, the graph-write fence triggers and the deploy's bypass marker.",
  "packages/db/src/test-fixture-client.ts":
    "Test fixtures only: a client whose connections carry the bypass marker.",
  "packages/db/scripts/verify-schema-hardening.mjs":
    "Deploy verification: asserts the hardening SQL still defines the protocol.",
};

function findAdvisoryReferences(file: string, source: string): string[] {
  return /\bpg_(?:try_)?advisory(?:_xact)?_(?:lock|unlock)(?:_shared)?\b|\bpg_advisory\b/.test(
    source,
  )
    ? [file]
    : [];
}

function findFenceProtocolReferences(file: string, source: string): string[] {
  return /\bwsmp_acquire_fences\b|wsmp\.fences\b|wsmp\.fence_last\b/.test(source) ? [file] : [];
}

// ---------------------------------------------------------------------------
// 2. Writer classes: hot-path tables
// ---------------------------------------------------------------------------

function delegateName(table: string): string {
  return table.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const WRITE_METHODS =
  "create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany";

/** H tables a source writes, by Prisma delegate or raw SQL. */
function findTableWrites(
  source: string,
  tables: readonly string[],
): Array<{ table: string; via: string }> {
  const writes: Array<{ table: string; via: string }> = [];
  for (const table of tables) {
    const delegate = delegateName(table);
    if (new RegExp(`\\.${delegate}\\.(?:${WRITE_METHODS})\\s*\\(`).test(source))
      writes.push({ table, via: "delegate" });
    const sql = new RegExp(
      `\\b(?:INSERT\\s+INTO|UPDATE(?:\\s+ONLY)?|DELETE\\s+FROM)\\s+(?:"?public"?\\.)?"?${table}"?(?![\\w])`,
      "i",
    );
    if (sql.test(source)) writes.push({ table, via: "sql" });
  }
  return writes;
}

/**
 * Modules allowed to write hot-path tables, by writer class. Management (M)
 * modules are absent by design: an M transaction holds graph rows and owner
 * fences, and must never also hold an H row.
 */
const HOT_PATH_WRITERS: Record<string, string> = {
  "apps/server/src/model-api/capacity/postgres-store.ts": "H: the admission store",
  "apps/server/src/model-api/capacity/postgres-process-worker.ts":
    "H: the multi-process admission proof worker (scheduler state under the capacity fence)",
  "apps/server/src/model-api/cache-affinity.ts":
    "H: cache affinity (fence) and its expiry sweep (S)",
  "apps/server/src/model-api/routes.ts": "H: relay status, execution telemetry and stickiness",
  "apps/server/src/model-api/public-overflow.ts": "H: external-provider relay status",
  "apps/server/src/model-api/provider-budget.ts": "H: provider budget admission and accounting",
  "apps/server/src/model-api/provider-attempt-runtime.ts": "H: provider attempt telemetry",
  "apps/server/src/model-api/usage-rollup.ts": "H: relay finalization and rollups",
  "apps/server/src/model-api/relay-telemetry-recovery.ts": "H/S: relay crash repair",
  "apps/server/src/model-api/usage-retention.ts": "S: relay and rollup retention",
  "packages/db/src/capacity-lock-order.ts": "S: the SKIP LOCKED relay delete helper",
  "packages/db/src/parent-deletion.ts": "S: the user-deletion history drain",
  "packages/db/src/hot-path-sweeps.ts": "S: purge, retention, orphan sweeps; H: affinity clear",
  "packages/db/src/usage-rollup-requester-drain.ts": "S: requester rollup merge",
  "packages/db/prisma/schema-hardening.sql": "D: deploy backfills under exclusive table locks",
  "packages/db/scripts/verify-schema-hardening.mjs":
    "D: schema verification on a disposable database",
  "packages/db/scripts/pre-push-null-cleanup.mjs":
    "D: legacy NULL row cleanup before the schema push",
};

// ---------------------------------------------------------------------------
// 3. Graph writer census
// ---------------------------------------------------------------------------

/**
 * Every module that writes a graph table, with its class. M writers take
 * owner fences first (the fence triggers refuse their structural writes
 * otherwise); H status writers change only unfenced status columns, one row
 * per statement or in the provider account -> model order.
 */
const GRAPH_WRITERS: Record<string, string> = {
  "apps/server/src/relay/registration.ts": "M: relay registration",
  "apps/server/src/relay/session-manager.ts": "H status: device connection state",
  "apps/server/src/model-api/provider-attempt-runtime.ts":
    "H status: provider health and fencing (account -> model)",
  "apps/server/src/model-api/public-overflow.ts": "H status: credential lastUsedAt",
  "packages/api/src/lib/model-pool-routing.ts":
    "H status: pool member health, one row per statement",
  "packages/api/src/lib/model-api-token-access.ts": "H status: token lastUsedAt (SKIP LOCKED)",
  "packages/api/src/lib/discovered-inference-capacity.ts": "M: capacity discovery and backfill",
  "packages/api/src/lib/engine-facts.ts":
    "M: relay engine facts and AUTO limit refresh (registration holds the capacity fences)",
  "packages/api/src/lib/cli-credential-access.ts": "M: device login and deletion",
  "packages/api/src/routers/forwarder-management.ts": "M: dashboard pool/device/model writes",
  "packages/api/src/routers/capacity-management.ts": "M: capacity policy",
  "packages/api/src/routers/provider-management.ts": "M: provider management",
  "packages/api/src/routers/provider-catalog.ts": "M: provider catalog import",
  "packages/api/src/routers/pool-fallback.ts":
    "M: pool external-fallback settings (owner fence, pool row)",
  "packages/api/src/routers/pool-fallback-preferences.ts": "M: own-key preference",
  "packages/api/src/routers/model-api-tokens.ts": "M: model API tokens",
  "packages/api/src/routers/users.ts": "user profile/ban fields (unfenced columns)",
  "packages/api/src/routers/auth.ts": "user profile fields (unfenced columns)",
  "packages/api/src/routers/settings.ts": "user settings (unfenced columns)",
  "packages/db/src/capacity-lock-order.ts": "M: the user delete under owner fences",
  "packages/db/src/parent-deletion.ts": "user deletion marker writes (unfenced columns)",
  "packages/db/prisma/schema-hardening.sql": "D: deploy backfills (bypass marker)",
  "packages/db/scripts/verify-schema-hardening.mjs": "D: schema verification",
};

// ---------------------------------------------------------------------------
// 4. Reviewed FOR SHARE locks (E0 send-claim order)
// ---------------------------------------------------------------------------

/**
 * Graph parents whose explicit FOR SHARE locks are reviewed: FOR SHARE
 * conflicts with the FOR NO KEY UPDATE of writers and of the deletion mark,
 * unlike a foreign key's FOR KEY SHARE.
 */
const SHARE_GUARDED_TABLES = ["execution_target", "model_pool", "pool_member", "user"];

/**
 * Explicit FOR SHARE locks on a guarded graph parent, each with its reviewed
 * reason. Key: `<relative file>:<table>.FOR SHARE`.
 */
const REVIEWED_SHARE_LOCKS: Record<string, string> = {
  "packages/api/src/routers/pool-fallback-preferences.ts:model_pool.FOR SHARE":
    "Own-key preference setter: after its owner fence, pool SHARE, then exact grant SHARE, requester account SHARE, model SHARE, preference upsert. No capacity fence. Writers/deletion serialize at the pool; provider writers serialize at the account before reaching model/preference. See capacity-lock-order.ts, preference setter transaction.",
  "packages/db/prisma/schema-hardening.sql:user.FOR SHARE":
    "session_refuse_deleting_user (DEL-STATE commit point): a BEFORE INSERT ON session trigger. The session inserter holds no fence and takes none afterwards (a single-statement insert, or sign-up's transaction on a brand-new user row), so its wait on a mark, the user delete's row lock or a user writer closes no cycle.",
  "packages/db/src/parent-deletion.ts:user.FOR SHARE":
    "lockUserDeletionOwner (F2-03): the first lock of a user-deletion drain batch, on its deletion generation. The batch takes no fence; afterwards it takes only history rows with SKIP LOCKED and their H-internal cascades, every lock wait bounded by a transaction-local lock_timeout and every statement by a transaction-local statement_timeout. It never waits on a fence or a graph row, so the user delete (fences, then this row FOR UPDATE) waiting for it closes no cycle; abandon, restore and a new mark wait for the batch and then withdraw the generation.",
  "packages/api/src/lib/model-api-token-access.ts:model_pool.FOR SHARE":
    "lockExternalSendConsent (E0 send boundary): the first lock of the send-claim transaction, which starts holding nothing, then takes grant, token and allowlist rows FOR SHARE and provider account/credential rows FOR UPDATE, and no fence. Capacity admission takes no pool row at all; the claim's wait on a pool writer or delete closes no cycle (see capacity-lock-order.ts, E0 send-claim transaction).",
  "packages/api/src/lib/cli-credential-access.ts:user.FOR SHARE":
    "mintCliDeviceCredentialFromApprovedDeviceCode (F2-04): the owner's marker read after its owner fence and the device row, before the device-code row. The user delete holds the same owner fence, so the two never interleave.",
};

type Finding = { file: string; site: string; detail: string };

function sqlStatements(file: string, source: string): string[] {
  if (file.endsWith(".sql")) return source.split(/;\s*(?:\n|$)/);
  return [...source.matchAll(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)].map(
    (match) => match[0],
  );
}

function findSqlLockOrderViolations(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of sqlStatements(file, source)) {
    const sql = raw.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    if (/\bFOR\s+SHARE\b/i.test(sql))
      for (const table of SHARE_GUARDED_TABLES) {
        const from = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?"?${table}"?(?:\\s|$)`, "i");
        if (from.test(sql))
          findings.push({ file, site: `${table}.FOR SHARE`, detail: sql.slice(0, 140) });
      }
  }
  return findings;
}

function scanShareLocks(): Finding[] {
  return productionSources()
    .filter(({ file }) => !file.endsWith(".sh"))
    .flatMap(({ file, source }) => findSqlLockOrderViolations(file, source));
}

describe("capacity lock order (DL-1 design (d)): writer classes and fences", () => {
  it("takes advisory locks only through acquireFences (and the deploy entrypoint)", () => {
    const sites = productionSources().flatMap(({ file, source }) =>
      findAdvisoryReferences(file, source),
    );
    expect(sites.filter((file) => !(file in ADVISORY_SITES))).toEqual([]);
    // No stale allowance.
    expect(Object.keys(ADVISORY_SITES).filter((file) => !sites.includes(file))).toEqual([]);
  });

  it("names the fence protocol only in the fence module, the hardening SQL and the fixture client", () => {
    const sites = productionSources().flatMap(({ file, source }) =>
      findFenceProtocolReferences(file, source),
    );
    expect(sites.filter((file) => !(file in FENCE_PROTOCOL_SITES))).toEqual([]);
    expect(Object.keys(FENCE_PROTOCOL_SITES).filter((file) => !sites.includes(file))).toEqual([]);
  });

  it("writes hot-path tables only from hot-path and sweeper modules", () => {
    const writers = new Map<string, string[]>();
    for (const { file, source } of productionSources()) {
      const writes = findTableWrites(source, HOT_PATH_TABLES);
      if (writes.length > 0)
        writers.set(file, [...new Set(writes.map((write) => write.table))].sort());
    }
    expect([...writers.keys()].filter((file) => !(file in HOT_PATH_WRITERS)).sort()).toEqual([]);
    expect(Object.keys(HOT_PATH_WRITERS).filter((file) => !writers.has(file))).toEqual([]);
  });

  it("classifies every module that writes a graph table", () => {
    const writers = new Set<string>();
    for (const { file, source } of productionSources())
      if (findTableWrites(source, GRAPH_TABLES).length > 0) writers.add(file);
    expect([...writers].filter((file) => !(file in GRAPH_WRITERS)).sort()).toEqual([]);
    expect(Object.keys(GRAPH_WRITERS).filter((file) => !writers.has(file))).toEqual([]);
  });

  it("detects advisory and fence-protocol references in every spelling it can see (negative cases)", () => {
    expect(
      findAdvisoryReferences("x.ts", "tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`"),
    ).toEqual(["x.ts"]);
    expect(
      findAdvisoryReferences(
        "x.ts",
        'await tx.$executeRawUnsafe("SELECT pg_try_advisory_xact_lock($1)", k)',
      ),
    ).toEqual(["x.ts"]);
    expect(findAdvisoryReferences("x.sql", "PERFORM pg_advisory_lock_shared(7);")).toEqual([
      "x.sql",
    ]);
    expect(findAdvisoryReferences("x.ts", "const f = fences.owner(userId);")).toEqual([]);
    expect(
      findFenceProtocolReferences(
        "x.ts",
        "tx.$executeRaw`SELECT set_config('wsmp.fences', ',*,', true)`",
      ),
    ).toEqual(["x.ts"]);
    expect(findFenceProtocolReferences("x.ts", "SELECT wsmp_acquire_fences($1, true)")).toEqual([
      "x.ts",
    ]);
  });

  it("detects hot-path writes by delegate and by raw SQL (negative cases)", () => {
    const tables = (source: string) => findTableWrites(source, HOT_PATH_TABLES);
    expect(tables("await tx.capacityLease.create({ data })")).toEqual([
      { table: "capacity_lease", via: "delegate" },
    ]);
    expect(tables("await tx.relayRequest.updateMany({ where, data })")).toEqual([
      { table: "relay_request", via: "delegate" },
    ]);
    expect(tables('tx.$executeRaw`UPDATE "capacity_runtime" SET x = 1`')).toEqual([
      { table: "capacity_runtime", via: "sql" },
    ]);
    expect(tables("tx.$executeRaw`INSERT INTO public.admission_request (id) VALUES ($1)`")).toEqual(
      [{ table: "admission_request", via: "sql" }],
    );
    expect(tables("DELETE FROM usage_rollup_minute WHERE ctid IN (...)")).toEqual([
      { table: "usage_rollup_minute", via: "sql" },
    ]);
    // Reads are not writes; a longer table name is not the H table.
    expect(tables("await tx.capacityLease.findMany({ where })")).toEqual([]);
    expect(tables("SELECT 1 FROM capacity_lease WHERE id = $1 FOR UPDATE")).toEqual([]);
    expect(tables("UPDATE relay_request_archive SET x = 1")).toEqual([]);
  });

  it("classifies every table: hot-path and graph lists are disjoint and complete against the schema", () => {
    const schemaDir = join(repoRoot, "packages/db/prisma/schema");
    const tables = new Set<string>();
    for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".prisma"))) {
      const source = readFileSync(join(schemaDir, file), "utf8");
      for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm))
        tables.add(/@@map\("([^"]+)"\)/.exec(match[2] ?? "")?.[1] ?? match[1] ?? "");
    }
    const hot = new Set<string>(HOT_PATH_TABLES);
    const graph = new Set<string>(GRAPH_TABLES);
    expect([...hot].filter((table) => graph.has(table))).toEqual([]);
    expect([...hot, ...graph].filter((table) => !tables.has(table))).toEqual([]);
  });

  it("finds no unreviewed FOR SHARE lock on a guarded graph parent", () => {
    const unreviewed = scanShareLocks().filter(
      (finding) => !REVIEWED_SHARE_LOCKS[`${finding.file}:${finding.site}`],
    );
    expect(unreviewed.map((finding) => `${finding.file}: ${finding.detail}`)).toEqual([]);
    const sites = new Set(scanShareLocks().map((finding) => `${finding.file}:${finding.site}`));
    expect(Object.keys(REVIEWED_SHARE_LOCKS).filter((site) => !sites.has(site))).toEqual([]);
  });

  it("flags explicit FOR SHARE on a guarded graph parent, not FOR KEY SHARE", () => {
    const check = (source: string) =>
      findSqlLockOrderViolations("probe.sql", source).map((finding) => finding.site);
    expect(check('SELECT 1 FROM "user" u WHERE u.id = NEW."userId" FOR SHARE;\n')).toEqual([
      "user.FOR SHARE",
    ]);
    expect(check("SELECT id FROM model_pool WHERE id = 1 FOR SHARE;\n")).toEqual([
      "model_pool.FOR SHARE",
    ]);
    expect(check('SELECT 1 FROM "user" WHERE id = 1 FOR KEY SHARE;\n')).toEqual([]);
  });
});
