import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The queued command steps of the retention sweep on real PostgreSQL with the schema hardening
// (shape CHECK, decided-once trigger): QUEUED rows past their expiry are stored EXPIRED, rows
// decided over 7 days ago are deleted, and nothing else is touched. Rows are removed afterwards,
// scoped to this run's user.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Modules = {
  retention: typeof import("./usage-retention.js");
  fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  prisma: typeof import("@ws-model-proxy/db")["default"];
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

integration("queued node command retention (PostgreSQL)", () => {
  let m: Modules;
  const suffix = randomUUID().slice(0, 8);
  const userId = `qr-${suffix}`;
  const nodeId = `qrnode${suffix}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    m = {
      retention: await import("./usage-retention.js"),
      fixture: createFixturePrismaClient(databaseUrl ?? ""),
      prisma: (await import("@ws-model-proxy/db")).default,
    };
    const db = m.fixture;
    await db.user.create({ data: { id: userId, name: "Queued", email: `${userId}@example.test` } });
    await db.node.create({
      data: { id: nodeId, userId, slug: `qr-${suffix}`, connection: "ONLINE", trust: "FULL" },
    });
  });

  afterAll(async () => {
    if (!m) return;
    const db = m.fixture;
    try {
      // Every delete scoped to this run (WHERE); the node's queued commands cascade with it.
      await db.queuedNodeCommand.deleteMany({ where: { userId } });
      await db.node.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
      await m.prisma.$disconnect();
    }
  });

  async function dbNow(): Promise<Date> {
    const [row] = await m.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    if (!row) throw new Error("no clock");
    return row.now;
  }

  async function seed(
    id: string,
    createdAt: Date,
    expiresAt: Date,
    decided?: { state: "RUN" | "DISMISSED" | "EXPIRED" | "WITHDRAWN"; at: Date },
  ) {
    await m.fixture.queuedNodeCommand.create({
      data: {
        id,
        userId,
        nodeId,
        agentTokenId: "tok",
        command: "sudo true",
        createdAt,
        expiresAt,
        ...(decided
          ? {
              state: decided.state,
              decidedAt: decided.at,
              decidedBy: decided.state === "EXPIRED" ? null : userId,
            }
          : {}),
      },
    });
  }

  it("expires overdue QUEUED rows and deletes rows decided over 7 days ago", async () => {
    const now = await dbNow();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const later = (ms: number) => new Date(now.getTime() + ms);
    await seed(`${suffix}-overdue`, ago(2 * HOUR_MS), ago(HOUR_MS));
    await seed(`${suffix}-waiting`, ago(HOUR_MS), later(HOUR_MS));
    await seed(`${suffix}-old-run`, ago(10 * DAY_MS), ago(9 * DAY_MS), {
      state: "RUN",
      at: ago(8 * DAY_MS),
    });
    await seed(`${suffix}-old-withdrawn`, ago(10 * DAY_MS), ago(9 * DAY_MS), {
      state: "WITHDRAWN",
      at: ago(8 * DAY_MS),
    });
    await seed(`${suffix}-old-expired`, ago(10 * DAY_MS), ago(9 * DAY_MS), {
      state: "EXPIRED",
      at: ago(8 * DAY_MS),
    });
    await seed(`${suffix}-recent-dismissed`, ago(3 * DAY_MS), ago(2 * DAY_MS), {
      state: "DISMISSED",
      at: ago(2 * DAY_MS),
    });
    // A QUEUED row is never deleted, however old (it is expired first, then kept 7 days).
    await seed(`${suffix}-old-queued`, ago(9 * DAY_MS), ago(8 * DAY_MS));

    const expired = await m.retention.expireOverdueQueuedNodeCommands({ now, batch: 1 });
    expect(expired).toBeGreaterThanOrEqual(2);
    const deleted = await m.retention.deleteDecidedQueuedNodeCommands({ now, batch: 1 });
    expect(deleted).toBeGreaterThanOrEqual(3);

    const rows = await m.prisma.queuedNodeCommand.findMany({
      where: { userId },
      select: { id: true, state: true, decidedAt: true, decidedBy: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    const byId = new Map(rows.map((row) => [row.id.slice(suffix.length + 1), row]));
    expect([...byId.keys()].sort()).toEqual([
      "old-queued",
      "overdue",
      "recent-dismissed",
      "waiting",
    ]);
    for (const key of ["overdue", "old-queued"]) {
      expect(byId.get(key)).toMatchObject({ state: "EXPIRED", decidedAt: now, decidedBy: null });
      expect(byId.get(key)?.updatedAt).toEqual(now);
    }
    expect(byId.get("waiting")).toMatchObject({ state: "QUEUED", decidedAt: null });
    expect(byId.get("recent-dismissed")).toMatchObject({ state: "DISMISSED" });

    // Rows the sweep just expired are kept their 7 days: a second run deletes nothing of ours.
    await m.retention.deleteDecidedQueuedNodeCommands({ now, batch: 10 });
    expect(await m.prisma.queuedNodeCommand.count({ where: { userId } })).toBe(4);
    // And expiring again changes nothing: decided rows are left alone.
    await m.retention.expireOverdueQueuedNodeCommands({ now: later(DAY_MS), batch: 10 });
    expect(
      await m.prisma.queuedNodeCommand.findUniqueOrThrow({
        where: { id: `${suffix}-recent-dismissed` },
        select: { state: true },
      }),
    ).toEqual({ state: "DISMISSED" });
  });
});
