import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  disconnectDatabaseClients,
  drainHttpWithDeadline,
  runGracefulShutdownSequence,
  runProcessShutdown,
  runWithDeadline,
} from "./graceful-shutdown";
import { PROCESS_SHUTDOWN_DEADLINE_MS, SHARED_DISCONNECT_TIMEOUT_MS } from "./shutdown-timeouts";

/**
 * Graceful-shutdown ORDERING tests (Phase 4 item 4): the MCP
 * handler close() runs AFTER the HTTP drain and BEFORE the Prisma
 * disconnect; step failures are logged and swallowed so later steps still
 * run.
 */
describe("runGracefulShutdownSequence", () => {
  function recorder(
    overrides: Partial<
      Record<
        | "stopPeriodicJobs"
        | "closeBrowserSockets"
        | "drainHttp"
        | "closeRelaySessions"
        | "closeMcpHandler"
        | "disconnectPrisma",
        Error | undefined
      >
    > = {},
  ) {
    const order: string[] = [];
    const step = (name: keyof typeof overrides) => async () => {
      order.push(name);
      const failure = overrides[name];
      if (failure) throw failure;
    };
    return {
      order,
      deps: {
        stopPeriodicJobs: step("stopPeriodicJobs"),
        closeBrowserSockets: step("closeBrowserSockets"),
        drainHttp: step("drainHttp"),
        closeRelaySessions: step("closeRelaySessions"),
        closeMcpHandler: step("closeMcpHandler"),
        disconnectPrisma: step("disconnectPrisma"),
        log: () => {},
        logError: () => {},
      },
    };
  }

  it("runs stopPeriodicJobs → closeBrowserSockets → drainHttp → closeRelaySessions → closeMcpHandler → disconnectPrisma, in order", async () => {
    const { order, deps } = recorder();
    await runGracefulShutdownSequence(deps);
    expect(order).toEqual([
      "stopPeriodicJobs",
      "closeBrowserSockets",
      "drainHttp",
      "closeRelaySessions",
      "closeMcpHandler",
      "disconnectPrisma",
    ]);
  });

  it("closes browser sockets before the HTTP drain and relay sessions after it", async () => {
    const { order, deps } = recorder();
    await runGracefulShutdownSequence(deps);
    expect(order.indexOf("closeBrowserSockets")).toBeGreaterThan(order.indexOf("stopPeriodicJobs"));
    expect(order.indexOf("closeBrowserSockets")).toBeLessThan(order.indexOf("drainHttp"));
    expect(order.indexOf("closeRelaySessions")).toBeGreaterThan(order.indexOf("drainHttp"));
    expect(order.indexOf("closeRelaySessions")).toBeLessThan(order.indexOf("disconnectPrisma"));
    expect(order.indexOf("closeRelaySessions")).toBeLessThan(order.indexOf("closeMcpHandler"));
  });

  it("MCP close runs strictly AFTER HTTP drain and strictly BEFORE Prisma disconnect", async () => {
    const { order, deps } = recorder();
    await runGracefulShutdownSequence(deps);
    expect(order.indexOf("closeMcpHandler")).toBeGreaterThan(order.indexOf("drainHttp"));
    expect(order.indexOf("closeMcpHandler")).toBeLessThan(order.indexOf("disconnectPrisma"));
  });

  it.each([
    "stopPeriodicJobs",
    "closeBrowserSockets",
    "drainHttp",
    "closeRelaySessions",
    "closeMcpHandler",
  ] as const)("a failing %s does not prevent the remaining steps", async (failingStep) => {
    const { order, deps } = recorder({ [failingStep]: new Error("boom") } as Parameters<
      typeof recorder
    >[0]);
    await runGracefulShutdownSequence(deps);
    expect(order).toEqual([
      "stopPeriodicJobs",
      "closeBrowserSockets",
      "drainHttp",
      "closeRelaySessions",
      "closeMcpHandler",
      "disconnectPrisma",
    ]);
  });

  it("a failing Prisma disconnect is swallowed (no throw)", async () => {
    const { deps } = recorder({ disconnectPrisma: new Error("boom") });
    await expect(runGracefulShutdownSequence(deps)).resolves.toBeUndefined();
  });
});

describe("runGracefulShutdownSequence — default-logger sanitization (L19, F3)", () => {
  // The DEFAULT logError must never emit error contents (Prisma messages
  // embed SQL + params; rejections can be arbitrary objects). These tests
  // use the DEFAULT logger under a console capture — an injected no-op
  // logError would conceal the defect entirely (the pass-1 mistake).
  const SENTINEL = "shutdown-secret-hunter2";
  const STEPS = [
    "stopPeriodicJobs",
    "closeBrowserSockets",
    "drainHttp",
    "closeRelaySessions",
    "closeMcpHandler",
    "disconnectPrisma",
  ] as const;
  const REJECTIONS: { label: string; value: unknown; expectedLabel: string }[] = [
    {
      label: "Error rejection",
      value: new Error(`db blew up: ${SENTINEL}`),
      expectedLabel: "Error",
    },
    { label: "string rejection", value: `raw string ${SENTINEL}`, expectedLabel: "string" },
    {
      label: "object rejection",
      value: { message: SENTINEL, sql: `SELECT ${SENTINEL}` },
      expectedLabel: "object",
    },
  ];

  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it.each(STEPS)("step %s failing with Error/string/object: sanitized line only", async (step) => {
    for (const rejection of REJECTIONS) {
      errorSpy.mockClear();
      logSpy.mockClear();
      const order: string[] = [];
      const deps = {
        stopPeriodicJobs: async () => {
          order.push("stopPeriodicJobs");
          if (step === "stopPeriodicJobs") throw rejection.value;
        },
        closeBrowserSockets: async () => {
          order.push("closeBrowserSockets");
          if (step === "closeBrowserSockets") throw rejection.value;
        },
        drainHttp: async () => {
          order.push("drainHttp");
          if (step === "drainHttp") throw rejection.value;
        },
        closeRelaySessions: async () => {
          order.push("closeRelaySessions");
          if (step === "closeRelaySessions") throw rejection.value;
        },
        closeMcpHandler: async () => {
          order.push("closeMcpHandler");
          if (step === "closeMcpHandler") throw rejection.value;
        },
        disconnectPrisma: async () => {
          order.push("disconnectPrisma");
          if (step === "disconnectPrisma") throw rejection.value;
        },
        // NO log/logError overrides — the DEFAULT logger is under test.
      };
      await runGracefulShutdownSequence(deps);
      // Continuation preserved: every step still ran.
      expect(order).toEqual([
        "stopPeriodicJobs",
        "closeBrowserSockets",
        "drainHttp",
        "closeRelaySessions",
        "closeMcpHandler",
        "disconnectPrisma",
      ]);
      expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of errorSpy.mock.calls) {
        const line = call.map(String).join(" ");
        expect(line).not.toContain(SENTINEL);
        expect(line).not.toContain("db blew up");
        expect(line).toContain(`(${rejection.expectedLabel})`);
      }
    }
  });

  it("default success path logs through the default console.log", async () => {
    await runGracefulShutdownSequence({
      stopPeriodicJobs: () => {},
      closeBrowserSockets: () => {},
      drainHttp: async () => {},
      closeRelaySessions: () => {},
      closeMcpHandler: async () => {},
      disconnectPrisma: async () => {},
    });
    expect(logSpy.mock.calls.flat().map(String).join("\n")).toContain("Prisma disconnected.");
  });
});

describe("drainHttpWithDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<void>(() => {});

  it("stops admission before relay persistence starts", async () => {
    const order: string[] = [];
    await drainHttpWithDeadline({
      timeoutMs: 10_000,
      stopAdmission: async () => {
        order.push("stopAdmission");
      },
      closeIdleRelaySessions: async () => {
        order.push("closeIdleRelaySessions");
      },
      forceCloseConnections: () => order.push("forceClose"),
      warn: () => {},
      logError: () => {},
    });
    expect(order).toEqual(["stopAdmission", "closeIdleRelaySessions"]);
  });

  it("finishes by the deadline when a relay DB write never resolves, and forces connections closed", async () => {
    const warnings: string[] = [];
    const forceClose = vi.fn();
    let admissionStopped = false;
    let persistenceSawAdmissionStopped: boolean | undefined;
    let done = false;
    const drain = drainHttpWithDeadline({
      timeoutMs: 10_000,
      stopAdmission: () => {
        admissionStopped = true;
        // The HTTP server would close once the stalled socket is gone.
        return never();
      },
      closeIdleRelaySessions: () => {
        persistenceSawAdmissionStopped = admissionStopped;
        return never();
      },
      forceCloseConnections: forceClose,
      warn: (message) => warnings.push(message),
      logError: () => {},
    }).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    expect(forceClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await drain;
    expect(done).toBe(true);
    expect(persistenceSawAdmissionStopped).toBe(true);
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(warnings.join("\n")).toContain("Drain timeout reached");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for the deadline when the DB and HTTP drain are healthy", async () => {
    const forceClose = vi.fn();
    await drainHttpWithDeadline({
      timeoutMs: 10_000,
      stopAdmission: async () => {},
      closeIdleRelaySessions: async () => {},
      forceCloseConnections: forceClose,
      warn: () => {},
      logError: () => {},
    });
    expect(forceClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a failed relay close with a sanitized label and still drains", async () => {
    const errors: string[] = [];
    await drainHttpWithDeadline({
      timeoutMs: 10_000,
      stopAdmission: async () => {},
      closeIdleRelaySessions: async () => {
        throw new Error("SELECT secret");
      },
      forceCloseConnections: () => {},
      warn: () => {},
      logError: (message, error) =>
        errors.push(`${message} ${error instanceof Error ? error.constructor.name : ""}`),
    });
    expect(errors).toEqual(["[server] Error closing idle relay sessions: Error"]);
  });
});

describe("runWithDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a DB write that never resolves at the deadline", async () => {
    const warnings: string[] = [];
    let done = false;
    const run = runWithDeadline(() => new Promise<void>(() => {}), 5_000, "relay session close", {
      warn: (message) => warnings.push(message),
    }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(true);
    expect(warnings).toEqual(["[server] relay session close did not finish before its deadline."]);
  });

  it("lets a whole shutdown sequence finish while relay persistence hangs", async () => {
    const order: string[] = [];
    const hang = () => new Promise<void>(() => {});
    const sequence = runGracefulShutdownSequence({
      stopPeriodicJobs: () => {},
      closeBrowserSockets: () => {},
      drainHttp: () =>
        drainHttpWithDeadline({
          timeoutMs: 10_000,
          stopAdmission: async () => {
            order.push("stopAdmission");
          },
          closeIdleRelaySessions: () => {
            order.push("closeIdleRelaySessions");
            return hang();
          },
          forceCloseConnections: () => {},
          warn: () => {},
        }),
      closeRelaySessions: async () => {
        await runWithDeadline(hang, 5_000, "relay session close", { warn: () => {} });
      },
      closeMcpHandler: async () => {},
      disconnectPrisma: async () => {
        order.push("disconnectPrisma");
      },
      log: () => {},
      logError: () => {},
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await sequence;
    expect(order).toEqual(["stopAdmission", "closeIdleRelaySessions", "disconnectPrisma"]);
  });

  it("returns as soon as the work finishes", async () => {
    await runWithDeadline(async () => {}, 5_000, "relay session close", { warn: () => {} });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// F2-07: the database step bounds the shared disconnect too. Executed
// against PostgreSQL (a shared UPDATE blocked on a row the quarantined sweep
// COMMIT holds) in packages/api/src/lib/parent-deletion.postgres.integration.test.ts.
describe("disconnectDatabaseClients", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the sweep shutdown first, then abandons a shared disconnect that never settles at its deadline", async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    let result: Awaited<ReturnType<typeof disconnectDatabaseClients<string>>> | undefined;
    const run = disconnectDatabaseClients({
      shutDownSweep: async () => {
        order.push("sweep");
        return "sweep-outcome";
      },
      shared: {
        $disconnect: () => {
          order.push("shared");
          return new Promise<void>(() => {});
        },
      },
      warn: (message) => warnings.push(message),
    }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(SHARED_DISCONNECT_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(order).toEqual(["sweep", "shared"]);
    expect(result).toEqual({ sweep: "sweep-outcome", shared: "timeout" });
    expect(warnings).toEqual([
      "[server] shared database client disconnect did not finish before its deadline.",
      expect.stringContaining("Abandoning the shared database client"),
    ]);
  });

  it("returns done without a warning when the shared disconnect is healthy (inverse)", async () => {
    const warnings: string[] = [];
    const result = await disconnectDatabaseClients({
      shutDownSweep: async () => "ok",
      shared: { $disconnect: async () => {} },
      warn: (message) => warnings.push(message),
    });
    expect(result).toEqual({ sweep: "ok", shared: "done" });
    expect(warnings).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still disconnects the shared client when the sweep shutdown throws (sanitized log)", async () => {
    const errors: string[] = [];
    let disconnected = false;
    const result = await disconnectDatabaseClients({
      shutDownSweep: async () => {
        throw new TypeError("secret SQL text");
      },
      shared: {
        $disconnect: async () => {
          disconnected = true;
        },
      },
      warn: () => {},
      logError: (message, error) =>
        errors.push(`${message} ${error instanceof Error ? error.constructor.name : ""}`),
    });
    expect(disconnected).toBe(true);
    expect(result).toEqual({ sweep: undefined, shared: "done" });
    expect(errors).toEqual(["[server] Error shutting down the user deletion sweep: TypeError"]);
  });
});

// F2-07 (class): the process watchdog ends shutdown at the deadline whatever a
// step waits on.
describe("runProcessShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits with status 1 at the deadline when a step never settles", async () => {
    const exit = vi.fn();
    const errors: string[] = [];
    const { watchdog } = runProcessShutdown({
      sequence: () => new Promise<void>(() => {}),
      exit,
      log: () => {},
      logError: (message) => errors.push(message),
    });
    // Armed synchronously, before anything was awaited, and unref'd.
    expect(vi.getTimerCount()).toBe(1);
    expect(watchdog.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual(["[server] Shutdown deadline exceeded; exiting."]);
  });

  it("ends a real sequence whose step has no bound: exit(1) at the deadline, never exit(0)", async () => {
    const exit = vi.fn();
    runProcessShutdown({
      sequence: () =>
        runGracefulShutdownSequence({
          stopPeriodicJobs: () => {},
          closeBrowserSockets: () => {},
          drainHttp: async () => {},
          closeRelaySessions: () => {},
          // A future step without a bound.
          closeMcpHandler: () => new Promise<void>(() => {}),
          disconnectPrisma: async () => {},
          log: () => {},
          logError: () => {},
        }),
      exit,
      log: () => {},
      logError: () => {},
    });
    await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_DEADLINE_MS);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it("exits with status 0 once the sequence finished, before the deadline (normal path)", async () => {
    const exit = vi.fn();
    const logs: string[] = [];
    const { done, watchdog } = runProcessShutdown({
      sequence: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      },
      exit,
      log: (message) => logs.push(message),
      logError: () => {},
    });
    expect(watchdog.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(exit.mock.calls).toEqual([[0]]);
    expect(logs).toEqual(["[server] Shutdown complete."]);
  });

  it("exits with status 1 when the sequence itself rejects (sanitized log)", async () => {
    const exit = vi.fn();
    const errors: string[] = [];
    const { done } = runProcessShutdown({
      sequence: async () => {
        throw new RangeError("secret");
      },
      exit,
      log: () => {},
      logError: (message) => errors.push(message),
    });
    await done;
    expect(exit.mock.calls).toEqual([[1]]);
    expect(errors).toEqual(["[server] Shutdown sequence failed (RangeError); exiting."]);
  });
});
