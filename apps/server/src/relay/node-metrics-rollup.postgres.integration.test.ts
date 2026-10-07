import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The node_metrics_minute upsert on real PostgreSQL: two flushes into one node-minute merge
// the gauges, the free accelerator minimum and the custom aggregates per name (the 16-name cap
// keeps the names stored first). Rows are removed afterwards, scoped to this run's owner.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  rollup: typeof import("./node-metrics-rollup.js");
  prisma: typeof import("@ws-model-proxy/db")["default"];
};

integration("node metrics rollup upsert (PostgreSQL)", () => {
  let m: Modules;
  const ownerUserId = `nm-${randomUUID().slice(0, 8)}`;
  const at = new Date("2026-10-01T10:00:05.000Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    m = {
      rollup: await import("./node-metrics-rollup.js"),
      prisma: (await import("@ws-model-proxy/db")).default,
    };
  });

  afterAll(async () => {
    await m?.prisma.nodeMetricsMinute.deleteMany({ where: { ownerUserId } });
  });

  it("merges free accelerator memory and custom aggregates across flushes", async () => {
    const { mergeNodeMetricsIncrements, writeNodeMetricsIncrements } = m.rollup;
    const sample = {
      ownerUserId,
      nodeId: "node-1",
      receivedAt: at,
      cpuPercent: 10,
    };
    const first = mergeNodeMetricsIncrements(undefined, {
      ...sample,
      acceleratorFreeMiB: 8_000,
      custom: [
        { name: "gpu_power", value: 100 },
        { name: "gpu_power", value: 200 },
        ...Array.from({ length: 15 }, (_, index) => ({ name: `a${index}`, value: index })),
      ],
    });
    expect(await writeNodeMetricsIncrements([first], m.prisma)).toBe(1);
    const second = mergeNodeMetricsIncrements(undefined, {
      ...sample,
      receivedAt: new Date(at.getTime() + 20_000),
      cpuPercent: 30,
      acceleratorFreeMiB: 3_000,
      custom: [
        { name: "gpu_power", value: 50 },
        { name: "zz_new", value: 1 },
      ],
    });
    expect(await writeNodeMetricsIncrements([second], m.prisma)).toBe(1);

    const row = await m.prisma.nodeMetricsMinute.findFirstOrThrow({
      where: { ownerUserId, nodeId: "node-1" },
    });
    expect(row.samples).toBe(2);
    expect(row.sumCpuPercent).toBe(40);
    expect(row.minAcceleratorFreeMiB).toBe(3_000);
    const custom = row.custom as Record<
      string,
      { min: number; sum: number; max: number; samples: number }
    >;
    expect(custom.gpu_power).toEqual({ min: 50, sum: 350, max: 200, samples: 3 });
    // 16 names stored by the first flush: the new name does not displace them.
    expect(Object.keys(custom)).toHaveLength(16);
    expect(custom.zz_new).toBeUndefined();
  });

  it("stores a row with no custom values as an empty object", async () => {
    const { mergeNodeMetricsIncrements, writeNodeMetricsIncrements } = m.rollup;
    const increment = mergeNodeMetricsIncrements(undefined, {
      ownerUserId,
      nodeId: "node-2",
      receivedAt: at,
      cpuPercent: 5,
    });
    await writeNodeMetricsIncrements([increment, { ...increment, nodeId: "node-3" }], m.prisma);
    await writeNodeMetricsIncrements([increment], m.prisma);
    const rows = await m.prisma.nodeMetricsMinute.findMany({
      where: { ownerUserId, nodeId: { in: ["node-2", "node-3"] } },
      orderBy: { nodeId: "asc" },
    });
    expect(rows.map((row) => [row.nodeId, row.samples, row.custom])).toEqual([
      ["node-2", 2, {}],
      ["node-3", 1, {}],
    ]);
    expect(rows[0]?.minAcceleratorFreeMiB).toBeNull();
  });
});
