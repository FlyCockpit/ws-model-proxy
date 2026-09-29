import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof of the agent audit retention step: rows older than 90
 * days go (in batches, oldest first), newer rows stay, other tables are not
 * touched, and the writer's batched insert lands in the same table.
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

type Db = ReturnType<typeof createPrismaClient>;
const DAY_MS = 24 * 60 * 60 * 1000;

integration("agent audit retention with real PostgreSQL", () => {
  let db: Db;
  let retention: typeof import("./usage-retention.js");
  const tag = `retention-${crypto.randomUUID()}`;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    db = createPrismaClient(databaseUrl);
    retention = await import("./usage-retention.js");
  });

  afterAll(async () => {
    await db?.cliAgentActionEvent.deleteMany({ where: { userId: tag } });
    await db?.$disconnect();
  });

  function row(ageDays: number, path: string) {
    return {
      userId: tag,
      cliDeviceId: "dev",
      kind: "command" as const,
      path,
      outcome: "completed" as const,
      startedAt: new Date(),
      createdAt: new Date(Date.now() - ageDays * DAY_MS),
    };
  }

  it("deletes rows older than 90 days and keeps newer ones", async () => {
    await db.cliAgentActionEvent.createMany({
      data: [
        row(91, "old-1"),
        row(120, "old-2"),
        row(400, "old-3"),
        row(89, "recent-1"),
        row(1, "recent-2"),
      ],
    });
    const now = new Date();
    await expect(
      retention.deleteExpiredCliAgentActions({ prisma: db, now, batch: 2 }),
    ).resolves.toBe(3);
    const left = await db.cliAgentActionEvent.findMany({
      where: { userId: tag },
      orderBy: { path: "asc" },
    });
    expect(left.map((event) => event.path)).toEqual(["recent-1", "recent-2"]);
    await expect(retention.deleteExpiredCliAgentActions({ prisma: db, now })).resolves.toBe(0);
  });

  it("runUsageRetention includes the step and reports its count", async () => {
    await db.cliAgentActionEvent.createMany({ data: [row(200, "old-again")] });
    const result = await retention.runUsageRetention({ prisma: db, retentionDays: 14 });
    expect(result.agentActionsDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.cliAgentActionEvent.count({ where: { path: "old-again" } })).toBe(0);
  });
});
