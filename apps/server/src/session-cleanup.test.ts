import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import {
  SESSION_CLEANUP_BATCH,
  startSessionCleanup,
  sweepExpiredSessions,
} from "./session-cleanup.js";

const db = prisma as unknown as {
  session: { findMany: MockInstance; deleteMany: MockInstance };
};
const NOW = new Date("2026-09-19T12:00:00.000Z");

describe("sweepExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmDbShutdownFence();
  });
  afterEach(() => disarmDbShutdownFence());

  it("is an idempotent no-op for an empty expired-session set", async () => {
    db.session.findMany.mockResolvedValue([]);

    await sweepExpiredSessions({ now: NOW });
    await sweepExpiredSessions({ now: NOW });

    expect(db.session.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: NOW } },
      select: { id: true },
      take: SESSION_CLEANUP_BATCH,
    });
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only the exact, still-expired batch selected at the inclusive boundary", async () => {
    db.session.findMany.mockResolvedValue([{ id: "session-1" }]);
    db.session.deleteMany.mockResolvedValue({ count: 1 });

    await expect(sweepExpiredSessions({ now: NOW })).resolves.toBe(1);

    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: NOW },
        id: { in: ["session-1"] },
      },
    });
  });

  it("stops between batches when shutdown arms, leaving later rows for restart", async () => {
    db.session.findMany.mockResolvedValue(
      Array.from({ length: SESSION_CLEANUP_BATCH }, (_, index) => ({ id: `session-${index}` })),
    );
    db.session.deleteMany.mockImplementation(async () => {
      armDbShutdownFence();
      return { count: SESSION_CLEANUP_BATCH };
    });

    await expect(sweepExpiredSessions({ now: NOW })).resolves.toBe(SESSION_CLEANUP_BATCH);

    expect(db.session.findMany).toHaveBeenCalledTimes(1);
    expect(db.session.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("startSessionCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    disarmDbShutdownFence();
  });
  afterEach(() => {
    vi.useRealTimers();
    disarmDbShutdownFence();
  });

  it("runs at startup, never overlaps, and stops future scheduling", async () => {
    let releaseSweep: (() => void) | undefined;
    const sweep = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          releaseSweep = () => resolve(0);
        }),
    );
    const stop = startSessionCleanup({ intervalMs: 100, sweep });

    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(1);
    releaseSweep?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("keeps one scheduler when started repeatedly and permits a clean restart after stop", async () => {
    const firstSweep = vi.fn().mockResolvedValue(0);
    const secondSweep = vi.fn().mockResolvedValue(0);
    const stopFirst = startSessionCleanup({ intervalMs: 100, sweep: firstSweep });
    const stopSecond = startSessionCleanup({ intervalMs: 100, sweep: secondSweep });

    expect(stopSecond).toBe(stopFirst);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSweep).toHaveBeenCalledTimes(1);
    expect(secondSweep).not.toHaveBeenCalled();
    stopFirst();

    const restartSweep = vi.fn().mockResolvedValue(0);
    const stopRestart = startSessionCleanup({ intervalMs: 100, sweep: restartSweep });
    await vi.advanceTimersByTimeAsync(0);
    expect(restartSweep).toHaveBeenCalledTimes(1);
    stopRestart();
  });
});
