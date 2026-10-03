import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required");
const integration = databaseUrl ? describe : describe.skip;

integration("node metrics failure settlement with real PostgreSQL", () => {
  let db: ReturnType<typeof createFixturePrismaClient>;
  let metrics: typeof import("./node-metrics-rollup.js");
  const ownerId = `metrics-write-${crypto.randomUUID()}`;
  const now = new Date("2026-10-03T12:00:20Z");
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    db = createFixturePrismaClient(databaseUrl!);
    metrics = await import("./node-metrics-rollup.js");
  }, 120_000);
  afterAll(async () => {
    if (!db) return;
    await db.nodeMetricsMinute.deleteMany({ where: { ownerUserId: ownerId } });
    await db.$disconnect();
    const { default: production } = await import("@ws-model-proxy/db");
    await production.$disconnect();
  });
  const sample = (cliDeviceId: string) => ({
    ownerUserId: ownerId,
    cliDeviceId,
    receivedAt: now,
    cpuPercent: 20,
    memoryAvailableMiB: 1000,
    memoryTotalMiB: 2000,
  });

  it("routes a real int4 rejection, writes only successful siblings once, and restores normal writes", async () => {
    const good = metrics.mergeNodeMetricsIncrements(undefined, sample("a-good"));
    const bad = {
      ...metrics.mergeNodeMetricsIncrements(undefined, sample("b-bad")),
      samples: 2147483648,
    };
    await expect(metrics.writeNodeMetricsIncrements([bad, good], db)).rejects.toMatchObject({
      written: 1,
      failed: 1,
    });
    expect(await db.nodeMetricsMinute.findMany({ where: { ownerUserId: ownerId } })).toEqual([
      expect.objectContaining({ cliDeviceId: "a-good", samples: 1, sumCpuPercent: 20 }),
    ]);
    // Recovery writes new increments only. Replaying a partially committed
    // batch would double a-good: this is deliberately not a retry contract.
    await expect(
      metrics.writeNodeMetricsIncrements(
        [metrics.mergeNodeMetricsIncrements(undefined, sample("b-bad"))],
        db,
      ),
    ).resolves.toBe(1);
    expect(
      (
        await db.nodeMetricsMinute.findMany({
          where: { ownerUserId: ownerId },
          orderBy: { cliDeviceId: "asc" },
        })
      ).map((r) => r.samples),
    ).toEqual([1, 1]);
  });

  it("never duplicates real additive rows after the commit acknowledgement is lost", async () => {
    let calls = 0;
    await expect(
      metrics.writeNodeMetricsIncrements(
        [metrics.mergeNodeMetricsIncrements(undefined, sample("ack-lost"))],
        {
          $executeRaw: async (query) => {
            calls++;
            await db.$executeRaw(query);
            throw new Error("injected connection acknowledgement loss");
          },
        },
      ),
    ).rejects.toMatchObject({ written: 0, failed: 1, uncertain: 1 });
    expect(calls).toBe(1);
    expect(
      await db.nodeMetricsMinute.findFirst({
        where: { ownerUserId: ownerId, cliDeviceId: "ack-lost" },
      }),
    ).toMatchObject({ samples: 1 });
  });

  it("logs only operational failure counts, recovers, and shutdown joins the actual write", async () => {
    const log = vi.fn();
    let failing = true;
    let release: (() => void) | undefined;
    const writer = metrics.createNodeMetricsRollupWriter({
      clock: () => now.getTime(),
      log,
      write: async (increments) => {
        if (failing)
          return metrics.writeNodeMetricsIncrements(
            increments.map((i) => ({ ...i, samples: 2147483648 })),
            db,
          );
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return metrics.writeNodeMetricsIncrements(increments, db);
      },
    });
    try {
      writer.observe(sample("writer"));
      await writer.flushNow();
      expect(log).toHaveBeenCalledWith({ written: 0, failed: 1 });
      expect(
        await db.nodeMetricsMinute.count({
          where: { ownerUserId: ownerId, cliDeviceId: "writer" },
        }),
      ).toBe(0);
      failing = false;
      writer.observe(sample("writer"));
      const flushing = writer.flushNow();
      await Promise.resolve();
      let stopped = false;
      const stop = writer.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release?.();
      await flushing;
      await stop;
      expect(stopped).toBe(true);
      expect(
        await db.nodeMetricsMinute.findFirst({
          where: { ownerUserId: ownerId, cliDeviceId: "writer" },
        }),
      ).toMatchObject({ samples: 1 });
      writer.observe(sample("writer-late"));
      await writer.flushNow();
      expect(
        await db.nodeMetricsMinute.count({
          where: { ownerUserId: ownerId, cliDeviceId: "writer-late" },
        }),
      ).toBe(0);
    } finally {
      await writer.stop();
    }
  });
});
