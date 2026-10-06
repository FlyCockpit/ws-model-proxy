import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://usage-retention-test", NODE_ENV: "test" },
}));
// The hot-path history sweeps have their own PostgreSQL suites; here only
// their wiring into the retention run is under test.
const sweeps = vi.hoisted(() => ({
  HOT_PATH_SWEEP_BATCH: 1_000,
  NODE_COMMAND_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
  pruneTerminalCapacityHistory: vi.fn(),
  purgeDeletedUsersHistory: vi.fn(),
  pruneOrphanCapacityScheduler: vi.fn(),
  pruneExpiredStickiness: vi.fn(),
  pruneOldNodeCommands: vi.fn(),
}));
vi.mock("@ws-model-proxy/db/hot-path-sweeps", () => sweeps);

const {
  ABANDONED_PENDING_AFTER_MS,
  compactMinuteRollups,
  deleteExpiredNodeAuditEvents,
  deleteOrphanNodeAuditEvents,
  deleteExpiredHourRollups,
  deleteExpiredRelayRequests,
  deleteExpiredRoutingVerdicts,
  deleteExpiredKvEvictions,
  deleteExpiredRuntimeLoadMinutes,
  deleteExpiredNodeMetricsMinutes,
  KV_EVICTION_RETENTION_MS,
  hourIncrementsFromMinuteRows,
  ROUTING_VERDICT_RETENTION_MS,
  reapAbandonedPendingRequests,
  runUsageRetention,
  startUsageRetention,
} = await import("./usage-retention.js");

const NOW = new Date("2026-09-24T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type Sql = { sql: string; values: unknown[] };

function fakePrisma() {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    relayRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { prisma, tx };
}

function minuteRow(overrides: Record<string, unknown> = {}) {
  return {
    bucketStart: new Date("2026-08-01T10:07:00.000Z"),
    ownerUserId: "owner-1",
    requesterUserId: "user-1",
    poolId: "pool-1",
    runtimeId: "",
    versionId: "version-1",
    nodeId: "node-1",
    instanceId: "instance-1",
    runtimeModelId: "model-1",
    providerModelId: "",
    source: "API_KEY",
    requests: 2,
    successes: 2,
    errors: 0,
    cancels: 0,
    retries: 0,
    usageKnownRequests: 2,
    inputTokens: 10n,
    outputTokens: 4n,
    cacheReadTokens: 5n,
    cacheWriteTokens: 0n,
    cacheKnownRequests: 2,
    cacheKnownInputTokens: 10n,
    continuationRequests: 1,
    continuationInputTokens: 5n,
    continuationCacheReadTokens: 3n,
    durationCount: 2,
    durationSumMs: 300n,
    latencyHistogram: [0, 0, 0, 0, 0, 0, 2],
    ttftCount: 0,
    ttftSumMs: 0n,
    ttftHistogram: [],
    ...overrides,
  };
}

describe("usage retention", () => {
  beforeEach(() => {
    disarmDbShutdownFence();
    sweeps.pruneTerminalCapacityHistory.mockReset().mockResolvedValue(0);
    sweeps.purgeDeletedUsersHistory
      .mockReset()
      .mockResolvedValue({ users: 0, rows: 0, completed: 0 });
    sweeps.pruneOrphanCapacityScheduler.mockReset().mockResolvedValue(0);
    sweeps.pruneExpiredStickiness.mockReset().mockResolvedValue(0);
    sweeps.pruneOldNodeCommands.mockReset().mockResolvedValue(0);
  });
  afterEach(() => disarmDbShutdownFence());

  it("is a no-op on an empty database", async () => {
    const { prisma, tx } = fakePrisma();
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("clock_timestamp") ? [{ now: NOW }] : [],
    );
    prisma.$executeRaw.mockResolvedValue(0);
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      runUsageRetention({ prisma: prisma as never, retentionDays: 14 }),
    ).resolves.toEqual({
      abandonedReaped: 0,
      relayRequestsDeleted: 0,
      minuteRowsCompacted: 0,
      hourRowsDeleted: 0,
      nodeAuditEventsDeleted: 0,
      nodeCommandsDeleted: 0,
      admissionHistoryPruned: 0,
      deletedUserRowsPurged: 0,
      orphanSchedulersDeleted: 0,
      expiredStickinessDeleted: 0,
      routingVerdictsDeleted: 0,
      kvEvictionsDeleted: 0,
      runtimeLoadMinutesDeleted: 0,
      nodeMetricsMinutesDeleted: 0,
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("runs the node audit and node command steps in every sweep and reports their counts", async () => {
    const { prisma, tx } = fakePrisma();
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("clock_timestamp") ? [{ now: NOW }] : [],
    );
    prisma.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("node_audit_event") ? 4 : 0,
    );
    sweeps.pruneOldNodeCommands.mockResolvedValue(2);
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      runUsageRetention({ prisma: prisma as never, retentionDays: 14, batch: 100, sweepBatch: 50 }),
    ).resolves.toMatchObject({ nodeAuditEventsDeleted: 8, nodeCommandsDeleted: 2 }); // 4 expired + 4 orphaned
    expect(sweeps.pruneOldNodeCommands).toHaveBeenCalledWith(prisma, {
      before: new Date(NOW.getTime() - 30 * DAY_MS),
      batch: 50,
    });
  });

  it("deletes expired and orphaned node audit events in SKIP LOCKED batches, fence-checked", async () => {
    const { prisma } = fakePrisma();
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    let round = 0;
    prisma.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        round += 1;
        return round % 2 === 1 ? 2 : 1;
      },
    );
    await expect(
      deleteExpiredNodeAuditEvents({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(3);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("DELETE FROM node_audit_event");
    expect(statements[0]?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(statements[0]?.values[0]).toEqual(new Date(NOW.getTime() - 90 * DAY_MS));
    expect(statements[0]?.values[1]).toBe(2);
    statements.length = 0;
    await expect(deleteOrphanNodeAuditEvents({ prisma: prisma as never, batch: 2 })).resolves.toBe(
      3,
    );
    expect(statements[0]?.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = e."userId")',
    );
    expect(statements[0]?.sql).toContain("FOR UPDATE OF e SKIP LOCKED");
    armDbShutdownFence();
    statements.length = 0;
    await expect(
      deleteExpiredNodeAuditEvents({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(0);
    await expect(deleteOrphanNodeAuditEvents({ prisma: prisma as never, batch: 2 })).resolves.toBe(
      0,
    );
    expect(statements).toEqual([]);
  });

  it("runs the hot-path history sweeps after the rollup retention and reports their counts", async () => {
    const { prisma, tx } = fakePrisma();
    const order: string[] = [];
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("clock_timestamp") ? [{ now: NOW }] : [],
    );
    prisma.$executeRaw.mockImplementation(async () => {
      order.push("rollup-retention");
      return 0;
    });
    tx.$queryRaw.mockResolvedValue([]);
    sweeps.pruneTerminalCapacityHistory.mockImplementation(async () => {
      order.push("admission-history");
      return 4;
    });
    sweeps.purgeDeletedUsersHistory.mockImplementation(async () => {
      order.push("deleted-users");
      return { users: 2, rows: 7, completed: 1 };
    });
    sweeps.pruneOrphanCapacityScheduler.mockImplementation(async () => {
      order.push("orphan-scheduler");
      return 3;
    });
    sweeps.pruneExpiredStickiness.mockImplementation(async () => {
      order.push("expired-stickiness");
      return 5;
    });
    await expect(
      runUsageRetention({
        prisma: prisma as never,
        retentionDays: 14,
        batch: 50,
        sweepBatch: 50,
      }),
    ).resolves.toMatchObject({
      admissionHistoryPruned: 4,
      deletedUserRowsPurged: 7,
      orphanSchedulersDeleted: 3,
      expiredStickinessDeleted: 5,
    });
    // Terminal admission history uses the relay-request retention window.
    expect(sweeps.pruneTerminalCapacityHistory).toHaveBeenCalledWith(prisma, {
      before: new Date(NOW.getTime() - 14 * DAY_MS),
      batch: 50,
    });
    expect(sweeps.purgeDeletedUsersHistory).toHaveBeenCalledWith(prisma, { now: NOW, batch: 50 });
    expect(sweeps.pruneOrphanCapacityScheduler).toHaveBeenCalledWith(prisma, { batch: 50 });
    expect(sweeps.pruneExpiredStickiness).toHaveBeenCalledWith(prisma, { now: NOW, batch: 50 });
    expect(order.slice(-4)).toEqual([
      "admission-history",
      "deleted-users",
      "orphan-scheduler",
      "expired-stickiness",
    ]);
  });

  it("deletes raw relay requests past the retention cutoff in SKIP LOCKED batches", async () => {
    const { prisma, tx } = fakePrisma();
    let pickRound = 0;
    const statements: string[] = [];
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      statements.push(sql);
      if (!sql.includes("FROM relay_request")) return [];
      pickRound += 1;
      return pickRound === 1 ? [{ id: "relay-1" }, { id: "relay-2" }] : [{ id: "relay-3" }];
    });
    let deleteRound = 0;
    tx.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      deleteRound += 1;
      return deleteRound === 1 ? 2 : 1;
    });
    await expect(
      deleteExpiredRelayRequests({
        prisma: prisma as never,
        now: NOW,
        retentionDays: 14,
        batch: 2,
      }),
    ).resolves.toBe(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const [pickStrings, cutoff, batch] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    // Never picks an uncounted (PENDING) request: terminal statuses only.
    expect(pickStrings.join("?")).toContain("status IN ('SUCCEEDED', 'FAILED', 'CANCELED')");
    expect(pickStrings.join("?")).not.toContain("PENDING");
    expect(cutoff).toEqual(new Date(NOW.getTime() - 14 * DAY_MS));
    expect(batch).toBe(2);
    // No admission row references a request any more (0.4.0): the delete takes only the
    // relay rows, SKIP LOCKED, so it never waits on a row a finalizer holds.
    const [pick, remove] = statements;
    expect(pick).toContain("FROM relay_request");
    expect(remove).toContain("DELETE FROM relay_request");
    expect(remove).toContain("FOR UPDATE SKIP LOCKED");
    expect(remove).toContain("status IN ('SUCCEEDED', 'FAILED', 'CANCELED')");
  });

  it("drains the whole abandoned backlog before deleting expired requests", async () => {
    const { prisma, tx } = fakePrisma();
    const order: string[] = [];
    let candidateRound = 0;
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("clock_timestamp")) return [{ now: NOW }];
      order.push("reap-select");
      candidateRound += 1;
      // Backlog of 3 with batch 2: two full rounds would be needed; the old
      // single-batch reap left relay-3 for the delete to remove uncounted.
      if (candidateRound === 1) return [{ id: "relay-1" }, { id: "relay-2" }];
      if (candidateRound === 2) return [{ id: "relay-3" }];
      return [];
    });
    prisma.$executeRaw.mockImplementation(async () => {
      order.push("delete");
      return 0;
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("clock_timestamp") ? [{ now: NOW }] : [],
    );
    tx.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    const result = await runUsageRetention({
      prisma: prisma as never,
      retentionDays: 14,
      batch: 2,
    });
    expect(result.abandonedReaped).toBe(3);
    expect(tx.relayRequest.updateMany).toHaveBeenCalledTimes(3);
    expect(tx.relayRequest.updateMany.mock.calls.map(([arg]) => arg.where.id)).toEqual([
      "relay-1",
      "relay-2",
      "relay-3",
    ]);
    // Every reap round precedes the first relay_request delete.
    expect(order.indexOf("delete")).toBeGreaterThan(order.lastIndexOf("reap-select"));
    expect(candidateRound).toBe(2);
  });

  it.each([
    ["before-send", "local", "owner", "pool", ""],
    ["send-intent", "own_key", "requester", "", "own-instance"],
    ["superseded-intent", "local", "owner", "pool", "local-instance"],
  ])(
    "reaps %s using the durable route identity without attributing unsent own-key work",
    async (_stage, route, owner, pool, instance) => {
      const { prisma, tx } = fakePrisma();
      prisma.$queryRaw.mockResolvedValue([{ id: "request" }]);
      tx.$queryRaw.mockResolvedValue([{ now: NOW }]);
      tx.relayRequest.findMany.mockResolvedValue([
        {
          id: "request",
          userId: "requester",
          status: "FAILED",
          source: "API_KEY",
          route,
          external: false,
          rejection: null,
          startedAt: new Date(NOW.getTime() - 3_600_000),
          completedAt: NOW,
          firstClientByteAt: null,
          durationMs: null,
          queueWaitMs: null,
          poolId: "pool",
          runtimeModelId: null,
          selectedTargetId: null,
          selectedInstanceId: instance || null,
          selectedVersionId: null,
          selectedNodeId: null,
          selectedProviderModelId: null,
          attemptCount: 0,
          promptTokens: null,
          completionTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          usageKnown: false,
          // Derived by the database at insert: the requested pool's owner.
          resourceOwnerUserId: "owner",
        },
      ]);
      expect(await reapAbandonedPendingRequests({ prisma: prisma as never, now: NOW })).toBe(1);
      expect(tx.relayRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PENDING" }),
          data: expect.objectContaining({ errorClass: "abandoned" }),
        }),
      );
      const [sql] = tx.$executeRaw.mock.calls[0] as [Sql];
      // owner, requester, then the dimensions: pool … instance (index 7).
      expect(sql.values.slice(1, 4)).toEqual([owner, "requester", pool]);
      expect(sql.values[7]).toBe(instance);
    },
  );

  it("stops draining the abandoned backlog once the shutdown fence is armed", async () => {
    const { prisma, tx } = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([{ id: "relay-1" }, { id: "relay-2" }]);
    tx.$queryRaw.mockResolvedValue([{ now: NOW }]);
    tx.relayRequest.updateMany.mockImplementation(async () => {
      armDbShutdownFence();
      return { count: 1 };
    });
    await expect(
      reapAbandonedPendingRequests({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("stops between batches once the shutdown fence is armed", async () => {
    const { prisma } = fakePrisma();
    armDbShutdownFence();
    await expect(
      deleteExpiredRelayRequests({ prisma: prisma as never, now: NOW, retentionDays: 14 }),
    ).resolves.toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("deletes hourly rollups older than 13 months", async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockResolvedValueOnce(0);
    await deleteExpiredHourRollups({ prisma: prisma as never, now: NOW });
    const [strings, cutoff] = prisma.$executeRaw.mock.calls[0] as [TemplateStringsArray, Date];
    expect(strings.join("?")).toContain("DELETE FROM usage_rollup_hour");
    expect(cutoff).toEqual(new Date(NOW.getTime() - 395 * DAY_MS));
  });

  it("deletes routing verdicts that expired over an hour ago in SKIP LOCKED batches", async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    await expect(
      deleteExpiredRoutingVerdicts({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(3);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    const [strings, cutoff, batch] = prisma.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    expect(strings.join("?")).toContain("DELETE FROM routing_verdict");
    expect(strings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
    expect(cutoff).toEqual(new Date(NOW.getTime() - ROUTING_VERDICT_RETENTION_MS));
    expect(batch).toBe(2);
  });

  it("sweeps KV feedback only after one hour, in bounded SKIP LOCKED batches", async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(await deleteExpiredKvEvictions({ prisma: prisma as never, now: NOW, batch: 2 })).toBe(3);
    const [strings, cutoff, batch] = prisma.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    expect(strings.join("?")).toContain("DELETE FROM capacity_kv_eviction");
    expect(strings.join("?")).toContain('"capacityId" = ANY(ARRAY(');
    expect(strings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
    expect(cutoff).toEqual(new Date(NOW.getTime() - KV_EVICTION_RETENTION_MS));
    expect(batch).toBe(2);
    armDbShutdownFence();
    prisma.$executeRaw.mockClear();
    expect(await deleteExpiredKvEvictions({ prisma: prisma as never, now: NOW })).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("deletes runtime-load minutes older than 8 days in SKIP LOCKED batches", async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(
      await deleteExpiredRuntimeLoadMinutes({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).toBe(3);
    const [strings, cutoff, batch] = prisma.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    expect(strings.join("?")).toContain("DELETE FROM runtime_load_minute");
    expect(strings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
    expect(cutoff).toEqual(new Date(NOW.getTime() - 8 * DAY_MS));
    expect(batch).toBe(2);
    armDbShutdownFence();
    prisma.$executeRaw.mockClear();
    expect(await deleteExpiredRuntimeLoadMinutes({ prisma: prisma as never, now: NOW })).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("deletes node-metrics minutes older than 7 days in SKIP LOCKED batches", async () => {
    const { prisma } = fakePrisma();
    prisma.$executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(
      await deleteExpiredNodeMetricsMinutes({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).toBe(3);
    const [strings, cutoff, batch] = prisma.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      number,
    ];
    expect(strings.join("?")).toContain("DELETE FROM node_metrics_minute");
    expect(strings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
    expect(cutoff).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    expect(batch).toBe(2);
    armDbShutdownFence();
    prisma.$executeRaw.mockClear();
    expect(await deleteExpiredNodeMetricsMinutes({ prisma: prisma as never, now: NOW })).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("moves minute rows older than 30 days into additive hourly upserts in one transaction", async () => {
    const { prisma, tx } = fakePrisma();
    tx.$queryRaw.mockResolvedValueOnce([
      minuteRow(),
      minuteRow({ bucketStart: new Date("2026-08-01T10:55:00.000Z"), errors: 1 }),
      minuteRow({ bucketStart: new Date("2026-08-01T11:02:00.000Z") }),
    ]);
    await expect(
      compactMinuteRollups({ prisma: prisma as never, now: NOW, batch: 10 }),
    ).resolves.toBe(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [strings, cutoff] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, Date];
    expect(strings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
    expect(strings.join("?")).toContain("DELETE FROM usage_rollup_minute");
    expect(cutoff).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
    // Two hour keys (10:00 and 11:00) -> two upserts into the hourly table.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const statements = tx.$executeRaw.mock.calls.map(([sql]) => sql as Sql);
    expect(statements.every((sql) => sql.sql.includes("INSERT INTO usage_rollup_hour"))).toBe(true);
    const tenOClock = statements.find(
      (sql) => (sql.values[0] as Date).toISOString() === "2026-08-01T10:00:00.000Z",
    )!;
    // requests (after bucket, owner, requester, 7 dimensions, source) summed across the
    // two 10:xx minute rows.
    expect(tenOClock.values[11]).toBe(4);
  });

  it("re-keys minute rows to their hour without losing counters", () => {
    const [increment] = hourIncrementsFromMinuteRows([minuteRow() as never]);
    expect(increment?.bucketStart.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(increment).toMatchObject({
      requests: 2,
      inputTokens: 10n,
      durationSumMs: 300n,
      continuationRequests: 1,
      continuationInputTokens: 5n,
      continuationCacheReadTokens: 3n,
    });
    expect(increment?.latencyHistogram[6]).toBe(2);
  });

  it("carries live transcription audio into the hourly rollup", () => {
    const [increment] = hourIncrementsFromMinuteRows([
      minuteRow({ audioInputMs: 61_000n }) as never,
    ]);
    expect(increment?.audioInputMs).toBe(61_000n);
    const [legacy] = hourIncrementsFromMinuteRows([minuteRow() as never]);
    expect(legacy?.audioInputMs).toBe(0n);
  });

  it("returns every column when it moves minute rows", async () => {
    const { prisma, tx } = fakePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]);
    await compactMinuteRollups({ prisma: prisma as never, now: NOW });
    const [strings] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join("?")).toContain("m.*");
  });

  it("reaps abandoned PENDING requests through the guarded transition and counts them once", async () => {
    const { prisma, tx } = fakePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: "relay-1" }, { id: "relay-2" }]);
    tx.$queryRaw.mockResolvedValue([{ now: NOW }]);
    tx.relayRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      count: 0,
    });
    tx.relayRequest.findMany.mockResolvedValue([
      {
        id: "relay-1",
        userId: "user-1",
        status: "FAILED",
        source: "API_KEY",
        startedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        completedAt: NOW,
        durationMs: null,
        firstClientByteAt: null,
        route: "local",
        external: false,
        rejection: null,
        queueWaitMs: null,
        poolId: "pool-1",
        runtimeModelId: null,
        selectedTargetId: null,
        selectedInstanceId: null,
        selectedVersionId: null,
        selectedNodeId: null,
        selectedProviderModelId: null,
        attemptCount: 0,
        promptTokens: null,
        completionTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        usageKnown: false,
      },
    ]);
    await expect(reapAbandonedPendingRequests({ prisma: prisma as never, now: NOW })).resolves.toBe(
      1,
    );
    const [strings, cutoff] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, Date];
    expect(strings.join("?")).toContain("FROM attempt a");
    expect(strings.join("?")).toContain("'ACTIVE'::\"AttemptState\"");
    expect(cutoff).toEqual(new Date(NOW.getTime() - ABANDONED_PENDING_AFTER_MS));
    expect(tx.relayRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "relay-1", status: "PENDING" }),
        data: expect.objectContaining({ status: "FAILED", errorClass: "abandoned" }),
      }),
    );
    // Only the request this sweep transitioned is counted; relay-2 lost the race.
    expect(tx.relayRequest.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("schedules one guarded run and stops cleanly", async () => {
    const run = vi.fn().mockResolvedValue({
      abandonedReaped: 0,
      relayRequestsDeleted: 0,
      minuteRowsCompacted: 0,
      hourRowsDeleted: 0,
      nodeAuditEventsDeleted: 0,
      routingVerdictsDeleted: 0,
      kvEvictionsDeleted: 0,
      runtimeLoadMinutesDeleted: 0,
      nodeMetricsMinutesDeleted: 0,
    });
    const stop = startUsageRetention({ retentionDays: 14, intervalMs: 60_000, run });
    expect(startUsageRetention({ retentionDays: 14, run })).toBe(stop);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ retentionDays: 14 }));
    stop();
  });
});
