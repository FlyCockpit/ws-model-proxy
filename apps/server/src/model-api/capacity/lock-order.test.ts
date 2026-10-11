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
    return /\.(tsx?|mjs|sql|sh)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/(?:\.test-helper|-test-helpers)\.ts$/.test(entry.name)
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
    "Defines wsmp_acquire_fences and the residency trigger's nonblocking target try-lock (never a waited fence).",
  "scripts/docker-entrypoint.sh":
    "Writer class D: the deploy's session-level lock serializing schema applies on a dedicated connection that holds nothing else.",
  "scripts/test-docker-entrypoint-schema.sh": "Test double for the entrypoint's deploy lock.",
};

/** Files allowed to name the fence protocol (function or setting), and why. */
const FENCE_PROTOCOL_SITES: Record<string, string> = {
  "packages/db/src/capacity-lock-order.ts":
    "acquireFences, the only caller of wsmp_acquire_fences; requireOwnerFences reads the held set.",
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
  "apps/server/src/model-api/cache-affinity-observers.ts":
    "H: observer receipts and leases; status authority commits separately before receipt CAS, no graph locks held with history/projection.",
  "apps/server/src/model-api/cache-affinity-maintenance.ts":
    "S: durable clear claims and orphan metadata pruning; bounded H reclaim helper owns the pool fence before rows.",
  "apps/server/src/model-api/capacity/postgres-store.ts": "H: the admission store",
  "apps/server/src/model-api/cache-affinity.ts":
    "H: cache affinity (fence) and its expiry sweep (S)",
  "apps/server/src/model-api/cache-affinity-residency.ts":
    "S: bounded disposable projection discovery/repair/GC; only bucket/cursor locks, no graph or source-row locks, statement-bounded upserts.",
  "apps/server/src/model-api/routes.ts": "H: relay status, execution telemetry and stickiness",
  "apps/server/src/model-api/public-overflow.ts": "H: external-provider relay status",
  "apps/server/src/model-api/provider-attempt-runtime.ts": "H: provider attempt telemetry",
  "apps/server/src/model-api/provider-budget.ts":
    "H: cloud spend admission and accounting (attempt anchor, reservations, settlements, ledger) after the spend-attempt then spend-cap fences; graph rows read without a lock; S: its expired-attempt repair takes the same attempt fence",
  "apps/server/src/model-api/kv-eviction-feedback.ts":
    "H: disposable KV eviction feedback (one owner-guarded single-statement upsert, no fence)",
  "apps/server/src/relay/runtime-load-rollup.ts":
    "H: persisted runtime-load minutes (batched owner-guarded upserts, no fence)",
  "apps/server/src/relay/node-metrics-rollup.ts":
    "H: node metrics minutes (batched upserts, no fence)",
  "apps/server/src/model-api/usage-rollup.ts": "H: relay finalization and rollups",
  "apps/server/src/model-api/realtime/metering.ts":
    "H: live transcription session relay rows (one create at open; finalized through usage-rollup's terminal transition); no fence, no graph locks",
  "apps/server/src/model-api/relay-telemetry-recovery.ts": "H/S: relay crash repair",
  "apps/server/src/model-api/usage-retention.ts": "S: relay and rollup retention",
  "apps/server/src/relay/metric-routing-evaluator.ts":
    "H: metric routing verdicts (the per-device rule evaluator; single-statement writes)",
  "packages/db/src/capacity-lock-order.ts": "S: the SKIP LOCKED relay delete helper",
  "packages/db/src/parent-deletion.ts": "S: the user-deletion history drain",
  "packages/db/src/hot-path-sweeps.ts": "S: purge, retention, orphan sweeps; H: affinity clear",
  "packages/db/prisma/schema-hardening.sql": "D: deploy backfills under exclusive table locks",
  "packages/db/scripts/verify-schema-hardening.mjs":
    "D: schema verification on a disposable database",
  "packages/db/scripts/pre-push-null-cleanup.mjs":
    "D: legacy NULL row cleanup and in-place renames before the schema push",
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
  "apps/server/src/model-api/cache-affinity-generation.ts":
    "H status: bounded capacity generation then endpoint epoch; commits each before optional projection publication, no source/bucket lock overlaps",
  "apps/server/src/relay/registration.ts": "M: relay registration",
  "apps/server/src/runtimes/lifecycle.ts":
    "M: runtime lifecycle (steps, claims, instance phases, a managed instance's engine facts, the inactive-owner drain) under graphWrite: the owner fence, then the instance's capacity fence; execution targets of a READY instance in the same transaction",
  "apps/server/src/runtimes/always-on.ts":
    "M: always-on runtimes from inventory (node-origin runtimes, versions, served models, the instance, its targets, facts and phase) under graphWrite: the owner fence, then the capacity fences of the runtime's instances; a node-origin runtime the node stopped reporting under graphDelete (fenceParentDelete)",
  "apps/server/src/relay/node-services.ts":
    "H status: node detectedServers for the current connection generation (no fenced column)",
  "apps/server/src/relay/runtime-sync.ts":
    "H status: node held definitions and held hashes for the current connection generation (no fenced column)",
  "apps/server/src/model-api/provider-attempt-runtime.ts":
    "H status: provider health and fencing (account -> model)",
  "packages/api/src/lib/claim-release.ts":
    "M: a claim's release (proven stop or a person's release without proof) and its release requests, inside the caller's graphWrite (owner fence, then the instance's capacity fence); the request sweep writes only claim_release_request, which no fence covers",
  "packages/api/src/lib/runtime-store.ts":
    "M: runtime versions, written inside lane C's graphWrite (owner fence, then capacity fences of the runtime's instances)",
  "packages/api/src/lib/share-invite-accept.ts":
    "M: invite acceptance creates the pool share or runtime share under both owners' fences (sorted), then the invite row",
  "packages/api/src/lib/share-invite-write.ts":
    "M: pool and runtime invites (create, resend) under runAccessTransaction (the owner's fence); emailSentAt is a status column",
  "packages/api/src/nodes/enroll-exchange.ts":
    "M: enrollment exchange creates or takes over the node under graphWrite (the code owner's fence), code row FOR UPDATE",
  "packages/api/src/nodes/fabrics.ts":
    "M: fabric memberships, written inside nodes.update's graphWrite (owner fence first)",
  "packages/api/src/nodes/secrets.ts":
    "H status: node features secret names after a confirmed secret write (one owner-guarded compare-and-set statement on an unfenced column)",
  "packages/api/src/nodes/procedures.ts":
    "M: node definition, trust and fabrics under graphWrite (owner fence); node delete under graphDelete (fenceParentDelete)",
  "packages/api/src/profiles/procedures.ts":
    "M: profile save and apply under graphWrite (owner fence); profile delete under graphDelete (fenceParentDelete)",
  "packages/api/src/routers/access.ts":
    "M: API keys, agent tokens, shares, own-key choices and invites under runAccessTransaction (sorted owner fences; a share cap edit then the share's spend fence)",
  "packages/api/src/routers/pools.ts":
    "M: pools, members, routing and sidecars under graphWrite (owner fence, then pool target policy fences); an own-key equivalent change also clears the shares' own-key choices under the grantees' owner fences",
  "packages/api/src/routers/providers.ts":
    "M: provider accounts, keys, models, prices and caps under graphWrite (owner fence, then the account's spend fence for caps, or model target policy fences); a new or restored model's execution target is inserted under the owner fence alone (provider-targets.ts takes the same owner fence first, and a skipDuplicates insert makes a race with it a no-op)",
  "packages/api/src/routers/runtime-lifecycle.ts":
    "M: start/stop operations, instances and ranks under graphWrite (owner fence, then instance capacity fences)",
  "packages/api/src/routers/runtimes.ts":
    "M: runtimes, versions, models and shares under graphWrite / graphDelete",
  "packages/api/src/lib/pool-routing.ts":
    "H status: execution-target health and recovery trials, one row per statement",
  "packages/api/src/lib/engine-facts.ts":
    "M: relay engine facts and AUTO limit refresh (registration holds the capacity fences)",
  "packages/api/src/routers/users.ts": "user profile/ban fields (unfenced columns)",
  "packages/api/src/routers/auth.ts": "user profile fields (unfenced columns)",
  "packages/api/src/routers/settings.ts": "user settings (unfenced columns)",
  "packages/api/src/lib/needs-you-mail.ts":
    "H status: the needs-you e-mail marker and failure count on an instance (unfenced status columns), one compare-and-set statement per row",
  "packages/auth/src/proved-email.ts": "user mailbox proof after verify-email (unfenced column)",
  "packages/db/src/capacity-lock-order.ts": "M: the user delete under owner fences",
  "apps/server/src/model-api/public-overflow.ts":
    "H status: the E0 send claim's credential lastUsedAt, after its owner fences and the credential row FOR UPDATE",
  "apps/server/src/model-api/provider-targets.ts":
    "M: a provider model's missing execution target (models created before providers.models.create made it), created on first use under the owner then target-identity fences, account and model rows FOR KEY SHARE first",
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
const SHARE_GUARDED_TABLES = [
  "execution_target",
  "pool",
  "pool_member",
  "share",
  "node",
  "runtime_instance",
  "user",
];

/**
 * Explicit FOR SHARE locks on a guarded graph parent, each with its reviewed
 * reason. Key: `<relative file>:<table>.FOR SHARE`.
 */
const REVIEWED_SHARE_LOCKS: Record<string, string> = {
  "apps/server/src/model-api/local-send.ts:pool_member.FOR SHARE":
    "Taken after sorted owner and target-policy fences and device/endpoint/model rows, before sorted account rows. Serializes operational instance gates and health; this transaction acquires no hot-path or later fences.",
  "apps/server/src/model-api/local-send.ts:pool.FOR SHARE":
    "Local permission transaction takes sorted graph owner fences and the target's capacity-policy fence before any row; no hot-path writes or admission locks, no response/body waits. Pool, then share, node, instance, target (KEY SHARE), member, user. Management writers sharing owners serialize at the fences before rows.",
  "apps/server/src/model-api/local-send.ts:share.FOR SHARE":
    "Same transaction, after the pool row: the requester's share (canUse). Share writers hold the pool owner's fence, which this transaction already holds, so they serialize before rows.",
  "apps/server/src/model-api/local-send.ts:node.FOR SHARE":
    "Same transaction, after the share: the head node row catches unfenced connection/trust status writes (registration, trust lowering). Those writers update one node row and take no fence or graph row afterwards, so waiting on them closes no cycle.",
  "apps/server/src/model-api/local-send.ts:runtime_instance.FOR SHARE":
    "Same transaction, after the node: the instance row catches unfenced lifecycle/phase writes (A4 jobs, health). Those writers take the instance's capacity fence first only for structural changes; status writes touch one row and nothing later, so no cycle.",
  "apps/server/src/model-api/public-overflow.ts:pool.FOR SHARE":
    "E0 send claim: after the sorted owner fences of requester, pool owner and payer, before any other row. Pool, then share, api_key, pool_member, then provider account/model (SHARE) and credential (UPDATE), users last. Pool and share writers hold an owner fence this transaction already holds, so they serialize before rows; it writes nothing but the held credential's lastUsedAt and takes no hot-path row or later fence.",
  "apps/server/src/model-api/public-overflow.ts:share.FOR SHARE":
    "E0 send claim, after the pool row: the requester's share (canUse, own-key choice). Share writers hold the pool owner's fence, which the claim already holds.",
  "apps/server/src/model-api/public-overflow.ts:pool_member.FOR SHARE":
    "E0 send claim, after pool, pool_fallback, share and api_key, before the provider rows: the CLOUD member's state. Member writers need the pool owner's fence (structural and state/weight columns), which the claim already holds, so they serialize before rows; no cycle.",
  "apps/server/src/model-api/public-overflow.ts:user.FOR SHARE":
    "E0 send claim, last lock: the sorted requester, pool owner and payer rows catch unfenced Better Auth bans. A ban writer updates one user row and takes nothing afterwards; deletion writers hold an owner fence the claim already holds. No fence or row is taken after it.",
  "apps/server/src/model-api/local-send.ts:user.FOR SHARE":
    "Sorted user SHARE locks after graph owner/target-policy fences and graph rows catch unfenced Better Auth one-user bans. Ban writer updates one user and takes no inference row afterwards. Deletion writers share owner fences, and pool-before-user order matches deletion. No later fence/graph row acquisition.",
  "packages/db/prisma/schema-hardening.sql:user.FOR SHARE":
    "session_refuse_deleting_user (DEL-STATE commit point): a BEFORE INSERT ON session trigger. The session inserter holds no fence and takes none afterwards (a single-statement insert, or sign-up's transaction on a brand-new user row), so its wait on a mark, the user delete's row lock or a user writer closes no cycle.",
  "packages/db/src/parent-deletion.ts:user.FOR SHARE":
    "lockUserDeletionOwner (F2-03): the first lock of a user-deletion drain batch, on its deletion generation. The batch takes no fence; afterwards it takes only history rows with SKIP LOCKED and their H-internal cascades, every lock wait bounded by a transaction-local lock_timeout and every statement by a transaction-local statement_timeout. It never waits on a fence or a graph row, so the user delete (fences, then this row FOR UPDATE) waiting for it closes no cycle; abandon, restore and a new mark wait for the batch and then withdraw the generation.",
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

/** Text of the balanced (...) or {...} group starting at `start` (quotes skipped). */
function balanced(source: string, start: number): string {
  const open = source[start];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced group at ${start}`);
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
    // Discovery/repair/GC owns only the disposable projection. In particular,
    // adding canonical record writes here must not inherit a broad H allowance.
    expect(writers.get("apps/server/src/model-api/cache-affinity-residency.ts")).toEqual([
      "cache_affinity_residency",
      "cache_affinity_residency_cursor",
    ]);
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
    expect(tables('tx.$executeRaw`UPDATE "capacity_scheduler" SET x = 1`')).toEqual([
      { table: "capacity_scheduler", via: "sql" },
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
    expect(check("SELECT id FROM pool WHERE id = 1 FOR SHARE;\n")).toEqual(["pool.FOR SHARE"]);
    expect(check('SELECT 1 FROM "user" WHERE id = 1 FOR KEY SHARE;\n')).toEqual([]);
  });

  // E0 send claim (public-overflow.ts): its locks appear in the documented order (fences,
  // consent rows, member, provider account -> model -> credential, users last), every re-read
  // follows the last lock, and nothing after the last lock waits or writes anything but the
  // held credential's lastUsedAt.
  it("keeps the E0 send claim's lock sequence and lock-free post-lock re-reads", () => {
    const file = "apps/server/src/model-api/public-overflow.ts";
    const source = readFileSync(join(repoRoot, file), "utf8");
    const claimStart = source.indexOf(
      "export async function claimPublicProviderCredentialForSend(",
    );
    expect(claimStart).toBeGreaterThanOrEqual(0);
    const claim = balanced(
      source,
      source.indexOf("{", source.indexOf("): Promise<PublicProviderSendClaim> {", claimStart)),
    );
    const position = (needle: string) => {
      const index = claim.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    const sequence = [
      "set_config('lock_timeout'",
      "fenceOwners(",
      "FROM pool WHERE id",
      "FROM pool_fallback WHERE",
      "FROM share WHERE id",
      "FROM api_key WHERE id",
      "FROM pool_member WHERE id",
      "FROM provider_account WHERE id",
      "FROM provider_model WHERE id",
      "FROM provider_credential WHERE id",
      'FROM "user" WHERE id IN',
      "recheckExternalSendTarget(",
      "providerCredential.update(",
    ].map(position);
    expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    const recheckStart = source.indexOf("async function recheckExternalSendTarget(");
    const recheck = balanced(
      source,
      source.indexOf("{", source.indexOf("): Promise<", recheckStart)),
    );
    expect(recheck).toContain("poolMember.findFirst(");
    expect(recheck).toContain("providerModel.findFirst(");
    expect(recheck).not.toMatch(/FOR (NO KEY )?(SHARE|UPDATE)|\$queryRaw|\$executeRaw/);
    const lockClause = /FOR (NO KEY |KEY )?(SHARE|UPDATE)|NOWAIT|SKIP LOCKED|LOCK TABLE/;
    const tail = claim.slice(claim.indexOf("// Nothing below waits on a lock."));
    expect(tail).not.toMatch(lockClause);
    expect(tail).not.toMatch(/\$queryRaw|\$executeRaw|acquireFences|fenceOwners/);
    expect(
      tail.match(/\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\(/g),
    ).toEqual([".update("]);
    expect(tail).toContain("tx.providerCredential.update(");
  });
});
