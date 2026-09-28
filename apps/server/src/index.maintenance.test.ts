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
    stop();
  });

  it("stop clears every timer", async () => {
    const deps = fakes();
    startRelayMaintenance(deps)();
    await vi.advanceTimersByTimeAsync(10 * CLI_COMMAND_SWEEP_INTERVAL_MS);
    expect(deps.relaySessions.checkStaleSessions).not.toHaveBeenCalled();
    expect(deps.sweepExpiredTokenCommands).not.toHaveBeenCalled();
    expect(deps.terminalHub.recheckSessions).not.toHaveBeenCalled();
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
    stop();
  });
});
