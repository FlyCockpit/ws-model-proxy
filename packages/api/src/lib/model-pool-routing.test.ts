import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  POOL_MEMBER_HEALTH_COOLDOWN_MS,
  buildPoolRouteSequence,
  isRetryablePoolMemberRelayFailure,
  markPoolMemberRelaySuccess,
  markPoolMembersForCliUnavailable,
  poolMemberFailureClassForRelayFailure,
  recordPoolMemberRelayFailure,
  resetPoolMemberHealth,
  resetPoolMemberHealthForDiscoveredModels,
  transitionPoolMemberHealthAfterRetryableFailure,
} = await import("./model-pool-routing");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  poolMember: {
    findUnique: MockInstance;
    update: MockInstance;
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
  cliStatus = "CONNECTED",
  nextRetryAt = null,
  halfOpenTrialStartedAt = null,
}: {
  id: string;
  weight?: number;
  healthStatus?: PoolMemberRouteRow["healthStatus"];
  routingStatus?: PoolMemberRouteRow["routingStatus"];
  cliDeviceId?: string;
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
      upstreamModelId: `${id}-upstream`,
      Endpoint: {
        id: `${id}-endpoint`,
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

  it("maps only retryable relay failures to member health failure classes", () => {
    expect(poolMemberFailureClassForRelayFailure("transport")).toBe("TRANSPORT");
    expect(poolMemberFailureClassForRelayFailure("timeout")).toBe("RELAY_TIMEOUT");
    expect(poolMemberFailureClassForRelayFailure("disconnected")).toBe("WEBSOCKET_DISCONNECTED");
    expect(poolMemberFailureClassForRelayFailure("upstream_5xx")).toBe("UPSTREAM_5XX");
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

    expect(first).toMatchObject({ healthStatus: "HEALTHY", consecutiveRetryableFailures: 1 });
    expect(second).toMatchObject({ healthStatus: "HEALTHY", consecutiveRetryableFailures: 2 });
    expect(third).toEqual({
      healthStatus: "UNHEALTHY",
      lastFailureClass: "UPSTREAM_5XX",
      consecutiveRetryableFailures: 3,
      lastFailureAt: now,
      nextRetryAt: new Date(now.getTime() + POOL_MEMBER_HEALTH_COOLDOWN_MS),
      halfOpenTrialStartedAt: null,
    });

    const failedHalfOpen = transitionPoolMemberHealthAfterRetryableFailure({
      member: {
        ...third,
        healthStatus: "HALF_OPEN",
        halfOpenTrialStartedAt: new Date(now.getTime() + POOL_MEMBER_HEALTH_COOLDOWN_MS),
      },
      failureClass: "TRANSPORT",
      now: new Date(now.getTime() + POOL_MEMBER_HEALTH_COOLDOWN_MS),
    });

    expect(failedHalfOpen).toMatchObject({
      healthStatus: "UNHEALTHY",
      consecutiveRetryableFailures: 4,
      lastFailureClass: "TRANSPORT",
    });
    expect(failedHalfOpen.nextRetryAt?.toISOString()).toBe("2026-01-01T00:02:00.000Z");
  });

  it("resets health on success and fresh inventory without changing routing status", async () => {
    db.poolMember.update.mockResolvedValue({ id: "member-id" });
    db.poolMember.updateMany.mockResolvedValue({ count: 2 });

    await markPoolMemberRelaySuccess("member-id");
    await resetPoolMemberHealthForDiscoveredModels(["model-a", "model-b"]);

    expect(db.poolMember.update).toHaveBeenCalledWith({
      where: { id: "member-id" },
      data: resetPoolMemberHealth(),
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        discoveredModelId: { in: ["model-a", "model-b"] },
        routingStatus: { not: "DISABLED" },
      },
      data: resetPoolMemberHealth(),
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
    db.poolMember.update.mockResolvedValue({ id: "member-id" });
    db.poolMember.updateMany.mockResolvedValue({ count: 3 });

    const result = await recordPoolMemberRelayFailure({
      poolMemberId: "member-id",
      failure: "timeout",
      now,
    });
    await markPoolMembersForCliUnavailable({
      cliDeviceId: "cli-1",
      failureClass: "WEBSOCKET_DISCONNECTED",
      now,
    });

    expect(result).toMatchObject({
      retryable: true,
      update: {
        healthStatus: "UNHEALTHY",
        lastFailureClass: "RELAY_TIMEOUT",
        consecutiveRetryableFailures: 3,
      },
    });
    expect(db.poolMember.update).toHaveBeenCalledWith({
      where: { id: "member-id" },
      data: expect.objectContaining({
        healthStatus: "UNHEALTHY",
        lastFailureClass: "RELAY_TIMEOUT",
      }),
      select: { id: true },
    });
    expect(db.poolMember.updateMany).toHaveBeenCalledWith({
      where: {
        DiscoveredModel: {
          Endpoint: { cliDeviceId: "cli-1" },
        },
      },
      data: expect.objectContaining({
        healthStatus: "UNHEALTHY",
        lastFailureClass: "WEBSOCKET_DISCONNECTED",
      }),
    });
  });
});
