import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_COMMAND_SWEEP_INTERVAL_MS,
  RELAY_STALE_SESSION_SWEEP_INTERVAL_MS,
  startRelayMaintenance,
  TERMINAL_SESSION_RECHECK_INTERVAL_MS,
} from "./relay-maintenance.js";

// The shutdown wiring index.ts installs is tested in server-shutdown.test.ts;
// this covers the relay maintenance timers it starts (relay-maintenance.ts).
describe("relay maintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakes() {
    return {
      relaySessions: {
        checkStaleSessions: vi.fn(async () => undefined),
        sweepExpiredPendingTerminals: vi.fn(),
      },
      sweepExpiredTokenCommands: vi.fn(),
      terminalHub: { recheckSessions: vi.fn(async () => undefined) },
    };
  }

  it("runs each sweep on its interval without running any at start", async () => {
    const deps = fakes();
    const stop = startRelayMaintenance(deps);
    expect(deps.relaySessions.checkStaleSessions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RELAY_STALE_SESSION_SWEEP_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions).toHaveBeenCalledTimes(1);
    expect(deps.relaySessions.sweepExpiredPendingTerminals).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(
      Math.max(CLI_COMMAND_SWEEP_INTERVAL_MS, TERMINAL_SESSION_RECHECK_INTERVAL_MS) -
        RELAY_STALE_SESSION_SWEEP_INTERVAL_MS,
    );
    expect(deps.sweepExpiredTokenCommands).toHaveBeenCalledTimes(1);
    expect(deps.terminalHub.recheckSessions).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("rechecks live transcription sessions on the terminal recheck interval", async () => {
    const realtimeSessions = { recheckSessions: vi.fn(async () => undefined) };
    const stop = startRelayMaintenance({ ...fakes(), realtimeSessions });
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_RECHECK_INTERVAL_MS);
    expect(realtimeSessions.recheckSessions).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("stop clears every timer", async () => {
    const deps = fakes();
    await startRelayMaintenance(deps)();
    await vi.advanceTimersByTimeAsync(10 * CLI_COMMAND_SWEEP_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions).not.toHaveBeenCalled();
    expect(deps.sweepExpiredTokenCommands).not.toHaveBeenCalled();
    expect(deps.terminalHub.recheckSessions).not.toHaveBeenCalled();
  });

  it("stop flushes the agent audit queue after the running sweeps settle, and logs a failed flush by class", async () => {
    const order: string[] = [];
    const deps = {
      ...fakes(),
      stopCliAgentAudit: vi.fn(async () => {
        order.push("audit");
      }),
    };
    let release!: () => void;
    deps.terminalHub.recheckSessions.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            order.push("sweep");
            resolve(undefined);
          };
        }),
    );
    const stop = startRelayMaintenance(deps);
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_RECHECK_INTERVAL_MS);
    const stopping = stop();
    await Promise.resolve();
    expect(deps.stopCliAgentAudit).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(order).toEqual(["sweep", "audit"]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    deps.stopCliAgentAudit.mockRejectedValue(new TypeError("secret detail"));
    await startRelayMaintenance(deps)();
    expect(errors).toHaveBeenCalledWith("[server] agent audit flush failed", "TypeError");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret detail");
  });

  it("a failing sweep is logged by class and does not stop the others", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = fakes();
    deps.relaySessions.checkStaleSessions.mockRejectedValue(new TypeError("secret detail"));
    deps.relaySessions.sweepExpiredPendingTerminals.mockImplementation(() => {
      throw new RangeError("secret detail");
    });
    deps.sweepExpiredTokenCommands.mockImplementation(() => {
      throw new Error("secret detail");
    });
    const stop = startRelayMaintenance(deps);
    await vi.advanceTimersByTimeAsync(2 * CLI_COMMAND_SWEEP_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions.mock.calls.length).toBeGreaterThan(1);
    expect(deps.terminalHub.recheckSessions).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("[server] stale relay session sweep failed", "TypeError");
    expect(errors).toHaveBeenCalledWith("[server] pending terminal sweep failed", "RangeError");
    expect(errors).toHaveBeenCalledWith("[server] CLI command sweep failed", "Error");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret detail");
    await stop();
  });

  it("stop resolves only once every sweep already running has settled", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = fakes();
    const stale = Promise.withResolvers<undefined>();
    const recheck = Promise.withResolvers<undefined>();
    deps.relaySessions.checkStaleSessions.mockReturnValue(stale.promise);
    deps.terminalHub.recheckSessions.mockReturnValue(recheck.promise);
    const stop = startRelayMaintenance(deps);
    // Advance to the 60 s tick: the last stale sweep and the recheck are both
    // still running (the earlier stale sweeps shared the same pending promise).
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_RECHECK_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions).toHaveBeenCalled();
    expect(deps.terminalHub.recheckSessions).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    // Timers are cleared at once: no further sweep starts.
    await vi.advanceTimersByTimeAsync(10 * CLI_COMMAND_SWEEP_INTERVAL_MS);
    expect(deps.terminalHub.recheckSessions).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);
    // Settling the stale sweep alone leaves the pending recheck holding stop.
    stale.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    // A failing sweep still settles the stop (and is logged by class).
    recheck.reject(new TypeError("secret detail"));
    await stopping;
    expect(stopped).toBe(true);
    expect(errors).toHaveBeenCalledWith("[server] terminal session recheck failed", "TypeError");
  });

  it("stop stays pending while only the stale-session sweep is still running", async () => {
    const deps = fakes();
    const stale = Promise.withResolvers<undefined>();
    const recheck = Promise.withResolvers<undefined>();
    deps.relaySessions.checkStaleSessions.mockReturnValue(stale.promise);
    deps.terminalHub.recheckSessions.mockReturnValue(recheck.promise);
    const stop = startRelayMaintenance(deps);
    // Advance to the 60 s tick: the last stale sweep and the recheck are both
    // still running (the earlier stale sweeps shared the same pending promise).
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_RECHECK_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions).toHaveBeenCalled();
    expect(deps.terminalHub.recheckSessions).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    // The recheck settling alone must not let stop resolve: the stale sweep is
    // still using the database client, so it has to keep stop open too.
    recheck.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    stale.resolve(undefined);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("a sweep that throws synchronously is logged and does not stall stop", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = fakes();
    deps.terminalHub.recheckSessions.mockImplementation(() => {
      throw new RangeError("secret detail");
    });
    const stop = startRelayMaintenance(deps);
    await vi.advanceTimersByTimeAsync(TERMINAL_SESSION_RECHECK_INTERVAL_MS);
    await stop();
    expect(errors).toHaveBeenCalledWith("[server] terminal session recheck failed", "RangeError");
  });
});
