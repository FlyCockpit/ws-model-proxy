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
 * failing sweep does not stop the others. Returns one stop for all timers.
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

export function startRelayMaintenance(deps: RelayMaintenanceDeps): () => void {
  const schedule = (tick: () => void, ms: number) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return timer;
  };
  const timers = [
    schedule(() => {
      void deps.relaySessions.checkStaleSessions().catch((error: unknown) => {
        console.error("[server] stale relay session sweep failed", errorClass(error));
      });
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
      void deps.terminalHub.recheckSessions().catch((error: unknown) => {
        console.error("[server] terminal session recheck failed", errorClass(error));
      });
    }, TERMINAL_SESSION_RECHECK_INTERVAL_MS),
  ];
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
