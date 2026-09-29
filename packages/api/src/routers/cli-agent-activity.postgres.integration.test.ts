import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";

/**
 * The agent audit log on real PostgreSQL: column defaults, owner-scoped
 * keyset listing that is stable under inserts, and the whole-user delete
 * (rows of that user go, another user's stay; a device delete keeps rows).
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("cli agent action events with real PostgreSQL", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  // Graph rows (user, device) are written through the fixture client, which the
  // graph-write fence triggers accept; the code under test uses `prisma`.
  let fixture: ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client").createFixturePrismaClient
  >;
  let router: typeof import("./cli-agent-activity").cliAgentActivityRouter;
  let deletion: typeof import("@ws-model-proxy/db/parent-deletion");
  let sweeps: typeof import("@ws-model-proxy/db/hot-path-sweeps");
  const users: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, routerModule, deletionModule, sweepsModule] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./cli-agent-activity"),
      import("@ws-model-proxy/db/parent-deletion"),
      import("@ws-model-proxy/db/hot-path-sweeps"),
    ]);
    prisma = db.default;
    fixture = (await import("@ws-model-proxy/db/test-fixture-client")).createFixturePrismaClient(
      databaseUrl,
    );
    router = routerModule.cliAgentActivityRouter;
    deletion = deletionModule;
    sweeps = sweepsModule;
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of users) {
      await prisma.cliAgentActionEvent.deleteMany({ where: { userId: id } });
      await fixture.user.deleteMany({ where: { id } });
    }
    await fixture.$disconnect();
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    const row = await fixture.user.create({
      data: {
        name: `Audit ${label}`,
        email: `audit-${label}-${suffix}@example.test`,
        slug: `audit-${label}-${suffix}`,
      },
    });
    users.push(row.id);
    return row;
  }

  function client(owner: { id: string }) {
    const session = {
      user: owner,
      session: {
        id: `session-${crypto.randomUUID()}`,
        userId: owner.id,
        token: `token-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as unknown as Session;
    return createRouterClient(router, { context: { session } as Context });
  }

  const base = {
    kind: "command" as const,
    path: "hmac-sha256:abc pwd",
    outcome: "completed" as const,
    startedAt: new Date(),
  };

  it("fills the column defaults and keeps every optional column null", async () => {
    const owner = await user("defaults");
    const row = await prisma.cliAgentActionEvent.create({
      data: { userId: owner.id, cliDeviceId: "dev", ...base },
    });
    expect(row.id).toMatch(/^[a-z0-9]{20,}$/);
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(row).toMatchObject({
      mcpTokenId: null,
      etagBefore: null,
      etagAfter: null,
      bytes: null,
      reason: null,
      finishedAt: null,
    });
  });

  it("has no foreign keys and the documented indexes", async () => {
    const fks = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_constraint
       WHERE conrelid = 'cli_agent_action_event'::regclass AND contype = 'f'`;
    expect(Number(fks[0]?.n)).toBe(0);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'cli_agent_action_event'`;
    const defs = indexes.map((row) => row.indexdef).join("\n");
    expect(defs).toContain('("userId", "createdAt")');
    expect(defs).toContain('("cliDeviceId", "createdAt")');
    expect(defs).toContain('("createdAt")');
  });

  it("lists only the caller's rows, filters by device, and pages stably under inserts", async () => {
    const owner = await user("list");
    const other = await user("other");
    const t0 = Date.UTC(2026, 0, 1);
    // Two rows share one createdAt: the id breaks the tie.
    const stamps = [0, 1, 1, 2, 3, 4];
    for (const [index, second] of stamps.entries())
      await prisma.cliAgentActionEvent.create({
        data: {
          userId: owner.id,
          cliDeviceId: index % 2 === 0 ? "dev-a" : "dev-b",
          ...base,
          createdAt: new Date(t0 + second * 1000),
        },
      });
    await prisma.cliAgentActionEvent.create({
      data: { userId: other.id, cliDeviceId: "dev-a", ...base },
    });

    const mine = client(owner);
    const seen: string[] = [];
    let cursor: string | undefined;
    let inserted = false;
    for (;;) {
      const page = await mine.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.events.map((event) => event.id));
      if (!inserted) {
        // A newer row arrives between pages: it must not shift or repeat the rest.
        await prisma.cliAgentActionEvent.create({
          data: {
            userId: owner.id,
            cliDeviceId: "dev-a",
            ...base,
            createdAt: new Date(t0 + 99_000),
          },
        });
        inserted = true;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const all = await mine.list({ limit: 100 });
    expect(all.events.every((event) => event.cliDeviceId.startsWith("dev-"))).toBe(true);
    expect(all.events).toHaveLength(7);

    const onlyA = await mine.list({ cliDeviceId: "dev-a", limit: 100 });
    expect(onlyA.events.every((event) => event.cliDeviceId === "dev-a")).toBe(true);
    // Another user's device id (or one that has rows only for someone else) returns nothing.
    const none = await client(await user("stranger")).list({ cliDeviceId: "dev-a" });
    expect(none.events).toEqual([]);
  });

  it("a whole-user delete removes that user's rows only, in batches, with no FK error", async () => {
    const doomed = await user("doomed");
    const kept = await user("kept");
    for (let i = 0; i < 7; i += 1) {
      await prisma.cliAgentActionEvent.create({
        data: { userId: doomed.id, cliDeviceId: "dev", ...base },
      });
    }
    await prisma.cliAgentActionEvent.create({
      data: { userId: kept.id, cliDeviceId: "dev", ...base },
    });
    await expect(deletion.deleteUserDurably(prisma, doomed.id, { batch: 3 })).resolves.toBe(
      "deleted",
    );
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(0);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: kept.id } })).toBe(1);
  });

  it("purges a row written after the user delete, and a row the drain skipped while locked", async () => {
    const doomed = await user("late");
    // A row another transaction holds when the drain runs is skipped (SKIP LOCKED).
    const locked = await prisma.cliAgentActionEvent.create({
      data: { userId: doomed.id, cliDeviceId: "dev", ...base },
    });
    const holder = new Promise<void>((resolve, reject) => {
      prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM cli_agent_action_event WHERE id = ${locked.id} FOR UPDATE`;
            await deletion.deleteUserDurably(prisma, doomed.id, { batch: 3 });
            resolve();
            await new Promise((done) => setTimeout(done, 300));
          },
          { timeout: 20_000 },
        )
        .catch(reject);
    });
    await holder;
    // The user is gone, but the skipped row survives the drain.
    expect(await prisma.user.count({ where: { id: doomed.id } })).toBe(0);
    // A late event (queued write, other replica) lands after the delete.
    await prisma.cliAgentActionEvent.create({
      data: { userId: doomed.id, cliDeviceId: "dev", ...base },
    });
    await new Promise((done) => setTimeout(done, 500));
    const purged = await sweeps.purgeDeletedUserHistory(prisma, doomed.id, { batch: 3 });
    expect(purged.remaining).toBe(false);
    expect(await prisma.cliAgentActionEvent.count({ where: { userId: doomed.id } })).toBe(0);
  }, 60_000);

  it("keeps the rows when a device is deleted (owner history until retention)", async () => {
    const owner = await user("device");
    const device = await fixture.cliDevice.create({
      data: { userId: owner.id, slug: `dev-${crypto.randomUUID().slice(0, 8)}` },
    });
    await prisma.cliAgentActionEvent.create({
      data: { userId: owner.id, cliDeviceId: device.id, ...base },
    });
    await fixture.cliDevice.delete({ where: { id: device.id } });
    expect(await prisma.cliAgentActionEvent.count({ where: { cliDeviceId: device.id } })).toBe(1);
  });
});
