import { createRouterClient, ORPCError } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLERS, contextFor } from "../routers/lane-c-test-helpers";
import { retryAnswers } from "./retry-answers";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

integration("sidecar chains on PostgreSQL", () => {
  const run = `sidecar-${crypto.randomUUID()}`;
  const owners = [`${run}-a`, `${run}-b`];
  let modules:
    | {
        fixtures: ReturnType<
          typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
        >;
        prisma: typeof import("@ws-model-proxy/db").default;
        lockOrder: typeof import("@ws-model-proxy/db/capacity-lock-order");
        pools: typeof import("../routers/pools").poolsRouter;
      }
    | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    const [fixtures, db, lockOrder, pools] = await Promise.all([
      import("@ws-model-proxy/db/test-fixture-client"),
      import("@ws-model-proxy/db"),
      import("@ws-model-proxy/db/capacity-lock-order"),
      import("../routers/pools"),
    ]);
    modules = {
      fixtures: fixtures.createFixturePrismaClient(databaseUrl),
      prisma: db.default,
      lockOrder,
      pools: pools.poolsRouter,
    };
    await modules.fixtures.user.createMany({
      data: owners.map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    });
  });

  afterAll(async () => {
    if (!modules) return;
    try {
      await modules.fixtures.pool.deleteMany({ where: { userId: { in: owners } } });
      await modules.fixtures.auditEvent.deleteMany({ where: { userId: { in: owners } } });
      await modules.fixtures.user.deleteMany({ where: { id: { in: owners } } });
    } finally {
      await modules.fixtures.$disconnect();
      await modules.prisma.$disconnect();
    }
  });

  it("concurrent A→B and B→C edits share B's owner fence and cannot commit a chain", async () => {
    if (!modules) throw new Error("modules unavailable");
    const { fixtures, prisma, lockOrder, pools } = modules;
    const ownerA = owners[0] ?? "";
    const ownerB = owners[1] ?? "";
    const [a, b, c] = await Promise.all(
      [ownerA, ownerB, ownerB].map((userId, index) =>
        fixtures.pool.create({
          data: { userId, slug: `pool-${index}`, name: `Pool ${index}`, modelType: "LLM" },
        }),
      ),
    );
    if (!a || !b || !c) throw new Error("pools unavailable");
    await fixtures.share.create({
      data: { poolId: b.id, ownerUserId: ownerB, granteeUserId: ownerA, canUse: true },
    });
    const as = (userId: string) =>
      createRouterClient(pools, {
        context: contextFor(CALLERS.person(userId)),
        interceptors: [retryAnswers],
      });

    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    // Only the blocker is a test transaction. Both router writes use the ordinary client,
    // actual PostgreSQL locks, and the graph-write enforcement triggers.
    const blocker = prisma
      .$transaction(
        async (tx) => {
          await lockOrder.acquireFences(tx, [lockOrder.fences.owner(ownerB)]);
          const [backend] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("blocker backend unavailable");
          held.resolve(backend.pid);
          await release.promise;
        },
        { maxWait: 30_000, timeout: 30_000 },
      )
      .catch((error: unknown) => {
        held.reject(error);
        throw error;
      });

    let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blockerPid = await held.promise;
      outcomes = Promise.allSettled([
        as(ownerA).update({ poolId: a.id, sidecars: [{ input: "IMAGE", targetPoolId: b.id }] }),
        as(ownerB).update({ poolId: b.id, sidecars: [{ input: "IMAGE", targetPoolId: c.id }] }),
      ]);
      // Observe two real waiters for this exact advisory lock, rather than sleeping and
      // assuming the requests reached it. Without the target-owner fence, A→B never waits.
      await expect
        .poll(
          async () => {
            const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int AS count
              FROM pg_locks waiting
              JOIN pg_locks held
                ON held.locktype = waiting.locktype
                AND held.database = waiting.database
                AND held.classid = waiting.classid
                AND held.objid = waiting.objid
                AND held.objsubid = waiting.objsubid
              WHERE held.pid = ${blockerPid} AND held.granted
                AND waiting.locktype = 'advisory' AND NOT waiting.granted
            `;
            return row?.count ?? 0;
          },
          { timeout: 10_000, interval: 25 },
        )
        .toBe(2);
      expect(await prisma.poolSidecar.count({ where: { poolId: { in: [a.id, b.id] } } })).toBe(0);
    } finally {
      release.resolve();
      // Settle both writers even when the lock assertion fails, before fixture teardown.
      await Promise.all([blocker, outcomes]);
    }

    const results = await outcomes;
    expect(results?.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results?.find((result) => result.status === "rejected");
    if (loser?.status !== "rejected") throw new Error("one sidecar edit must be refused");
    expect(loser.reason).toBeInstanceOf(ORPCError);
    expect(loser.reason).toMatchObject({ data: { reason: "sidecar_chain" } });
    const edges = await prisma.poolSidecar.findMany({
      where: { poolId: { in: [a.id, b.id] }, input: "IMAGE" },
      select: { poolId: true, targetPoolId: true },
    });
    expect(edges).toHaveLength(1);
    expect([
      { poolId: a.id, targetPoolId: b.id },
      { poolId: b.id, targetPoolId: c.id },
    ]).toContainEqual(edges[0]);
  });
});
