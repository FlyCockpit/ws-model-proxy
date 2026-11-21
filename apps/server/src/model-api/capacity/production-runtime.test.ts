import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainHttpWithDeadline, runGracefulShutdownSequence } from "../../graceful-shutdown.js";
import { createProductionCapacityRuntime } from "./production-runtime.js";
import type { AdmissionAttempt, CapacityAdmissionStore } from "./types.js";

const store = vi.hoisted(() => ({
  acquire: vi.fn<CapacityAdmissionStore["acquire"]>(),
  heartbeat: vi.fn().mockResolvedValue(true),
  release: vi.fn().mockResolvedValue(true),
  reclaimExpired: vi.fn().mockResolvedValue(0),
  sweepAbandoned: vi.fn().mockResolvedValue(0),
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { DATABASE_URL: "postgresql://localhost/test" },
}));
vi.mock("./postgres-store.js", () => ({
  PostgresCapacityAdmissionStore: class {
    acquire = store.acquire;
    heartbeat = store.heartbeat;
    release = store.release;
    reclaimExpired = store.reclaimExpired;
    sweepAbandoned = store.sweepAbandoned;
  },
}));

const attempt = (id: string): AdmissionAttempt => ({
  requestId: id,
  attemptId: id,
  ownerId: "owner",
  sourceKind: "TEST",
  basePriority: 1,
  connectionOwner: "test",
  deadlineAt: new Date(Date.now() + 60_000),
  candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store.acquire.mockImplementation(async ({ attemptId }) => ({
    state: "ADMITTED",
    lease: {
      leaseId: attemptId,
      attemptId,
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 30_000),
    },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("production capacity shutdown lifecycle", () => {
  it("catches maintenance failures, logs only their class and retries on the next tick", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    store.sweepAbandoned.mockRejectedValueOnce(new TypeError("SQL with private parameters"));
    const lifecycle = createProductionCapacityRuntime();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "[capacity] maintenance sweep failed:",
        "TypeError",
      );
      expect(unhandled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.sweepAbandoned).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
      await lifecycle.close();
    }
  });

  it("skips overlapping sweeps and waits for the active sweep before stopping", async () => {
    let finish!: () => void;
    store.sweepAbandoned.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lifecycle = createProductionCapacityRuntime();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.sweepAbandoned).toHaveBeenCalledTimes(1);
    const stopped = vi.fn();
    const stopping = lifecycle.stopMaintenance().then(stopped);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(stopped).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.sweepAbandoned).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it("stops maintenance with no owners and closes idempotently", async () => {
    const lifecycle = createProductionCapacityRuntime();
    await lifecycle.stopMaintenance();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.sweepAbandoned).not.toHaveBeenCalled();
    await lifecycle.close();
    await lifecycle.close();
    expect(store.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "deadline", "failure"])(
    "keeps owners and admissions alive through a %s drain, then releases before the DB fence",
    async (outcome) => {
      const lifecycle = createProductionCapacityRuntime();
      const existing = await lifecycle.runtime.acquire(attempt("existing"));
      if (existing.state !== "ADMITTED") throw new Error("Expected existing admission");
      let finishDrain!: () => void;
      const draining = new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
      const forceCloseConnections = vi.fn();
      const drainHttp = vi.fn(() =>
        outcome === "deadline"
          ? drainHttpWithDeadline({
              timeoutMs: 31_000,
              stopAdmission: () => draining,
              closeIdleRelaySessions: () => {},
              forceCloseConnections,
              warn: () => {},
            })
          : draining.then(() => {
              if (outcome === "failure") throw new Error("drain failed");
            }),
      );
      const closeCapacityRuntimes = vi.fn(() => lifecycle.close());
      const closeMcpHandler = vi.fn(async () => {
        // The production MCP close arms the DB fence at this boundary.
        expect(store.release).toHaveBeenCalledTimes(2);
        expect(existing.lease.signal?.aborted).toBe(true);
      });
      const disconnectPrisma = vi.fn(async () => {});
      const logError = vi.fn();
      const shutdown = runGracefulShutdownSequence({
        stopPeriodicJobs: () => lifecycle.stopMaintenance(),
        closeBrowserSockets: () => {},
        drainHttp,
        closeRelaySessions: () => {},
        closeCapacityRuntimes,
        closeMcpHandler,
        disconnectPrisma,
        log: () => {},
        logError,
      });
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(drainHttp).toHaveBeenCalledOnce();
        expect(closeCapacityRuntimes).not.toHaveBeenCalled();
        expect(store.heartbeat).toHaveBeenCalledTimes(2);
        expect(store.release).not.toHaveBeenCalled();
        expect(existing.lease.signal?.aborted).toBe(false);

        // A request still being served can reach physical admission during drain.
        const duringDrain = await lifecycle.runtime.acquire(attempt("during-drain"));
        expect(duringDrain.state).toBe("ADMITTED");
        if (duringDrain.state !== "ADMITTED") throw new Error("Expected drain-window admission");
        expect(duringDrain.lease.signal?.aborted).toBe(false);
        if (outcome === "completed") {
          await lifecycle.runtime.release(existing.lease);
          await lifecycle.runtime.release(duringDrain.lease);
        }
        if (outcome === "deadline") await vi.advanceTimersByTimeAsync(21_000);
        else finishDrain();
        await shutdown;
        expect(store.release).toHaveBeenCalledTimes(2);
        expect(duringDrain.lease.signal?.aborted).toBe(true);
        expect(closeCapacityRuntimes).toHaveBeenCalledOnce();
        expect(closeMcpHandler).toHaveBeenCalledOnce();
        expect(disconnectPrisma).toHaveBeenCalledOnce();
        expect(forceCloseConnections).toHaveBeenCalledTimes(outcome === "deadline" ? 1 : 0);
        expect(logError).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
        expect(await lifecycle.runtime.acquire(attempt("after-close"))).toEqual({
          state: "CANCELLED",
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        finishDrain();
        await shutdown;
        await lifecycle.close();
      }
    },
  );
});
