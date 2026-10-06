import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { overviewWindow } from "../lib/overview-metrics";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required");
const integration = databaseUrl ? describe : describe.skip;

function planNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(planNodes)];
}

integration("node histories SQL aggregation with PostgreSQL", () => {
  let fixtures: ReturnType<typeof createFixturePrismaClient>;
  let production: typeof import("@ws-model-proxy/db").default;
  let router: typeof import("./forwarder-cli-devices").cliDeviceProcedures;
  let ownerId: string;
  let deviceId: string;
  const now = new Date("2026-10-03T12:07:37Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    production = (await import("@ws-model-proxy/db")).default;
    router = (await import("./forwarder-cli-devices")).cliDeviceProcedures;
    fixtures = createFixturePrismaClient(databaseUrl!);
    const suffix = crypto.randomUUID();
    const owner = await fixtures.user.create({
      data: {
        name: "Node metrics probe",
        email: `node-metrics-${suffix}@example.test`,
        slug: `nm-${suffix}`,
      },
    });
    ownerId = owner.id;
    deviceId = (await fixtures.cliDevice.create({ data: { userId: ownerId, slug: "metrics" } })).id;
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (!fixtures) return;
    // Telemetry has no FKs: explicitly remove only this probe's unique owner.
    if (ownerId) {
      await fixtures.nodeMetricsMinute.deleteMany({ where: { ownerUserId: ownerId } });
      await fixtures.user.deleteMany({ where: { id: ownerId } });
    }
    await fixtures.$disconnect();
    await production?.$disconnect();
  });

  function client() {
    return createRouterClient(router, {
      context: {
        session: {
          user: { id: ownerId },
          session: {
            id: crypto.randomUUID(),
            userId: ownerId,
            token: crypto.randomUUID(),
            expiresAt: new Date("2027-01-01"),
            createdAt: now,
            updatedAt: now,
          },
        } as unknown as Session,
      } as Context,
    });
  }

  it("bounds result buckets and checks actual indexed predicates; sums counts, weights means and excludes other nodes and exact-window edges", async () => {
    const week = overviewWindow("7d", now);
    const day = overviewWindow("24h", now);
    const hour = overviewWindow("1h", now);
    // Insert backwards to prove output ordering is independent of insertion order.
    const points = [
      new Date("2026-10-03T12:06:00Z"),
      new Date("2026-10-03T12:05:00Z"),
      new Date("2026-10-01T04:02:00Z"),
      week.start,
      new Date(week.start.getTime() - 60000),
      week.end,
    ];
    await fixtures.nodeMetricsMinute.createMany({
      data: points.map((bucketStart, index) => ({
        ownerUserId: ownerId,
        cliDeviceId: deviceId,
        bucketStart,
        samples: index === 0 ? 3 : 1,
        cpuSamples: index === 0 ? 3 : 1,
        minCpuPercent: index === 0 ? 30 : 10,
        sumCpuPercent: index === 0 ? 90 : 10,
        maxCpuPercent: index === 0 ? 30 : 10,
        memorySamples: index === 0 ? 3 : 1,
        minMemoryAvailableMiB: 1000,
        sumMemoryAvailableMiB: index === 0 ? 9000 : 1000,
        maxMemoryAvailableMiB: 3000,
      })),
    });
    await fixtures.nodeMetricsMinute.create({
      data: {
        ownerUserId: ownerId,
        cliDeviceId: `${deviceId}-other`,
        bucketStart: points[0]!,
        samples: 999,
        cpuSamples: 999,
        sumCpuPercent: 99900,
      },
    });
    // Make global history large enough that an index plan is meaningful.
    // Tiny, recently vacuumed tables legitimately choose a sequential scan.
    await fixtures.nodeMetricsMinute.createMany({
      data: Array.from({ length: 20000 }, (_, index) => ({
        ownerUserId: ownerId,
        cliDeviceId: `${deviceId}-unrelated-history`,
        bucketStart: new Date(week.start.getTime() + index * 60000),
        samples: 1,
      })),
    });
    // Only fake Date; leave timers and database I/O running normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const queries: Array<{ text: string; values: unknown[]; count: number }> = [];
    const original = production.$queryRaw.bind(production);
    const spy = vi.spyOn(production, "$queryRaw").mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (Array.isArray(args[0]) && Array.isArray(rows)) {
        const strings = args[0] as unknown as TemplateStringsArray;
        queries.push({
          text: strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""),
          values: args.slice(1),
          count: rows.length,
        });
      }
      return rows;
    });
    const result = await client().getCliDeviceMetrics({ cliDeviceId: deviceId });
    spy.mockRestore();
    vi.useRealTimers();
    expect(queries.map((q) => q.count).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.minuteHistory.map((p) => p.start)).toEqual([
      points[1]!.toISOString(),
      points[0]!.toISOString(),
    ]);
    expect(result.history24h).toHaveLength(day.bucketCount);
    expect(result.history7d).toHaveLength(week.bucketCount);
    expect(result.history24h.filter((p) => !p.gap)).toEqual([
      expect.objectContaining({
        samples: 4,
        minCpuPercent: 10,
        avgCpuPercent: 25,
        maxCpuPercent: 30,
        avgMemoryAvailableMiB: 2500,
      }),
    ]);
    expect(result.history7d.reduce((sum, p) => sum + p.samples, 0)).toBe(6);
    expect(result.history7d[0]).toMatchObject({
      start: week.start.toISOString(),
      samples: 1,
      gap: false,
    });
    expect(
      result.minuteHistory.every(
        (p) => new Date(p.start) >= hour.start && new Date(p.start) < hour.end,
      ),
    ).toBe(true);
    for (const query of queries) {
      const plan = await production.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
        ...query.values,
      );
      // Require an actual telemetry index condition bounding both time edges.
      // Device identity may be a post-index filter on an owner/time path.
      const nodes = planNodes(plan);
      const scans = nodes.filter(
        (node) =>
          ["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(
            String(node["Node Type"]),
          ) && String(node["Index Name"]).startsWith("node_metrics_minute_"),
      );
      expect(scans.length).toBeGreaterThan(0);
      expect(
        scans.some((scan) => {
          const condition = String(scan["Index Cond"]);
          return (
            condition.includes("bucketStart") &&
            condition.includes(">=") &&
            condition.includes("<") &&
            (condition.includes("ownerUserId") || condition.includes("cliDeviceId"))
          );
        }),
      ).toBe(true);
      const relations = nodes.filter((node) => node["Relation Name"] === "node_metrics_minute");
      expect(relations.length).toBeGreaterThan(0);
      const predicates = JSON.stringify(
        nodes.map((node) => [node["Index Cond"], node.Filter, node["Recheck Cond"]]),
      );
      expect(predicates).toContain("cliDeviceId");
      expect(predicates).toContain("ownerUserId");
      for (const relation of relations) {
        expect(typeof relation["Actual Rows"]).toBe("number");
        expect(typeof relation["Actual Loops"]).toBe("number");
      }
      console.info("node-history-query-plan", JSON.stringify(plan));
      console.info(
        "node-history-scan-work",
        relations.map((node) => ({
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
          filteredRows: node["Rows Removed by Filter"] ?? 0,
          indexCondition: node["Index Cond"],
          filter: node.Filter,
        })),
      );
    }
  });

  it("returns only 324 SQL buckets for a dense seven-day history and records fresh query timings", async () => {
    const week = overviewWindow("7d", now);
    await fixtures.nodeMetricsMinute.createMany({
      skipDuplicates: true,
      data: Array.from({ length: 10080 }, (_, index) => ({
        ownerUserId: ownerId,
        cliDeviceId: deviceId,
        bucketStart: new Date(week.start.getTime() + (10079 - index) * 60000),
        samples: 1,
        cpuSamples: 1,
        minCpuPercent: 10,
        sumCpuPercent: 10,
        maxCpuPercent: 10,
      })),
    });
    expect(
      await fixtures.nodeMetricsMinute.count({
        where: {
          ownerUserId: ownerId,
          cliDeviceId: deviceId,
          bucketStart: { gte: week.start, lt: week.end },
        },
      }),
    ).toBe(10080);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const counts: number[] = [];
    const original = production.$queryRaw.bind(production);
    const spy = vi.spyOn(production, "$queryRaw").mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (Array.isArray(rows)) counts.push(rows.length);
      return rows;
    });
    const timings: number[] = [];
    try {
      for (let run = 0; run < 10; run++) {
        const started = performance.now();
        const result = await client().getCliDeviceMetrics({ cliDeviceId: deviceId });
        timings.push(performance.now() - started);
        expect(result.minuteHistory).toHaveLength(60);
        expect(result.history24h).toHaveLength(96);
        expect(result.history7d).toHaveLength(168);
        expect(result.history7d.reduce((sum, point) => sum + point.samples, 0)).toBe(10082);
      }
      expect(counts).toHaveLength(30);
      for (let index = 0; index < counts.length; index += 3)
        expect(counts.slice(index, index + 3).sort((a, b) => a - b)).toEqual([60, 96, 168]);
      console.info("node-history-dense-probe", {
        sourceRows: 10080,
        resultRows: 324,
        runs: timings.length,
        maxMs: Math.max(...timings),
      });
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("persists special GPU keys through the real budget mutation and Prisma JSON roundtrip", async () => {
    const keys = ["__proto__", "constructor", "toString", "GPU-aaa", "index:4", "toJSON"];
    await fixtures.cliDevice.update({
      where: { id: deviceId },
      data: {
        nodeInfo: {
          nodeKind: "discrete",
          memoryTotalMiB: 32768,
          gpus: keys.map((key, index) => ({
            index,
            ...(key.startsWith("index:") ? {} : { uuid: key }),
            vramTotalMiB: 8192,
          })),
        },
      },
    });
    const overrides = Object.fromEntries(keys.map((key) => [key, 6.25]));
    const result = await client().setCliDeviceUsableBudgets({
      cliDeviceId: deviceId,
      usableVramGb: overrides,
    });
    const row = await fixtures.cliDevice.findUniqueOrThrow({ where: { id: deviceId } });
    expect(row.usableVramGb).toEqual(overrides);
    for (const key of keys) expect(Object.hasOwn(row.usableVramGb!, key)).toBe(true);
    expect(result.node.gpus.map((gpu) => [gpu.usableVramGb, gpu.usableVramGbDefault])).toEqual(
      keys.map(() => [6.25, false]),
    );
    await expect(
      client().setCliDeviceUsableBudgets({
        cliDeviceId: deviceId,
        usableVramGb: Object.fromEntries([["__proto__", 8.01]]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { fields: ["usableVramGb.__proto__"] } });
    expect(
      (await fixtures.cliDevice.findUniqueOrThrow({ where: { id: deviceId } })).usableVramGb,
    ).toEqual(overrides);
    const restored = await client().setCliDeviceUsableBudgets({
      cliDeviceId: deviceId,
      usableVramGb: null,
    });
    expect(
      (await fixtures.cliDevice.findUniqueOrThrow({ where: { id: deviceId } })).usableVramGb,
    ).toBeNull();
    expect(restored.node.gpus.map((gpu) => [gpu.usableVramGb, gpu.usableVramGbDefault])).toEqual(
      keys.map(() => [7.5, true]),
    );
  });

  it("fills empty ranges with gaps without fabricating minute samples", async () => {
    await fixtures.nodeMetricsMinute.deleteMany({ where: { ownerUserId: ownerId } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const result = await client().getCliDeviceMetrics({ cliDeviceId: deviceId });
    vi.useRealTimers();
    expect(result.minuteHistory).toEqual([]);
    expect(result.history24h).toHaveLength(96);
    expect(result.history7d).toHaveLength(168);
    expect(
      [...result.history24h, ...result.history7d].every(
        (p) => p.gap && p.samples === 0 && p.avgCpuPercent === null,
      ),
    ).toBe(true);
  });
});
