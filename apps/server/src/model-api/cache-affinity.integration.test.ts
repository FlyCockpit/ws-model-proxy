// Fixture writes need no owner fences (the graph-write fence triggers accept
// this client); production code under test uses its own clients.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireFences, fences } from "@ws-model-proxy/db/capacity-lock-order";
import {
  clearCacheAffinityRecords,
  reclaimClearedAffinity,
} from "@ws-model-proxy/db/hot-path-sweeps";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type PrismaSql = typeof import("@ws-model-proxy/db").Prisma;
const runFile = promisify(execFile);

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[cache-affinity] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

// Loaded after the skip guard: the residency module imports the production
// Prisma client and env, whose validation fails in a unit run with no database.
type Residency = typeof import("./cache-affinity-residency.js");
let discoverAffinityResidency: Residency["discoverAffinityResidency"];
let pruneAffinityResidency: Residency["pruneAffinityResidency"];
let queryAffinityResidency: Residency["queryAffinityResidency"];
let repairAffinityResidencyPage: Residency["repairAffinityResidencyPage"];
let startAffinityResidencyRepair: Residency["startAffinityResidencyRepair"];

integration("cache affinity PostgreSQL concurrency and retention", () => {
  const db = databaseUrl ? createFixturePrismaClient(databaseUrl) : undefined;
  let service: typeof import("./cache-affinity.js");
  let Prisma: PrismaSql;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "cache-affinity-integration-secret-32-bytes";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    ({ Prisma } = await import("@ws-model-proxy/db"));
    service = await import("./cache-affinity.js");
    ({
      discoverAffinityResidency,
      pruneAffinityResidency,
      queryAffinityResidency,
      repairAffinityResidencyPage,
      startAffinityResidencyRepair,
    } = await import("./cache-affinity-residency.js"));
  });

  afterAll(async () => db?.$disconnect());

  async function fixture() {
    if (!db) throw new Error("database unavailable");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Affinity owner", email: `affinity-owner-${suffix}@example.test` },
    });
    const tenant = await db.user.create({
      data: { name: "Affinity tenant", email: `affinity-tenant-${suffix}@example.test` },
    });
    const otherTenant = await db.user.create({
      data: { name: "Other tenant", email: `affinity-other-${suffix}@example.test` },
    });
    const device = await db.cliDevice.create({
      data: { userId: owner.id, slug: `device-${suffix}` },
    });
    const endpoint = await db.endpoint.create({
      data: {
        userId: owner.id,
        cliDeviceId: device.id,
        slug: `endpoint-${suffix}`,
        label: "Endpoint",
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `capacity-${suffix}`,
        runtimeIdentityKey: `runtime-${suffix}`,
        runtimeModel: "model",
      },
    });
    const targets = await Promise.all(
      ["a", "b"].map(async (label) => {
        const model = await db.discoveredModel.create({
          data: {
            userId: owner.id,
            endpointId: endpoint.id,
            upstreamModelId: `${label}-${suffix}`,
            encodedModelId: `${label}-${suffix}`,
          },
        });
        return db.executionTarget.update({
          where: { discoveredModelId: model.id },
          data: { inferenceCapacityId: capacity.id },
        });
      }),
    );
    const pool = await db.modelPool.create({
      data: { userId: owner.id, name: "Affinity pool", slug: `affinity-${suffix}` },
    });
    const target = (index: number) => ({
      poolMemberId: `member-${index}`,
      executionTargetId: targets[index]!.id,
      targetIdentity: `identity-${index}`,
      capacityId: capacity.id,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    });
    return { owner, tenant, otherTenant, pool, target, endpoint };
  }

  const policy = {
    enabled: true,
    ttlSeconds: 60,
    maxRecords: 3,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 250,
    loadPenaltyWeight: 100,
  };

  it("starts a new root while the authoritative client id retains routing without leaking across tenant, token, or runtime", async () => {
    if (!db) return;
    const row = await fixture();
    const first = await service.rememberAffinity({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy: { ...policy, maxRecords: 8 },
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "private-conversation-id",
        input: "first turn",
        instructions: "old instructions",
        tools: [{ name: "old-tool" }],
        temperature: 0.1,
      },
      target: row.target(0),
    });
    const created = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
      select: {
        digestVersion: true,
        prefixDigest: true,
        prefixDepth: true,
        conversationDigest: true,
      },
    });
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((record) => record.digestVersion === 5)).toBe(true);
    expect(
      created
        .filter((record) => record.prefixDigest !== null)
        .every((record) => record.prefixDepth > 0 && record.conversationDigest === null),
    ).toBe(true);
    const changedTurn = {
      conversation: "private-conversation-id",
      input: "second turn",
      instructions: "new instructions",
      tools: [{ name: "new-tool" }],
      temperature: 0.9,
    };
    const ranked = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: changedTurn,
      targets: [row.target(1), row.target(0)],
    });
    // A client id is authoritative across root changes. It keeps the session
    // footprint/routing bonus, but never claims conversation-prefix cache reuse.
    expect(ranked.orderedTargetIds[0]).toBe(row.target(0).executionTargetId);
    expect(ranked.conversationMatches[row.target(0).executionTargetId]).toBe(true);
    expect(ranked.matchedSessionIds?.[row.target(0).executionTargetId]).toBe(first!.sessionId);
    const changedMaterial = service.affinityPrefixDigests({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      surface: "OPENAI_RESPONSES",
      payload: changedTurn,
      runtimeIdentity: row.target(0).targetIdentity,
    });
    expect(changedMaterial.rootDigest).not.toBe(first!.rootDigest);
    expect(ranked.prefixDepths[row.target(0).executionTargetId]).toBe(0);

    for (const isolation of [
      { ownerId: row.otherTenant.id, securityScope: "token-a", accessGrantId: "grant-a" },
      { ownerId: row.tenant.id, securityScope: "token-b", accessGrantId: "grant-a" },
      { ownerId: row.tenant.id, securityScope: "token-a", accessGrantId: "grant-b" },
    ]) {
      const isolated = await service.rankAffinityTargets({
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: changedTurn,
        targets: [row.target(1), row.target(0)],
        ...isolation,
      });
      expect(isolated.conversationMatches[row.target(0).executionTargetId]).toBe(false);
    }
    const replacementGrant = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-b",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: {
        conversation: "private-conversation-id",
        input: "first turn",
        instructions: "old instructions",
        tools: [{ name: "old-tool" }],
        temperature: 0.1,
      },
      targets: [row.target(1), row.target(0)],
    });
    expect(replacementGrant.prefixDepths[row.target(0).executionTargetId]).toBe(0);
    expect(replacementGrant.conversationMatches[row.target(0).executionTargetId]).toBe(false);
    const changedRuntime = { ...row.target(0), targetIdentity: "changed-runtime-binding" };
    const runtimeIsolated = await service.rankAffinityTargets({
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      accessGrantId: "grant-a",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: changedTurn,
      targets: [row.target(1), changedRuntime],
    });
    expect(runtimeIsolated.conversationMatches[changedRuntime.executionTargetId]).toBe(false);
  });

  it("keeps one warm-session id for an explicit conversation across edited and shortened history and changed parameters", async () => {
    if (!db) return;
    const row = await fixture();
    const base = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "token-a",
      policy: { ...policy, maxRecords: 100 },
      surface: "OPENAI_CHAT_COMPLETIONS",
    };
    // Real-clock based (the row's createdAt is the database's now), one second per step.
    const start = Date.now();
    const at = (seconds: number) => new Date(start + seconds * 1000);
    const user = (content: string) => ({ role: "user", content });
    const assistant = (content: string) => ({ role: "assistant", content });
    const chat = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
      messages: [{ role: "system", content: "rules" }, ...messages],
      ...extra,
    });
    const remember = (
      payload: Record<string, unknown>,
      seconds: number,
      targetIndex = 0,
      overrides: Record<string, unknown> = {},
    ) =>
      service.rememberAffinity({
        ...base,
        ...overrides,
        payload,
        target: row.target(targetIndex),
        estimatedTokens: 10_000 + seconds,
        now: at(seconds),
      });
    const sessions = async () =>
      new Set(
        (
          await db.cacheAffinityRecord.findMany({
            where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
            select: { sessionId: true },
          })
        ).map((record) => record.sessionId),
      );

    // Turn 1, turn 2 (continuation), then an edited earlier turn and a
    // shortened history: one session throughout.
    await remember(chat([user("a")]), 1);
    const [first] = [...(await sessions())];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await remember(chat([user("a"), assistant("b"), user("c")]), 2);
    await remember(chat([user("a"), assistant("b"), user("c"), assistant("d"), user("e")]), 3);
    await remember(chat([user("a"), assistant("b"), user("EDITED"), assistant("x"), user("y")]), 4);
    await remember(chat([user("a"), assistant("b"), user("c")]), 5);
    expect(await sessions()).toEqual(new Set([first]));

    // A different conversation (fresh first message) is its own session; so is
    // the same history on another target (its KV lives elsewhere).
    await remember(chat([user("unrelated")]), 6);
    expect((await sessions()).size).toBe(2);
    await remember(chat([user("a"), assistant("b"), user("c")]), 7, 1);
    expect((await sessions()).size).toBe(3);

    // An explicit conversation keeps its session when the parameters change;
    // a tenant's records never join another tenant's.
    const explicit = (temperature: number, text: string) => ({
      conversation: "conv-1",
      input: [
        { role: "user", content: "one" },
        { role: "assistant", content: text },
      ],
      temperature,
    });
    const responses = { surface: "OPENAI_RESPONSES" };
    const explicitFirst = await remember(explicit(0.1, "one"), 8, 0, responses);
    const afterFirst = await sessions();
    await remember(explicit(0.9, "one and two"), 9, 0, responses);
    expect((await sessions()).size).toBe(afterFirst.size);
    const conversationRecords = await db.cacheAffinityRecord.findMany({
      where: {
        tenantUserId: row.tenant.id,
        poolId: row.pool.id,
        sessionId: explicitFirst!.sessionId,
      },
      select: { sessionId: true },
    });
    expect(new Set(conversationRecords.map((record) => record.sessionId)).size).toBe(1);
    await service.rememberAffinity({
      ...base,
      ownerId: row.otherTenant.id,
      payload: chat([user("a"), assistant("b"), user("c")]),
      target: row.target(0),
      now: at(10),
    });
    const otherTenantSessions = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.otherTenant.id, poolId: row.pool.id },
      select: { sessionId: true },
    });
    expect(otherTenantSessions.every(({ sessionId }) => sessionId !== null)).toBe(true);
    expect(
      otherTenantSessions.some(({ sessionId }) =>
        (afterFirst as Set<string | null>).has(sessionId),
      ),
    ).toBe(false);
  });

  it("persists exactly one session footprint and one conversation hint under concurrent refreshes", async () => {
    if (!db) return;
    const row = await fixture();
    const args = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      securityScope: "grant:token",
      policy,
      surface: "OPENAI_RESPONSES",
      payload: { conversation: "conversation-only" },
      target: row.target(0),
    };
    await Promise.all(Array.from({ length: 8 }, () => service.rememberAffinity(args)));
    const records = await db.cacheAffinityRecord.findMany({
      where: { tenantUserId: row.tenant.id, poolId: row.pool.id },
      select: {
        prefixDigest: true,
        conversationDigest: true,
        prefixDepth: true,
        digestVersion: true,
      },
    });
    // Root-only client requests have no prefix rows: one independent footprint
    // plus one conversation hint. maxRecords is a ceiling, not a target size.
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({ prefixDigest: null, prefixDepth: 0, digestVersion: 5 });
      expect(record.conversationDigest).toHaveLength(43);
    }
    expect(new Set(records.map((record) => record.conversationDigest)).size).toBe(2);
  });

  it("serializes concurrent remembers and enforces a bound independently per target and tenant", async () => {
    if (!db) return;
    const row = await fixture();
    const remember = (tenantUserId: string, targetIndex: number, value: string) =>
      service.rememberAffinity({
        ownerId: tenantUserId,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: value },
        target: row.target(targetIndex),
      });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        remember(row.tenant.id, index % 2, `tenant request ${index}`),
      ),
    );
    await Promise.all([
      remember(row.otherTenant.id, 0, "isolated one"),
      remember(row.otherTenant.id, 0, "isolated two"),
    ]);
    const grouped = await db.cacheAffinityRecord.groupBy({
      by: ["tenantUserId", "executionTargetId"],
      where: { poolId: row.pool.id },
      _count: { _all: true },
    });
    expect(grouped.find((entry) => entry.tenantUserId === row.tenant.id)?._count._all).toBe(3);
    expect(grouped.filter((entry) => entry.tenantUserId === row.tenant.id)).toHaveLength(2);
    expect(grouped.find((entry) => entry.tenantUserId === row.otherTenant.id)?._count._all).toBe(3);
  });

  it("makes cleanup idempotent and safe against a concurrent refresh", async () => {
    if (!db) return;
    const row = await fixture();
    const args = {
      ownerId: row.tenant.id,
      resourceOwnerId: row.owner.id,
      poolId: row.pool.id,
      policy: { ...policy, ttlSeconds: 1 },
      surface: "OPENAI_RESPONSES",
      payload: { input: "same request" },
      target: row.target(0),
    };
    await service.rememberAffinity(args);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await Promise.all([
      service.sweepExpiredAffinity({ now: new Date(), limit: 1 }),
      service.rememberAffinity({ ...args, policy, now: new Date() }),
    ]);
    expect(
      await db.cacheAffinityRecord.count({
        where: { tenantUserId: row.tenant.id, poolId: row.pool.id, expiresAt: { gt: new Date() } },
      }),
    ).toBe(2);
    let swept = 1;
    for (let attempt = 0; attempt < 100 && swept > 0; attempt += 1) {
      swept = await service.sweepExpiredAffinity({ now: new Date(), limit: 10 });
    }
    expect(swept).toBe(0);
    expect(await service.sweepExpiredAffinity({ now: new Date(), limit: 1 })).toBe(0);
  });

  it("holds concurrent remember behind the pool's cache-affinity fence", async () => {
    if (!db || !databaseUrl) return;
    const row = await fixture();
    const blocker = createFixturePrismaClient(databaseUrl);
    let releaseLock!: () => void;
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lock = blocker.$transaction(async (tx) => {
      // The fence the writer (and the dashboard clear) takes; under DL-1 (d)
      // affinity writes lock no graph row.
      await acquireFences(tx, [fences.cacheAffinity(row.owner.id, row.pool.id)]);
      signalLockAcquired();
      await release;
    });
    await lockAcquired;
    let settled = false;
    const remembering = service
      .rememberAffinity({
        ownerId: row.tenant.id,
        resourceOwnerId: row.owner.id,
        poolId: row.pool.id,
        policy,
        surface: "OPENAI_RESPONSES",
        payload: { input: "blocked" },
        target: row.target(0),
      })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    releaseLock();
    await Promise.all([lock, remembering]);
    expect(settled).toBe(true);
    await blocker.$disconnect();
  });

  // An empty table can legitimately use a different index or sequential scan.
  // Measure actual work on growing, populated target ranges without planner flags.
  it("bounds residency SQL with maintained buckets and preserves exact completed semantics", async () => {
    if (!db) return;
    const row = await fixture();
    const other = await fixture();
    const now = new Date();
    const limit = service.AFFINITY_RESIDENCY_QUERY_LIMIT;
    const sql = service.affinityResidencySql(
      row.owner.id,
      [row.target(0).capacityId, other.target(0).capacityId],
      now,
    );
    expect(sql.strings.join("")).toContain("JOIN LATERAL");
    type Plan = {
      "Node Type": string;
      "Relation Name"?: string;
      "Index Name"?: string;
      "Index Cond"?: string;
      "Actual Rows": number;
      "Actual Loops": number;
      "Rows Removed by Filter"?: number;
      "Rows Removed by Index Recheck"?: number;
      "Heap Fetches"?: number;
      "Shared Hit Blocks"?: number;
      "Shared Read Blocks"?: number;
      Plans?: Plan[];
    };
    const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const explain = async () => {
      const [result] = await db.$queryRaw<{ "QUERY PLAN": { Plan: Plan }[] }[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      );
      return result!["QUERY PLAN"][0]!.Plan;
    };
    // Preserve the empty plan for comparison, without imposing an index name.
    process.stdout.write(`${JSON.stringify({ residencyEmptyPlan: await explain() })}\n`);
    expect(await db.$queryRaw(sql)).toEqual([]);
    const buffers: number[] = [];
    const assertWork = (plan: Plan, count: number, state: string) => {
      const nodes = flatten(plan);
      expect(nodes.filter((node) => node["Relation Name"] === "cache_affinity_record")).toEqual([]);
      // The old 8000 row / 32000 buffer assertion now measures the actual
      // projection reader, including JSON expansion, not a removed history scan.
      const scans = nodes.filter(
        (node) => node["Relation Name"] || node["Node Type"] === "Function Scan",
      );
      const visits = (scan: Plan) =>
        (scan["Actual Rows"] +
          (scan["Rows Removed by Filter"] ?? 0) +
          (scan["Rows Removed by Index Recheck"] ?? 0)) *
        scan["Actual Loops"];
      const visited = scans.reduce((sum, scan) => sum + visits(scan), 0);
      const blocks = (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
      process.stdout.write(
        `${JSON.stringify({ residencyWork: { count, state, limit, visited, blocks, plan } })}\n`,
      );
      expect(nodes.some((node) => node["Node Type"] === "WindowAgg")).toBe(false);
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        // Small tables can use a cheaper scan. At scale, reject broad scans and
        // filters even if an output LIMIT or a named index happens to be present.
        if (count >= limit) {
          expect(visits(scan)).toBeLessThanOrEqual(limit * 2);
          expect(scan["Heap Fetches"] ?? 0).toBeLessThanOrEqual(limit * 2);
        }
      }
      expect(visited).toBeLessThanOrEqual(limit * 4);
      expect(blocks).toBeLessThan(limit * 16);
      return blocks;
    };
    let previous = 0;
    try {
      for (const count of [1, 32, limit + 64, limit * 4]) {
        for (const owner of [row, other]) {
          for (const targetIndex of [0, 1]) {
            const target = owner.target(targetIndex);
            // Mix live footprints, twice as many live prefix hints, and expired
            // footprints. Scrambled heap order prevents insertion order from
            // accidentally making an unbounded scan cheap. All rows are digest-only.
            await db.$executeRaw`INSERT INTO cache_affinity_record
              (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
               "executionTargetId", "targetIdentity", "bindingDigest", "prefixDigest",
               "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens",
               "sharedWithSessionId", "sharedPrefixTokens")
              SELECT ${owner.pool.id} || '-' || ${targetIndex}::text || '-' || kind || '-' || lpad(i::text, 8, '0'),
                     ${new Date(now.getTime() - 3_600_000)}, ${now},
                     CASE WHEN kind = 'expired' THEN ${now}::timestamp - (i % 2) * interval '1 minute'
                          ELSE ${now}::timestamp + (i / 2) * interval '1 second' + interval '1 hour' END,
                     ${owner.owner.id}, ${owner.tenant.id}, ${owner.pool.id},
                     ${target.executionTargetId}, ${target.targetIdentity}, md5(kind || i::text),
                     CASE WHEN kind LIKE 'prefix%' THEN md5(kind || i::text) ELSE NULL END,
                     CASE WHEN kind LIKE 'prefix%' THEN NULL ELSE md5(kind || i::text) END,
                     ${owner.pool.id} || '-' || ${targetIndex}::text || '-' || kind || '-' || lpad(i::text, 8, '0'),
                     CASE WHEN kind LIKE 'prefix%' THEN 1 ELSE 0 END, i,
                     CASE WHEN kind = 'live' AND i % 2 = 0 THEN 'shared-session' ELSE NULL END,
                     CASE WHEN kind = 'live' AND i % 2 = 0 THEN 100 ELSE NULL END
                FROM generate_series(${previous + 1}::int, ${count}::int) i
                CROSS JOIN (VALUES ('live'), ('expired'), ('prefix-a'), ('prefix-b')) kinds(kind)
               ORDER BY md5(kind || i::text)`;
          }
        }
        previous = count;
        if (count === 1) {
          // Newly created buckets deliberately start unknown; bounded repair
          // includes pre-upgrade canonical history before claiming completeness.
          expect(await db.$queryRaw(sql)).toEqual([]);
          for (let page = 0; page < 4; page++) {
            await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity'::timestamp
              WHERE "userId" IN (${row.owner.id}, ${other.owner.id}) AND NOT complete`;
            expect(await repairAffinityResidencyPage(db)).toBe(true);
          }
        }
        const buckets = await db.$queryRaw<
          Array<{ size: number; bytes: number; complete: boolean }>
        >`
          SELECT jsonb_array_length(entries) AS size, octet_length(entries::text) AS bytes, complete
          FROM cache_affinity_residency WHERE "userId" IN (${row.owner.id}, ${other.owner.id})`;
        expect(buckets).toHaveLength(4);
        expect(
          buckets.every(
            (bucket) => bucket.complete && bucket.size <= limit && bucket.bytes <= 4194304,
          ),
        ).toBe(true);
        if (count >= limit) assertWork(await explain(), count, "before maintenance");
        // Repeated fixture cleanup leaves dead btree entries and unset visibility
        // bits. Measure the maintained index, as the identity work probe does;
        // no planner paths are disabled. This is not a bound on arbitrary bloat.
        await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_record");
        await db.$executeRawUnsafe("ANALYZE execution_target");
        const results =
          await db.$queryRaw<
            {
              capacityId: string;
              sessionId: string;
              tokens: number;
              sharedWithSessionId: string | null;
              sharedPrefixTokens: number | null;
            }[]
          >(sql);
        const expected = Math.min(count, limit);
        expect(results).toHaveLength(expected * 2);
        for (const targetIndex of [0, 1]) {
          const footprint = results.filter((result) =>
            result.sessionId.startsWith(`${row.pool.id}-${targetIndex}-live-`),
          );
          expect(footprint).toHaveLength(expected);
          // Expiry ties use descending id, and no prefix, expired or other-owner
          // row may displace a live footprint. Preserve shared-prefix metadata.
          expect(footprint.map((result) => result.tokens)).toEqual(
            Array.from({ length: expected }, (_, index) => count - index),
          );
          for (const result of footprint) {
            expect(result.capacityId).toBe(row.target(targetIndex).capacityId);
            expect(result.sharedWithSessionId).toBe(
              result.tokens % 2 === 0 ? "shared-session" : null,
            );
            expect(result.sharedPrefixTokens).toBe(result.tokens % 2 === 0 ? 100 : null);
          }
        }
        const blocks = assertWork(await explain(), count, "maintained mixed");
        if (count >= limit) buffers.push(blocks);
      }
      expect(buffers[1]! / Math.max(1, buffers[0]!)).toBeLessThanOrEqual(2);
      // The selected live ranges stay identical as unrelated rows disappear.
      // This also exercises dense, all-owner footprints and dead index entries.
      await db.cacheAffinityRecord.deleteMany({
        where: {
          poolId: { in: [row.pool.id, other.pool.id] },
          OR: [
            { userId: other.owner.id },
            { prefixDigest: { not: null } },
            { expiresAt: { lte: now } },
          ],
        },
      });
      // Deletion never reads retained JSON (residency_delete): touched buckets
      // become unknown until bounded background repair rebuilds survivors.
      expect(await db.$queryRaw(sql)).toEqual([]);
      const incomplete = () =>
        db.cacheAffinityResidency.count({
          where: { userId: { in: [row.owner.id, other.owner.id] }, complete: false },
        });
      for (let page = 0; page < 200 && (await incomplete()) > 0; page++) {
        await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity'::timestamp
          WHERE "userId" IN (${row.owner.id}, ${other.owner.id}) AND NOT complete`;
        await repairAffinityResidencyPage(db);
      }
      expect(await incomplete()).toBe(0);
      assertWork(await explain(), previous, "dense after scoped cleanup");
      await db.$executeRawUnsafe("VACUUM ANALYZE cache_affinity_record");
      assertWork(await explain(), previous, "maintained dense");
      const sample = await db.cacheAffinityRecord.findFirstOrThrow({
        where: { poolId: row.pool.id },
      });
      // Class-H rows have no target FK, but ownership triggers prohibit a
      // foreign footprint from being attached to this owner's pool or target.
      for (const poolId of [row.pool.id, other.pool.id])
        await expect(
          db.cacheAffinityRecord.create({
            data: {
              ...sample,
              id: `foreign-${row.pool.id}`,
              userId: other.owner.id,
              poolId,
              bindingDigest: "foreign-binding",
              expiresAt: new Date(now.getTime() + 86_400_000),
              estimatedTokens: 999_999,
            },
          }),
        ).rejects.toThrow(
          /cache affinity (pool must belong to its owner|target requires its owner or active pool contribution)/,
        );
      for (const selectedLimit of [0, 1, 31]) {
        const selected = await db.$queryRaw<{ sessionId: string; tokens: number }[]>(
          service.affinityResidencySql(
            row.owner.id,
            [row.target(0).capacityId, other.target(0).capacityId],
            now,
            selectedLimit,
          ),
        );
        expect(selected).toHaveLength(selectedLimit * 2);
        for (const targetIndex of [0, 1])
          expect(
            selected
              .filter((result) => result.sessionId.startsWith(`${row.pool.id}-${targetIndex}-`))
              .map((result) => result.tokens),
          ).toEqual(Array.from({ length: selectedLimit }, (_, index) => previous - index));
      }
      expect(
        await db.$queryRaw(
          service.affinityResidencySql(row.owner.id, [other.target(0).capacityId], now),
        ),
      ).toEqual([]);
    } finally {
      await db.cacheAffinityRecord.deleteMany({
        where: { poolId: { in: [row.pool.id, other.pool.id] } },
      });
    }
  }, 120_000);

  it("owns residency statement cancellation and leaves its pooled connection reusable", async () => {
    await expect(queryAffinityResidency(Prisma.sql`SELECT pg_sleep(2)::text`)).rejects.toThrow(
      /statement timeout/,
    );
    expect(await queryAffinityResidency(Prisma.sql`SELECT 1 AS ok`)).toEqual([{ ok: 1 }]);
    const sleepers = [0, 1].map(() =>
      queryAffinityResidency(Prisma.sql`SELECT pg_sleep(0.22)::text`),
    );
    // Start both lazy Prisma operations before attempting a third checkout.
    const occupied = Promise.all(sleepers);
    for (let probe = 0; probe < 20; probe++) {
      const [row] = await db!.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = 'wsmp-affinity-residency' AND state = 'active' AND query LIKE '%pg_sleep%'`;
      if (row?.count === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(queryAffinityResidency(Prisma.sql`SELECT 1`)).rejects.toThrow();
    await occupied;
    expect(await queryAffinityResidency(Prisma.sql`SELECT 1 AS ok`)).toEqual([{ ok: 1 }]);
  });

  it("repairs promotion in durable pages, fences changed generations, and clears without resurrection", async () => {
    if (!db) return;
    const row = await fixture();
    const target = row.target(0);
    const now = new Date();
    const sql = service.affinityResidencySql(row.owner.id, [target.capacityId], now);
    await db.cacheAffinityResidency.create({
      data: {
        executionTargetId: row.target(1).executionTargetId,
        userId: row.owner.id,
        complete: true,
      },
    });
    const bucket = () =>
      db.cacheAffinityResidency.findUniqueOrThrow({
        where: { executionTargetId: target.executionTargetId },
      });
    const nextPage = async () => {
      await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity'::timestamp
        WHERE "executionTargetId" = ${target.executionTargetId}`;
      await repairAffinityResidencyPage();
    };
    const finish = async () => {
      for (let page = 0; page < 20 && !(await bucket()).complete; page++) await nextPage();
      expect((await bucket()).complete).toBe(true);
    };
    try {
      await db.$executeRaw`INSERT INTO cache_affinity_record
        (id, "expiresAt", "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
         "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens")
        SELECT ${row.pool.id} || '-' || lpad(i::text, 8, '0'), ${now}::timestamp + interval '1 hour' + i * interval '1 second',
          ${row.owner.id}, ${row.tenant.id}, ${row.pool.id}, ${target.executionTargetId}, ${target.targetIdentity},
          md5(i::text), md5(i::text), 'session-' || i::text, 0, i
        FROM generate_series(1, 2100) i`;
      expect(await db.$queryRaw(sql)).toEqual([]);
      await nextPage();
      const first = await bucket();
      expect(first.complete).toBe(false);
      expect(first.repairCursor).not.toBeNull();
      expect(first.repairEntries).toHaveLength(256);
      // A separate call resumes durable state (no in-memory repair accumulator).
      await nextPage();
      expect((await bucket()).repairEntries).toHaveLength(512);
      await db.cacheAffinityRecord.update({
        where: { id: `${row.pool.id}-00000001` },
        data: { estimatedTokens: 9999 },
      });
      const changed = await bucket();
      expect(changed.revision).toBeGreaterThan(first.revision);
      expect(changed.repairCursor).toBeNull();
      expect(changed.repairEntries).toEqual([]);
      await finish();
      expect(await db.$queryRaw(sql)).toHaveLength(2000);
      await db.cacheAffinityRecord.delete({ where: { id: `${row.pool.id}-00002100` } });
      expect((await bucket()).complete).toBe(false);
      expect(await db.$queryRaw(sql)).toEqual([]);
      await finish();
      const promoted = await db.$queryRaw<Array<{ tokens: number }>>(sql);
      expect(promoted.map(({ tokens }) => tokens)).toEqual(
        Array.from({ length: 2000 }, (_, index) => 2099 - index),
      );
      await db.cacheAffinityRecord.update({
        where: { id: `${row.pool.id}-00002099` },
        data: { expiresAt: new Date(now.getTime() + 1000) },
      });
      expect((await bucket()).complete).toBe(false);
      await finish();
      const reordered = await db.$queryRaw<Array<{ tokens: number }>>(sql);
      expect(reordered[0]?.tokens).toBe(2098);
      expect(reordered.at(-1)?.tokens).toBe(99);
      await expect(db.$executeRaw`UPDATE cache_affinity_residency SET entries = (
        SELECT jsonb_agg(jsonb_build_object('x', i)) FROM generate_series(1, 2001) i)
        WHERE "executionTargetId" = ${target.executionTargetId}`).rejects.toThrow(
        /cache_affinity_residency_bound/,
      );
      await expect(db.$executeRaw`UPDATE cache_affinity_residency SET entries = jsonb_build_array(repeat('x', 4194305))
        WHERE "executionTargetId" = ${target.executionTargetId}`).rejects.toThrow(
        /cache_affinity_residency_bound/,
      );

      // Logical clear commits independently of bucket contention. Physical
      // reclamation is explicit and resumes in separately bounded batches.
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "executionTargetId" FROM cache_affinity_residency
          WHERE "executionTargetId" = ${target.executionTargetId} FOR UPDATE`;
        signalLocked();
        await released;
      });
      await locked;
      const releaseTimer = setTimeout(release, 60);
      try {
        expect(
          await clearCacheAffinityRecords(db, { ownerUserId: row.owner.id, poolId: row.pool.id }),
        ).toEqual({ cleared: true, reclamation: "pending" });
        expect(await db.$queryRaw(sql)).toEqual([]);
      } finally {
        release();
        clearTimeout(releaseTimer);
        await holder;
      }
      let reclaimed = 0;
      for (let batch = 0; batch < 20; batch++) {
        const removed = await reclaimClearedAffinity(db, {
          ownerUserId: row.owner.id,
          poolId: row.pool.id,
        });
        reclaimed += removed;
        if (!removed) break;
      }
      expect(reclaimed).toBe(2099);
      expect((await bucket()).entries).toEqual([]);
      expect((await bucket()).repairEntries).toEqual([]);
      await finish();
      expect(await db.$queryRaw(sql)).toEqual([]);
      await db.executionTarget.delete({ where: { id: target.executionTargetId } });
      await pruneAffinityResidency();
      expect(
        await db.cacheAffinityResidency.findUnique({
          where: { executionTargetId: target.executionTargetId },
        }),
      ).toBeNull();
    } finally {
      await db.cacheAffinityRecord.deleteMany({ where: { poolId: row.pool.id } });
    }
  }, 30_000);

  it("suppresses missing-bucket and oversized fanout instead of treating unknown as cold", async () => {
    if (!db) return;
    const row = await fixture();
    const target = row.target(0);
    const sql = service.affinityResidencySql(row.owner.id, [target.capacityId], new Date());
    // Current entries always carry their consumer pool and cache generation
    // (cache_affinity_residency_bound); see the legacy upgrade test below.
    const entry = {
      id: "fixture",
      expiresAt: "2099-01-01T00:00:00",
      sessionId: "fixture",
      tokens: 10,
      sharedWithSessionId: null,
      sharedPrefixTokens: null,
      cacheGeneration: "",
      poolId: row.pool.id,
    };
    await db.cacheAffinityResidency.create({
      data: {
        executionTargetId: target.executionTargetId,
        userId: row.owner.id,
        entries: [entry],
        complete: true,
      },
    });
    expect(await db.$queryRaw(sql)).toEqual([]); // The second target is undiscovered.
    await db.cacheAffinityResidency.create({
      data: {
        executionTargetId: row.target(1).executionTargetId,
        userId: row.owner.id,
        complete: true,
      },
    });
    expect(await db.$queryRaw(sql)).toHaveLength(1);
    for (let index = 0; index < 7; index++) {
      const id = `residency-fanout-${crypto.randomUUID()}`;
      const model = await db.discoveredModel.create({
        data: {
          userId: row.owner.id,
          endpointId: row.endpoint.id,
          upstreamModelId: id,
          encodedModelId: id,
        },
      });
      const next = await db.executionTarget.update({
        where: { discoveredModelId: model.id },
        data: { inferenceCapacityId: target.capacityId },
      });
      await db.cacheAffinityResidency.create({
        data: { executionTargetId: next.id, userId: row.owner.id, complete: true },
      });
    }
    expect(await db.$queryRaw(sql)).toEqual([]);
    await db.cacheAffinityResidency.deleteMany({ where: { userId: row.owner.id } });
  });

  it("refuses unscoped entries and the installer turns legacy buckets unknown until repair", async () => {
    if (!db) return;
    const row = await fixture();
    const target = row.target(0);
    const sql = service.affinityResidencySql(row.owner.id, [target.capacityId], new Date());
    const bucket = () =>
      db.cacheAffinityResidency.findUniqueOrThrow({
        where: { executionTargetId: target.executionTargetId },
      });
    const repair = async () => {
      for (let page = 0; page < 4 && !(await bucket()).complete; page++) {
        await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity'::timestamp
          WHERE "executionTargetId" = ${target.executionTargetId}`;
        await repairAffinityResidencyPage(db);
      }
      expect((await bucket()).complete).toBe(true);
    };
    const legacyEntries = Prisma.sql`(SELECT jsonb_agg(e - 'poolId') FROM jsonb_array_elements(entries) e)`;
    await db.cacheAffinityResidency.create({
      data: {
        executionTargetId: row.target(1).executionTargetId,
        userId: row.owner.id,
        complete: true,
      },
    });
    try {
      await db.$executeRaw`INSERT INTO cache_affinity_record
        (id, "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest",
         "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens", "expiresAt")
        VALUES (${`legacy-${row.pool.id}`}, ${row.owner.id}, ${row.owner.id}, ${row.pool.id},
          ${target.executionTargetId}, 'legacy', repeat('a', 32), repeat('b', 32), 'legacy', 0, 10, '2099-01-01')`;
      await repair(); // New buckets start unknown.
      expect(await db.$queryRaw(sql)).toHaveLength(1);
      // The reader trusts every published entry to carry its pool scope.
      await expect(
        db.$executeRaw`UPDATE cache_affinity_residency SET entries = ${legacyEntries}
          WHERE "executionTargetId" = ${target.executionTargetId}`,
      ).rejects.toThrow(/cache_affinity_residency_bound/);
      // Simulate a bucket written before entries carried poolId, then upgrade.
      await db.$transaction([
        db.$executeRaw`ALTER TABLE cache_affinity_residency DROP CONSTRAINT cache_affinity_residency_bound`,
        db.$executeRaw`UPDATE cache_affinity_residency SET entries = ${legacyEntries}
          WHERE "executionTargetId" = ${target.executionTargetId}`,
      ]);
      const legacy = await bucket();
      expect(legacy.complete).toBe(true);
      expect(legacy.entries).toEqual([expect.not.objectContaining({ poolId: expect.anything() })]);
    } finally {
      const root = fileURLToPath(new URL("../../../../", import.meta.url));
      await runFile(process.execPath, ["packages/db/scripts/apply-schema-hardening.mjs"], {
        cwd: root,
        env: { ...process.env, SCHEMA_HARDENING_FORCE: "1" },
        timeout: 30000,
      });
    }
    try {
      const upgraded = await bucket();
      expect(upgraded).toMatchObject({ complete: false, entries: [], repairCursor: null });
      expect(await db.$queryRaw(sql)).toEqual([]); // Unknown, never cold or unscoped.
      await repair();
      const repaired = await bucket();
      expect(repaired.entries).toEqual([expect.objectContaining({ poolId: row.pool.id })]);
      expect(await db.$queryRaw(sql)).toHaveLength(1);
    } finally {
      await db.cacheAffinityRecord.deleteMany({ where: { poolId: row.pool.id } });
      await db.cacheAffinityResidency.deleteMany({ where: { userId: row.owner.id } });
    }
  }, 60_000);

  it("persists a failed page delay so a poisoned first bucket cannot starve another target", async () => {
    if (!db) return;
    const row = await fixture();
    await db.cacheAffinityResidency.createMany({
      data: [
        {
          executionTargetId: row.target(0).executionTargetId,
          userId: row.owner.id,
          repairAfter: new Date("1900-01-01"),
          repairEntries: [{ id: "poison", expiresAt: "invalid" }],
        },
        {
          executionTargetId: row.target(1).executionTargetId,
          userId: row.owner.id,
          repairAfter: new Date("1901-01-01"),
        },
      ],
    });
    await expect(repairAffinityResidencyPage()).rejects.toThrow();
    expect(
      (
        await db.cacheAffinityResidency.findUniqueOrThrow({
          where: { executionTargetId: row.target(0).executionTargetId },
        })
      ).repairAfter.getTime(),
    ).toBeGreaterThan(Date.now());
    expect(await repairAffinityResidencyPage()).toBe(true);
    expect(
      (
        await db.cacheAffinityResidency.findUniqueOrThrow({
          where: { executionTargetId: row.target(1).executionTargetId },
        })
      ).complete,
    ).toBe(true);
    await db.cacheAffinityResidency.deleteMany({ where: { userId: row.owner.id } });
  });

  it("discovers dormant targets durably and owns runtime shutdown with a query pending", async () => {
    if (!db) return;
    const row = await fixture();
    await db.$executeRaw`INSERT INTO cache_affinity_record
      (id, "expiresAt", "userId", "tenantUserId", "poolId", "executionTargetId", "targetIdentity",
       "bindingDigest", "conversationDigest", "sessionId", "prefixDepth", "estimatedTokens")
      VALUES (${crypto.randomUUID()}, clock_timestamp() + interval '1 hour', ${row.owner.id}, ${row.tenant.id},
        ${row.pool.id}, ${row.target(0).executionTargetId}, ${row.target(0).targetIdentity},
        repeat('x', 32), repeat('y', 32), 'dormant-session', 0, 7)`;
    // Emulate pre-projection durable history, without another completion write.
    await db.cacheAffinityResidency.deleteMany({ where: { userId: row.owner.id } });
    // Position only this synthetic discovery window; existing targets remain
    // eligible on the next wrap. The production discovery function owns writes.
    const previousTarget = await db.executionTarget.findFirst({
      where: { id: { lt: row.target(0).executionTargetId } },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    await db.cacheAffinityResidencyCursor.upsert({
      where: { id: 1 },
      create: { id: 1, cursor: previousTarget?.id ?? "", resumeAt: new Date(0) },
      update: { cursor: previousTarget?.id ?? "", resumeAt: new Date(0) },
    });
    for (let page = 0; page < 100; page++) {
      await discoverAffinityResidency();
      if (
        await db.cacheAffinityResidency.findUnique({
          where: { executionTargetId: row.target(0).executionTargetId },
        })
      )
        break;
    }
    expect(
      await db.cacheAffinityResidency.findUnique({
        where: { executionTargetId: row.target(0).executionTargetId },
      }),
    ).not.toBeNull();
    await db.$executeRaw`UPDATE cache_affinity_residency SET "repairAfter" = '-infinity'::timestamp
      WHERE "executionTargetId" = ${row.target(0).executionTargetId}`;
    const stop = startAffinityResidencyRepair();
    let warmed = false;
    for (let probe = 0; probe < 100; probe++) {
      const bucket = await db.cacheAffinityResidency.findUnique({
        where: { executionTargetId: row.target(0).executionTargetId },
      });
      if (bucket?.complete) {
        expect(bucket.entries).toEqual([
          expect.objectContaining({ sessionId: "dormant-session", tokens: 7 }),
        ]);
        warmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(warmed).toBe(true);
    const pending = queryAffinityResidency(Prisma.sql`SELECT pg_sleep(2)`).catch(() => "cancelled");
    let active = false;
    for (let probe = 0; probe < 20; probe++) {
      const [row] = await db.$queryRaw<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = 'wsmp-affinity-residency' AND state = 'active' AND query LIKE '%pg_sleep%'`;
      if (row?.count) {
        active = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(active).toBe(true);
    await stop();
    expect(await pending).toBe("cancelled");
    expect(() => queryAffinityResidency(Prisma.sql`SELECT 1`)).toThrow(/closed/);
    await db.cacheAffinityRecord.deleteMany({ where: { poolId: row.pool.id } });
  });
});
