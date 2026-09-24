import { latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-PostgreSQL proof of the rollup semantics:
 *  - the '' sentinel keys make ON CONFLICT merge (NULLs would be distinct);
 *  - histograms merge element-wise;
 *  - the guarded terminal transition counts a request exactly once and keys
 *    it by resource owner + requester;
 *  - deleting a requester keeps the owner's history (merged into the ''
 *    requester by the usage_rollup_detach_requester trigger), deleting the
 *    owner cascades;
 *  - minute -> hour compaction moves rows additively;
 *  - raw retention never deletes an uncounted PENDING request and drains the
 *    abandoned backlog (counting each once) before deleting.
 */
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[usage-rollup-postgres] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

type Db = ReturnType<typeof createPrismaClient>;

integration("usage rollups with real PostgreSQL", () => {
  let db: Db;
  let rollup: typeof import("./usage-rollup.js");
  let retention: typeof import("./usage-retention.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    db = createPrismaClient(databaseUrl);
    rollup = await import("./usage-rollup.js");
    retention = await import("./usage-retention.js");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function user(label: string) {
    const suffix = crypto.randomUUID();
    return db.user.create({
      data: {
        name: `Rollup ${label}`,
        email: `rollup-${label}-${suffix}@example.test`,
        slug: `rollup-${label}-${suffix}`,
      },
    });
  }

  function facts(overrides: Partial<import("./usage-rollup.js").RelayRollupRow> = {}) {
    return {
      id: "unused",
      userId: "requester",
      status: "SUCCEEDED" as const,
      source: "API_TOKEN" as const,
      startedAt: new Date("2026-09-24T10:15:29.000Z"),
      completedAt: new Date("2026-09-24T10:15:30.000Z"),
      durationMs: 1000,
      firstClientByteAt: null,
      requestedModelPoolId: null,
      selectedPoolMemberId: null,
      requestedExecutionTargetId: null,
      selectedExecutionTargetId: null,
      attemptCount: 1,
      promptTokens: 10,
      completionTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: null,
      usageKnown: true,
      RequestedModelPool: null,
      SelectedExecutionTarget: null,
      RequestedExecutionTarget: null,
      ...overrides,
    };
  }

  it("merges sentinel-keyed increments, including element-wise histogram merge", async () => {
    const owner = await user("sentinel");
    try {
      const fast = rollup.rollupIncrementForRequest(facts({ userId: owner.id, durationMs: 40 }))!;
      const slow = rollup.rollupIncrementForRequest(facts({ userId: owner.id, durationMs: 9000 }))!;
      // Separate transactions: the second must hit ON CONFLICT, not insert.
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_minute", [fast]),
      );
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_minute", [slow]),
      );
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_minute", [slow]),
      );
      const rows = await db.usageRollupMinute.findMany({ where: { ownerUserId: owner.id } });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        ownerUserId: owner.id,
        requesterUserId: owner.id,
        poolId: "",
        poolMemberId: "",
        executionTargetId: "",
        requests: 3,
        inputTokens: 30n,
        cacheReadTokens: 12n,
        durationCount: 3,
        durationSumMs: 18_040n,
      });
      expect(row!.latencyHistogram[latencyBucketIndex(40)]).toBe(1);
      expect(row!.latencyHistogram[latencyBucketIndex(9000)]).toBe(2);
      expect(row!.latencyHistogram.reduce((sum, value) => sum + value, 0)).toBe(3);
    } finally {
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  });

  it("counts a guarded terminal transition once, keyed by pool owner and requester", async () => {
    const owner = await user("owner");
    const grantee = await user("grantee");
    try {
      const pool = await db.modelPool.create({
        data: { userId: owner.id, name: "Shared", slug: `shared-${crypto.randomUUID()}` },
      });
      const relay = await db.relayRequest.create({
        data: {
          userId: grantee.id,
          requestedSurface: "OPENAI_CHAT_COMPLETIONS",
          requestedModelPoolId: pool.id,
          status: "PENDING",
        },
      });
      const now = new Date("2026-09-24T11:00:10.000Z");
      const first = await db.$transaction((tx) =>
        rollup.transitionRelayRequestTerminal(
          tx,
          relay.id,
          { status: "CANCELED", completedAt: now, durationMs: 50, errorClass: "cancelled" },
          now,
        ),
      );
      const second = await db.$transaction((tx) =>
        rollup.transitionRelayRequestTerminal(
          tx,
          relay.id,
          { status: "FAILED", completedAt: now, errorClass: "unknown" },
          now,
        ),
      );
      expect([first, second]).toEqual([true, false]);
      const stored = await db.relayRequest.findUniqueOrThrow({ where: { id: relay.id } });
      expect(stored.status).toBe("CANCELED");
      const rows = await db.usageRollupMinute.findMany({ where: { poolId: pool.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        bucketStart: new Date("2026-09-24T11:00:00.000Z"),
        ownerUserId: owner.id,
        requesterUserId: grantee.id,
        requests: 1,
        cancels: 1,
        errors: 0,
      });
    } finally {
      await db.user.deleteMany({ where: { id: { in: [owner.id, grantee.id] } } });
    }
  });

  it("keeps the owner's history when a requester is deleted, and cascades on owner deletion", async () => {
    const owner = await user("keep-owner");
    const requester = await user("deleted-requester");
    const earlier = await user("earlier-deleted");
    try {
      const bucket = new Date("2026-09-24T12:00:00.000Z");
      const key = (requesterUserId: string, extra: Record<string, unknown> = {}) =>
        rollup.rollupIncrementForRequest(
          facts({
            userId: requesterUserId,
            completedAt: bucket,
            durationMs: 100,
            requestedModelPoolId: "pool-x",
            selectedPoolMemberId: "member-x",
            RequestedModelPool: { userId: owner.id },
            ...extra,
          }),
        )!;
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_minute", [
          key(requester.id),
          key(requester.id, { durationMs: 5000 }),
          key(earlier.id),
          // The requester's own direct traffic (they are the owner): erased.
          rollup.rollupIncrementForRequest(facts({ userId: requester.id, completedAt: bucket }))!,
        ]),
      );
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_hour", [key(requester.id)]),
      );
      // A prior deletion already produced the '' sentinel row for this key.
      await db.user.delete({ where: { id: earlier.id } });
      await db.user.delete({ where: { id: requester.id } });

      const minute = await db.usageRollupMinute.findMany({ where: { ownerUserId: owner.id } });
      expect(minute).toHaveLength(1);
      expect(minute[0]).toMatchObject({
        requesterUserId: "",
        poolId: "pool-x",
        poolMemberId: "member-x",
        requests: 3,
        durationSumMs: 5200n,
      });
      expect(minute[0]!.latencyHistogram[latencyBucketIndex(100)]).toBe(2);
      expect(minute[0]!.latencyHistogram[latencyBucketIndex(5000)]).toBe(1);
      const hour = await db.usageRollupHour.findMany({ where: { ownerUserId: owner.id } });
      expect(hour).toEqual([expect.objectContaining({ requesterUserId: "", requests: 1 })]);
      expect(
        await db.usageRollupMinute.count({
          where: { OR: [{ requesterUserId: requester.id }, { ownerUserId: requester.id }] },
        }),
      ).toBe(0);

      await db.user.delete({ where: { id: owner.id } });
      expect(await db.usageRollupMinute.count({ where: { ownerUserId: owner.id } })).toBe(0);
      expect(await db.usageRollupHour.count({ where: { ownerUserId: owner.id } })).toBe(0);
    } finally {
      await db.user.deleteMany({ where: { id: { in: [owner.id, requester.id, earlier.id] } } });
    }
  });

  it("compacts minute rows older than the minute retention into additive hourly rows", async () => {
    const owner = await user("compaction");
    try {
      const now = new Date();
      const oldHour = new Date(
        Math.floor((now.getTime() - 40 * 24 * 60 * 60 * 1000) / 3_600_000) * 3_600_000,
      );
      const at = (minute: number, durationMs: number) =>
        rollup.rollupIncrementForRequest(
          facts({
            userId: owner.id,
            completedAt: new Date(oldHour.getTime() + minute * 60_000),
            durationMs,
          }),
        )!;
      await db.$transaction((tx) =>
        rollup.writeRollupIncrements(tx, "usage_rollup_minute", [
          at(1, 100),
          at(7, 100),
          at(59, 3000),
          rollup.rollupIncrementForRequest(facts({ userId: owner.id, completedAt: now }))!,
        ]),
      );
      const moved = await retention.compactMinuteRollups({ prisma: db, now });
      expect(moved).toBeGreaterThanOrEqual(3);
      const minute = await db.usageRollupMinute.findMany({ where: { ownerUserId: owner.id } });
      // Only the recent row stays at minute resolution.
      expect(minute).toHaveLength(1);
      const hour = await db.usageRollupHour.findMany({ where: { ownerUserId: owner.id } });
      expect(hour).toHaveLength(1);
      expect(hour[0]).toMatchObject({
        bucketStart: oldHour,
        requesterUserId: owner.id,
        requests: 3,
        durationSumMs: 3200n,
      });
      expect(hour[0]!.latencyHistogram[latencyBucketIndex(100)]).toBe(2);
      expect(hour[0]!.latencyHistogram[latencyBucketIndex(3000)]).toBe(1);
      // Idempotent: a second run moves nothing more for this owner.
      await retention.compactMinuteRollups({ prisma: db, now });
      expect(
        (await db.usageRollupHour.findMany({ where: { ownerUserId: owner.id } }))[0]!.requests,
      ).toBe(3);
    } finally {
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  });

  it("never deletes an uncounted PENDING request past the raw retention cutoff", async () => {
    const owner = await user("retention");
    try {
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const relay = (status: "PENDING" | "SUCCEEDED") =>
        db.relayRequest.create({
          data: {
            userId: owner.id,
            requestedSurface: "OPENAI_CHAT_COMPLETIONS",
            status,
            createdAt: old,
            startedAt: old,
            ...(status === "SUCCEEDED" ? { completedAt: old } : {}),
          },
        });
      const done = await relay("SUCCEEDED");
      const pending = await relay("PENDING");
      // The delete alone must skip the uncounted PENDING row.
      await retention.deleteExpiredRelayRequests({
        prisma: db,
        now: new Date(),
        retentionDays: 14,
      });
      expect(await db.relayRequest.findUnique({ where: { id: done.id } })).toBeNull();
      expect(await db.relayRequest.findUnique({ where: { id: pending.id } })).toMatchObject({
        status: "PENDING",
      });

      // A backlog larger than one reap batch is drained (batch 1, backlog 3):
      // every abandoned request is counted once, then its raw row ages out.
      const more = [await relay("PENDING"), await relay("PENDING")];
      const result = await retention.runUsageRetention({ prisma: db, retentionDays: 14, batch: 1 });
      expect(result.abandonedReaped).toBeGreaterThanOrEqual(3);
      for (const id of [pending.id, ...more.map((row) => row.id)])
        expect(await db.relayRequest.findUnique({ where: { id } })).toBeNull();
      const counted = await db.usageRollupMinute.findMany({ where: { ownerUserId: owner.id } });
      expect(counted.reduce((sum, row) => sum + row.requests, 0)).toBe(3);
      expect(counted.reduce((sum, row) => sum + row.errors, 0)).toBe(3);
    } finally {
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  });
});
