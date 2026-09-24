import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

/**
 * Runs the real overview metrics SQL against real rollup rows: owner scope
 * (every requester on what you own, incl. a deleted requester's '' sentinel),
 * grantee scope (only your own usage of pools shared with you, per pool), and
 * the histogram-based percentiles.
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("overview metrics with real PostgreSQL", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  let overviewRouter: typeof import("./overview").overviewRouter;
  let latencyBucketIndex: typeof import("@ws-model-proxy/config/usage-metrics").latencyBucketIndex;
  let emptyLatencyHistogram: typeof import("@ws-model-proxy/config/usage-metrics").emptyLatencyHistogram;
  const created: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, router, metrics] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./overview"),
      import("@ws-model-proxy/config/usage-metrics"),
    ]);
    prisma = db.default;
    overviewRouter = router.overviewRouter;
    latencyBucketIndex = metrics.latencyBucketIndex;
    emptyLatencyHistogram = metrics.emptyLatencyHistogram;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    const row = await prisma.user.create({
      data: {
        name: `Overview ${label}`,
        email: `overview-${label}-${suffix}@example.test`,
        slug: `overview-${label}-${suffix}`,
      },
    });
    created.push(row.id);
    return row;
  }

  function client(user: { id: string }) {
    const session = {
      user,
      session: {
        id: `session-${crypto.randomUUID()}`,
        userId: user.id,
        token: `token-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as unknown as Session;
    return createRouterClient(overviewRouter, { context: { session } as Context });
  }

  function histogram(ms: number, count: number) {
    const values = emptyLatencyHistogram();
    values[latencyBucketIndex(ms)] = count;
    return values;
  }

  it("scopes owned traffic by resource owner and shared usage by requester", async () => {
    const owner = await user("owner");
    const grantee = await user("grantee");
    const stranger = await user("stranger");
    const pool = await prisma.modelPool.create({
      data: { userId: owner.id, name: "Team GPUs", slug: `team-${crypto.randomUUID()}` },
    });
    await prisma.poolGrant.create({
      data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
    });
    const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000);
    const row = (ownerUserId: string, requesterUserId: string, requests: number, ms: number) => ({
      bucketStart,
      ownerUserId,
      requesterUserId,
      poolId: pool.id,
      poolMemberId: "",
      executionTargetId: "",
      source: "API_TOKEN" as const,
      requests,
      successes: requests - 1,
      errors: 1,
      usageKnownRequests: requests,
      inputTokens: BigInt(requests * 100),
      outputTokens: BigInt(requests * 10),
      cacheReadTokens: BigInt(requests * 50),
      cacheKnownRequests: requests,
      cacheKnownInputTokens: BigInt(requests * 100),
      durationCount: requests,
      durationSumMs: BigInt(requests * ms),
      latencyHistogram: histogram(ms, requests),
      ttftHistogram: emptyLatencyHistogram(),
    });
    await prisma.usageRollupMinute.createMany({
      data: [
        row(owner.id, owner.id, 4, 200),
        row(owner.id, grantee.id, 6, 2000),
        // A deleted requester's merged history still belongs to the owner.
        row(owner.id, "", 2, 200),
        // Test traffic is excluded by default.
        { ...row(owner.id, grantee.id, 50, 200), source: "CHAT_TEST" as const },
      ],
    });

    const ownerView = await client(owner).metrics({ range: "1h" });
    expect(ownerView.totals.current).toMatchObject({ requests: 12, errors: 3 });
    expect(ownerView.totals.current.cacheHitRate).toBeCloseTo(0.5);
    // 6 of 12 requests are ~2 s: p95 lands in the 2 s bucket, p50 at the boundary.
    expect(ownerView.totals.current.p95LatencyMs).toBeGreaterThan(1000);
    expect(ownerView.pools).toHaveLength(1);
    expect(ownerView.pools[0]).toMatchObject({ poolId: pool.id, name: "Team GPUs" });
    expect(ownerView.pools[0]!.current.requests).toBe(12);
    expect(ownerView.sharedPools).toEqual([]);

    const granteeView = await client(grantee).metrics({ range: "1h" });
    // The grantee serves nothing; they see only their own usage of the pool.
    expect(granteeView.totals.current.requests).toBe(0);
    expect(granteeView.pools).toEqual([]);
    expect(granteeView.sharedPools).toEqual([
      expect.objectContaining({
        poolId: pool.id,
        available: true,
        name: "Team GPUs",
        current: expect.objectContaining({ requests: 6, errors: 1 }),
      }),
    ]);
    expect(granteeView.sharedPools[0]!.current.p95LatencyMs).toBeGreaterThan(1000);

    const withTest = await client(grantee).metrics({ range: "1h", includeTestTraffic: true });
    expect(withTest.sharedPools[0]!.current.requests).toBe(56);

    const strangerView = await client(stranger).metrics({ range: "1h" });
    expect(strangerView.totals.current.requests).toBe(0);
    expect(strangerView.sharedPools).toEqual([]);
    await expect(client(stranger).metrics({ range: "1h", poolId: pool.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
