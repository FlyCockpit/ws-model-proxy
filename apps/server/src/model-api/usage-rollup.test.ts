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
    route: "local",
    external: false,
    rejection: null,
    source: "API_KEY",
    startedAt,
    completedAt: new Date("2026-09-24T10:15:01.250Z"),
    durationMs: 1250,
    firstClientByteAt: new Date("2026-09-24T10:15:00.400Z"),
    queueWaitMs: null,
    poolId: "pool-1",
    runtimeModelId: "model-1",
    selectedTargetId: "target-1",
    selectedInstanceId: "instance-1",
    selectedVersionId: "version-1",
    selectedNodeId: "node-1",
    selectedProviderModelId: null,
    attemptCount: 1,
    promptTokens: 100,
    completionTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: null,
    usageKnown: true,
    affinityOutcome: "PREDICTED_MATCH",
    operation: null,
    audioInputMs: null,
    contextTokenCount: null,
    // Derived by the database at insert (schema-hardening.sql): the pool owner.
    resourceOwnerUserId: "owner-1",
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
  it("counts live transcription audio and keeps session wall time out of latency", () => {
    const realtime = rollupIncrementForRequest(
      row({
        operation: "audio.realtime_transcription",
        durationMs: 900_000,
        audioInputMs: 812_000,
      }),
    );
    expect(realtime).toMatchObject({
      requests: 1,
      durationCount: 0,
      durationSumMs: 0n,
      audioInputMs: 812_000n,
    });
    expect(realtime?.latencyHistogram.every((count) => count === 0)).toBe(true);
    const http = rollupIncrementForRequest(
      row({ operation: "audio.transcriptions", durationMs: 900 }),
    );
    expect(http).toMatchObject({ durationCount: 1, durationSumMs: 900n, audioInputMs: 0n });
    const sql = rollupUpsertSql("usage_rollup_minute", realtime!);
    expect(sql.sql).toContain(
      '"audioInputMs" = usage_rollup_minute."audioInputMs" + EXCLUDED."audioInputMs"',
    );
    expect(sql.values).toContain(812_000n);
  });

  it("builds one increment keyed on the completion minute", () => {
    const increment = rollupIncrementForRequest(row())!;
    expect(increment.bucketStart.toISOString()).toBe("2026-09-24T10:15:00.000Z");
    expect(increment).toMatchObject({
      ownerUserId: "owner-1",
      requesterUserId: "user-1",
      poolId: "pool-1",
      instanceId: "instance-1",
      runtimeModelId: "model-1",
      versionId: "version-1",
      nodeId: "node-1",
      providerModelId: "",
      source: "API_KEY",
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
      continuationRequests: 1,
      continuationInputTokens: 100n,
      continuationCacheReadTokens: 60n,
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
        poolId: null,
        runtimeModelId: null,
        selectedInstanceId: null,
        selectedVersionId: null,
        selectedNodeId: null,
      }),
    )!;
    expect(increment.poolId).toBe("");
    expect(increment.instanceId).toBe("");
    expect(increment.runtimeModelId).toBe("");
    expect(increment.versionId).toBe("");
    expect(increment.nodeId).toBe("");
    // B5 fills the runtime from the instance; until then it is the '' sentinel.
    expect(increment.runtimeId).toBe("");
  });

  it("counts cloud requests and refusals by reason family", () => {
    expect(rollupIncrementForRequest(row({ external: true, route: "cloud" }))).toMatchObject({
      cloudRequests: 1,
    });
    expect(
      rollupIncrementForRequest(row({ status: "FAILED", rejection: "context_too_large" })),
    ).toMatchObject({ rejectedContext: 1, rejectedCapacity: 0, rejectedOther: 0 });
    expect(
      rollupIncrementForRequest(row({ status: "FAILED", rejection: "capacity_wait_expired" })),
    ).toMatchObject({ rejectedCapacity: 1 });
    expect(
      rollupIncrementForRequest(row({ status: "FAILED", rejection: "no_member" })),
    ).toMatchObject({ rejectedOther: 1 });
  });

  it("keys the stored resource owner (else the requester) and the requester", () => {
    // The database derives resourceOwnerUserId at insert (pool owner, else
    // target owner); the rollup reads it by value and never joins the graph.
    const pooled = rollupIncrementForRequest(row())!;
    expect([pooled.ownerUserId, pooled.requesterUserId]).toEqual(["owner-1", "user-1"]);
    const direct = rollupIncrementForRequest(
      row({ poolId: null, resourceOwnerUserId: "target-owner" }),
    )!;
    expect(direct.ownerUserId).toBe("target-owner");
    const unresolved = rollupIncrementForRequest(
      row({
        poolId: null,
        selectedTargetId: null,
        resourceOwnerUserId: null,
      }),
    )!;
    expect(unresolved.ownerUserId).toBe("user-1");
  });

  it("prefers the durable resource owner, which survives the pool's deletion", () => {
    // The pool was deleted in flight and the selection is gone; the owner
    // stored at insert still attributes the traffic to the pool owner.
    const orphaned = rollupIncrementForRequest(
      row({
        resourceOwnerUserId: "owner-1",
        poolId: null,
        selectedTargetId: null,
        selectedInstanceId: null,
      }),
    )!;
    expect(orphaned).toMatchObject({
      ownerUserId: "owner-1",
      requesterUserId: "user-1",
      poolId: "",
      instanceId: "",
    });
    // Own-key traffic stays with the requester even though the stored owner
    // is the pool owner.
    expect(
      rollupIncrementForRequest(
        row({
          resourceOwnerUserId: "owner-1",
          route: "own_key",
        }),
      )!.ownerUserId,
    ).toBe("user-1");
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
      continuationRequests: 0,
      continuationInputTokens: 0n,
      continuationCacheReadTokens: 0n,
      usageKnownRequests: 1,
    });
    expect(
      rollupIncrementForRequest(
        row({ usageKnown: false, promptTokens: null, cacheReadTokens: null }),
      ),
    ).toMatchObject({ usageKnownRequests: 0, inputTokens: 0n, cacheKnownRequests: 0 });
  });

  it("increments continuation columns only for matched affinity with cache fields", () => {
    expect(rollupIncrementForRequest(row({ affinityOutcome: "NO_MATCH" }))).toMatchObject({
      cacheKnownRequests: 1,
      continuationRequests: 0,
      continuationInputTokens: 0n,
      continuationCacheReadTokens: 0n,
    });
    expect(rollupIncrementForRequest(row({ affinityOutcome: "HOLDER_SPILLED" }))).toMatchObject({
      continuationRequests: 0,
    });
    expect(rollupIncrementForRequest(row({ affinityOutcome: "HOLDER_WAITED" }))).toMatchObject({
      continuationRequests: 1,
      continuationInputTokens: 100n,
      continuationCacheReadTokens: 60n,
    });
    expect(rollupIncrementForRequest(row({ affinityOutcome: null }))).toMatchObject({
      continuationRequests: 0,
    });
  });
});

describe("merge and SQL", () => {
  it("merges increments with the same composite key", () => {
    const first = rollupIncrementForRequest(row())!;
    const second = rollupIncrementForRequest(row({ id: "relay-2", status: "FAILED" }))!;
    const other = rollupIncrementForRequest(row({ selectedInstanceId: "instance-2" }))!;
    const merged = mergeRollupIncrements([first, second, other]);
    expect(merged).toHaveLength(2);
    const combined = merged.find((increment) => increment.instanceId === "instance-1")!;
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
      'ON CONFLICT ("bucketStart", "ownerUserId", "requesterUserId", "poolId", "runtimeId", "versionId", "nodeId", "instanceId", "runtimeModelId", "providerModelId", "source") DO UPDATE SET',
    );
    expect(text).toContain('"requests" = usage_rollup_minute."requests" + EXCLUDED."requests"');
    // The owner key is a plain durable id: a deleted owner's increment is skipped.
    expect(text).toContain('WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ');
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
      rollupIncrementForRequest(row({ selectedInstanceId: "b" }))!,
      rollupIncrementForRequest(row({ selectedInstanceId: "a" }))!,
      rollupIncrementForRequest(row({ selectedInstanceId: "a" }))!,
    ]);
    expect(written).toBe(2);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    // Values: bucket, owner, requester, then pool, runtime, version, node, instance (index 7).
    const members = tx.$executeRaw.mock.calls.map(([sql]) => (sql as Prisma.Sql).values[7]);
    expect(members).toEqual(["a", "b"]);
  });

  it("orders keys by code point, not locale collation", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    // localeCompare would put "a" before "B"; code-point order is "B" < "a".
    await writeRollupIncrements(tx, "usage_rollup_minute", [
      rollupIncrementForRequest(row({ selectedInstanceId: "a" }))!,
      rollupIncrementForRequest(row({ selectedInstanceId: "B" }))!,
    ]);
    const members = tx.$executeRaw.mock.calls.map(([sql]) => (sql as Prisma.Sql).values[7]);
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

it("own-key rollups belong to requester and omit the owner's pool", () => {
  const increment = rollupIncrementForRequest(row({ route: "own_key" }));
  expect(increment).toMatchObject({
    ownerUserId: "user-1",
    requesterUserId: "user-1",
    poolId: "",
  });
});
