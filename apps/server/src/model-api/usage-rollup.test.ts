import { latencyBucketIndex } from "@ws-model-proxy/config/usage-metrics";
import { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";
import {
  mergeRollupIncrements,
  type RelayRollupRow,
  recordRollupsForTransitionedRequests,
  rollupIncrementForRequest,
  rollupUpsertSql,
  transitionRelayRequestTerminal,
  truncateToHour,
  truncateToMinute,
  writeRollupIncrements,
} from "./usage-rollup.js";

// Only the Prisma namespace (Sql builder, error class) is real; the client is
// a deep mock so no test can reach a database.
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://usage-rollup-test", NODE_ENV: "test" },
}));

const startedAt = new Date("2026-09-24T10:15:00.000Z");

function row(overrides: Partial<RelayRollupRow> = {}): RelayRollupRow {
  return {
    id: "relay-1",
    userId: "user-1",
    status: "SUCCEEDED",
    source: "API_TOKEN",
    startedAt,
    completedAt: new Date("2026-09-24T10:15:01.250Z"),
    durationMs: 1250,
    firstClientByteAt: new Date("2026-09-24T10:15:00.400Z"),
    requestedModelPoolId: "pool-1",
    selectedPoolMemberId: "member-1",
    requestedExecutionTargetId: null,
    selectedExecutionTargetId: "target-1",
    attemptCount: 1,
    promptTokens: 100,
    completionTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: null,
    usageKnown: true,
    RequestedModelPool: { userId: "owner-1" },
    SelectedExecutionTarget: { userId: "owner-1" },
    RequestedExecutionTarget: null,
    ...overrides,
  };
}

function recordNotFound() {
  return new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
    code: "P2025",
    clientVersion: "test",
  });
}

describe("rollupIncrementForRequest", () => {
  it("builds one increment keyed on the completion minute", () => {
    const increment = rollupIncrementForRequest(row())!;
    expect(increment.bucketStart.toISOString()).toBe("2026-09-24T10:15:00.000Z");
    expect(increment).toMatchObject({
      ownerUserId: "owner-1",
      requesterUserId: "user-1",
      poolId: "pool-1",
      poolMemberId: "member-1",
      executionTargetId: "target-1",
      source: "API_TOKEN",
      requests: 1,
      successes: 1,
      errors: 0,
      cancels: 0,
      retries: 0,
      usageKnownRequests: 1,
      inputTokens: 100n,
      outputTokens: 20n,
      cacheReadTokens: 60n,
      cacheKnownRequests: 1,
      cacheKnownInputTokens: 100n,
      durationCount: 1,
      durationSumMs: 1250n,
      ttftCount: 1,
      ttftSumMs: 400n,
    });
    expect(increment.latencyHistogram[latencyBucketIndex(1250)]).toBe(1);
    expect(increment.ttftHistogram[latencyBucketIndex(400)]).toBe(1);
    expect(increment.latencyHistogram.reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it("maps missing identities to the '' sentinel (never NULL)", () => {
    const increment = rollupIncrementForRequest(
      row({
        requestedModelPoolId: null,
        selectedPoolMemberId: null,
        selectedExecutionTargetId: null,
        requestedExecutionTargetId: null,
      }),
    )!;
    expect(increment.poolId).toBe("");
    expect(increment.poolMemberId).toBe("");
    expect(increment.executionTargetId).toBe("");
  });

  it("falls back to the requested execution target for direct requests", () => {
    const increment = rollupIncrementForRequest(
      row({ selectedExecutionTargetId: null, requestedExecutionTargetId: "requested" }),
    )!;
    expect(increment.executionTargetId).toBe("requested");
  });

  it("keys the resource owner (pool, else target, else requester) and the requester", () => {
    const pooled = rollupIncrementForRequest(row())!;
    expect([pooled.ownerUserId, pooled.requesterUserId]).toEqual(["owner-1", "user-1"]);
    const direct = rollupIncrementForRequest(
      row({
        requestedModelPoolId: null,
        RequestedModelPool: null,
        SelectedExecutionTarget: { userId: "target-owner" },
      }),
    )!;
    expect(direct.ownerUserId).toBe("target-owner");
    const requestedOnly = rollupIncrementForRequest(
      row({
        requestedModelPoolId: null,
        RequestedModelPool: null,
        selectedExecutionTargetId: null,
        SelectedExecutionTarget: null,
        requestedExecutionTargetId: "requested",
        RequestedExecutionTarget: { userId: "requested-owner" },
      }),
    )!;
    expect(requestedOnly.ownerUserId).toBe("requested-owner");
    const unresolved = rollupIncrementForRequest(
      row({
        requestedModelPoolId: null,
        RequestedModelPool: null,
        selectedExecutionTargetId: null,
        SelectedExecutionTarget: null,
      }),
    )!;
    expect(unresolved.ownerUserId).toBe("user-1");
  });

  it("classifies failures, cancels, and retries", () => {
    expect(rollupIncrementForRequest(row({ status: "FAILED", attemptCount: 3 }))).toMatchObject({
      successes: 0,
      errors: 1,
      cancels: 0,
      retries: 2,
    });
    expect(rollupIncrementForRequest(row({ status: "CANCELED" }))).toMatchObject({
      errors: 0,
      cancels: 1,
    });
  });

  it("never counts a PENDING row", () => {
    expect(rollupIncrementForRequest(row({ status: "PENDING" }))).toBeNull();
  });

  it("keeps unmeasured durations and TTFT out of the latency histograms", () => {
    const increment = rollupIncrementForRequest(
      row({ durationMs: null, firstClientByteAt: null, status: "FAILED" }),
    )!;
    expect(increment.durationCount).toBe(0);
    expect(increment.ttftCount).toBe(0);
    expect(increment.latencyHistogram.every((value) => value === 0)).toBe(true);
    expect(increment.ttftHistogram.every((value) => value === 0)).toBe(true);
  });

  it("does not count cache when the upstream did not report it, or usage is unknown", () => {
    expect(rollupIncrementForRequest(row({ cacheReadTokens: null }))).toMatchObject({
      cacheKnownRequests: 0,
      cacheKnownInputTokens: 0n,
      cacheReadTokens: 0n,
      usageKnownRequests: 1,
    });
    expect(
      rollupIncrementForRequest(
        row({ usageKnown: false, promptTokens: null, cacheReadTokens: null }),
      ),
    ).toMatchObject({ usageKnownRequests: 0, inputTokens: 0n, cacheKnownRequests: 0 });
  });
});

describe("merge and SQL", () => {
  it("merges increments with the same composite key", () => {
    const first = rollupIncrementForRequest(row())!;
    const second = rollupIncrementForRequest(row({ id: "relay-2", status: "FAILED" }))!;
    const other = rollupIncrementForRequest(row({ selectedPoolMemberId: "member-2" }))!;
    const merged = mergeRollupIncrements([first, second, other]);
    expect(merged).toHaveLength(2);
    const combined = merged.find((increment) => increment.poolMemberId === "member-1")!;
    expect(combined.requests).toBe(2);
    expect(combined.errors).toBe(1);
    expect(combined.latencyHistogram[latencyBucketIndex(1250)]).toBe(2);
    // Inputs are not mutated.
    expect(first.requests).toBe(1);
  });

  it("upserts additively on the full composite key", () => {
    const sql = rollupUpsertSql("usage_rollup_minute", rollupIncrementForRequest(row())!);
    const text = sql.sql.replace(/\s+/g, " ");
    expect(text).toContain("INSERT INTO usage_rollup_minute");
    expect(text).toContain(
      'ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", "poolId", "poolMemberId", "executionTargetId", "source") DO UPDATE SET',
    );
    expect(text).toContain('"requests" = usage_rollup_minute."requests" + EXCLUDED."requests"');
    expect(text).toContain(
      'unnest(usage_rollup_minute."latencyHistogram", EXCLUDED."latencyHistogram")',
    );
    // Prompt-free parameters only.
    expect(sql.values).toContain("pool-1");
    expect(sql.values.some((value) => typeof value === "string" && value.includes("prompt"))).toBe(
      false,
    );
  });

  it("writes one statement per merged key in sorted order", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const written = await writeRollupIncrements(tx, "usage_rollup_hour", [
      rollupIncrementForRequest(row({ selectedPoolMemberId: "b" }))!,
      rollupIncrementForRequest(row({ selectedPoolMemberId: "a" }))!,
      rollupIncrementForRequest(row({ selectedPoolMemberId: "a" }))!,
    ]);
    expect(written).toBe(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const members = tx.$executeRaw.mock.calls.map(([sql]) => (sql as Prisma.Sql).values[4]);
    expect(members).toEqual(["a", "b"]);
  });

  it("orders keys by code point, not locale collation", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    // localeCompare would put "a" before "B"; code-point order is "B" < "a".
    await writeRollupIncrements(tx, "usage_rollup_minute", [
      rollupIncrementForRequest(row({ selectedPoolMemberId: "a" }))!,
      rollupIncrementForRequest(row({ selectedPoolMemberId: "B" }))!,
    ]);
    const members = tx.$executeRaw.mock.calls.map(([sql]) => (sql as Prisma.Sql).values[4]);
    expect(members).toEqual(["B", "a"]);
  });

  it("truncates bucket boundaries", () => {
    const value = new Date("2026-09-24T10:15:42.123Z");
    expect(truncateToMinute(value).toISOString()).toBe("2026-09-24T10:15:00.000Z");
    expect(truncateToHour(value).toISOString()).toBe("2026-09-24T10:00:00.000Z");
  });
});

describe("transitionRelayRequestTerminal (exactly-once claim)", () => {
  it("guards on PENDING and records exactly one increment when it transitions", async () => {
    const tx = {
      relayRequest: { update: vi.fn().mockResolvedValue(row()) },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    await expect(
      transitionRelayRequestTerminal(tx, "relay-1", { status: "SUCCEEDED" }),
    ).resolves.toBe(true);
    expect(tx.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "relay-1", status: "PENDING" } }),
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when another finalizer already won (duplicate finalization)", async () => {
    const tx = {
      relayRequest: { update: vi.fn().mockRejectedValue(recordNotFound()) },
      $executeRaw: vi.fn(),
    };
    await expect(transitionRelayRequestTerminal(tx, "relay-1", { status: "FAILED" })).resolves.toBe(
      false,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("counts once across a success followed by a late failure finalization", async () => {
    let status: RelayRollupRow["status"] = "PENDING";
    const update = vi.fn();
    update.mockImplementation(
      async (args: { where: { status?: string }; data: { status: RelayRollupRow["status"] } }) => {
        if (args.where.status !== status) throw recordNotFound();
        status = args.data.status;
        return row({ status });
      },
    );
    const tx = { relayRequest: { update }, $executeRaw: vi.fn().mockResolvedValue(1) };
    await transitionRelayRequestTerminal(tx, "relay-1", { status: "SUCCEEDED" });
    await transitionRelayRequestTerminal(tx, "relay-1", { status: "FAILED" });
    await transitionRelayRequestTerminal(tx, "relay-1", { status: "CANCELED" });
    expect(status).toBe("SUCCEEDED");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("propagates unexpected errors so the transaction rolls back", async () => {
    const tx = {
      relayRequest: { update: vi.fn().mockRejectedValue(new Error("connection lost")) },
      $executeRaw: vi.fn(),
    };
    await expect(
      transitionRelayRequestTerminal(tx, "relay-1", { status: "FAILED" }),
    ).rejects.toThrow("connection lost");
  });

  it("records rollups only for rows the caller transitioned", async () => {
    const tx = {
      relayRequest: { findMany: vi.fn().mockResolvedValue([row()]) },
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    await expect(recordRollupsForTransitionedRequests(tx, [])).resolves.toBe(0);
    expect(tx.relayRequest.findMany).not.toHaveBeenCalled();
    await expect(recordRollupsForTransitionedRequests(tx, ["relay-1"])).resolves.toBe(1);
    expect(tx.relayRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["relay-1"] }, status: { not: "PENDING" } } }),
    );
  });
});
