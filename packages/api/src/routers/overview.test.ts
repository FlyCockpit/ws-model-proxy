import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://overview-test", NODE_ENV: "test" },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { overviewRouter } = await import("./overview");

const db = prisma as unknown as {
  appSetting: { findUnique: MockInstance };
  modelPool: { findMany: MockInstance };
  executionTarget: { findMany: MockInstance };
  cliDevice: { findMany: MockInstance };
  endpoint: { findMany: MockInstance };
  poolMember: { findMany: MockInstance };
  modelApiToken: { count: MockInstance };
  poolGrant: { findMany: MockInstance };
  $queryRaw: MockInstance;
};

function context(signedIn = true): Context {
  if (!signedIn) return { session: null } as Context;
  return {
    session: {
      user: {
        id: "owner-id",
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      session: {
        id: "session-id",
        userId: "owner-id",
        token: "session-token",
        expiresAt: new Date("2099-01-02T00:00:00.000Z"),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    } as Session,
  } as Context;
}

function client(signedIn = true) {
  return createRouterClient(overviewRouter, { context: context(signedIn) });
}

function localTarget(id: string, model: string) {
  return {
    id,
    kind: "DISCOVERED_MODEL",
    DiscoveredModel: {
      upstreamModelId: model,
      Endpoint: {
        label: "vLLM",
        CliDevice: { name: null, reportedHostname: "gpu-box", slug: "gpu" },
      },
    },
    ProviderModel: null,
  };
}

function pool() {
  return {
    id: "pool-1",
    name: "Coding",
    slug: "coding",
    PoolMembers: [
      {
        id: "member-a",
        tier: "PRIMARY",
        healthStatus: "HEALTHY",
        routingStatus: "ACTIVE",
        executionTargetId: "target-a",
        ExecutionTarget: localTarget("target-a", "qwen-a"),
      },
      {
        id: "member-b",
        tier: "PRIMARY",
        healthStatus: "DEGRADED",
        routingStatus: "ACTIVE",
        executionTargetId: "target-b",
        ExecutionTarget: localTarget("target-b", "qwen-b"),
      },
    ],
  };
}

function aggregate(overrides: Record<string, unknown>) {
  return {
    current: true,
    poolId: "pool-1",
    poolMemberId: "member-a",
    executionTargetId: "target-a",
    requests: 0n,
    successes: 0n,
    errors: 0n,
    cancels: 0n,
    retries: 0n,
    usageKnownRequests: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    cacheKnownRequests: 0n,
    cacheKnownInputTokens: 0n,
    durationCount: 0n,
    durationSumMs: 0n,
    ttftCount: 0n,
    ttftSumMs: 0n,
    ...overrides,
  };
}

type RawCall = [TemplateStringsArray, ...unknown[]];

/** Joins a tagged-template call's SQL text, including nested fragments. */
function rawText(call: RawCall): string {
  const [strings, ...rest] = call;
  const part = (value: unknown): string =>
    value !== null && typeof value === "object" && "strings" in value
      ? (value as { strings: string[] }).strings.join("?")
      : "?";
  return strings.reduce(
    (text, chunk, index) => text + chunk + (index < rest.length ? part(rest[index]) : ""),
    "",
  );
}

/** Flattens tagged-template parameters, including nested Prisma.Sql fragments. */
function rawValues(call: RawCall): unknown[] {
  const [, ...rest] = call;
  const flatten = (value: unknown): unknown[] =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "values" in value &&
    Array.isArray((value as { values: unknown }).values)
      ? (value as { values: unknown[] }).values.flatMap(flatten)
      : [value];
  return rest.flatMap(flatten);
}

describe("overviewRouter.metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.modelPool.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers", async () => {
    await expect(client(false).metrics({ range: "24h" })).rejects.toBeInstanceOf(ORPCError);
  });

  it("returns an empty, chart-ready default for a new user", async () => {
    const result = await client().metrics({});
    expect(result.range).toBe("24h");
    expect(result.bucketMs).toBe(15 * 60_000);
    expect(result.includeTestTraffic).toBe(false);
    expect(result.pools).toEqual([]);
    expect(result.direct).toEqual([]);
    expect(result.sharedPools).toEqual([]);
    expect(result.setup).toEqual({ hasPools: false, hasDirectTargets: false });
    expect(result.totals.current).toMatchObject({
      requests: 0,
      errorRate: null,
      cacheHitRate: null,
      p95LatencyMs: null,
      p95TtftMs: null,
    });
    // Owner scope: pools and execution targets are looked up by the session user.
    expect(db.modelPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner-id" } }),
    );
    expect(db.executionTarget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner-id" } }),
    );
  });

  it("excludes chat-test and MCP traffic unless asked, and never counts transformer hops", async () => {
    await client().metrics({ range: "1h" });
    for (const call of db.$queryRaw.mock.calls as RawCall[])
      expect(rawValues(call)).toContainEqual(["API_TOKEN"]);
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.modelPool.findMany.mockResolvedValue([]);
    db.executionTarget.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
    await client().metrics({ range: "1h", includeTestTraffic: true });
    for (const call of db.$queryRaw.mock.calls as RawCall[]) {
      const values = rawValues(call);
      expect(values).toContainEqual(["API_TOKEN", "CHAT_TEST", "MCP"]);
      expect(JSON.stringify(values)).not.toContain("TRANSFORMER");
    }
  });

  it("shapes per-pool series, member shares, cache hit rate and percentiles", async () => {
    db.modelPool.findMany.mockResolvedValue([pool()]);
    db.executionTarget.findMany.mockResolvedValue([localTarget("direct-target", "llama")]);
    const latency = latencyBucketIndex(400);
    db.$queryRaw
      .mockResolvedValueOnce([
        aggregate({
          requests: 30n,
          successes: 29n,
          errors: 1n,
          usageKnownRequests: 30n,
          inputTokens: 3000n,
          outputTokens: 300n,
          cacheReadTokens: 1500n,
          cacheKnownRequests: 30n,
          cacheKnownInputTokens: 3000n,
          durationCount: 30n,
          durationSumMs: 12_000n,
        }),
        aggregate({
          poolMemberId: "member-b",
          executionTargetId: "target-b",
          requests: 10n,
          successes: 10n,
          usageKnownRequests: 10n,
          inputTokens: 1000n,
        }),
        // A member removed since, still visible in the table.
        aggregate({ poolMemberId: "gone", executionTargetId: "old", requests: 10n, errors: 10n }),
        aggregate({ current: false, requests: 20n, errors: 0n }),
        aggregate({
          poolId: "",
          poolMemberId: "",
          executionTargetId: "direct-target",
          requests: 5n,
          successes: 5n,
        }),
      ])
      .mockResolvedValueOnce([
        {
          current: true,
          poolId: "pool-1",
          poolMemberId: "member-a",
          executionTargetId: "target-a",
          kind: "latency",
          idx: BigInt(latency + 1),
          count: 30n,
        },
      ])
      .mockResolvedValueOnce([
        { poolId: "pool-1", poolMemberId: "member-a", bucket: 95, requests: 30n, errors: 1n },
        { poolId: "pool-1", poolMemberId: "member-b", bucket: 95, requests: 15n, errors: 0n },
      ]);

    const result = await client().metrics({ range: "24h" });
    expect(result.setup.hasPools).toBe(true);
    const card = result.pools[0]!;
    expect(card.current.requests).toBe(50);
    expect(card.previous.requests).toBe(20);
    expect(card.members.map((member) => member.poolMemberId)).toEqual([
      "member-a",
      "member-b",
      "gone",
    ]);
    const [a, b, gone] = card.members;
    expect(a!.share).toBeCloseTo(0.6);
    expect(a!.stats.cacheHitRate).toBeCloseTo(0.5);
    expect(a!.stats.p95LatencyMs).toBeGreaterThanOrEqual(300);
    expect(a!.stats.p95LatencyMs).toBeLessThan(500);
    expect(a!.model).toBe("qwen-a");
    expect(a!.location).toBe("vLLM · gpu-box");
    // Usage known but cache not reported: "not reported", never 0%.
    expect(b!.stats.cacheHitRate).toBeNull();
    expect(b!.healthStatus).toBe("DEGRADED");
    expect(gone!.present).toBe(false);
    expect(gone!.stats.errorRate).toBe(1);
    // 24h at 15-minute buckets, values in requests per minute.
    expect(card.series).toHaveLength(96);
    expect(card.series[95]!.values).toMatchObject({ "member-a": 2, "member-b": 1 });
    expect(card.series[0]!.values).toMatchObject({ "member-a": 0, "member-b": 0 });
    expect(result.direct).toEqual([
      expect.objectContaining({
        executionTargetId: "direct-target",
        model: "llama",
        current: expect.objectContaining({ requests: 5 }),
      }),
    ]);
    expect(result.totals.current.requests).toBe(55);
    expect(result.totals.previous.requests).toBe(20);
  });

  it("scopes owned traffic by resource owner and shared-pool usage by requester only", async () => {
    await client().metrics({ range: "1h" });
    const calls = db.$queryRaw.mock.calls as RawCall[];
    // Owned: aggregates, histograms, series. Shared: aggregates, histograms.
    expect(calls).toHaveLength(5);
    const owned = calls.slice(0, 3).map(rawText);
    const shared = calls.slice(3).map(rawText);
    for (const text of owned) {
      expect(text).toContain('r."ownerUserId" = ?');
      expect(text).not.toContain("requesterUserId");
    }
    for (const [index, text] of shared.entries()) {
      expect(text).toContain('r."requesterUserId" = ?');
      expect(text).toContain('r."ownerUserId" <> ?');
      expect(text).toContain(`r."poolId" <> ''`);
      // The owner's member/target identities are never grouped or returned.
      expect(text).not.toContain('r."poolMemberId"');
      expect(text).not.toContain('r."executionTargetId"');
      expect(rawValues(calls[3 + index]!)).toContain("owner-id");
    }
  });

  it("reports the caller's own usage of pools shared with them, separately from owned totals", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([]) // owned aggregates
      .mockResolvedValueOnce([]) // owned histograms
      .mockResolvedValueOnce([]) // owned series
      .mockResolvedValueOnce([
        aggregate({
          poolId: "shared-pool",
          poolMemberId: "",
          executionTargetId: "",
          requests: 7n,
          errors: 1n,
        }),
        aggregate({
          poolId: "revoked-pool",
          poolMemberId: "",
          executionTargetId: "",
          requests: 2n,
        }),
      ])
      .mockResolvedValueOnce([]);
    db.poolGrant.findMany.mockResolvedValue([
      {
        poolId: "shared-pool",
        ModelPool: { name: "Team GPUs", slug: "team-gpus" },
        Owner: { slug: "alice" },
      },
    ]);
    const result = await client().metrics({ range: "24h" });
    expect(db.poolGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { granteeUserId: "owner-id", poolId: { in: ["shared-pool", "revoked-pool"] } },
      }),
    );
    expect(result.sharedPools).toEqual([
      expect.objectContaining({
        poolId: "shared-pool",
        available: true,
        name: "Team GPUs",
        ownerSlug: "alice",
        current: expect.objectContaining({ requests: 7, errors: 1 }),
      }),
      expect.objectContaining({ poolId: "revoked-pool", available: false, name: null }),
    ]);
    // Shared-pool usage is not traffic you serve.
    expect(result.totals.current.requests).toBe(0);
    expect(result.pools).toEqual([]);
  });

  it("skips shared-pool queries when filtering to one owned pool", async () => {
    db.modelPool.findMany.mockResolvedValue([pool()]);
    const result = await client().metrics({ range: "1h", poolId: "pool-1" });
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
    expect(result.sharedPools).toEqual([]);
    for (const call of db.$queryRaw.mock.calls as RawCall[]) {
      expect(rawText(call)).toContain('r."ownerUserId" = ? AND r."poolId" = ?');
      expect(rawValues(call)).toEqual(expect.arrayContaining(["owner-id", "pool-1"]));
    }
  });

  it("rejects a poolId the caller does not own", async () => {
    db.modelPool.findMany.mockResolvedValue([]);
    await expect(client().metrics({ range: "1h", poolId: "someone-else" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("overviewRouter.health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
  });

  it("counts online CLIs, healthy endpoints and unhealthy members with link ids", async () => {
    const now = Date.now();
    db.cliDevice.findMany.mockResolvedValue([
      {
        id: "cli-1",
        slug: "gpu",
        name: null,
        reportedHostname: "gpu-box",
        status: "CONNECTED",
        lastHeartbeatAt: new Date(now - 5_000),
      },
      {
        id: "cli-2",
        slug: "laptop",
        name: "Laptop",
        reportedHostname: null,
        status: "CONNECTED",
        lastHeartbeatAt: new Date(now - 10 * 60_000),
      },
    ]);
    db.endpoint.findMany.mockResolvedValue([
      { id: "ep-1", label: "vLLM", status: "ONLINE", cliDeviceId: "cli-1" },
      { id: "ep-2", label: "Ollama", status: "OFFLINE", cliDeviceId: "cli-2" },
    ]);
    db.poolMember.findMany.mockResolvedValue([
      {
        id: "member-a",
        poolId: "pool-1",
        healthStatus: "UNHEALTHY",
        routingStatus: "ACTIVE",
        ModelPool: { name: "Coding" },
        ExecutionTarget: localTarget("target-a", "qwen-a"),
      },
      {
        id: "member-b",
        poolId: "pool-1",
        healthStatus: "DEGRADED",
        routingStatus: "DISABLED",
        ModelPool: { name: "Coding" },
        ExecutionTarget: localTarget("target-b", "qwen-b"),
      },
    ]);
    db.modelApiToken.count.mockResolvedValue(2);
    const health = await client().health();
    expect(health.clis).toMatchObject({ total: 2, online: 1 });
    expect(health.clis.offline).toEqual([
      { id: "cli-2", displayName: "Laptop", status: "CONNECTED" },
    ]);
    expect(health.endpoints).toMatchObject({ total: 2, healthy: 1 });
    expect(health.endpoints.unhealthy[0]).toMatchObject({ id: "ep-2", cliDeviceId: "cli-2" });
    // Disabled members are not routed, so they do not count as degraded.
    expect(health.poolMembers).toMatchObject({ total: 1, degradedCount: 0, circuitOpenCount: 1 });
    expect(health.poolMembers.circuitOpen[0]).toMatchObject({ id: "member-a", poolId: "pool-1" });
    expect(health.modelApiTokens).toBe(2);
    expect(db.cliDevice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "owner-id", status: { not: "REVOKED" } } }),
    );
  });
});
