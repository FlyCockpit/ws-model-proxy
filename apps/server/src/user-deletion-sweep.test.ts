import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import { RetainedHistoryError } from "@ws-model-proxy/db/parent-deletion";
import {
  startUserDeletionSweep,
  sweepPendingUserDeletions,
  USER_DELETION_SWEEP_BATCH,
  USER_DELETION_SWEEP_GRACE_MS,
  type UserDeletionSweepResult,
} from "./user-deletion-sweep.js";

// The drain and the ordered delete run against real PostgreSQL in
// packages/api/src/lib/parent-deletion.postgres.integration.test.ts; here the
// sweep's queue, outcome handling and fencing are exercised.
const db = prisma as unknown as {
  user: { findMany: MockInstance };
  $executeRaw: MockInstance;
};
const NOW = new Date("2026-09-25T12:00:00.000Z");

function row(id: string, attempts = 0) {
  return { id, deletionGeneration: `generation-${id}`, deletionSweepAttempts: attempts };
}

describe("sweepPendingUserDeletions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmDbShutdownFence();
    db.$executeRaw.mockResolvedValue(1);
  });
  afterEach(() => disarmDbShutdownFence());

  it("reads only markers older than the grace period, oldest first, bounded", async () => {
    db.user.findMany.mockResolvedValue([]);
    const complete = vi.fn();
    await expect(sweepPendingUserDeletions({ now: NOW, complete })).resolves.toEqual({
      deleted: 0,
      abandoned: 0,
      failed: 0,
    });
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        deletionRequestedAt: {
          not: null,
          lte: new Date(NOW.getTime() - USER_DELETION_SWEEP_GRACE_MS),
        },
        deletionGeneration: { not: null },
        OR: [{ deletionSweepNextAttemptAt: null }, { deletionSweepNextAttemptAt: { lte: NOW } }],
      },
      orderBy: [
        { deletionSweepNextAttemptAt: { sort: "asc", nulls: "first" } },
        { deletionRequestedAt: "asc" },
      ],
      select: { id: true, deletionGeneration: true, deletionSweepAttempts: true },
      take: USER_DELETION_SWEEP_BATCH,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes each marked user, notifies deleted ones, and keeps transient failures", async () => {
    db.user.findMany.mockResolvedValue([row("deleted"), row("gone"), row("flaky", 3)]);
    const complete = vi.fn(async (_db: unknown, userId: string, _generation: string) => {
      if (userId === "flaky") throw Object.assign(new Error("timeout"), { code: "P2028" });
      return userId === "deleted";
    });
    const notify = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sweepPendingUserDeletions({ now: NOW, complete, notify })).resolves.toEqual({
      deleted: 1,
      abandoned: 0,
      failed: 1,
    });
    expect(notify.mock.calls).toEqual([["deleted"]]);
    // Each completion names the generation the sweep selected.
    expect(complete.mock.calls.map((call) => call[2])).toEqual([
      "generation-deleted",
      "generation-gone",
      "generation-flaky",
    ]);
    // A transient failure keeps the marker and records sweep backoff for the
    // selected generation only, counting this attempt (3 earlier + 1).
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = db.$executeRaw.mock.calls[0] ?? [];
    expect((sql as string[]).join("?")).toContain('"deletionGeneration" = ?');
    expect(values).toContain("generation-flaky");
    expect(values).toContain("flaky");
    const next = values.find((value): value is Date => value instanceof Date && value > NOW);
    // Attempt 4: backoff cap 30 s * 2^3 = 240 s, jittered into [120 s, 240 s].
    expect(next && next.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(120_000);
    expect(next && next.getTime() - NOW.getTime()).toBeLessThanOrEqual(240_000);
    expect(errors).toHaveBeenCalledWith("[auth] user deletion sweep will retry:", "Error");
    errors.mockRestore();
  });

  it("abandons the marker (the user stays archived) on a permanent refusal", async () => {
    db.user.findMany.mockResolvedValue([row("retained")]);
    const complete = vi.fn(async () => {
      throw new RetainedHistoryError("capacity lease");
    });
    const notify = vi.fn(async () => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sweepPendingUserDeletions({ now: NOW, complete, notify })).resolves.toEqual({
      deleted: 0,
      abandoned: 1,
      failed: 0,
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = db.$executeRaw.mock.calls[0] ?? [];
    expect((sql as string[]).join("?")).toContain('"deletionGeneration" = ?');
    expect(values).toContain("generation-retained");
    expect(notify).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not count an abandon that matched no row (a newer generation replaced it)", async () => {
    db.user.findMany.mockResolvedValue([row("replaced")]);
    db.$executeRaw.mockResolvedValue(0);
    const complete = vi.fn(async () => {
      throw new RetainedHistoryError("capacity lease");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sweepPendingUserDeletions({ now: NOW, complete })).resolves.toEqual({
      deleted: 0,
      abandoned: 0,
      failed: 0,
    });
    errors.mockRestore();
  });

  it("stops between users once the DB shutdown fence is armed", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b")]);
    const complete = vi.fn(async () => {
      armDbShutdownFence();
      return true;
    });
    const notify = vi.fn(async () => undefined);

    const result = await sweepPendingUserDeletions({ now: NOW, complete, notify });
    expect(result.deleted).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("starts no further user once the stop flag is set (SWEEPER-STOP)", async () => {
    db.user.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    let stopped = false;
    const complete = vi.fn(async () => {
      stopped = true;
      return true;
    });
    const notify = vi.fn(async () => undefined);
    const result = await sweepPendingUserDeletions({
      now: NOW,
      complete,
      notify,
      shouldStop: () => stopped,
    });
    expect(result.deleted).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("startUserDeletionSweep stop (SWEEPER-STOP)", () => {
  afterEach(() => vi.useRealTimers());

  it("stop sets the flag the tick in flight sees, joins that tick, and starts no new one", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const seen: Array<() => boolean> = [];
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const sweep = vi.fn(async (options?: { shouldStop?: () => boolean }) => {
      if (options?.shouldStop) seen.push(options.shouldStop);
      if (sweep.mock.calls.length === 1) await finished;
      return empty;
    });
    const stop = startUserDeletionSweep({ intervalMs: 1_000, sweep });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(seen[0]?.()).toBe(false);

    let joined = false;
    const stopping = stop().then(() => {
      joined = true;
    });
    // The in-flight tick now sees the stop flag, and stop waits for it.
    expect(seen[0]?.()).toBe(true);
    await Promise.resolve();
    expect(joined).toBe(false);
    finish();
    await stopping;
    expect(joined).toBe(true);

    // No tick after stop.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("a stopped sweep can be started again (a fresh instance)", async () => {
    const empty: UserDeletionSweepResult = { deleted: 0, abandoned: 0, failed: 0 };
    const sweep = vi.fn(async () => empty);
    const stop = startUserDeletionSweep({ intervalMs: 60_000, sweep });
    await stop();
    const again = startUserDeletionSweep({ intervalMs: 60_000, sweep });
    expect(again).not.toBe(stop);
    await again();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
