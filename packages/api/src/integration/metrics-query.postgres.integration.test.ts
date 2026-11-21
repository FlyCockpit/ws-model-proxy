/**
 * `activity.metrics.query` on real PostgreSQL (`pnpm test:postgres`): the rollup SQL (minute and
 * hour request rollups, engine load, node gauges and node metric command values), bucketing,
 * grouping and labels, and who sees what: the owner sees their resources, a share holder sees
 * only their own requests to a shared pool (ungrouped or by source), anyone else gets NOT_FOUND.
 *
 * Rollup rows are written directly. Every row is removed afterwards, each delete scoped to this
 * run's users.
 */
import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { emptyLatencyHistogram, latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { TEST_NODE_FEATURES } from "../lib/node-features-test-fixture";
import type { RuntimeSpec } from "../lib/runtime-spec";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const RUN = `mq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `${RUN}-o`;
const GRANTEE = `${RUN}-g`;
const STRANGER = `${RUN}-s`;

const SPEC: RuntimeSpec = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "m" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 16 }],
    labels: [],
    commands: [{ start: "vllm serve m --host 127.0.0.1 --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

function sessionOf(userId: string): Session {
  return {
    user: {
      id: userId,
      email: `${userId}@example.test`,
      name: userId,
      role: "user",
      emailVerified: true,
      twoFactorEnabled: false,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 600_000) },
  } as Session;
}

const agent = (userId: string): CallerAuth => ({
  kind: "agent_token",
  userId,
  agentTokenId: `${userId}-tok`,
  access: { scopes: ["read"], nodeIds: null },
});
const person = (userId: string): CallerAuth => ({
  kind: "cookie_session",
  userId,
  sessionId: `s-${userId}`,
  csrfVerified: true,
});

// Two days ago on the hour: inside every family's retention, outside the Overview's 24h.
const T0 = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 48 * 3_600_000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const WINDOW = { from: T0.toISOString(), to: at(10).toISOString() };

function histogramWith(...values: number[]): number[] {
  const histogram = emptyLatencyHistogram();
  for (const value of values) histogram[latencyBucketIndex(value)]! += 1;
  return histogram;
}

integration("metrics_query on PostgreSQL", () => {
  let fixtures: ReturnType<typeof createFixturePrismaClient>;
  let appRouter: typeof import("../routers/index")["appRouter"];
  const ids = { node: "", runtime: "", runtimeModel: "", version: "", instance: "", pool: "" };

  const client = (auth: CallerAuth) => {
    const context: Context = { auth, session: sessionOf(auth.userId) };
    return createRouterClient(appRouter, { context });
  };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    appRouter = (await import("../routers/index")).appRouter;
    fixtures = createFixturePrismaClient(databaseUrl);
    const db = fixtures;
    for (const id of [OWNER, GRANTEE, STRANGER])
      await db.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true, slug: id },
      });
    const node = await db.node.create({
      data: {
        userId: OWNER,
        slug: `${RUN}-box`,
        connection: "ONLINE",
        trust: "FULL",
        features: TEST_NODE_FEATURES,
        declaredResources: { kind: "unified", memoryGb: 66 },
        portStart: 30000,
        portEnd: 30010,
      },
      select: { id: true },
    });
    ids.node = node.id;
    const owner = client(person(OWNER));
    const created = await owner.runtimes.create({
      slug: "model",
      name: "Model",
      kind: "STARTABLE",
      spec: SPEC,
    });
    ids.runtime = created.runtime.id;
    const runtime = await db.runtime.findUniqueOrThrow({
      where: { id: ids.runtime },
      select: { currentVersionId: true, Models: { select: { id: true } } },
    });
    ids.version = runtime.currentVersionId ?? "";
    ids.runtimeModel = runtime.Models[0]?.id ?? "";
    const preview = await owner.runtimes.start({
      runtimeId: ids.runtime,
      nodeIds: [ids.node],
      preview: true,
    });
    if (preview.mode !== "preview") throw new Error("expected a preview");
    const applied = await owner.runtimes.start({
      runtimeId: ids.runtime,
      nodeIds: [ids.node],
      fingerprint: preview.preview.fingerprint,
    });
    if (applied.mode !== "applied") throw new Error("expected an applied start");
    ids.instance = applied.operation.instances[0]?.id ?? "";
    const pool = await db.pool.create({
      data: { userId: OWNER, slug: "chat", name: "Chat", modelType: "LLM" },
      select: { id: true },
    });
    ids.pool = pool.id;
    await db.poolMember.create({
      data: { poolId: ids.pool, kind: "LOCAL", runtimeModelId: ids.runtimeModel },
    });
    await db.share.create({
      data: { poolId: ids.pool, ownerUserId: OWNER, granteeUserId: GRANTEE, canUse: true },
    });

    const key = {
      ownerUserId: OWNER,
      poolId: ids.pool,
      // Older rows: the runtime only through the version.
      runtimeId: "",
      versionId: ids.version,
      nodeId: ids.node,
      instanceId: ids.instance,
      runtimeModelId: ids.runtimeModel,
      providerModelId: "",
    };
    await db.usageRollupMinute.createMany({
      data: [
        {
          ...key,
          bucketStart: at(1),
          requesterUserId: OWNER,
          source: "API_KEY",
          requests: 3,
          errors: 1,
          outputTokens: 300n,
          generationTokens: 300n,
          generationMs: 3_000n,
          ttftHistogram: histogramWith(100, 200, 400),
          latencyHistogram: histogramWith(1_000, 2_000, 4_000),
        },
        {
          ...key,
          bucketStart: at(1),
          requesterUserId: GRANTEE,
          source: "API_KEY",
          requests: 2,
          ttftHistogram: histogramWith(150, 150),
        },
        {
          ...key,
          bucketStart: at(3),
          requesterUserId: OWNER,
          source: "AGENT_TEST",
          requests: 1,
        },
        {
          // A person's Test page request to the pool: a test too.
          ...key,
          bucketStart: at(3),
          requesterUserId: OWNER,
          source: "TEST",
          requests: 2,
        },
        {
          // An agent test of the runtime itself (`runtime:<id>:<model>`): direct, no pool.
          ...key,
          poolId: "",
          bucketStart: at(2),
          requesterUserId: OWNER,
          source: "AGENT_TEST",
          requests: 1,
        },
        {
          // Cloud traffic of the pool: no placement.
          ownerUserId: OWNER,
          poolId: ids.pool,
          bucketStart: at(3),
          requesterUserId: OWNER,
          source: "API_KEY",
          requests: 4,
          cloudRequests: 4,
        },
        {
          // Another owner's traffic in the same minute: never counted.
          ...key,
          ownerUserId: STRANGER,
          poolId: "elsewhere",
          bucketStart: at(1),
          requesterUserId: STRANGER,
          source: "API_KEY",
          requests: 50,
        },
      ],
    });
    await db.usageRollupHour.create({
      data: {
        ...key,
        bucketStart: new Date("2026-07-01T05:00:00.000Z"),
        requesterUserId: OWNER,
        source: "API_KEY",
        requests: 7,
      },
    });
    await db.runtimeLoadMinute.createMany({
      data: [
        {
          bucketStart: at(1),
          ownerUserId: OWNER,
          instanceId: ids.instance,
          runtimeId: ids.runtime,
          versionId: ids.version,
          nodeId: ids.node,
          samples: 4,
          kvSamples: 4,
          sumKvUsage: 2,
          maxKvUsage: 0.9,
          maxRunning: 6,
          maxWaiting: 2,
          fullSamples: 1,
        },
        {
          bucketStart: at(2),
          ownerUserId: OWNER,
          instanceId: ids.instance,
          runtimeId: ids.runtime,
          versionId: ids.version,
          nodeId: ids.node,
          samples: 4,
          kvSamples: 4,
          sumKvUsage: 3.6,
          maxKvUsage: 0.95,
          maxRunning: 8,
          maxWaiting: 0,
          fullSamples: 3,
        },
      ],
    });
    await db.nodeMetricsMinute.createMany({
      data: [
        {
          bucketStart: at(1),
          ownerUserId: OWNER,
          nodeId: ids.node,
          samples: 2,
          cpuSamples: 2,
          sumCpuPercent: 60,
          memorySamples: 2,
          sumMemoryAvailableMiB: 4_096,
          minAcceleratorFreeMiB: 2_048,
          maxGpuUtilizationPercent: 70,
          custom: { gpu_power: { min: 100, sum: 300, max: 200, samples: 2 } },
        },
        {
          bucketStart: at(1),
          ownerUserId: STRANGER,
          nodeId: ids.node,
          samples: 1,
          cpuSamples: 1,
          sumCpuPercent: 99,
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (!fixtures) return;
    const db = fixtures;
    try {
      const users = { in: [OWNER, GRANTEE, STRANGER] };
      await db.relayRequest.deleteMany({ where: { userId: users } });
      await db.usageRollupMinute.deleteMany({ where: { ownerUserId: users } });
      await db.usageRollupHour.deleteMany({ where: { ownerUserId: users } });
      await db.runtimeLoadMinute.deleteMany({ where: { ownerUserId: users } });
      await db.nodeMetricsMinute.deleteMany({ where: { ownerUserId: users } });
      await db.pool.deleteMany({ where: { userId: users } });
      await db.profile.deleteMany({ where: { userId: users } });
      await db.runtimeInstance.deleteMany({ where: { userId: users } });
      await db.runtimeOperation.deleteMany({ where: { userId: users } });
      await db.runtime.updateMany({ where: { userId: users }, data: { currentVersionId: null } });
      await db.runtime.deleteMany({ where: { userId: users } });
      await db.node.deleteMany({ where: { userId: users } });
      await db.nodeAuditEvent.deleteMany({ where: { userId: users } });
      await db.auditEvent.deleteMany({ where: { userId: users } });
      await db.user.deleteMany({ where: { id: users } });
      expect(await db.user.count({ where: { id: users } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("answers a pool's request metrics per minute, compactly", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { pool: ids.pool },
      metrics: ["requests", "errors", "ttft_p95", "cloud_share", "decode_tps"],
      range: WINDOW,
      step: "1m",
    });
    expect(result.start).toBe(T0.toISOString());
    expect(result.series).toHaveLength(1);
    const [series] = result.series;
    expect(series?.group).toBeUndefined();
    // The pool's agent and Test page tests are left out of the series and counted apart; the
    // runtime's own test (no pool) is not the pool's.
    expect(series?.at).toEqual([1, 3]);
    expect(series?.values.requests).toEqual([5, 4]);
    expect(series?.values.errors).toEqual([1, 0]);
    expect(series?.values.cloud_share).toEqual([0, 1]);
    expect(series?.values.ttft_p95?.[1]).toBeNull();
    expect(series?.values.decode_tps).toEqual([100, null]);
    expect(result.totals).toMatchObject({ requests: 9, errors: 1, cloud_share: 0.444, tests: 3 });
    expect(result.totals.ttft_p95).toBeGreaterThan(150);
  });

  it("counts tests like any request when asked", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { pool: ids.pool },
      metrics: ["requests"],
      range: WINDOW,
      step: "5m",
      includeTests: true,
    });
    expect(result.series[0]).toEqual({ at: [0], values: { requests: [12] } });
    expect(result.totals).toEqual({ requests: 12 });
  });

  it("counts a runtime's own tests and its pool's tests on the runtime", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { runtime: ids.runtime },
      metrics: ["requests"],
      range: WINDOW,
      step: "5m",
    });
    expect(result.totals).toEqual({ requests: 5, tests: 4 });
  });

  it("groups by runtime through the version, with labels, and an empty key for cloud", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { pool: ids.pool },
      metrics: ["requests"],
      range: WINDOW,
      step: "1m",
      groupBy: "runtime",
    });
    expect(result.series.map((series) => [series.group, series.values.requests])).toEqual([
      [{ key: ids.runtime, label: "model" }, [5]],
      [{ key: "" }, [4]],
    ]);
  });

  it("reads hourly rows for hour steps", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { runtime: ids.runtime },
      metrics: ["requests"],
      range: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-02T00:00:00.000Z" },
      step: "1h",
      groupBy: "version",
    });
    expect(result.series).toEqual([
      { group: { key: ids.version, label: "model v1" }, at: [5], values: { requests: [7] } },
    ]);
  });

  it("answers engine load and node gauges of the caller's own rows only", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { instance: ids.instance },
      metrics: [
        "kv_usage_avg",
        "kv_usage_max",
        "running_max",
        "full_ratio",
        "cpu_pct",
        "memory_available_gb",
        "accelerator_free_gb",
        "gpu_util_pct",
        "custom:gpu_power",
        "custom:missing",
      ],
      range: WINDOW,
      step: "1m",
    });
    const [series] = result.series;
    expect(series?.at).toEqual([1, 2]);
    expect(series?.values).toMatchObject({
      kv_usage_avg: [0.5, 0.9],
      kv_usage_max: [0.9, 0.95],
      running_max: [6, 8],
      full_ratio: [0.25, 0.75],
      cpu_pct: [30, null],
      memory_available_gb: [2, null],
      accelerator_free_gb: [2, null],
      gpu_util_pct: [70, null],
      "custom:gpu_power": [150, null],
      "custom:missing": [null, null],
    });
    expect(result.totals).toMatchObject({ kv_usage_avg: 0.7, running_max: 8, cpu_pct: 30 });
    expect(result.totals["custom:missing"]).toBeUndefined();

    const byNode = await client(agent(OWNER)).activity.metrics.query({
      scope: { runtime: ids.runtime },
      metrics: ["cpu_pct", "kv_usage_max"],
      range: WINDOW,
      step: "5m",
      groupBy: "node",
    });
    expect(byNode.series).toEqual([
      {
        group: { key: ids.node, label: `${RUN}-box` },
        at: [0],
        values: { cpu_pct: [30], kv_usage_max: [0.95] },
      },
    ]);
  });

  it("gives a share holder their own requests to the shared pool, and nothing else", async () => {
    const grantee = client(agent(GRANTEE)).activity.metrics;
    const own = await grantee.query({
      scope: { pool: ids.pool },
      metrics: ["requests", "ttft_p50"],
      range: WINDOW,
      step: "1m",
      groupBy: "source",
    });
    expect(own.series).toEqual([
      { group: { key: "API_KEY" }, at: [1], values: { requests: [2], ttft_p50: [175] } },
    ]);
    for (const input of [
      { metrics: ["requests"], groupBy: "node" },
      { metrics: ["kv_usage_max"] },
      { metrics: ["cpu_pct"] },
    ] as const) {
      await expect(
        grantee.query({ scope: { pool: ids.pool }, range: WINDOW, step: "1m", ...input }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      grantee.query({
        scope: { runtime: ids.runtime },
        metrics: ["requests"],
        range: WINDOW,
        step: "1m",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sums the Overview over the owner's resources and their own requests, without agent tests", async () => {
    const recent = new Date(Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000);
    const base = {
      bucketStart: recent,
      poolId: ids.pool,
      versionId: ids.version,
      nodeId: ids.node,
      instanceId: ids.instance,
      runtimeModelId: ids.runtimeModel,
    };
    await fixtures.usageRollupMinute.createMany({
      data: [
        {
          ...base,
          ownerUserId: OWNER,
          requesterUserId: GRANTEE,
          source: "API_KEY",
          requests: 6,
          errors: 2,
          cloudRequests: 3,
          latencyHistogram: histogramWith(900),
        },
        // Tests are not load: an agent's and a person's Test page requests are left out.
        { ...base, ownerUserId: OWNER, requesterUserId: OWNER, source: "AGENT_TEST", requests: 40 },
        { ...base, ownerUserId: OWNER, requesterUserId: OWNER, source: "TEST", requests: 30 },
        // The grantee's own request to someone else's pool counts on their Overview only.
        {
          ownerUserId: STRANGER,
          requesterUserId: GRANTEE,
          bucketStart: recent,
          poolId: "theirs",
          source: "API_KEY",
          requests: 1,
        },
      ],
    });
    const summary = await client(person(OWNER)).activity.overview.summary({ range: "24h" });
    expect(summary.kpis).toMatchObject({ requests: 6, errors: 2, cloudShare: 0.5 });
    expect(summary.kpis.p95LatencyMs).toBeGreaterThan(750);
    expect(summary.nodes).toEqual([
      { id: ids.node, slug: `${RUN}-box`, online: true, trust: "FULL" },
    ]);
    const [pool] = summary.pools;
    expect(pool).toMatchObject({
      id: ids.pool,
      callableId: `${OWNER}/chat`,
      requests: 6,
      errors: 2,
    });
    expect(pool?.sparkline).toHaveLength(24);
    expect(pool?.sparkline.reduce((sum, value) => sum + value, 0)).toBe(6);
    expect(summary.onboarding.steps).toMatchObject({ node: true, runtime: true, pool: true });

    const grantee = await client(person(GRANTEE)).activity.overview.summary({ range: "24h" });
    // Their 6 requests to the owner's pool and 1 to another pool.
    expect(grantee.kpis.requests).toBe(7);
    expect(grantee.pools).toEqual([]);
    expect(grantee.nodes).toEqual([]);
  });

  it("gives a pool member its 15-minute p95 and 24-hour requests, through the serving version", async () => {
    const { memberRecentTraffic } = await import("../lib/overview-summary");
    const { memberLatencyKey } = await import("../lib/pool-views");
    const recent = await memberRecentTraffic(OWNER, [ids.pool], at(10));
    const key = memberLatencyKey(ids.pool, { runtimeId: ids.runtime });
    // Only the owner's real traffic with latencies: tests, cloud rows without them and other
    // owners' rows give no member a value.
    expect([...recent.p95.keys()]).toEqual([key]);
    expect(recent.p95.get(key)).toBeGreaterThanOrEqual(2_000);
    // Requests: the owner's real traffic a member served (tests, other owners' rows and the
    // cloud row naming no provider model left out).
    expect(recent.requests).toEqual(new Map([[key, 5]]));
    expect(recent.poolRequests).toEqual(new Map([[ids.pool, 5]]));
    // Past the p95 window the requests still count; past the share window nothing does.
    const later = await memberRecentTraffic(OWNER, [ids.pool], at(30));
    expect(later.p95.size).toBe(0);
    expect(later.poolRequests.get(ids.pool)).toBe(5);
    expect((await memberRecentTraffic(OWNER, [ids.pool], at(25 * 60))).poolRequests.size).toBe(0);
    expect((await memberRecentTraffic(STRANGER, [ids.pool], at(10))).requests.size).toBe(0);
  });

  it("puts pool traffic into fixed sparkline buckets, the oldest at the window start", async () => {
    const { poolTraffic } = await import("../lib/overview-summary");
    const sixHours = 6 * 3_600_000;
    const now = new Date();
    const end = Math.floor(now.getTime() / sixHours) * sixHours + sixHours;
    const from = new Date(end - 7 * 24 * 3_600_000);
    await fixtures.usageRollupMinute.createMany({
      data: [
        { bucketStart: from, requests: 5 },
        { bucketStart: new Date(from.getTime() - 60_000), requests: 100 },
        { bucketStart: new Date(from.getTime() + sixHours + 60_000), requests: 2 },
      ].map((row) => ({
        ...row,
        ownerUserId: OWNER,
        requesterUserId: STRANGER,
        poolId: ids.pool,
        source: "SIDECAR" as const,
      })),
    });
    const traffic = (await poolTraffic(OWNER, [ids.pool], "7d", now)).get(ids.pool);
    expect(traffic?.sparkline).toHaveLength(28);
    expect(traffic?.sparkline.slice(0, 2)).toEqual([5, 2]);
    expect(traffic?.requests).toBeGreaterThanOrEqual(7);
    expect(traffic?.requests).toBeLessThan(100);
  });

  it("lists the run's nodes, runtimes, pools and requests to an admin", async () => {
    const admin = createRouterClient(appRouter, {
      context: {
        auth: person(STRANGER),
        session: { ...sessionOf(STRANGER), user: { ...sessionOf(STRANGER).user, role: "admin" } },
      } as Context,
    }).adminObservability;
    const ownerQuery = OWNER;
    const instance = await fixtures.runtimeInstance.findUniqueOrThrow({
      where: { id: ids.instance },
      select: { phase: true },
    });
    // The started instance has not stopped (no node acts in this test).
    expect(["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"]).toContain(instance.phase);
    const nodes = await admin.nodes({ ownerQuery });
    expect(nodes.items).toEqual([
      expect.objectContaining({
        id: ids.node,
        trust: "FULL",
        connection: "ONLINE",
        runningInstances: 1,
      }),
    ]);
    const runtimes = await admin.runtimes({ ownerQuery });
    expect(runtimes.items[0]).toMatchObject({ id: ids.runtime, modelType: "LLM" });
    const pools = await admin.pools({ ownerQuery });
    expect(pools.items).toEqual([
      expect.objectContaining({ id: ids.pool, callableId: `${OWNER}/chat`, members: 1, shares: 1 }),
    ]);
    await fixtures.relayRequest.create({
      data: {
        userId: OWNER,
        source: "API_KEY",
        poolId: ids.pool,
        external: true,
        status: "FAILED",
        durationMs: 120,
        errorClass: "upstream_5xx",
        completedAt: new Date(),
      },
    });
    const relay = await admin.relay({ ownerQuery });
    expect(relay.total).toBe(1);
    expect(relay.items).toEqual([
      expect.objectContaining({
        owner: expect.objectContaining({ id: OWNER }),
        status: "FAILED",
        callableId: `${OWNER}/chat:external`,
        durationMs: 120,
        errorClass: "upstream_5xx",
      }),
    ]);
    expect((await admin.relay({ ownerQuery: `${RUN}-nobody` })).items).toEqual([]);
    await expect(client(person(OWNER)).adminObservability.nodes({})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("answers NOT_FOUND to anyone else", async () => {
    const stranger = client(agent(STRANGER)).activity.metrics;
    for (const scope of [
      { pool: ids.pool },
      { runtime: ids.runtime },
      { version: ids.version },
      { node: ids.node },
      { instance: ids.instance },
    ]) {
      const error = await stranger
        .query({ scope, metrics: ["requests"], range: WINDOW, step: "1m" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
    }
  });
  it("counts only the owner's own traffic on their node, and hides a contributor's placement", async () => {
    const node = await client(agent(OWNER)).activity.metrics.query({
      scope: { node: ids.node },
      metrics: ["requests"],
      range: WINDOW,
      step: "5m",
    });
    // 3 + 2 of the owner's pool, and its tests and the runtime's own one apart; the other
    // owner's 50 on this node stay theirs.
    expect(node.totals).toEqual({ requests: 5, tests: 4 });

    // A share holder's contributed model serves the owner's pool on the holder's runtime.
    await fixtures.usageRollupMinute.create({
      data: {
        bucketStart: at(7),
        ownerUserId: OWNER,
        requesterUserId: OWNER,
        poolId: ids.pool,
        versionId: "contrib-version",
        nodeId: "contrib-node",
        instanceId: "contrib-instance",
        runtimeModelId: "contrib-model",
        source: "API_KEY",
        requests: 3,
      },
    });
    const window = { from: at(7).toISOString(), to: at(8).toISOString() };
    for (const groupBy of ["node", "instance", "version", "runtime"] as const) {
      const result = await client(agent(OWNER)).activity.metrics.query({
        scope: { pool: ids.pool },
        metrics: ["requests"],
        range: window,
        step: "1m",
        groupBy,
      });
      expect(result.series).toEqual([{ group: { key: "" }, at: [0], values: { requests: [3] } }]);
    }
    const member = await client(agent(OWNER)).activity.metrics.query({
      scope: { pool: ids.pool },
      metrics: ["requests"],
      range: window,
      step: "1m",
      groupBy: "member",
    });
    expect(member.series[0]?.group).toEqual({ key: "contrib-model" });
  });

  it("filters hidden-node aggregates and refuses removing their runtime members on PostgreSQL", async () => {
    // A rank is on the allowed node, but its live reservation reaches the hidden node.
    // This checks the whole-instance relation predicates, beyond a simple node-id filter.
    const hidden = await fixtures.node.create({
      data: {
        userId: OWNER,
        slug: "aggregate-hidden",
        connection: "ONLINE",
        trust: "FULL",
        features: TEST_NODE_FEATURES,
      },
    });
    await fixtures.instanceReservation.create({
      data: {
        instanceId: ids.instance,
        nodeId: hidden.id,
        index: 0,
        labels: [],
        resources: { kind: "unified", memoryGb: 1 },
      },
    });
    const pool = await fixtures.pool.create({
      data: { userId: OWNER, slug: "aggregate-filter", name: "Aggregate filter", modelType: "LLM" },
    });
    const member = await fixtures.poolMember.create({
      data: { poolId: pool.id, kind: "LOCAL", runtimeModelId: ids.runtimeModel },
    });
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const key = {
      bucketStart,
      ownerUserId: OWNER,
      requesterUserId: OWNER,
      poolId: pool.id,
      source: "API_KEY" as const,
    };
    await fixtures.usageRollupMinute.createMany({
      data: [
        {
          ...key,
          runtimeId: ids.runtime,
          versionId: ids.version,
          nodeId: ids.node,
          requests: 4,
          errors: 1,
          latencyHistogram: histogramWith(10, 10, 10, 10),
        },
        {
          ...key,
          runtimeId: ids.runtime,
          versionId: ids.version,
          nodeId: hidden.id,
          requests: 96,
          errors: 20,
          latencyHistogram: histogramWith(...new Array<number>(96).fill(20_000)),
        },
        { ...key, providerModelId: "aggregate-cloud", requests: 6, cloudRequests: 6 },
        {
          // Served on the ALLOWED node by the mixed instance: hidden from the allowlist too.
          ...key,
          runtimeId: ids.runtime,
          versionId: ids.version,
          nodeId: ids.node,
          instanceId: ids.instance,
          requests: 50,
          errors: 5,
          latencyHistogram: histogramWith(...new Array<number>(50).fill(20_000)),
        },
      ],
    });
    const mixedRequest = await fixtures.relayRequest.create({
      data: {
        userId: OWNER,
        resourceOwnerUserId: OWNER,
        source: "API_KEY",
        poolId: pool.id,
        status: "SUCCEEDED",
        selectedNodeId: ids.node,
        selectedInstanceId: ids.instance,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    const plainRequest = await fixtures.relayRequest.create({
      data: {
        userId: OWNER,
        resourceOwnerUserId: OWNER,
        source: "API_KEY",
        poolId: pool.id,
        status: "SUCCEEDED",
        selectedNodeId: ids.node,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    await fixtures.runtimeLoadMinute.create({
      data: {
        bucketStart,
        ownerUserId: OWNER,
        runtimeId: ids.runtime,
        versionId: ids.version,
        instanceId: ids.instance,
        nodeId: ids.node,
        samples: 1,
        maxRunning: 7,
      },
    });
    // A long-stopped instance with a reservation on the hidden node. A lookup bounded by
    // request creation (`requests_list`) leaves it out; rollup reads are unbounded, because a
    // request it served can complete (or be finalized by recovery) long after it stopped.
    const stoppedAt = new Date(Date.now() - 30 * 24 * 3_600_000);
    const stale = await fixtures.runtimeInstance.create({
      data: {
        userId: OWNER,
        runtimeId: ids.runtime,
        versionId: ids.version,
        launchVersionId: ids.version,
        handle: `i-${RUN.replace(/[^a-z0-9]/g, "")
          .padEnd(12, "0")
          .slice(-12)}`,
        startedBy: "USER",
        desiredState: "STOPPED",
        phase: "STOPPED",
        phaseChangedAt: stoppedAt,
      },
      select: { id: true },
    });
    await fixtures.instanceReservation.create({
      data: {
        instanceId: stale.id,
        nodeId: hidden.id,
        index: 0,
        labels: [],
        resources: { kind: "unified", memoryGb: 1 },
      },
    });
    // Its last request, finalized in this window on the ALLOWED node long after it stopped.
    await fixtures.usageRollupMinute.create({
      data: {
        ...key,
        runtimeId: ids.runtime,
        versionId: ids.version,
        nodeId: ids.node,
        instanceId: stale.id,
        requests: 3,
        errors: 1,
        latencyHistogram: histogramWith(20_000, 20_000, 20_000),
      },
    });
    const { hiddenServing } = await import("../lib/agent-hidden-serving");
    const recent = await hiddenServing(fixtures, [hidden.id], new Date(Date.now() - 86_400_000));
    expect(recent.instanceIds).toContain(ids.instance);
    expect(recent.instanceIds).not.toContain(stale.id);
    const longAgo = await hiddenServing(fixtures, [hidden.id], new Date(stoppedAt.getTime() - 1));
    expect(longAgo.instanceIds).toEqual(expect.arrayContaining([ids.instance, stale.id]));
    const unbounded = await hiddenServing(fixtures, [hidden.id]);
    expect(unbounded.instanceIds).toEqual(expect.arrayContaining([ids.instance, stale.id]));
    const access = { scopes: ["read", "pools", "runtimes"] as const, nodeIds: [ids.node] };
    const range = {
      from: new Date(bucketStart.getTime() - 60_000).toISOString(),
      to: new Date(bucketStart.getTime() + 120_000).toISOString(),
    };
    for (const kind of ["agent_token", "oauth_access_token"] as const) {
      const scoped = client(
        kind === "agent_token"
          ? { kind, userId: OWNER, agentTokenId: "aggregate-token", access }
          : { kind, userId: OWNER, grantId: "aggregate-grant", access },
      );
      const runtime = await scoped.runtimes.get({ runtimeId: ids.runtime });
      expect(runtime.instances.starting).toBe(0);
      expect(runtime.instanceList).toHaveLength(0);
      const view = await scoped.pools.get({ poolId: pool.id });
      expect(view.members[0]?.live.instances).toBe(0);
      expect(view.traffic24h.requests).toBe(10);
      expect(view.traffic24h.errors).toBe(1);
      expect(view.traffic24h.sparkline.reduce((a, b) => a + b, 0)).toBe(10);
      expect(view.members[0]?.live.share).toBeCloseTo(0.4);
      expect(view.members[0]?.live.p95LatencyMs).toBeLessThan(100);
      const node = await scoped.nodes.get({ nodeId: ids.node });
      expect(node.runningInstances).toBe(0);
      expect(node.reservedNowMemoryGb).toBe(0);
      const load = await scoped.activity.metrics.query({
        scope: { runtime: ids.runtime },
        metrics: ["running_max"],
        range,
        step: "1m",
      });
      expect(load.totals.running_max).toBeUndefined();
      const requestMetrics = await scoped.activity.metrics.query({
        scope: { pool: pool.id },
        metrics: ["requests", "errors"],
        range,
        step: "1m",
      });
      expect(requestMetrics.totals).toEqual({ requests: 10, errors: 1 });
      const listed = await scoped.activity.requests.list({ poolId: pool.id, limit: 50 });
      expect(listed.items.map((row) => row.id)).toContain(plainRequest.id);
      expect(listed.items.map((row) => row.id)).not.toContain(mixedRequest.id);
      await expect(
        scoped.pools.update({ poolId: pool.id, members: { remove: [member.id] } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(scoped.pools.delete({ poolId: pool.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(scoped.runtimes.delete({ runtimeId: ids.runtime })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await fixtures.poolMember.count({ where: { id: member.id } })).toBe(1);
    }
    for (const auth of [person(OWNER), agent(OWNER)]) {
      const unscoped = client(auth);
      const runtime = await unscoped.runtimes.get({ runtimeId: ids.runtime });
      expect(runtime.instances.starting).toBe(1);
      expect(runtime.instanceList).toHaveLength(1);
      const view = await unscoped.pools.get({ poolId: pool.id });
      expect(view.members[0]?.live.instances).toBe(1);
      expect(view.traffic24h.requests).toBe(159);
      expect(view.traffic24h.errors).toBe(27);
      expect(view.members[0]?.live.share).toBeCloseTo(153 / 159);
      const listed = await unscoped.activity.requests.list({ poolId: pool.id, limit: 50 });
      expect(listed.items.map((row) => row.id)).toEqual(
        expect.arrayContaining([plainRequest.id, mixedRequest.id]),
      );
      expect(view.members[0]?.live.p95LatencyMs).toBeGreaterThan(10_000);
      const load = await unscoped.activity.metrics.query({
        scope: { runtime: ids.runtime },
        metrics: ["running_max"],
        range,
        step: "1m",
      });
      expect(load.totals.running_max).toBe(7);
    }
    await client(person(OWNER)).pools.update({ poolId: pool.id, members: { remove: [member.id] } });
    expect(await fixtures.poolMember.count({ where: { id: member.id } })).toBe(0);
  });

  it("hides rankless always-on bindings consistently across read surfaces on PostgreSQL", async () => {
    const hidden = await fixtures.node.create({
      data: {
        userId: OWNER,
        slug: "always-on-hidden",
        connection: "ONLINE",
        trust: "FULL",
        features: TEST_NODE_FEATURES,
      },
    });
    const access = { scopes: ["read"] as const, nodeIds: [ids.node] };
    const callers: Array<{ auth: CallerAuth; filtered: boolean }> = [
      {
        auth: { kind: "agent_token", userId: OWNER, agentTokenId: "bound-token", access },
        filtered: true,
      },
      {
        auth: { kind: "oauth_access_token", userId: OWNER, grantId: "bound-grant", access },
        filtered: true,
      },
      { auth: agent(OWNER), filtered: false },
      {
        auth: {
          kind: "oauth_access_token",
          userId: OWNER,
          grantId: "all-grant",
          access: { ...access, nodeIds: null },
        },
        filtered: false,
      },
      { auth: person(OWNER), filtered: false },
    ];
    const profile = await fixtures.profile.create({
      data: {
        userId: OWNER,
        slug: "bound-controls",
        name: "Bound controls",
        editor: "USER",
        editorUserId: OWNER,
        Nodes: { create: [{ nodeId: ids.node }, { nodeId: hidden.id }] },
        Items: {
          create: [{ position: 0, runtimeId: ids.runtime, versionId: ids.version, count: 1 }],
        },
      },
    });
    const before = await Promise.all(
      callers.map(async ({ auth }) => ({
        node: await client(auth).nodes.get({ nodeId: ids.node }),
        profile: await client(auth).profiles.get({ profileId: profile.id }),
      })),
    );
    const created = await client(person(OWNER)).runtimes.create({
      slug: "bound-hidden",
      name: "Bound hidden",
      kind: "ALWAYS_ON",
      nodeId: hidden.id,
      spec: {
        api: "openai",
        engine: "vllm",
        modelType: "llm",
        models: [{ id: "m" }],
        address: { baseUrl: "http://127.0.0.1:8000" },
      },
    });
    const runtimeId = created.runtime.id;
    const runtime = await fixtures.runtime.findUniqueOrThrow({
      where: { id: runtimeId },
      include: { Models: true, Instances: true },
    });
    const instance = runtime.Instances[0]!;
    const model = runtime.Models[0]!;
    await fixtures.runtimeInstance.update({
      where: { id: instance.id },
      data: { phase: "READY", phaseReason: null, engineSlots: 8 },
    });
    expect(await fixtures.instanceRank.count({ where: { instanceId: instance.id } })).toBe(0);
    expect(await fixtures.instanceReservation.count({ where: { instanceId: instance.id } })).toBe(
      0,
    );
    await fixtures.executionTarget.create({
      data: {
        userId: OWNER,
        kind: "INSTANCE_MODEL",
        instanceId: instance.id,
        runtimeModelId: model.id,
        health: "HEALTHY",
      },
    });
    const pool = await fixtures.pool.create({
      data: { userId: OWNER, slug: "bound-pool", name: "Bound pool", modelType: "LLM" },
    });
    await fixtures.poolMember.create({
      data: { poolId: pool.id, kind: "LOCAL", runtimeModelId: model.id },
    });
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const range = {
      from: new Date(bucketStart.getTime() - 60_000).toISOString(),
      to: new Date(bucketStart.getTime() + 120_000).toISOString(),
    };
    // Deliberately record load under the allowed node: the runtime binding must also exclude it.
    await fixtures.runtimeLoadMinute.create({
      data: {
        bucketStart,
        ownerUserId: OWNER,
        runtimeId,
        versionId: instance.versionId,
        instanceId: instance.id,
        nodeId: ids.node,
        samples: 2,
        kvSamples: 2,
        sumKvUsage: 1,
        maxKvUsage: 0.75,
        maxRunning: 7,
        maxWaiting: 3,
        fullSamples: 1,
      },
    });
    for (const [index, { auth, filtered }] of callers.entries()) {
      const api = client(auth);
      const detail = await api.runtimes.get({ runtimeId });
      const list = await api.runtimes.list();
      for (const view of [detail, list.runtimes.find((row) => row.id === runtimeId)!]) {
        expect(view.instances).toEqual({
          running: filtered ? 0 : 1,
          starting: 0,
          failed: 0,
          needsYou: 0,
        });
      }
      expect(detail.instanceList).toHaveLength(filtered ? 0 : 1);
      const poolDetail = await api.pools.get({ poolId: pool.id });
      const poolList = await api.pools.list();
      for (const view of [poolDetail, poolList.pools.find((row) => row.id === pool.id)!]) {
        expect(view.members[0]).toMatchObject({
          status: filtered ? "unavailable" : "serving",
          health: filtered ? "UNKNOWN" : "HEALTHY",
          live: {
            instances: filtered ? 0 : 1,
            running: filtered ? 0 : 1,
            active: null,
            waiting: null,
            slots: filtered ? null : 8,
          },
        });
        expect(view.runsOn).toHaveLength(filtered ? 0 : 1);
        if (!filtered) expect(view.runsOn[0]).toMatchObject({ nodeId: hidden.id, instances: 1 });
      }
      const load = await api.activity.metrics.query({
        scope: { pool: pool.id },
        metrics: ["kv_usage_avg", "kv_usage_max", "running_max", "waiting_max", "full_ratio"],
        range,
        step: "1m",
      });
      if (filtered) {
        expect(load.totals).toEqual({});
        expect(load.series).toEqual([]);
      } else {
        expect(load.totals).toEqual({
          kv_usage_avg: 0.5,
          kv_usage_max: 0.75,
          running_max: 7,
          waiting_max: 3,
          full_ratio: 0.5,
        });
        expect(load.series[0]?.values.running_max).toEqual([7]);
      }
      const node = await api.nodes.get({ nodeId: ids.node });
      for (const key of [
        "runningInstances",
        "needsYou",
        "reservedNowMemoryGb",
        "alwaysOnRuntimes",
      ] as const)
        expect(node[key]).toEqual(before[index]!.node[key]);
      const profileView = await api.profiles.get({ profileId: profile.id });
      expect(profileView.items[0]?.runningNow).toEqual(before[index]!.profile.items[0]?.runningNow);
      expect(profileView.satisfied).toEqual(before[index]!.profile.satisfied);
      if (filtered)
        await expect(api.nodes.get({ nodeId: hidden.id })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
    }
  });
});
