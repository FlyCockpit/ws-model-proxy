import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

// DL-1 design (d) (#78) on real PostgreSQL: the structural claims the lock
// order rests on. The catalog (no foreign key between a hot-path table and
// the graph), the fence protocol (WMPF1/WMPF2), the graph-write fence
// triggers (WMPF4), parent deletes under owner fences, and the sweepers that
// handle what those deletes leave behind.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;
type Tx = Parameters<Parameters<Client["$transaction"]>[0]>[0];

function sessionFor(user: { id: string; email: string; name: string }): Context {
  return {
    session: {
      user: { ...user, emailVerified: true, role: "user" },
      session: {
        id: `session-${user.id}`,
        userId: user.id,
        token: `token-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "writer-classes-test",
      },
    } as Session,
  } as Context;
}

function sqlState(error: unknown): string | undefined {
  const text = String(error instanceof Error ? `${error.message} ${String(error.cause)}` : error);
  return /\b(WMPF[1-4]|40P01|55P03)\b/.exec(text)?.[1];
}

integration("DL-1 writer classes and fences on PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        order: typeof import("@ws-model-proxy/db/capacity-lock-order");
        deletion: typeof import("@ws-model-proxy/db/parent-deletion");
        sweeps: typeof import("@ws-model-proxy/db/hot-path-sweeps");
        forwarder: typeof import("../routers/forwarder-management");
        store: typeof import("../../../../apps/server/src/model-api/capacity/postgres-store.js");
      }
    | undefined;
  let fixtures: Client;
  let strict: Client;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    const [db, factory, fixtureFactory, order, deletion, sweeps, forwarder, store] =
      await Promise.all([
        import("@ws-model-proxy/db"),
        import("@ws-model-proxy/db/client-factory"),
        import("@ws-model-proxy/db/test-fixture-client"),
        import("@ws-model-proxy/db/capacity-lock-order"),
        import("@ws-model-proxy/db/parent-deletion"),
        import("@ws-model-proxy/db/hot-path-sweeps"),
        import("../routers/forwarder-management"),
        import("../../../../apps/server/src/model-api/capacity/postgres-store.js"),
      ]);
    modules = { prisma: db.default, order, deletion, sweeps, forwarder, store };
    fixtures = fixtureFactory.createFixturePrismaClient(databaseUrl);
    strict = factory.createPrismaClient(databaseUrl);
  });

  afterAll(async () => {
    await Promise.all([fixtures?.$disconnect(), strict?.$disconnect()]);
  });

  function required() {
    if (!modules) throw new Error("modules unavailable");
    return modules;
  }

  async function userFixture(label: string) {
    const suffix = crypto.randomUUID();
    const user = await fixtures.user.create({
      data: {
        name: `Writer ${label}`,
        email: `writer-${label}-${suffix}@example.test`,
        slug: `writer-${label}-${suffix}`,
        emailVerified: true,
      },
    });
    return { user, suffix };
  }

  async function localModel(userId: string, suffix: string, name: string) {
    const device = await fixtures.cliDevice.create({
      data: { userId, slug: `dev-${name}-${suffix}`.slice(0, 60) },
    });
    const endpoint = await fixtures.endpoint.create({
      data: {
        userId,
        cliDeviceId: device.id,
        slug: `ep-${name}-${suffix}`.slice(0, 60),
        label: name,
        status: "ONLINE",
      },
    });
    const model = await fixtures.discoveredModel.create({
      data: {
        userId,
        endpointId: endpoint.id,
        upstreamModelId: `up-${name}`,
        encodedModelId: `enc-${name}-${suffix}`,
      },
    });
    const target = await fixtures.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    if (!target.inferenceCapacityId) throw new Error("target without capacity");
    return { device, endpoint, model, target, capacityId: target.inferenceCapacityId };
  }

  /** Runs `work` in a strict (unbypassed) transaction and returns its outcome. */
  async function attempt(work: (tx: Tx) => Promise<unknown>) {
    try {
      await strict.$transaction(work);
      return "ok";
    } catch (error) {
      return sqlState(error) ?? String(error);
    }
  }

  describe("catalog", () => {
    it("has no foreign key between a hot-path table and a graph table, in either direction", async () => {
      const m = required();
      const rows = await strict.$queryRaw<Array<{ child: string; parent: string }>>`
        SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
          FROM pg_constraint WHERE contype = 'f'`;
      const hot = new Set<string>(m.order.HOT_PATH_TABLES);
      const unquote = (name: string) => name.replace(/^"|"$/g, "");
      const crossing = rows.filter(
        (row) => hot.has(unquote(row.child)) !== hot.has(unquote(row.parent)),
      );
      expect(crossing).toEqual([]);
      // The hot-path tables still exist and keep their internal keys.
      expect(
        rows.some((row) => row.child === "capacity_lease" && row.parent === "admission_request"),
      ).toBe(true);
    });

    it("guards every graph table with its fence triggers", async () => {
      const m = required();
      const rows = await strict.$queryRaw<Array<{ relation: string; name: string }>>`
        SELECT tgrelid::regclass::text AS relation, tgname AS name FROM pg_trigger
         WHERE tgname IN ('z_graph_write_fence', 'z_graph_update_fence')`;
      for (const table of m.order.GRAPH_TABLES) {
        const names = rows
          .filter((row) => row.relation.replace(/"/g, "") === table)
          .map((row) => row.name)
          .sort();
        expect(names, table).toEqual(
          table === "user"
            ? ["z_graph_write_fence"]
            : ["z_graph_update_fence", "z_graph_write_fence"],
        );
      }
    });
  });

  describe("fence protocol (acquireFences)", () => {
    it("refuses a fence after the transaction's first row lock or write (WMPF1)", async () => {
      const m = required();
      const { user } = await userFixture("wmpf1");
      expect(
        await attempt(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR KEY SHARE`;
          await m.order.fenceOwners(tx, [user.id]);
        }),
      ).toBe("WMPF1");
      expect(
        await attempt(async (tx) => {
          await tx.user.update({ where: { id: user.id }, data: { name: "renamed" } });
          await m.order.fenceOwners(tx, [user.id]);
        }),
      ).toBe("WMPF1");
      // Plain reads do not count.
      expect(
        await attempt(async (tx) => {
          await tx.user.findUnique({ where: { id: user.id } });
          await m.order.fenceOwners(tx, [user.id]);
        }),
      ).toBe("ok");
    });

    it("F2-05: a deferred closure or a caller-side lock cannot take a fence out of order", async () => {
      const m = required();
      const { user } = await userFixture("f2-05");
      // A closure defined before the lock and run after it.
      expect(
        await attempt(async (tx) => {
          const later = () => m.order.fenceOwners(tx, [user.id]);
          await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR UPDATE`;
          await later();
        }),
      ).toBe("WMPF1");
      // A lock the caller took before calling a helper that fences.
      expect(
        await attempt(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${user.id} FOR SHARE`;
          await m.order.fenceParentDelete(tx, { userId: user.id, poolIds: [] });
        }),
      ).toBe("WMPF1");
    });

    it("refuses a fence below one already held (WMPF2), skips a held one and records the set", async () => {
      const m = required();
      const { user } = await userFixture("wmpf2");
      expect(
        await attempt(async (tx) => {
          await m.order.acquireFences(tx, [m.order.fences.capacity("c-1")]);
          await m.order.acquireFences(tx, [m.order.fences.owner(user.id)]);
        }),
      ).toBe("WMPF2");
      // A malformed name (no level, or a comma that would forge the held set).
      for (const name of ["owner:x", "00:owner:a,00:owner:b"])
        expect(
          await attempt((tx) => tx.$queryRaw`SELECT wsmp_acquire_fences(ARRAY[${name}], true)`),
        ).toBe("WMPF3");
      let recorded = "";
      expect(
        await attempt(async (tx) => {
          await m.order.acquireFences(tx, [
            m.order.fences.capacity("c-2"),
            m.order.fences.owner(user.id),
          ]);
          // Re-requesting a held fence is a no-op, even below the last one.
          await m.order.fenceOwners(tx, [user.id]);
          const rows = await tx.$queryRaw<Array<{ held: string }>>`
            SELECT current_setting('wsmp.fences') AS held`;
          recorded = rows[0]?.held ?? "";
        }),
      ).toBe("ok");
      expect(recorded).toBe(`,00:owner:${user.id},08:capacity:c-2,`);
      // Transaction-local: gone after commit.
      const after = await strict.$queryRaw<Array<{ held: string | null }>>`
        SELECT current_setting('wsmp.fences', true) AS held`;
      expect(after[0]?.held ?? "").not.toContain(user.id);
    });

    it("with wait: false returns false at once on a busy fence, and holds nothing after commit", async () => {
      const m = required();
      const { user } = await userFixture("nowait");
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const holding = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holder = strict.$transaction(
        async (tx) => {
          await m.order.fenceOwners(tx, [user.id]);
          ready();
          await held;
        },
        { timeout: 20_000 },
      );
      await holding;
      const startedAt = Date.now();
      let acquired: boolean | undefined;
      await fixtures.$transaction(async (tx) => {
        acquired = await m.order.acquireFences(tx, [m.order.fences.owner(user.id)], {
          wait: false,
        });
      });
      expect(acquired).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      release();
      await holder;
      await fixtures.$transaction(async (tx) => {
        acquired = await m.order.acquireFences(tx, [m.order.fences.owner(user.id)], {
          wait: false,
        });
      });
      expect(acquired).toBe(true);
    });
  });

  describe("graph-write fence triggers", () => {
    it("require the owner fence for structural writes, not for status or display columns", async () => {
      const m = required();
      const { user, suffix } = await userFixture("owner-fence");
      const insert = (tx: Tx, slug: string) =>
        tx.modelPool.create({ data: { userId: user.id, slug, name: "Fence pool" } });
      expect(await attempt((tx) => insert(tx, `unfenced-${suffix}`))).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [user.id]);
          await insert(tx, `fenced-${suffix}`);
        }),
      ).toBe("ok");
      const pool = await fixtures.modelPool.findFirstOrThrow({
        where: { userId: user.id, slug: `fenced-${suffix}` },
      });
      // A display column: unfenced single-row write is allowed.
      expect(
        await attempt((tx) =>
          tx.modelPool.update({ where: { id: pool.id }, data: { name: "renamed" } }),
        ),
      ).toBe("ok");
      // An identity column: fenced only.
      expect(
        await attempt((tx) =>
          tx.modelPool.update({ where: { id: pool.id }, data: { slug: `moved-${suffix}` } }),
        ),
      ).toBe("WMPF4");
      // A delete: fenced only, also as a cascade from the user.
      expect(await attempt((tx) => tx.modelPool.delete({ where: { id: pool.id } }))).toBe("WMPF4");
      expect(await attempt((tx) => tx.user.delete({ where: { id: user.id } }))).toBe("WMPF4");
      // A hot-path status write on a graph row needs no fence.
      const local = await localModel(user.id, suffix, "status");
      const member = await fixtures.poolMember.create({
        data: { poolId: pool.id, executionTargetId: local.target.id, tier: "PRIMARY" },
      });
      expect(
        await attempt((tx) =>
          tx.poolMember.update({
            where: { id: member.id },
            data: { healthStatus: "DEGRADED", consecutiveRetryableFailures: 2 },
          }),
        ),
      ).toBe("ok");
      // A member's owner is its pool's owner (the row has no userId).
      expect(await attempt((tx) => tx.poolMember.delete({ where: { id: member.id } }))).toBe(
        "WMPF4",
      );
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [user.id]);
          await tx.poolMember.delete({ where: { id: member.id } });
        }),
      ).toBe("ok");
    });

    it("require the capacity-policy and capacity fences for policy writes, except on rows created by the same transaction", async () => {
      const m = required();
      const { user, suffix } = await userFixture("policy-fence");
      const local = await localModel(user.id, suffix, "policy");
      const pool = await fixtures.modelPool.create({
        data: { userId: user.id, slug: `policy-${suffix}`, name: "Policy pool" },
      });
      const owner = (tx: Tx) => m.order.fenceOwners(tx, [user.id]);
      const policy = (tx: Tx) =>
        m.order.acquireFences(tx, [m.order.fences.capacityPolicy(local.target.id)]);
      // Target direct policy.
      const direct = (tx: Tx) =>
        tx.executionTarget.update({ where: { id: local.target.id }, data: { directPriority: 20 } });
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          return direct(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await policy(tx);
          return direct(tx);
        }),
      ).toBe("ok");
      // Membership feeds the target's admission view.
      const join = (tx: Tx) =>
        tx.poolMember.create({
          data: { poolId: pool.id, executionTargetId: local.target.id, tier: "PRIMARY" },
        });
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          return join(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await policy(tx);
          return join(tx);
        }),
      ).toBe("ok");
      // Pool policy: the fences of every member target.
      const poolPolicy = (tx: Tx) =>
        tx.modelPool.update({ where: { id: pool.id }, data: { capacityReservedSlots: 1 } });
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          return poolPolicy(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await policy(tx);
          return poolPolicy(tx);
        }),
      ).toBe("ok");
      // Capacity hard limit: the capacity fence.
      const limit = (tx: Tx) =>
        tx.inferenceCapacity.update({
          where: { id: local.capacityId },
          data: { hardConcurrencyLimit: 3 },
        });
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          return limit(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await m.order.acquireFences(tx, [
            m.order.fences.owner(user.id),
            m.order.fences.capacity(local.capacityId),
          ]);
          await limit(tx);
        }),
      ).toBe("ok");
      // A capacity this transaction created needs no capacity fence.
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          const created = await tx.inferenceCapacity.create({
            data: {
              userId: user.id,
              label: `fresh-${suffix}`,
              runtimeIdentityKey: `fresh-${suffix}`,
              runtimeModel: "fresh",
            },
          });
          await tx.inferenceCapacity.update({
            where: { id: created.id },
            data: { hardConcurrencyLimit: 2 },
          });
        }),
      ).toBe("ok");
      // Fresh values: the writes above already set 3 and 20.
      const limit4 = (tx: Tx) =>
        tx.inferenceCapacity.update({
          where: { id: local.capacityId },
          data: { hardConcurrencyLimit: 4 },
        });
      const direct21 = (tx: Tx) =>
        tx.executionTarget.update({ where: { id: local.target.id }, data: { directPriority: 21 } });
      // An earlier write that needs no fence does not make an existing row
      // "created by this transaction": the policy write is still refused.
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await tx.inferenceCapacity.update({
            where: { id: local.capacityId },
            data: { label: `renamed-${suffix}` },
          });
          return limit4(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await tx.executionTarget.update({
            where: { id: local.target.id },
            data: { updatedAt: new Date() },
          });
          return direct21(tx);
        }),
      ).toBe("WMPF4");
      // An upsert that lands on an existing row inserts nothing.
      expect(
        await attempt(async (tx) => {
          await owner(tx);
          await tx.inferenceCapacity.upsert({
            where: { id: local.capacityId },
            create: {
              id: local.capacityId,
              userId: user.id,
              label: `upsert-${suffix}`,
              runtimeIdentityKey: `upsert-${suffix}`,
              runtimeModel: "upsert",
            },
            update: {},
          });
          return limit4(tx);
        }),
      ).toBe("WMPF4");
    });

    it("require both owners' fences for a grant and a cross-owner allowlist entry", async () => {
      const m = required();
      const { user: owner, suffix } = await userFixture("grant-owner");
      const { user: grantee } = await userFixture("grant-grantee");
      const pool = await fixtures.modelPool.create({
        data: { userId: owner.id, slug: `granted-${suffix}`, name: "Granted" },
      });
      const grant = (tx: Tx) =>
        tx.poolGrant.create({
          data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: grantee.id },
        });
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [owner.id]);
          return grant(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [owner.id, grantee.id]);
          return grant(tx);
        }),
      ).toBe("ok");
      const token = await fixtures.modelApiToken.create({
        data: {
          userId: grantee.id,
          name: "Grantee token",
          scopeMode: "ALLOWLIST",
          lookupPrefix: `lp-${suffix}`,
          secretDigest: `sd-${suffix}`,
        },
      });
      const entry = (tx: Tx) =>
        tx.modelApiTokenAllowlistEntry.create({
          data: { modelApiTokenId: token.id, target: "MODEL_POOL", modelPoolId: pool.id },
        });
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [grantee.id]);
          return entry(tx);
        }),
      ).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [owner.id, grantee.id]);
          return entry(tx);
        }),
      ).toBe("ok");
      // The grantee's delete cascades into the owner's grant and the
      // grantee's entry on the owner's pool: fenceParentDelete plans both
      // owners, so the durable delete succeeds.
      expect(
        (await m.deletion.resolveDeletedParents(strict, { userId: grantee.id, wholeUser: true }))
          .pool_grant.length,
      ).toBe(1);
      expect(await m.deletion.deleteUserDurably(m.prisma, grantee.id)).toBe("deleted");
      expect(await fixtures.poolGrant.count({ where: { poolId: pool.id } })).toBe(0);
      expect(await fixtures.deletedUserPurge.count({ where: { userId: grantee.id } })).toBe(1);
    });

    it("accept every write on a fixture connection (deploy/fixture marker)", async () => {
      const { user, suffix } = await userFixture("bypass");
      await fixtures.modelPool.create({
        data: { userId: user.id, slug: `bypass-${suffix}`, name: "Bypass" },
      });
      await fixtures.user.delete({ where: { id: user.id } });
      expect(await fixtures.user.count({ where: { id: user.id } })).toBe(0);
    });
  });

  describe("parent deletes and the sweepers", () => {
    it("deletes a pool with lease and admission history; the orphan sweep terminalizes its live rows", async () => {
      const m = required();
      const { user, suffix } = await userFixture("lease-history");
      const local = await localModel(user.id, suffix, "lease");
      const pool = await fixtures.modelPool.create({
        data: { userId: user.id, slug: `history-${suffix}`, name: "History" },
      });
      const member = await fixtures.poolMember.create({
        data: { poolId: pool.id, executionTargetId: local.target.id, tier: "PRIMARY" },
      });
      const request = async (name: string, state: "TERMINAL" | "WAITING" | "ADMITTED") => {
        const attemptId = `${name}-${suffix}`;
        const created = await fixtures.admissionRequest.create({
          data: {
            userId: user.id,
            requestId: attemptId,
            attemptId,
            sourceKind: "POOL",
            poolId: pool.id,
            basePriority: 16,
            enqueueSequence: BigInt(Date.now()),
            deadlineAt: new Date(Date.now() + 60_000),
            connectionOwner: name,
            heartbeatAt: new Date(),
            state,
            ...(state === "TERMINAL" ? { terminalAt: new Date() } : {}),
          },
        });
        await fixtures.capacityWaiter.create({
          data: {
            userId: user.id,
            admissionRequestId: created.id,
            requestId: attemptId,
            attemptId,
            enqueueSequence: created.enqueueSequence,
            capacityId: local.capacityId,
            executionTargetId: local.target.id,
            poolId: pool.id,
            poolMemberId: member.id,
            candidateOrder: 0,
            deadlineAt: new Date(Date.now() + 60_000),
            effectivePriority: 16,
            effectiveConcurrencyScope: "POOL",
            effectiveConcurrencyScopeId: pool.id,
            state: state === "WAITING" ? "WAITING" : "ADMITTED",
          },
        });
        if (state !== "WAITING")
          await fixtures.capacityLease.create({
            data: {
              userId: user.id,
              admissionRequestId: created.id,
              requestId: attemptId,
              attemptId,
              capacityId: local.capacityId,
              executionTargetId: local.target.id,
              poolId: pool.id,
              poolMemberId: member.id,
              priority: 16,
              reservationClass: 16,
              fencingToken: BigInt(Date.now()),
              state: state === "TERMINAL" ? "RELEASED" : "ACTIVE",
              ownerServerInstance: "history",
              heartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              ...(state === "TERMINAL"
                ? { releasedAt: new Date(), releaseReason: "released" }
                : {}),
            },
          });
        return created;
      };
      const terminal = await request("terminal", "TERMINAL");
      const waiting = await request("waiting", "WAITING");
      const admitted = await request("admitted", "ADMITTED");
      const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
        context: sessionFor(user),
      });
      // The pool's delete removes its member (graph) but not its history.
      await expect(forwarder.deleteModelPool({ id: pool.id })).resolves.toEqual({ deleted: true });
      expect(await fixtures.modelPool.count({ where: { id: pool.id } })).toBe(0);
      const leases = await fixtures.capacityLease.findMany({
        where: { admissionRequestId: { in: [terminal.id, admitted.id] } },
      });
      expect(leases.map((lease) => lease.poolId)).toEqual([pool.id, pool.id]);
      // The orphan sweep cancels the waiting request (its member is gone). The
      // admitted request runs on a live target and capacity, so its lease is
      // left to finish (or to expire): a pool delete does not cut in-flight work.
      const store = new m.store.PostgresCapacityAdmissionStore(m.prisma);
      expect(await store.sweepOrphans({ limit: 100 })).toBeGreaterThanOrEqual(1);
      expect(
        (await fixtures.admissionRequest.findUniqueOrThrow({ where: { id: admitted.id } })).state,
      ).toBe("ADMITTED");
      // Once the target itself is gone, the active lease is an orphan: released.
      await fixtures.endpoint.delete({ where: { id: local.endpoint.id } });
      expect(await store.sweepOrphans({ limit: 100 })).toBeGreaterThanOrEqual(1);
      const after = await fixtures.admissionRequest.findMany({
        where: { id: { in: [waiting.id, admitted.id] } },
        include: { Lease: true, Waiters: true },
        orderBy: { attemptId: "asc" },
      });
      const [admittedAfter, waitingAfter] = after;
      expect(waitingAfter?.state).toBe("CANCELLED");
      expect(waitingAfter?.terminalReason).toBe(m.store.ORPHANED_REASON);
      expect(waitingAfter?.Waiters.map((waiter) => waiter.state)).toEqual(["CANCELLED"]);
      expect(admittedAfter?.state).toBe("TERMINAL");
      expect(admittedAfter?.Lease?.state).toBe("RELEASED");
      expect(admittedAfter?.Lease?.releaseReason).toBe(m.store.ORPHANED_REASON);
      // Retention prunes terminal history (with its waiters and lease).
      const pruned = await m.sweeps.pruneTerminalCapacityHistory(m.prisma, {
        before: new Date(Date.now() + 60_000),
      });
      expect(pruned).toBeGreaterThanOrEqual(3);
      expect(
        await fixtures.admissionRequest.count({
          where: { id: { in: [terminal.id, waiting.id, admitted.id] } },
        }),
      ).toBe(0);
      expect(await fixtures.capacityLease.count({ where: { userId: user.id } })).toBe(0);
    });

    it("admission cancels a queued waiter whose target was deleted instead of leasing it", async () => {
      const m = required();
      const { user, suffix } = await userFixture("orphan-admit");
      const local = await localModel(user.id, suffix, "orphan");
      const store = new m.store.PostgresCapacityAdmissionStore(m.prisma);
      const attempt = (id: string) => ({
        attemptId: `${id}-${suffix}`,
        requestId: `${id}-${suffix}`,
        ownerId: user.id,
        sourceKind: "DIRECT" as const,
        basePriority: 16,
        connectionOwner: id,
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [
          { capacityId: local.capacityId, executionTargetId: local.target.id, candidateOrder: 0 },
        ],
      });
      await fixtures.inferenceCapacity.update({
        where: { id: local.capacityId },
        data: { hardConcurrencyLimit: 1 },
      });
      const first = await store.acquire(attempt("first"));
      expect(first.state).toBe("ADMITTED");
      const second = await store.acquire(attempt("second"));
      expect(second.state).toBe("WAITING");
      // The model and its target go, and with them the now-empty auto capacity
      // (#114); the queued request stays until the orphan sweep terminalizes it.
      const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
        context: sessionFor(user),
      });
      await forwarder.removeDiscoveredModelMetadata({ id: local.model.id });
      if (first.state !== "ADMITTED") throw new Error("unreachable");
      expect(await store.release(first.lease)).toBe(true);
      expect(await fixtures.inferenceCapacity.count({ where: { id: local.capacityId } })).toBe(0);
      await store.sweepOrphans({ limit: 100 });
      const queued = await fixtures.admissionRequest.findUniqueOrThrow({
        where: { attemptId: `second-${suffix}` },
        include: { Lease: true },
      });
      expect(queued.state).toBe("CANCELLED");
      expect(queued.terminalReason).toBe(m.store.ORPHANED_REASON);
      expect(queued.Lease).toBeNull();
    });

    it("purges a deleted user's in-flight history after the delete and removes the queue entry", async () => {
      const m = required();
      const { user, suffix } = await userFixture("purge");
      const { user: other } = await userFixture("purge-other");
      // A request still in flight during the delete: the drain passes PENDING rows.
      const relay = await fixtures.relayRequest.create({
        data: { userId: user.id, status: "PENDING" },
      });
      await fixtures.usageRollupMinute.create({
        data: {
          bucketStart: new Date(),
          ownerUserId: other.id,
          requesterUserId: user.id,
          source: "API_TOKEN",
          requests: 1,
        },
      });
      expect(await m.deletion.deleteUserDurably(m.prisma, user.id)).toBe("deleted");
      expect(await fixtures.relayRequest.count({ where: { id: relay.id } })).toBe(1);
      // The request finishes after the delete.
      await fixtures.relayRequest.update({
        where: { id: relay.id },
        data: { status: "SUCCEEDED" },
      });
      await fixtures.responseStickinessRecord.create({
        data: { userId: user.id, routingKeyDigest: `late-${suffix}` },
      });
      const purged = await m.sweeps.purgeDeletedUsersHistory(m.prisma, {
        now: new Date(),
        graceMs: 0,
        maxUsers: 1_000,
      });
      expect(purged.rows).toBeGreaterThanOrEqual(2);
      expect(await fixtures.relayRequest.count({ where: { userId: user.id } })).toBe(0);
      expect(await fixtures.responseStickinessRecord.count({ where: { userId: user.id } })).toBe(0);
      // Requester rows merged into the '' sentinel: the owner keeps the traffic.
      expect(await fixtures.usageRollupMinute.count({ where: { requesterUserId: user.id } })).toBe(
        0,
      );
      expect(
        await fixtures.usageRollupMinute.count({
          where: { ownerUserId: other.id, requesterUserId: "" },
        }),
      ).toBe(1);
      expect(await fixtures.deletedUserPurge.count({ where: { userId: user.id } })).toBe(0);
    });

    it("keeps the queue entry while the grace period runs or history remains", async () => {
      const m = required();
      const { user } = await userFixture("purge-grace");
      const relay = await fixtures.relayRequest.create({
        data: { userId: user.id, status: "PENDING" },
      });
      expect(await m.deletion.deleteUserDurably(m.prisma, user.id)).toBe("deleted");
      await m.sweeps.purgeDeletedUsersHistory(m.prisma, {
        now: new Date(),
        graceMs: 0,
        maxUsers: 1_000,
      });
      // PENDING history is never purged: the entry stays.
      expect(await fixtures.deletedUserPurge.count({ where: { userId: user.id } })).toBe(1);
      await fixtures.relayRequest.update({ where: { id: relay.id }, data: { status: "FAILED" } });
      await m.sweeps.purgeDeletedUsersHistory(m.prisma, { now: new Date(), maxUsers: 1_000 });
      // Nothing left, but inside the grace period: the entry stays.
      expect(await fixtures.relayRequest.count({ where: { id: relay.id } })).toBe(0);
      expect(await fixtures.deletedUserPurge.count({ where: { userId: user.id } })).toBe(1);
      await m.sweeps.purgeDeletedUsersHistory(m.prisma, {
        now: new Date(),
        graceMs: 0,
        maxUsers: 1_000,
      });
      expect(await fixtures.deletedUserPurge.count({ where: { userId: user.id } })).toBe(0);
    });

    it("reaches later queue entries while clean entries wait out the grace period", async () => {
      const m = required();
      const suffix = crypto.randomUUID().slice(0, 8);
      // More clean entries than one call's maxUsers, all older than the late
      // user: a queue head that is only waiting out the grace period must not
      // hide the entries behind it.
      for (let i = 0; i < 12; i++)
        await fixtures.deletedUserPurge.create({
          data: {
            userId: `hol-done-${i}-${suffix}`,
            deletedAt: new Date(Date.now() - 2 * 3_600_000),
          },
        });
      const late = `hol-late-${suffix}`;
      await fixtures.deletedUserPurge.create({
        data: { userId: late, deletedAt: new Date(Date.now() - 3_600_000) },
      });
      await fixtures.capacityRuntime.create({
        data: { capacityId: `hol-cap-${suffix}`, userId: late },
      });
      const purged = await m.sweeps.purgeDeletedUsersHistory(m.prisma, {
        now: new Date(),
        maxUsers: 10,
      });
      expect(purged.rows).toBeGreaterThanOrEqual(1);
      expect(await fixtures.capacityRuntime.count({ where: { userId: late } })).toBe(0);
      // The clean entries stay inside the grace period.
      expect(
        await fixtures.deletedUserPurge.count({ where: { userId: { startsWith: "hol-done-" } } }),
      ).toBeGreaterThanOrEqual(12);
      await fixtures.deletedUserPurge.deleteMany({ where: { userId: { contains: `-${suffix}` } } });
    });

    it("purge does not queue behind a busy rollup destination and merges after it frees", async () => {
      const m = required();
      const { user: owner, suffix } = await userFixture("purge-busy-owner");
      const gone = `purge-busy-gone-${suffix}`;
      const bucketStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      await fixtures.deletedUserPurge.create({ data: { userId: gone } });
      await fixtures.usageRollupMinute.create({
        data: {
          bucketStart,
          ownerUserId: owner.id,
          requesterUserId: gone,
          source: "API_TOKEN",
          requests: 2,
        },
      });
      await fixtures.usageRollupMinute.create({
        data: {
          bucketStart,
          ownerUserId: owner.id,
          requesterUserId: "",
          source: "API_TOKEN",
          requests: 5,
        },
      });
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const destinationLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // A hot finalizer holding the sentinel destination row.
      const holder = fixtures.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM usage_rollup_minute
           WHERE "ownerUserId" = ${owner.id} AND "requesterUserId" = '' FOR UPDATE`;
        locked();
        await mayCommit;
      });
      try {
        await destinationLocked;
        const started = Date.now();
        const busy = await m.sweeps.purgeDeletedUserHistory(m.prisma, gone, { batch: 10 });
        expect(Date.now() - started).toBeLessThan(5_000);
        // Nothing merged, nothing lost: the source row stays for the next run.
        expect(busy.remaining).toBe(true);
        expect(await fixtures.usageRollupMinute.count({ where: { requesterUserId: gone } })).toBe(
          1,
        );
      } finally {
        release();
        await holder;
      }
      const done = await m.sweeps.purgeDeletedUserHistory(m.prisma, gone, { batch: 10 });
      expect(done.remaining).toBe(false);
      const merged = await fixtures.usageRollupMinute.findFirstOrThrow({
        where: { ownerUserId: owner.id, requesterUserId: "" },
      });
      expect(merged.requests).toBe(7);
      await fixtures.deletedUserPurge.deleteMany({ where: { userId: gone } });
    });

    it("prunes the scheduler state of deleted capacities", async () => {
      const m = required();
      const { user, suffix } = await userFixture("runtime-orphan");
      await fixtures.capacityRuntime.create({
        data: { capacityId: `gone-${suffix}`, userId: user.id },
      });
      expect(await m.sweeps.pruneOrphanCapacityRuntime(m.prisma)).toBeGreaterThanOrEqual(1);
      expect(
        await fixtures.capacityRuntime.count({ where: { capacityId: `gone-${suffix}` } }),
      ).toBe(0);
    });

    it("prunes expired stickiness bindings (no foreign key removes them with their token or grant) and keeps live ones", async () => {
      const m = required();
      const { user, suffix } = await userFixture("stickiness-expiry");
      await fixtures.$executeRaw`
        INSERT INTO response_stickiness_record (id, "userId", "routingKeyDigest", "expiresAt")
        VALUES (${`expired-${suffix}`}, ${user.id}, ${`d-expired-${suffix}`}, now() - interval '1 minute'),
               (${`live-${suffix}`}, ${user.id}, ${`d-live-${suffix}`}, now() + interval '1 hour')`;
      expect(
        await m.sweeps.pruneExpiredStickiness(m.prisma, { now: new Date() }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        (
          await fixtures.responseStickinessRecord.findMany({
            where: { userId: user.id },
            select: { id: true },
          })
        ).map((row) => row.id),
      ).toEqual([`live-${suffix}`]);
    });

    it("an endpoint delete plans its cascade under the owner fence, so a concurrent model add is serialized", async () => {
      const m = required();
      const { user, suffix } = await userFixture("endpoint-plan");
      const local = await localModel(user.id, suffix, "plan");
      const forwarder = createRouterClient(m.forwarder.forwarderManagementRouter, {
        context: sessionFor(user),
      });
      // A registration-like writer holds the owner fence while it adds a model.
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const holding = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const writer = strict.$transaction(
        async (tx) => {
          await m.order.fenceOwners(tx, [user.id]);
          await tx.discoveredModel.create({
            data: {
              userId: user.id,
              endpointId: local.endpoint.id,
              upstreamModelId: "up-added",
              encodedModelId: `enc-added-${suffix}`,
            },
          });
          ready();
          await released;
        },
        { timeout: 20_000 },
      );
      await holding;
      const removal = forwarder.removeEndpointMetadata({ id: local.endpoint.id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await writer;
      await expect(removal).resolves.toEqual({ deleted: true });
      // The model added under the fence went with the endpoint.
      expect(
        await fixtures.discoveredModel.count({ where: { endpointId: local.endpoint.id } }),
      ).toBe(0);
      expect(await fixtures.executionTarget.count({ where: { userId: user.id } })).toBe(0);
    });
  });

  describe("guards found by mutation testing", () => {
    it("refuses an unfenced delete of a user who owns no graph rows (the user trigger itself)", async () => {
      const m = required();
      const { user } = await userFixture("bare-user");
      expect(await attempt((tx) => tx.user.delete({ where: { id: user.id } }))).toBe("WMPF4");
      expect(
        await attempt(async (tx) => {
          await m.order.fenceOwners(tx, [user.id]);
          await tx.user.delete({ where: { id: user.id } });
        }),
      ).toBe("ok");
    });

    it("re-plans a user delete whose owner set grew while it waited for its fences", async () => {
      const m = required();
      const { user: owner, suffix } = await userFixture("replan-owner");
      const { user: other } = await userFixture("replan-other");
      const pool = await fixtures.modelPool.create({
        data: { userId: owner.id, slug: `replan-${suffix}`, name: "Replan" },
      });
      const mark = await m.deletion.requestUserDeletion(m.prisma, owner.id);
      if (!mark) throw new Error("deletion mark was not taken");
      // A writer holding both owners' fences grants the pool to another user
      // after the delete planned its owners (it cannot see the uncommitted
      // grant) and before the delete holds its fences.
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let inserted!: () => void;
      const hasInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const writer = strict.$transaction(
        async (tx) => {
          await m.order.fenceOwners(tx, [owner.id, other.id]);
          await tx.poolGrant.create({
            data: { poolId: pool.id, ownerUserId: owner.id, granteeUserId: other.id },
          });
          inserted();
          await released;
        },
        { timeout: 20_000 },
      );
      await hasInserted;
      const deleting = m.deletion.completeUserDeletion(m.prisma, owner.id, mark.generation);
      await vi.waitFor(
        async () => {
          const rows = await fixtures.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*)::bigint AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
               AND query LIKE '%wsmp_acquire_fences%'`;
          expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
        },
        { timeout: 10_000, interval: 20 },
      );
      release();
      await writer;
      // The first attempt finds an owner it did not fence (the grantee of
      // the new grant its cascade deletes) and retries with it.
      await expect(deleting).resolves.toBe(true);
      expect(await fixtures.user.count({ where: { id: owner.id } })).toBe(0);
      expect(await fixtures.poolGrant.count({ where: { poolId: pool.id } })).toBe(0);
    });

    it("prunes only terminal admission history and never waits on a waiter another transaction holds", async () => {
      const m = required();
      const { user, suffix } = await userFixture("prune-guard");
      const local = await localModel(user.id, suffix, "prune");
      const pool = await fixtures.modelPool.create({
        data: { userId: user.id, slug: `prune-${suffix}`, name: "Prune" },
      });
      const member = await fixtures.poolMember.create({
        data: { poolId: pool.id, executionTargetId: local.target.id, tier: "PRIMARY" },
      });
      const request = async (label: string, state: "WAITING" | "CANCELLED") => {
        const id = `${label}-${suffix}`;
        await fixtures.$executeRawUnsafe(
          `INSERT INTO admission_request (id, "userId", "requestId", "attemptId", "sourceKind", "poolId",
             "basePriority", "enqueueSequence", "connectionOwner", "heartbeatAt", state, "terminalAt",
             "deadlineAt", "updatedAt")
           VALUES ('${id}', '${user.id}', '${id}', '${id}', 'POOL', '${pool.id}', 16, 1, 'fixture', now(),
             '${state}', ${state === "WAITING" ? "NULL" : "now()"},
             ${state === "WAITING" ? "now() + interval '1 hour'" : "NULL"}, now() - interval '30 days')`,
        );
        await fixtures.$executeRawUnsafe(
          `INSERT INTO capacity_waiter (id, "userId", "admissionRequestId", "requestId", "attemptId",
             "enqueueSequence", "capacityId", "executionTargetId", "poolId", "poolMemberId",
             "candidateOrder", "effectivePriority", "effectiveConcurrencyScope",
             "effectiveConcurrencyScopeId", "effectiveReservedSlots", "effectiveBorrowPolicy", state,
             "deadlineAt")
           VALUES ('w-${id}', '${user.id}', '${id}', '${id}', '${id}', 1, '${local.capacityId}',
             '${local.target.id}', '${pool.id}', '${member.id}', 0, 16, 'POOL', '${pool.id}', 0,
             'WHEN_IDLE', '${state}', now() + interval '1 hour')`,
        );
        return id;
      };
      const live = await request("prune-live", "WAITING");
      const held = await request("prune-held", "CANCELLED");
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = strict.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM capacity_waiter WHERE id = ${`w-${held}`} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 20_000 },
      );
      await isLocked;
      try {
        const started = Date.now();
        await m.sweeps.pruneTerminalCapacityHistory(m.prisma, {
          before: new Date(Date.now() + 60_000),
        });
        // Passed, not waited on (the holder keeps its lock until released).
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(await fixtures.admissionRequest.count({ where: { id: { in: [live, held] } } })).toBe(
          2,
        );
      } finally {
        release();
        await holder;
      }
      await m.sweeps.pruneTerminalCapacityHistory(m.prisma, {
        before: new Date(Date.now() + 60_000),
      });
      expect(
        (
          await fixtures.admissionRequest.findMany({
            where: { id: { in: [live, held] } },
            select: { id: true },
          })
        ).map((row) => row.id),
      ).toEqual([live]);
    });

    it("refuses a cache-affinity record naming another owner's pool or target, and tolerates a deleted one", async () => {
      const { user, suffix } = await userFixture("affinity-owner");
      const { user: other } = await userFixture("affinity-other");
      const own = await localModel(user.id, suffix, "affinity");
      const foreign = await localModel(other.id, suffix, "affinity-foreign");
      const ownPool = await fixtures.modelPool.create({
        data: { userId: user.id, slug: `aff-${suffix}`, name: "Aff" },
      });
      const foreignPool = await fixtures.modelPool.create({
        data: { userId: other.id, slug: `aff-f-${suffix}`, name: "Aff foreign" },
      });
      const insert = (label: string, poolId: string, targetId: string) =>
        attempt((tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO cache_affinity_record
               (id, "createdAt", "lastUsedAt", "expiresAt", "userId", "tenantUserId", "poolId",
                "executionTargetId", "targetIdentity", "digestVersion", "bindingDigest", "prefixDigest",
                "conversationDigest", "prefixDepth")
             VALUES ('${label}-${suffix}', now(), now(), now() + interval '1 hour', '${user.id}',
               '${user.id}', '${poolId}', '${targetId}', repeat('t', 32), 3, repeat('d', 43),
               repeat('${label.length % 10}', 43), NULL, 1)`,
          ),
        );
      expect(await insert("foreign-pool", foreignPool.id, own.target.id)).toContain("23514");
      expect(await insert("foreign-target", ownPool.id, foreign.target.id)).toContain("23514");
      expect(await insert("gone-pool", `gone-${suffix}`, own.target.id)).toBe("ok");
    });
  });
});
