import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runGracefulShutdownSequence } from "./graceful-shutdown";

/**
 * Graceful-shutdown ORDERING tests (MCP plan Phase 4 item 4): the MCP
 * handler close() runs AFTER the HTTP drain and BEFORE the Prisma
 * disconnect; step failures are logged and swallowed so later steps still
 * run.
 */
describe("runGracefulShutdownSequence", () => {
  function recorder(
    overrides: Partial<
      Record<
        "stopPeriodicJobs" | "drainHttp" | "closeMcpHandler" | "disconnectPrisma",
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
        drainHttp: step("drainHttp"),
        closeMcpHandler: step("closeMcpHandler"),
        disconnectPrisma: step("disconnectPrisma"),
        log: () => {},
        logError: () => {},
      },
    };
  }

  it("runs stopPeriodicJobs → drainHttp → closeMcpHandler → disconnectPrisma, in order", async () => {
    const { order, deps } = recorder();
    await runGracefulShutdownSequence(deps);
    expect(order).toEqual(["stopPeriodicJobs", "drainHttp", "closeMcpHandler", "disconnectPrisma"]);
  });

  it("MCP close runs strictly AFTER HTTP drain and strictly BEFORE Prisma disconnect", async () => {
    const { order, deps } = recorder();
    await runGracefulShutdownSequence(deps);
    expect(order.indexOf("closeMcpHandler")).toBeGreaterThan(order.indexOf("drainHttp"));
    expect(order.indexOf("closeMcpHandler")).toBeLessThan(order.indexOf("disconnectPrisma"));
  });

  it.each(["stopPeriodicJobs", "drainHttp", "closeMcpHandler"] as const)(
    "a failing %s does not prevent the remaining steps",
    async (failingStep) => {
      const { order, deps } = recorder({ [failingStep]: new Error("boom") } as Parameters<
        typeof recorder
      >[0]);
      await runGracefulShutdownSequence(deps);
      expect(order).toEqual([
        "stopPeriodicJobs",
        "drainHttp",
        "closeMcpHandler",
        "disconnectPrisma",
      ]);
    },
  );

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
  const STEPS = ["stopPeriodicJobs", "drainHttp", "closeMcpHandler", "disconnectPrisma"] as const;
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
        drainHttp: async () => {
          order.push("drainHttp");
          if (step === "drainHttp") throw rejection.value;
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
        "drainHttp",
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
      drainHttp: async () => {},
      closeMcpHandler: async () => {},
      disconnectPrisma: async () => {},
    });
    expect(logSpy.mock.calls.flat().map(String).join("\n")).toContain("Prisma disconnected.");
  });
});
