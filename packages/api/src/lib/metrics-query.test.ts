import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", async () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: await import("../../../db/prisma/generated/internal/prismaNamespace"),
}));

import {
  emptyLatencyHistogram,
  LATENCY_HISTOGRAM_BUCKETS,
  latencyBucketIndex,
} from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { metricsQueryInputSchema, metricsQueryOutputSchema } from "../contracts/metrics";
import { compactNumber, runMetricsQuery } from "./metrics-query";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const NOW = new Date("2026-10-07T12:00:30.000Z");

type SqlLike = { strings: readonly string[]; values: readonly unknown[] };
const text = (query: unknown) => (query as Prisma.Sql).sql;
const values = (query: unknown) => (query as SqlLike).values;

/** Answers each rollup query from the table it reads and whether it is a series. */
function answer(rows: {
  requestTotals?: Record<string, unknown>[];
  requestSeries?: Record<string, unknown>[];
  loadTotals?: Record<string, unknown>[];
  loadSeries?: Record<string, unknown>[];
  nodeTotals?: Record<string, unknown>[];
  nodeSeries?: Record<string, unknown>[];
  /** Tests the request metrics left out (SUM over no rows is NULL). */
  tests?: number;
}) {
  const queries: unknown[] = [];
  db.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...parts: unknown[]) => {
    const query = Prisma.sql(strings, ...parts);
    queries.push(query);
    const sql = text(query);
    const series = sql.includes("date_bin");
    if (sql.includes("source IN (")) return [{ requests: rows.tests ?? null }];
    if (sql.includes("usage_rollup_minute"))
      return (series ? rows.requestSeries : rows.requestTotals) ?? [];
    if (sql.includes("FROM runtime_load_minute l"))
      return (series ? rows.loadSeries : rows.loadTotals) ?? [];
    return (series ? rows.nodeSeries : rows.nodeTotals) ?? [];
  }) as never);
  return queries;
}

const parse = (input: unknown) => metricsQueryInputSchema.parse(input);
const minute = (index: number) => new Date(Date.parse("2026-10-07T11:00:00.000Z") + index * 60_000);

function histogram(...samples: number[]): Record<string, number> {
  const counts = emptyLatencyHistogram();
  for (const sample of samples) counts[latencyBucketIndex(sample)]! += 1;
  return Object.fromEntries(counts.map((count, index) => [`ttft_${index + 1}`, count]));
}

beforeEach(() => {
  mockReset(db);
  for (const delegate of [
    db.runtime,
    db.runtimeVersion,
    db.node,
    db.runtimeInstance,
    db.runtimeModel,
    db.providerModel,
  ])
    delegate.findMany.mockResolvedValue([] as never);
  db.pool.findFirst.mockResolvedValue({
    id: "pool1",
    Members: [{ RuntimeModel: { runtimeId: "rt1" } }],
  } as never);
});

describe("metrics_query scope", () => {
  it("answers NOT_FOUND for a scope the caller neither owns nor holds a share of, before any SQL", async () => {
    db.pool.findFirst.mockResolvedValue(null);
    db.share.findFirst.mockResolvedValue(null);
    await expect(
      runMetricsQuery(
        "owner",
        parse({ scope: { pool: "p" }, metrics: ["requests"], range: "1h", step: "1m" }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.pool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p", userId: "owner" } }),
    );
    expect(db.share.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { poolId: "p", granteeUserId: "owner", canUse: true } }),
    );
    for (const [scope, delegate] of [
      [{ runtime: "r" }, db.runtime.findFirst],
      [{ version: "v" }, db.runtimeVersion.findFirst],
      [{ node: "n" }, db.node.findFirst],
      [{ instance: "i" }, db.runtimeInstance.findFirst],
    ] as const) {
      delegate.mockResolvedValue(null);
      await expect(
        runMetricsQuery("owner", parse({ scope, metrics: ["requests"], range: "1h", step: "1m" })),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("gives a share holder their own requests only, ungrouped or by source", async () => {
    db.pool.findFirst.mockResolvedValue(null);
    db.share.findFirst.mockResolvedValue({ poolId: "pool1" } as never);
    for (const input of [
      { metrics: ["requests"], groupBy: "node" },
      { metrics: ["requests"], groupBy: "model" },
      { metrics: ["kv_usage_max"] },
      { metrics: ["cpu_pct"] },
    ]) {
      await expect(
        runMetricsQuery(
          "guest",
          parse({ scope: { pool: "pool1" }, range: "1h", step: "1m", ...input }),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const queries = answer({});
    await runMetricsQuery(
      "guest",
      parse({
        scope: { pool: "pool1" },
        metrics: ["requests"],
        range: "1h",
        step: "1m",
        groupBy: "source",
      }),
      NOW,
    );
    for (const query of queries) {
      expect(text(query)).toContain('"requesterUserId" =');
      expect(text(query)).not.toContain('"ownerUserId" =');
      expect(values(query)).toContain("guest");
    }
  });

  it("filters an owner's pool on the owner, and load and node rows on the node owner", async () => {
    const queries = answer({});
    await runMetricsQuery(
      "owner",
      parse({
        scope: { pool: "pool1" },
        metrics: ["requests", "kv_usage_max", "cpu_pct"],
        range: "1h",
        step: "1m",
      }),
      NOW,
    );
    // Request totals, series and the left-out agent tests; load and node totals and series.
    expect(queries).toHaveLength(7);
    for (const query of queries) {
      expect(text(query)).toMatch(/"ownerUserId" = /);
      expect(values(query)).toContain("owner");
    }
    // Only the caller's own member runtimes count for load and nodes.
    expect(db.pool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          Members: expect.objectContaining({ where: { RuntimeModel: { userId: "owner" } } }),
        }),
      }),
    );
  });

  it("skips load and node SQL for a pool without the caller's own runtimes", async () => {
    db.pool.findFirst.mockResolvedValue({ id: "pool1", Members: [] } as never);
    const queries = answer({});
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { pool: "pool1" },
        metrics: ["kv_usage_max", "cpu_pct"],
        range: "1h",
        step: "1m",
      }),
      NOW,
    );
    expect(queries).toEqual([]);
    expect(result).toEqual({
      start: "2026-10-07T11:00:00.000Z",
      series: [],
      totals: {},
      histogramVersion: "v1",
    });
  });
});

describe("metrics_query values", () => {
  it("leaves out empty buckets and null totals, and rounds", async () => {
    answer({
      requestTotals: [
        {
          g: "",
          requests: 3,
          errors: 1,
          cloudRequests: 1,
          generationTokens: 1_000,
          generationMs: 3_000,
          ...histogram(100, 200, 400),
        },
      ],
      requestSeries: [
        { t: minute(2), g: "", requests: 2, errors: 1, cloudRequests: 0, ...histogram(100, 200) },
        {
          t: minute(5),
          g: "",
          requests: 1,
          errors: 0,
          cloudRequests: 1,
          generationTokens: 1_000,
          generationMs: 3_000,
          ...histogram(400),
        },
      ],
    });
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { pool: "pool1" },
        metrics: ["requests", "errors", "cloud_share", "decode_tps", "ttft_p50", "cache_hit_rate"],
        range: "1h",
        step: "1m",
      }),
      NOW,
    );
    expect(metricsQueryOutputSchema.safeParse(result).success).toBe(true);
    expect(result.start).toBe("2026-10-07T11:00:00.000Z");
    expect(result.series).toEqual([
      {
        at: [2, 5],
        values: {
          requests: [2, 1],
          errors: [1, 0],
          cloud_share: [0, 1],
          decode_tps: [null, 333],
          ttft_p50: [150, 400],
          cache_hit_rate: [null, null],
        },
      },
    ]);
    expect(result.totals).toEqual({
      requests: 3,
      errors: 1,
      cloud_share: 0.333,
      decode_tps: 333,
      ttft_p50: 250,
    });
    expect("truncated" in result).toBe(false);
  });

  it("keeps the largest groups that fit, says it truncated, and labels only the caller's ids", async () => {
    const totals = Array.from({ length: 12 }, (_, index) => ({
      g: `v${index}`,
      requests: 100 - index,
    }));
    const queries = answer({
      requestTotals: totals,
      requestSeries: totals.slice(0, 10).map((row) => ({ ...row, t: minute(1) })),
    });
    db.runtimeVersion.findMany.mockResolvedValue([
      { id: "v0", version: 3, Runtime: { slug: "qwen" } },
    ] as never);
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { pool: "pool1" },
        metrics: ["requests"],
        range: "1h",
        step: "1m",
        groupBy: "version",
      }),
      NOW,
    );
    expect(result.truncated).toBe(true);
    expect(result.series).toHaveLength(10);
    expect(result.series[0]?.group).toEqual({ key: "v0", label: "qwen v3" });
    expect(result.series[1]?.group).toEqual({ key: "v1" });
    expect(result.totals.requests).toBe(totals.reduce((sum, row) => sum + row.requests, 0));
    // The series query asks for the kept keys only.
    const series = queries.find((query) => text(query).includes("date_bin"));
    expect(values(series)).toContainEqual(totals.slice(0, 10).map((row) => row.g));
    expect(db.runtimeVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: expect.any(Array) }, Runtime: { userId: "owner" } },
      }),
    );
  });

  it("fits fewer groups when buckets × metrics are many", async () => {
    const totals = Array.from({ length: 10 }, (_, index) => ({ g: `n${index}`, samples: 10 }));
    const queries = answer({ loadTotals: totals });
    db.runtime.findFirst.mockResolvedValue({ id: "rt1", nodeId: null, Instances: [] } as never);
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { runtime: "rt1" },
        metrics: ["kv_usage_avg", "kv_usage_max", "running_max", "waiting_max", "full_ratio"],
        range: "24h",
        step: "5m",
        groupBy: "node",
      }),
      NOW,
    );
    // 289 buckets × 5 metrics: 8000 / 1445 → 5 groups.
    expect(result.truncated).toBe(true);
    const series = queries.find((query) => text(query).includes("date_bin"));
    expect(values(series)).toContainEqual(["n0", "n1", "n2", "n3", "n4"]);
  });

  it("adds node memory across nodes and averages CPU by samples", async () => {
    db.node.findFirst.mockResolvedValue({ id: "n1" } as never);
    answer({
      nodeTotals: [
        {
          g: "",
          n: "n1",
          cpuSamples: 2,
          sumCpuPercent: 100,
          memorySamples: 2,
          sumMemoryAvailableMiB: 4096,
        },
      ],
      nodeSeries: [
        {
          t: minute(0),
          g: "",
          n: "n1",
          cpuSamples: 2,
          sumCpuPercent: 100,
          memorySamples: 2,
          sumMemoryAvailableMiB: 4096,
          minAcceleratorFreeMiB: 1536,
          maxGpuTemperatureC: 61,
          c0_sum: 30,
          c0_n: 3,
        },
      ],
    });
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { node: "n1" },
        metrics: [
          "cpu_pct",
          "memory_available_gb",
          "accelerator_free_gb",
          "gpu_temp_c",
          "custom:x",
        ],
        range: "1h",
        step: "1m",
      }),
      NOW,
    );
    expect(result.series[0]?.values).toEqual({
      cpu_pct: [50],
      memory_available_gb: [2],
      accelerator_free_gb: [1.5],
      gpu_temp_c: [61],
      "custom:x": [10],
    });
    expect(result.totals).toEqual({ cpu_pct: 50, memory_available_gb: 2 });
  });

  it("leaves tests (agent and Test page) out of the request metrics and counts them apart", async () => {
    const queries = answer({
      requestTotals: [{ g: "", requests: 2 }],
      requestSeries: [{ t: minute(3), g: "", requests: 2 }],
      tests: 3,
    });
    const input = { scope: { pool: "pool1" }, metrics: ["requests"], range: "1h", step: "1m" };
    const result = await runMetricsQuery("owner", parse(input), NOW);
    expect(metricsQueryOutputSchema.safeParse(result).success).toBe(true);
    expect(result.series).toEqual([{ at: [3], values: { requests: [2] } }]);
    expect(result.totals).toEqual({ requests: 2, tests: 3 });
    expect(queries).toHaveLength(3);
    const tests = queries.find((query) => text(query).includes("source IN ("));
    for (const query of queries.filter((query) => query !== tests))
      expect(text(query)).toContain(
        `source NOT IN ('TEST'::"RequestSource", 'AGENT_TEST'::"RequestSource")`,
      );
    // The count reads the same pool, owner and range as the metrics: same filter but the source.
    const filter = (query: unknown) =>
      /FROM usage_rollup_minute WHERE (.*?)\) r\b/s
        .exec(text(query))?.[1]
        ?.replace(/source (NOT )?IN \([^)]*\)/, "<source>");
    const totals = queries.find((query) => query !== tests && !text(query).includes("date_bin"));
    expect(filter(tests)).toContain('"poolId" =');
    expect(filter(tests)).toContain("<source>");
    expect(filter(tests)).toBe(filter(totals));
    expect(values(tests)).toEqual(values(totals));

    // Hour and day steps count the hourly rows too.
    const hourly = answer({ tests: 1 });
    await runMetricsQuery("owner", parse({ ...input, range: "7d", step: "1h" }), NOW);
    expect(hourly.find((query) => text(query).includes("source IN ("))).toSatisfy(
      (query: unknown) => text(query).includes("usage_rollup_hour"),
    );

    // Only tests in the range: requests 0 and still the tests, so an agent sees why.
    answer({ tests: 1 });
    expect((await runMetricsQuery("owner", parse(input), NOW)).totals).toEqual({
      requests: 0,
      tests: 1,
    });

    // No tests: no `tests` key.
    answer({ requestTotals: [{ g: "", requests: 2 }] });
    expect((await runMetricsQuery("owner", parse(input), NOW)).totals).toEqual({ requests: 2 });
  });

  it("counts tests like any request when asked, and skips the count without request metrics", async () => {
    const included = answer({ requestTotals: [{ g: "", requests: 5 }], tests: 3 });
    const result = await runMetricsQuery(
      "owner",
      parse({
        scope: { pool: "pool1" },
        metrics: ["requests"],
        range: "1h",
        step: "1m",
        includeTests: true,
      }),
      NOW,
    );
    expect(result.totals).toEqual({ requests: 5 });
    expect(included.some((query) => text(query).includes("'TEST'"))).toBe(false);

    const loadOnly = answer({ tests: 3 });
    const load = await runMetricsQuery(
      "owner",
      parse({ scope: { pool: "pool1" }, metrics: ["kv_usage_max"], range: "1h", step: "1m" }),
      NOW,
    );
    expect(load.totals).toEqual({});
    expect(loadOnly.some((query) => text(query).includes("'TEST'"))).toBe(false);
  });

  it("reads the hourly rows only for hour and day steps", async () => {
    const queries = answer({});
    await runMetricsQuery(
      "owner",
      parse({ scope: { pool: "pool1" }, metrics: ["requests"], range: "7d", step: "1h" }),
      NOW,
    );
    expect(queries.every((query) => text(query).includes("usage_rollup_hour"))).toBe(true);
    const minuteQueries = answer({});
    await runMetricsQuery(
      "owner",
      parse({ scope: { pool: "pool1" }, metrics: ["requests"], range: "1h", step: "5m" }),
      NOW,
    );
    expect(minuteQueries.some((query) => text(query).includes("usage_rollup_hour"))).toBe(false);
  });

  it("asks for histogram buckets only of the percentiles requested", async () => {
    const queries = answer({});
    await runMetricsQuery(
      "owner",
      parse({ scope: { pool: "pool1" }, metrics: ["latency_p95"], range: "1h", step: "1m" }),
      NOW,
    );
    expect(text(queries[0])).toContain(`AS "latency_${LATENCY_HISTOGRAM_BUCKETS}"`);
    expect(text(queries[0])).not.toContain("ttftHistogram");
  });
});

describe("metrics_query input bounds", () => {
  it("refuses too many buckets, or buckets × metrics", () => {
    const base = { scope: { pool: "p" }, metrics: ["requests"] };
    expect(metricsQueryInputSchema.safeParse({ ...base, range: "24h", step: "1m" }).success).toBe(
      false,
    );
    expect(metricsQueryInputSchema.safeParse({ ...base, range: "24h", step: "5m" }).success).toBe(
      true,
    );
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        metrics: Array.from({ length: 11 }, (_, index) => `custom:m${index}`),
        scope: { node: "n" },
        range: "24h",
        step: "5m",
      }).success,
    ).toBe(false);
  });
});

describe("metrics_query retention", () => {
  it("refuses a short range that starts before the rows its step reads are kept", () => {
    const hourAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const range = (days: number) => ({
      from: hourAgo(days).toISOString(),
      to: new Date(hourAgo(days).getTime() + 3_600_000).toISOString(),
    });
    const input = (metric: string, step: string, days: number) => ({
      scope: { node: "n" },
      metrics: [metric],
      range: range(days),
      step,
    });
    expect(metricsQueryInputSchema.safeParse(input("requests", "1m", 29)).success).toBe(true);
    expect(metricsQueryInputSchema.safeParse(input("requests", "1m", 40)).success).toBe(false);
    expect(metricsQueryInputSchema.safeParse(input("requests", "1h", 40)).success).toBe(true);
    expect(metricsQueryInputSchema.safeParse(input("kv_usage_max", "1h", 9)).success).toBe(false);
    expect(metricsQueryInputSchema.safeParse(input("cpu_pct", "5m", 6)).success).toBe(true);
  });
});

describe("compactNumber", () => {
  it("keeps integers and three significant digits", () => {
    expect(compactNumber(12_345)).toBe(12_345);
    expect(compactNumber(1234.56)).toBe(1235);
    expect(compactNumber(0.123456)).toBe(0.123);
    expect(compactNumber(12.3456)).toBe(12.3);
  });
});
