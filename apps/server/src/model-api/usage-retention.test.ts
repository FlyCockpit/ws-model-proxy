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
  pruneTerminalCapacityHistory: vi.fn(),
  purgeDeletedUsersHistory: vi.fn(),
  pruneOrphanCapacityRuntime: vi.fn(),
  pruneExpiredStickiness: vi.fn(),
}));
vi.mock("@ws-model-proxy/db/hot-path-sweeps", () => sweeps);

const {
  ABANDONED_PENDING_AFTER_MS,
  compactMinuteRollups,
  deleteExpiredCliAgentActions,
  deleteExpiredHourRollups,
  deleteExpiredRelayRequests,
  hourIncrementsFromMinuteRows,
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
    poolMemberId: "member-1",
    executionTargetId: "target-1",
    source: "API_TOKEN",
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
    sweeps.pruneOrphanCapacityRuntime.mockReset().mockResolvedValue(0);
    sweeps.pruneExpiredStickiness.mockReset().mockResolvedValue(0);
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
      agentActionsDeleted: 0,
      admissionHistoryPruned: 0,
      deletedUserRowsPurged: 0,
      orphanCapacityRuntimeDeleted: 0,
      expiredStickinessDeleted: 0,
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("runs the agent audit step in every sweep and reports its count", async () => {
    const { prisma, tx } = fakePrisma();
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("clock_timestamp") ? [{ now: NOW }] : [],
    );
    prisma.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("cli_agent_action_event") ? 4 : 0,
    );
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      runUsageRetention({ prisma: prisma as never, retentionDays: 14, batch: 100 }),
    ).resolves.toMatchObject({ agentActionsDeleted: 4 });
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
    sweeps.pruneOrphanCapacityRuntime.mockImplementation(async () => {
      order.push("orphan-runtime");
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
      orphanCapacityRuntimeDeleted: 3,
      expiredStickinessDeleted: 5,
    });
    // Terminal admission history uses the relay-request retention window.
    expect(sweeps.pruneTerminalCapacityHistory).toHaveBeenCalledWith(prisma, {
      before: new Date(NOW.getTime() - 14 * DAY_MS),
      batch: 50,
    });
    expect(sweeps.purgeDeletedUsersHistory).toHaveBeenCalledWith(prisma, { now: NOW, batch: 50 });
    expect(sweeps.pruneOrphanCapacityRuntime).toHaveBeenCalledWith(prisma, { batch: 50 });
    expect(sweeps.pruneExpiredStickiness).toHaveBeenCalledWith(prisma, { now: NOW, batch: 50 });
    expect(order.slice(-4)).toEqual([
      "admission-history",
      "deleted-users",
      "orphan-runtime",
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
    // Capacity lock order: the referencing admission_request rows are taken
    // first, then the relay rows; both SKIP LOCKED, so the delete never waits
    // on a row an in-flight admission holds.
    const [pick, lockAdmissions, countAdmissions, remove] = statements;
    expect(pick).toContain("FROM relay_request");
    expect(lockAdmissions).toContain("FROM admission_request");
    expect(lockAdmissions).toContain("FOR NO KEY UPDATE SKIP LOCKED");
    expect(countAdmissions).toContain("count(*)");
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
    ["send-intent", "own-key", "requester", "", "own-target"],
    ["superseded-intent", "local", "owner", "pool", "local-target"],
  ])(
    "reaps %s using the durable route identity without attributing unsent own-key work",
    async (_stage, route, owner, pool, target) => {
      const { prisma, tx } = fakePrisma();
      prisma.$queryRaw.mockResolvedValue([{ id: "request" }]);
      tx.$queryRaw.mockResolvedValue([{ now: NOW }]);
      tx.relayRequest.findMany.mockResolvedValue([
        {
          id: "request",
          userId: "requester",
          status: "FAILED",
          source: "API_TOKEN",
          fallbackRoute: route,
          startedAt: new Date(NOW.getTime() - 3_600_000),
          completedAt: NOW,
          firstClientByteAt: null,
          durationMs: null,
          requestedModelPoolId: "pool",
          selectedPoolMemberId: route === "local" && target ? "local-member" : null,
          requestedExecutionTargetId: null,
          selectedExecutionTargetId: target || null,
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
      expect(sql.values.slice(1, 6)).toEqual([
        owner,
        "requester",
        pool,
        route === "local" && target ? "local-member" : "",
        target,
      ]);
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
    // requests summed across the two 10:xx minute rows.
    expect(tenOClock.values[7]).toBe(4);
  });

  it("re-keys minute rows to their hour without losing counters", () => {
    const [increment] = hourIncrementsFromMinuteRows([minuteRow() as never]);
    expect(increment?.bucketStart.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(increment).toMatchObject({ requests: 2, inputTokens: 10n, durationSumMs: 300n });
    expect(increment?.latencyHistogram[6]).toBe(2);
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
        source: "API_TOKEN",
        startedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        completedAt: NOW,
        durationMs: null,
        firstClientByteAt: null,
        requestedModelPoolId: "pool-1",
        selectedPoolMemberId: null,
        requestedExecutionTargetId: null,
        selectedExecutionTargetId: null,
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
    expect(strings.join("?")).toContain("relay_execution_attempt");
    expect(strings.join("?")).toContain("provider_attempt");
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

  it("deletes agent audit events past 90 days in SKIP LOCKED batches and stops at the fence", async () => {
    const { prisma } = fakePrisma();
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    let round = 0;
    prisma.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        round += 1;
        return round === 1 ? 2 : 1;
      },
    );
    await expect(
      deleteExpiredCliAgentActions({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(3);
    expect(statements).toHaveLength(2);
    const [first] = statements;
    expect(first?.sql).toContain("DELETE FROM cli_agent_action_event");
    expect(first?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(first?.values[0]).toEqual(new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000));
    expect(first?.values[1]).toBe(2);

    armDbShutdownFence();
    statements.length = 0;
    await expect(
      deleteExpiredCliAgentActions({ prisma: prisma as never, now: NOW, batch: 2 }),
    ).resolves.toBe(0);
    expect(statements).toEqual([]);
  });

  it("schedules one guarded run and stops cleanly", async () => {
    const run = vi.fn().mockResolvedValue({
      abandonedReaped: 0,
      relayRequestsDeleted: 0,
      minuteRowsCompacted: 0,
      hourRowsDeleted: 0,
      agentActionsDeleted: 0,
    });
    const stop = startUsageRetention({ retentionDays: 14, intervalMs: 60_000, run });
    expect(startUsageRetention({ retentionDays: 14, run })).toBe(stop);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ retentionDays: 14 }));
    stop();
  });
});
