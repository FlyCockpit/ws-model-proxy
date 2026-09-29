import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  POOL_MEMBER_HALF_OPEN_LEASE_MS,
  buildPoolRouteSequence,
  isRetryablePoolMemberRelayFailure,
  markPoolMemberHalfOpenTrial,
  markPoolMemberRelaySuccess,
  markPoolMembersDueAfterCliReconnect,
  abandonPoolMemberRecoveryTrial,
  disconnectCliDeviceAtGeneration,
  markPoolMembersForCliUnavailable,
  poolMemberFailureClassForRelayFailure,
  poolMemberTrialLive,
  recordPoolMemberRelayFailure,
  releasePoolMemberHalfOpenTrial,
  resetPoolMemberHealth,
  resetPoolMemberHealthForDiscoveredModels,
  selectPoolRouteSequence,
  transitionPoolMemberHealthAfterRetryableFailure,
} = await import("./model-pool-routing");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  poolMember: {
    findMany: MockInstance;
    findUnique: MockInstance;
    updateMany: MockInstance;
  };
};

type PoolMemberRouteRow = Parameters<typeof buildPoolRouteSequence>[0]["members"][number];

const now = new Date("2026-01-01T00:00:00.000Z");

function memberRow({
  id,
  weight = 1,
  healthStatus = "HEALTHY",
  routingStatus = "ACTIVE",
  cliDeviceId = "cli-1",
  published = true,
  endpointPublished = true,
  cliStatus = "CONNECTED",
  nextRetryAt = null,
  halfOpenTrialStartedAt = null,
}: {
  id: string;
  weight?: number;
  healthStatus?: PoolMemberRouteRow["healthStatus"];
  routingStatus?: PoolMemberRouteRow["routingStatus"];
  cliDeviceId?: string;
  published?: boolean;
  endpointPublished?: boolean;
  cliStatus?: string;
  nextRetryAt?: Date | null;
  halfOpenTrialStartedAt?: Date | null;
}): PoolMemberRouteRow {
  return {
    id,
    poolId: "pool-1",
    discoveredModelId: `${id}-model`,
    weight,
    healthStatus,
    routingStatus,
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt,
    halfOpenTrialStartedAt,
    DiscoveredModel: {
      published,
      upstreamModelId: `${id}-upstream`,
      Endpoint: {
        id: `${id}-endpoint`,
        slug: `${id}-endpoint`,
        published: endpointPublished,
        cliDeviceId,
        status: "ONLINE",
        CliDevice: { status: cliStatus },
      },
    },
  };
}

describe("modelPoolRouting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a request right after a reconnect (disconnect -> reconnect -> routable)", async () => {
    // AC #113's acceptance sentence ("disconnect, reconnect, and a request
    // succeeds within about 2 s") composed across the real writers and the real
    // routing decision, driven by the logical chain rather than wall-clock
    // timing: a disconnect parks the members for the full 60 s cooldown, the
    // reconnect hello's due-write pulls them due, and the same members read as
    // routable to the dispatcher (via -- but not limited to -- the
    // UNHEALTHY+HALF_OPEN path).
    const cooldownUntil = new Date(now.getTime() + 60_000);
    const members: PoolMemberRouteRow[] = [
      memberRow({ id: "member-a", healthStatus: "UNHEALTHY", nextRetryAt: cooldownUntil }),
    ];
    const selectFor = async () => {
      const result = await selectPoolRouteSequence({
        poolId: "pool-1",
        activeCliDeviceIds: ["cli-1"],
        now,
      });
      return result.ok ? result.candidates.map((candidate) => candidate.poolMemberId) : [];
    };
    // The stored rows selectPoolRouteSequence -> routablePoolMembers sees after
    // each write. The mock applies the same conditional transition each
    // writer's SQL does: a due-write only moves a still-cooling member, so if
    // the transition's own predicate regresses the member stays cooling and
    // the routable assertion below fails.
    db.poolMember.findMany.mockImplementation(async () => members);
    db.poolMember.updateMany.mockImplementation(
      async (arg: { where: { healthStatus?: string }; data: { nextRetryAt?: Date } }) => {
        const dueWrite = arg.data?.nextRetryAt !== undefined;
        let matched = 0;
        for (const member of members) {
          if (dueWrite) {
            const cooling =
              member.nextRetryAt !== null && member.nextRetryAt.getTime() > now.getTime();
            if (member.healthStatus !== "UNHEALTHY" || !cooling) continue;
            member.nextRetryAt = arg.data.nextRetryAt ?? null;
          }
          matched += 1;
        }
        return { count: matched };
      },
    );

    // Before the reconnect: the cooldown still holds the member back.
    expect(await selectFor()).toEqual([]);

    const due = await markPoolMembersDueAfterCliReconnect({ cliDeviceId: "cli-1", now });
    expect(due).toBe(1);
    // The same member is now a routable HALF_OPEN candidate.
    const route = await selectPoolRouteSequence({
      poolId: "pool-1",
      activeCliDeviceIds: ["cli-1"],
      now,
    });
    expect(route).toMatchObject({
      ok: true,
      candidates: [{ poolMemberId: "member-a", healthStatus: "HALF_OPEN" }],
    });
  });

  it("routes a single healthy connected pool member", () => {
    const result = buildPoolRouteSequence({
      members: [memberRow({ id: "member-a" })],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: [
        {
          poolMemberId: "member-a",
          discoveredModelId: "member-a-model",
          cliDeviceId: "cli-1",
          weight: 1,
          healthStatus: "HEALTHY",
        },
      ],
      state: { "member-a": 0 },
    });
  });

  it("routes newly added UNKNOWN members as fully eligible", () => {
    const result = buildPoolRouteSequence({
      members: [memberRow({ id: "new-member", healthStatus: "UNKNOWN" })],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: [{ poolMemberId: "new-member", healthStatus: "HEALTHY" }],
    });
  });

  it("uses the bounded autonomous recovery backoff schedule", async () => {
    const { poolMemberRecoveryDelayMs } = await import("./model-pool-routing");
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(poolMemberRecoveryDelayMs)).toEqual([
      1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("allows a single degraded member through the normal availability gates once due", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({
          id: "degraded-member",
          healthStatus: "DEGRADED",
          nextRetryAt: new Date(now.getTime() - 1),
        }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: [{ poolMemberId: "degraded-member", healthStatus: "HALF_OPEN" }],
    });
  });

  it("does not bypass the degraded backoff, even when it is the only configured member", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({
          id: "degraded-member",
          healthStatus: "DEGRADED",
          nextRetryAt: new Date(now.getTime() + 1),
        }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result.ok).toBe(false);
  });

  it("uses smooth weighted round-robin with injected deterministic state", () => {
    const members = [memberRow({ id: "member-a", weight: 3 }), memberRow({ id: "member-b" })];
    let state = {};
    const selected: string[] = [];

    for (let index = 0; index < 8; index += 1) {
      const result = buildPoolRouteSequence({
        members,
        activeCliDeviceIds: ["cli-1"],
        now,
        state,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        selected.push(result.candidates[0]?.poolMemberId ?? "");
        state = result.state;
      }
    }

    expect(selected).toEqual([
      "member-a",
      "member-a",
      "member-b",
      "member-a",
      "member-a",
      "member-a",
      "member-b",
      "member-a",
    ]);
  });

  it("skips disabled, disconnected, absent, and unhealthy members", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({ id: "healthy" }),
        memberRow({ id: "disabled", routingStatus: "DISABLED" }),
        memberRow({ id: "disconnected", cliStatus: "DISCONNECTED" }),
        memberRow({ id: "absent", cliDeviceId: "cli-absent" }),
        memberRow({
          id: "unhealthy",
          healthStatus: "UNHEALTHY",
          nextRetryAt: new Date(now.getTime() + 1_000),
        }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates.map((candidate) => candidate.poolMemberId)).toEqual(["healthy"]);
    }
  });

  it("allows a cooldown-expired unhealthy member as exactly one half-open failover candidate", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({
          id: "half-open",
          healthStatus: "UNHEALTHY",
          nextRetryAt: new Date(now.getTime() - 1),
        }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: [{ poolMemberId: "half-open", healthStatus: "HALF_OPEN" }],
    });
  });

  it("skips half-open members whose single trial has already been claimed", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({
          id: "claimed-half-open",
          healthStatus: "HALF_OPEN",
          halfOpenTrialStartedAt: now,
        }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toEqual({
      ok: false,
      reason: "NO_ROUTABLE_POOL_MEMBERS",
      failureClass: "no_routable_member",
      retryable: true,
    });
  });

  // Deterministic clock: every instant is `now` plus an explicit offset.
  it.each([
    ["never claimed", null, true],
    ["claimed just now", 0, false],
    ["one ms before the lease elapses", -(POOL_MEMBER_HALF_OPEN_LEASE_MS - 1), false],
    ["exactly at the lease cutoff", -POOL_MEMBER_HALF_OPEN_LEASE_MS, true],
    ["one ms past the lease", -(POOL_MEMBER_HALF_OPEN_LEASE_MS + 1), true],
    ["claimed in the future (clock skew)", 1_000, false],
  ] as const)("routes a half-open member whose trial is %s: %s", (_name, offset, routable) => {
    const startedAt = offset === null ? null : new Date(now.getTime() + offset);
    const result = buildPoolRouteSequence({
      members: [
        memberRow({ id: "member", healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: startedAt }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });
    expect(result.ok).toBe(routable);
    expect(poolMemberTrialLive(startedAt, now)).toBe(!routable);
  });

  it("claims an unclaimed or expired half-open trial, complementing the routing lease predicate", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });
    await markPoolMemberHalfOpenTrial({ poolMemberId: "member-id", now });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: null },
          {
            healthStatus: "HALF_OPEN",
            halfOpenTrialStartedAt: {
              lte: new Date(now.getTime() - POOL_MEMBER_HALF_OPEN_LEASE_MS),
            },
          },
        ]),
      }),
      data: { healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: now },
    });
  });

  it("fences a release on the claim's own timestamp", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      releasePoolMemberHalfOpenTrial({ poolMemberId: "member-id", trialStartedAt: now }),
    ).resolves.toBe(false);
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: { id: "member-id", healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: now },
      data: { halfOpenTrialStartedAt: null },
    });
  });

  it("returns a typed no-routable-member result when every candidate is skipped", () => {
    const result = buildPoolRouteSequence({
      members: [memberRow({ id: "absent", cliDeviceId: "cli-absent" })],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toEqual({
      ok: false,
      reason: "NO_ROUTABLE_POOL_MEMBERS",
      failureClass: "no_routable_member",
      retryable: true,
    });
  });

  it("skips unpublished models and endpoints", () => {
    const result = buildPoolRouteSequence({
      members: [
        memberRow({ id: "unpublished-model", published: false }),
        memberRow({ id: "unpublished-endpoint", endpointPublished: false }),
      ],
      activeCliDeviceIds: ["cli-1"],
      now,
    });

    expect(result).toEqual({
      ok: false,
      reason: "NO_ROUTABLE_POOL_MEMBERS",
      failureClass: "no_routable_member",
      retryable: true,
    });
  });

  it("maps only retryable relay failures to member health failure classes", () => {
    expect(poolMemberFailureClassForRelayFailure("transport")).toBe("TRANSPORT");
    expect(poolMemberFailureClassForRelayFailure("timeout")).toBe("RELAY_TIMEOUT");
    expect(poolMemberFailureClassForRelayFailure("disconnected")).toBe("WEBSOCKET_DISCONNECTED");
    expect(poolMemberFailureClassForRelayFailure("upstream_5xx")).toBe("UPSTREAM_5XX");
    expect(poolMemberFailureClassForRelayFailure("protocol_error")).toBe("TRANSPORT");
    expect(poolMemberFailureClassForRelayFailure("upstream_4xx")).toBeNull();
    expect(poolMemberFailureClassForRelayFailure("access_denied")).toBeNull();
    expect(poolMemberFailureClassForRelayFailure("not_found")).toBeNull();
    expect(isRetryablePoolMemberRelayFailure("unsupported_capability")).toBe(false);
  });

  it("moves to unhealthy after three retryable failures and re-cools down failed half-open trials", () => {
    const first = transitionPoolMemberHealthAfterRetryableFailure({
      member: {
        healthStatus: "HEALTHY",
        lastFailureClass: null,
        consecutiveRetryableFailures: 0,
        lastFailureAt: null,
        nextRetryAt: null,
        halfOpenTrialStartedAt: null,
      },
      failureClass: "TRANSPORT",
      now,
    });
    const second = transitionPoolMemberHealthAfterRetryableFailure({
      member: first,
      failureClass: "RELAY_TIMEOUT",
      now,
    });
    const third = transitionPoolMemberHealthAfterRetryableFailure({
      member: second,
      failureClass: "UPSTREAM_5XX",
      now,
    });

    expect(first).toMatchObject({ healthStatus: "DEGRADED", consecutiveRetryableFailures: 1 });
    expect(second).toMatchObject({ healthStatus: "DEGRADED", consecutiveRetryableFailures: 2 });
    expect(third).toEqual({
      healthStatus: "UNHEALTHY",
      lastFailureClass: "UPSTREAM_5XX",
      consecutiveRetryableFailures: 3,
      lastFailureAt: now,
      nextRetryAt: new Date(now.getTime() + 5_000),
      halfOpenTrialStartedAt: null,
    });

    const failedHalfOpen = transitionPoolMemberHealthAfterRetryableFailure({
      member: {
        ...third,
        healthStatus: "HALF_OPEN",
        halfOpenTrialStartedAt: new Date(now.getTime() + 5_000),
      },
      failureClass: "TRANSPORT",
      now: new Date(now.getTime() + 5_000),
    });

    expect(failedHalfOpen).toMatchObject({
      healthStatus: "UNHEALTHY",
      consecutiveRetryableFailures: 4,
      lastFailureClass: "TRANSPORT",
    });
    expect(failedHalfOpen.nextRetryAt?.toISOString()).toBe("2026-01-01T00:00:15.000Z");
  });

  it("resets health on success and fresh inventory without changing routing status", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 2 });

    await markPoolMemberRelaySuccess("member-id", { trialStartedAt: null, now });
    await resetPoolMemberHealthForDiscoveredModels(["model-a", "model-b"]);

    // A non-claimant success never clears a live trial (owner fence).
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        id: "member-id",
        OR: [
          { healthStatus: { not: "HALF_OPEN" } },
          { halfOpenTrialStartedAt: null },
          {
            halfOpenTrialStartedAt: {
              lte: new Date(now.getTime() - POOL_MEMBER_HALF_OPEN_LEASE_MS),
            },
          },
        ],
      },
      data: resetPoolMemberHealth(),
    });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: { discoveredModelId: { in: ["model-a", "model-b"] } },
          },
          { executionTargetId: null, discoveredModelId: { in: ["model-a", "model-b"] } },
        ],
        routingStatus: { not: "DISABLED" },
      },
      data: resetPoolMemberHealth(),
    });
  });

  it("makes only disconnect-opened members of the device due on reconnect", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 2 });

    const count = await markPoolMembersDueAfterCliReconnect({ cliDeviceId: "cli-1", now });

    expect(count).toBe(2);
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: { in: ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] },
        nextRetryAt: { gt: now },
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: { DiscoveredModel: { Endpoint: { cliDeviceId: "cli-1" } } },
          },
          { executionTargetId: null, DiscoveredModel: { Endpoint: { cliDeviceId: "cli-1" } } },
        ],
      },
      data: { nextRetryAt: now },
    });
  });

  it("persists relay failure and websocket disconnect health updates", async () => {
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 2,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });

    const result = await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "timeout",
      trialStartedAt: null,
      now,
    });
    await markPoolMembersForCliUnavailable({
      cliDeviceId: "cli-1",
      failureClass: "WEBSOCKET_DISCONNECTED",
      generation: 7,
      now,
      db: prisma,
    });

    expect(result).toMatchObject({
      retryable: true,
      update: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: "RELAY_TIMEOUT",
        consecutiveRetryableFailures: 3,
      },
    });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-id",
        healthStatus: "HEALTHY",
        halfOpenTrialStartedAt: null,
        consecutiveRetryableFailures: 2,
      }),
      data: expect.objectContaining({
        healthStatus: "UNHEALTHY",
        lastFailureClass: "RELAY_TIMEOUT",
      }),
    });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        NOT: expect.objectContaining({ healthStatus: { in: ["UNHEALTHY", "DEGRADED"] } }),
        OR: [
          {
            executionTargetId: { not: null },
            ExecutionTarget: {
              DiscoveredModel: {
                Endpoint: { cliDeviceId: "cli-1", CliDevice: { connectionGeneration: 7 } },
              },
            },
          },
          {
            executionTargetId: null,
            DiscoveredModel: {
              Endpoint: { cliDeviceId: "cli-1", CliDevice: { connectionGeneration: 7 } },
            },
          },
        ],
      },
      data: expect.objectContaining({
        healthStatus: "UNHEALTHY",
        lastFailureClass: "WEBSOCKET_DISCONNECTED",
      }),
    });
  });

  it("drops a relay disconnect outcome: the fenced device write owns that health", async () => {
    db.poolMember.updateMany.mockReset();
    db.poolMember.findUnique.mockReset();
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });
    const claimed = new Date(now.getTime() - 1_000);
    const result = await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "disconnected",
      trialStartedAt: claimed,
      now,
    });
    expect(result).toEqual({ retryable: true, update: null });
    expect(db.poolMember.findUnique).not.toHaveBeenCalled();
    // The only write is the trial giving itself back, fenced on its timestamp.
    expect(db.poolMember.updateMany).toHaveBeenCalledTimes(1);
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: { id: "member-id", healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: claimed },
      data: { halfOpenTrialStartedAt: null },
    });
    db.poolMember.updateMany.mockClear();
    await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "disconnected",
      trialStartedAt: null,
      now,
    });
    expect(db.poolMember.updateMany).not.toHaveBeenCalled();
  });

  it("keeps real failure provenance out of the disconnect write", async () => {
    db.poolMember.updateMany.mockReset();
    db.poolMember.updateMany.mockResolvedValue({ count: 0 });
    await markPoolMembersForCliUnavailable({
      cliDeviceId: "cli-1",
      failureClass: "STALE_SESSION",
      generation: 2,
      now,
      db: prisma,
    });
    const where = db.poolMember.updateMany.mock.calls[0]?.[0]?.where;
    expect(where?.NOT).toEqual({
      healthStatus: { in: ["UNHEALTHY", "DEGRADED"] },
      nextRetryAt: { gt: now },
      lastFailureClass: { not: null, notIn: ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] },
    });
  });

  it("abandons a recovery trial fenced on its own timestamp, keeping counters and class", async () => {
    db.poolMember.updateMany.mockReset();
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });
    const claimed = new Date(now.getTime() - 500);
    await expect(
      abandonPoolMemberRecoveryTrial({ poolMemberId: "m", trialStartedAt: claimed, now }),
    ).resolves.toBe(true);
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: { id: "m", healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: claimed },
      data: { healthStatus: "UNHEALTHY", nextRetryAt: now, halfOpenTrialStartedAt: null },
    });
  });

  it("retries a disconnect transaction that expired or hit a lock timeout, within bounds", async () => {
    vi.useFakeTimers();
    const tx = db as unknown as { $transaction: MockInstance };
    const input = {
      cliDeviceId: "cli-1",
      generation: 1,
      cliStatus: "DISCONNECTED" as const,
      failureClass: "WEBSOCKET_DISCONNECTED" as const,
    };
    // Runs the call to completion under fake timers (backoff sleeps included).
    const settle = async (promise: Promise<boolean>, ms = 60_000) => {
      const outcome = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(ms);
      return outcome;
    };
    try {
      const expired = Object.assign(new Error("expired"), { code: "P2028" });
      tx.$transaction.mockReset();
      tx.$transaction.mockRejectedValueOnce(expired).mockResolvedValueOnce(true);
      await expect(settle(disconnectCliDeviceAtGeneration(input))).resolves.toEqual({
        value: true,
      });
      expect(tx.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.$transaction.mock.calls[0]?.[1]).toEqual({ timeout: 10_000, maxWait: 5_000 });

      // Other retryable errors are count-bound.
      tx.$transaction.mockReset();
      tx.$transaction.mockRejectedValue(expired);
      await expect(settle(disconnectCliDeviceAtGeneration(input))).resolves.toEqual({
        error: expired,
      });
      expect(tx.$transaction).toHaveBeenCalledTimes(5);

      // A lock timeout (real driver-adapter error shape) is transient and is
      // retried on a time budget well past the count cap: every attempt
      // releases the device row, and dropping the disconnect would leave the
      // device CONNECTED with no session.
      const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "P2039",
        meta: { driverAdapterError: { cause: { code: "55P03" } } },
      });
      tx.$transaction.mockReset();
      for (let i = 0; i < 12; i += 1) tx.$transaction.mockRejectedValueOnce(lockTimeout);
      tx.$transaction.mockResolvedValueOnce(true);
      await expect(settle(disconnectCliDeviceAtGeneration(input))).resolves.toEqual({
        value: true,
      });
      expect(tx.$transaction).toHaveBeenCalledTimes(13);

      // A lock that never clears is given up after the budget.
      tx.$transaction.mockReset();
      tx.$transaction.mockRejectedValue(lockTimeout);
      await expect(settle(disconnectCliDeviceAtGeneration(input), 120_000)).resolves.toEqual({
        error: lockTimeout,
      });

      // A non-transient error is not retried.
      tx.$transaction.mockReset();
      const fatal = new Error("boom");
      tx.$transaction.mockRejectedValue(fatal);
      await expect(settle(disconnectCliDeviceAtGeneration(input))).resolves.toEqual({
        error: fatal,
      });
      expect(tx.$transaction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences the member scope with the device generation", async () => {
    // Table over the branch a disconnect write takes. Each row is an accepted
    // input; the driver is the mock's count: 0 stands for the SQL matching no
    // rows (a successor hello already incremented the device generation).
    const rows = [
      { name: "current generation, rows matched", count: 1 },
      { name: "superseded generation, no rows matched", count: 0 },
    ];
    for (const row of rows) {
      db.poolMember.updateMany.mockReset();
      db.poolMember.updateMany.mockResolvedValue({ count: row.count });
      await markPoolMembersForCliUnavailable({
        cliDeviceId: "cli-1",
        failureClass: "WEBSOCKET_DISCONNECTED",
        generation: 4,
        db: prisma,
      });
      const where = db.poolMember.updateMany.mock.calls[0]?.[0]?.where;
      // Both relation arms must carry the fence: dropping it from either arm
      // reintroduces the stale-write race for members of that shape.
      const arms = [where?.OR?.[0], where?.OR?.[1]];
      for (const arm of arms) {
        const endpoint =
          arm?.ExecutionTarget?.DiscoveredModel?.Endpoint ??
          (arm?.DiscoveredModel?.Endpoint as { CliDevice?: unknown } | undefined);
        expect(endpoint, row.name).toMatchObject({
          cliDeviceId: "cli-1",
          CliDevice: { connectionGeneration: 4 },
        });
      }
    }
  });

  // Owner fence (#120 design pass): an outcome the attempt does not own is dropped
  // before any write; the row read decides, the versioned write repeats it.
  it.each([
    ["stale claimant", { trialStartedAt: new Date(now.getTime() - 1) }],
    ["non-claimant against a live trial", {}],
  ])("drops a relay failure from a %s", async (_name, options) => {
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HALF_OPEN",
      lastFailureClass: null,
      consecutiveRetryableFailures: 1,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: now,
    });
    const result = await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "timeout",
      trialStartedAt: null,
      now,
      ...options,
    });
    expect(result).toEqual({ retryable: true, update: null });
    expect(db.poolMember.updateMany).not.toHaveBeenCalled();
  });

  it("re-reads and retries a failure write when a concurrent writer changed the row", async () => {
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });
    db.poolMember.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const result = await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "timeout",
      trialStartedAt: null,
      now,
    });
    expect(result.update).not.toBeNull();
    expect(db.poolMember.findUnique).toHaveBeenCalledTimes(2);
    expect(db.poolMember.updateMany).toHaveBeenCalledTimes(2);
  });

  it("scopes a claimant's success to exactly its claim", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });
    await markPoolMemberRelaySuccess("member-id", { trialStartedAt: now, now });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: { id: "member-id", healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: now },
      data: resetPoolMemberHealth(),
    });
  });

  it("atomically claims a due degraded fallback only when it is the sole configured member", async () => {
    db.poolMember.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      markPoolMemberHalfOpenTrial({
        poolMemberId: "member-id",
        allowSingleDegradedFallback: true,
        now,
      }),
    ).resolves.toBe(1);

    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "member-id",
        routingStatus: "ACTIVE",
        weight: { gt: 0 },
        ModelPool: { PoolMembers: { none: { id: { not: "member-id" } } } },
        OR: expect.arrayContaining([{ healthStatus: "DEGRADED", nextRetryAt: { lte: now } }]),
      }),
      data: { healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: now },
    });
  });
});
