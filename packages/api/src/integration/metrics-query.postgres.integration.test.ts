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
  level: "READ",
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
      await db.usageRollupMinute.deleteMany({ where: { ownerUserId: users } });
      await db.usageRollupHour.deleteMany({ where: { ownerUserId: users } });
      await db.runtimeLoadMinute.deleteMany({ where: { ownerUserId: users } });
      await db.nodeMetricsMinute.deleteMany({ where: { ownerUserId: users } });
      await db.pool.deleteMany({ where: { userId: users } });
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
    expect(series?.at).toEqual([1, 3]);
    expect(series?.values.requests).toEqual([5, 5]);
    expect(series?.values.errors).toEqual([1, 0]);
    expect(series?.values.cloud_share).toEqual([0, 0.8]);
    expect(series?.values.ttft_p95?.[1]).toBeNull();
    expect(series?.values.decode_tps).toEqual([100, null]);
    expect(result.totals).toMatchObject({ requests: 10, errors: 1, cloud_share: 0.4 });
    expect(result.totals.ttft_p95).toBeGreaterThan(150);
  });

  it("leaves out agent tests when asked", async () => {
    const result = await client(agent(OWNER)).activity.metrics.query({
      scope: { pool: ids.pool },
      metrics: ["requests"],
      range: WINDOW,
      step: "5m",
      includeAgentTests: false,
    });
    expect(result.series[0]).toEqual({ at: [0], values: { requests: [9] } });
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
      [{ key: ids.runtime, label: "model" }, [5, 1]],
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
        { ...base, ownerUserId: OWNER, requesterUserId: OWNER, source: "AGENT_TEST", requests: 40 },
        // The grantee's own request to someone else's pool counts on their Overview only.
        {
          ownerUserId: STRANGER,
          requesterUserId: GRANTEE,
          bucketStart: recent,
          poolId: "theirs",
          source: "TEST",
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
    const nodes = await admin.nodes({ ownerQuery });
    expect(nodes.items).toEqual([
      expect.objectContaining({ id: ids.node, trust: "FULL", connection: "ONLINE" }),
    ]);
    expect(nodes.items[0]?.runningInstances).toBeGreaterThanOrEqual(0);
    const runtimes = await admin.runtimes({ ownerQuery });
    expect(runtimes.items[0]).toMatchObject({ id: ids.runtime, modelType: "LLM" });
    const pools = await admin.pools({ ownerQuery });
    expect(pools.items).toEqual([
      expect.objectContaining({ id: ids.pool, callableId: `${OWNER}/chat`, members: 1, shares: 1 }),
    ]);
    const relay = await admin.relay({ ownerQuery });
    expect(relay.total).toBe(0);
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
    // 3 + 2 + 1 of the owner's pool; the other owner's 50 on this node stay theirs.
    expect(node.totals.requests).toBe(6);

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
});
