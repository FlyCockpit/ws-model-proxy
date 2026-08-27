import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import {
  listDueOwnedPoolMemberRecoveries,
  type OwnedRecoveryMember,
  PoolMemberRecoveryScheduler,
} from "./pool-member-recovery.js";

const member: OwnedRecoveryMember = {
  id: "member-a",
  cliDeviceId: "local-cli",
  endpointSlug: "local",
  upstreamModelId: "model-a",
  userId: "user-a",
  capabilities: {
    version: 1,
    protocol: "openai-compatible",
    chatCompletions: { supported: true },
  },
};

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PoolMemberRecoveryScheduler", () => {
  it("selects only due active local relay members, excluding disabled and provider targets", async () => {
    const db = prisma as unknown as { poolMember: { findMany: ReturnType<typeof vi.fn> } };
    db.poolMember.findMany.mockResolvedValue([]);
    await listDueOwnedPoolMemberRecoveries(["local-cli"], new Date("2026-01-01T00:00:01Z"));

    expect(db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          routingStatus: "ACTIVE",
          weight: { gt: 0 },
          healthStatus: { in: ["DEGRADED", "UNHEALTHY"] },
          nextRetryAt: { lte: new Date("2026-01-01T00:00:01Z") },
          OR: expect.arrayContaining([
            expect.objectContaining({ executionTargetId: null }),
            expect.objectContaining({ executionTargetId: { not: null } }),
          ]),
        }),
      }),
    );
  });

  it("only probes members whose relay socket this process owns", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(true);
    const scheduler = new PoolMemberRecoveryScheduler({
      getOwnedCliDeviceIds: () => ["local-cli"],
      listDueMembers: vi.fn().mockResolvedValue([{ ...member, cliDeviceId: "remote-cli" }]),
      probe,
      claim: vi.fn().mockResolvedValue(new Date("2026-01-01T00:00:00Z")),
      settle: vi.fn().mockResolvedValue(true),
    });
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).not.toHaveBeenCalled();
    scheduler.stop();
    vi.useRealTimers();
  });

  it("skips unsupported model surfaces without claiming or degrading them", async () => {
    vi.useFakeTimers();
    const claim = vi.fn();
    const probe = vi.fn();
    const scheduler = new PoolMemberRecoveryScheduler({
      getOwnedCliDeviceIds: () => ["local-cli"],
      listDueMembers: vi.fn().mockResolvedValue([{ ...member, capabilities: null }]),
      claim,
      probe,
    });
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    scheduler.stop();
    vi.useRealTimers();
  });

  it("resets health after a successful owned probe and advances it after a failure", async () => {
    vi.useFakeTimers();
    let healthy = true;
    const settle = vi.fn().mockResolvedValue(true);
    const scheduler = new PoolMemberRecoveryScheduler({
      getOwnedCliDeviceIds: () => ["local-cli"],
      listDueMembers: vi.fn().mockResolvedValue([member]),
      probe: vi.fn().mockImplementation(async () => healthy),
      claim: vi.fn().mockImplementation((_id, now) => Promise.resolve(now)),
      settle,
    });
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ memberId: "member-a", healthy: true }),
    );

    healthy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ memberId: "member-a", healthy: false }),
    );
    scheduler.stop();
    vi.useRealTimers();
  });

  it("does not overlap ticks and cancels pending timers on stop", async () => {
    vi.useFakeTimers();
    let releaseProbe!: (healthy: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    const scheduler = new PoolMemberRecoveryScheduler({
      getOwnedCliDeviceIds: () => ["local-cli"],
      listDueMembers: vi.fn().mockResolvedValue([member]),
      probe,
      claim: vi.fn().mockImplementation((_id, now) => Promise.resolve(now)),
      settle: vi.fn().mockResolvedValue(true),
    });
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(1);

    scheduler.stop();
    releaseProbe(true);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not settle a probe after ownership is lost", async () => {
    vi.useFakeTimers();
    let owned = true;
    const settle = vi.fn().mockResolvedValue(true);
    const scheduler = new PoolMemberRecoveryScheduler({
      getOwnedCliDeviceIds: () => (owned ? ["local-cli"] : []),
      listDueMembers: vi.fn().mockResolvedValue([member]),
      probe: vi.fn().mockImplementation(async () => {
        owned = false;
        return true;
      }),
      claim: vi.fn().mockImplementation((_id, now) => Promise.resolve(now)),
      settle,
    });
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).not.toHaveBeenCalled();
    scheduler.stop();
    vi.useRealTimers();
  });
});
