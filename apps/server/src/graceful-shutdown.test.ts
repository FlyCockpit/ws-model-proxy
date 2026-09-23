import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  drainHttpWithDeadline,
  runGracefulShutdownSequence,
  runWithDeadline,
} from "./graceful-shutdown";

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
      closeRelaySessions: () =>
        runWithDeadline(hang, 5_000, "relay session close", { warn: () => {} }),
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
