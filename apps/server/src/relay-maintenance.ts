/**
 * In-process relay maintenance timers (unref'd, so they never keep a
 * finished process alive):
 *
 * - every 15 s: stale relay sessions (`checkStaleSessions`) and expired
 *   pending terminals (`sweepExpiredPendingTerminals`);
 * - every 60 s: expired token-scoped CLI commands (`sweepExpiredTokenCommands`);
 * - every 60 s: browser terminal session rechecks (`recheckSessions`).
 *
 * Each tick logs a failure by error class only (L19) and never throws, so one
 * failing sweep does not stop the others. Returns one stop for all timers: it
 * clears them synchronously, then resolves once every sweep already running
 * has settled, so none of them is still using the database client when
 * shutdown releases it. The stop has no bound of its own; shutdown awaits it
 * inside the periodic-job step, under `PERIODIC_JOBS_STOP_TIMEOUT_MS`
 * (./shutdown-timeouts.ts).
 */

export const RELAY_STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;
export const CLI_COMMAND_SWEEP_INTERVAL_MS = 60_000;
export const TERMINAL_SESSION_RECHECK_INTERVAL_MS = 60_000;

export type RelayMaintenanceDeps = {
  relaySessions: {
    checkStaleSessions(): Promise<unknown>;
    sweepExpiredPendingTerminals(): void;
  };
  sweepExpiredTokenCommands: () => void;
  terminalHub: { recheckSessions(): Promise<unknown> };
};

function errorClass(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export function startRelayMaintenance(deps: RelayMaintenanceDeps): () => Promise<void> {
  // The asynchronous sweeps still running (the synchronous ones finish inside
  // their tick). Each removes itself when it settles; it never rejects.
  const inFlight = new Set<Promise<void>>();
  const track = (run: () => Promise<unknown>, failure: string) => {
    // Called synchronously; the executor also turns a synchronous throw into
    // a logged failure.
    const settled: Promise<void> = new Promise<unknown>((resolve) => resolve(run()))
      .then(
        () => undefined,
        (error: unknown) => {
          console.error(failure, errorClass(error));
        },
      )
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
  };
  const schedule = (tick: () => void, ms: number) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return timer;
  };
  const timers = [
    schedule(() => {
      track(
        () => deps.relaySessions.checkStaleSessions(),
        "[server] stale relay session sweep failed",
      );
      try {
        deps.relaySessions.sweepExpiredPendingTerminals();
      } catch (error) {
        console.error("[server] pending terminal sweep failed", errorClass(error));
      }
    }, RELAY_STALE_SESSION_SWEEP_INTERVAL_MS),
    schedule(() => {
      try {
        deps.sweepExpiredTokenCommands();
      } catch (error) {
        console.error("[server] CLI command sweep failed", errorClass(error));
      }
    }, CLI_COMMAND_SWEEP_INTERVAL_MS),
    schedule(() => {
      track(() => deps.terminalHub.recheckSessions(), "[server] terminal session recheck failed");
    }, TERMINAL_SESSION_RECHECK_INTERVAL_MS),
  ];
  return async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.all([...inFlight]);
  };
}
