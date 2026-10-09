/**
 * The server's shutdown wiring (signal handlers, the step closures of
 * `runGracefulShutdownSequence`, and the user-deletion sweep handoff), as an
 * injectable function so its behaviour is unit-tested with fakes
 * (./server-shutdown.test.ts) instead of by matching index.ts source text.
 *
 * `installServerShutdown` registers SIGTERM and SIGINT on `signals`. The first
 * signal arms the process watchdog synchronously (`runProcessShutdown`,
 * before anything is awaited) and runs the graceful sequence under it; later
 * signals are ignored. The order of the steps is owned and tested by
 * ./graceful-shutdown.ts; this module decides what each step does:
 *
 * - stopPeriodicJobs: every periodic job's stop, the user-deletion sweep's
 *   stop flag (its join is handed to the database step, not awaited here),
 *   the relay session manager's timers, and capacity maintenance only
 *   (`stopMaintenance`; the capacity runtimes keep admitting and renewing
 *   until the drain ends);
 * - drainHttp: the relay drain flag and `server.close` first, then the drain
 *   deadline, idle CLI relay sockets closed inside it, and every lingering
 *   connection forced closed when it runs out (F8);
 * - closeCapacityRuntimes: the production and diagnostics runtimes, once;
 * - closeMcpHandler: the admission gate (which arms the auth DB fence) and the
 *   module-lifetime MCP handler;
 * - disconnectPrisma: the sweep's bounded shutdown (join handed over from
 *   stopPeriodicJobs, quarantine past the join deadline), then the shared
 *   client's bounded disconnect (`disconnectDatabaseClients`).
 *
 * Every bound and the process deadline that sums them live in
 * ./shutdown-timeouts.ts with the invariants they enforce.
 */
import type { StatementBoundedPrismaClient } from "@ws-model-proxy/db/client-factory";
import {
  disconnectDatabaseClients as defaultDisconnectDatabaseClients,
  drainHttpWithDeadline as defaultDrainHttpWithDeadline,
  runGracefulShutdownSequence as defaultRunGracefulShutdownSequence,
  runProcessShutdown as defaultRunProcessShutdown,
} from "./graceful-shutdown.js";
import { HTTP_DRAIN_TIMEOUT_MS } from "./shutdown-timeouts.js";
import {
  shutDownUserDeletionSweep as defaultShutDownUserDeletionSweep,
  type StopUserDeletionSweep,
} from "./user-deletion-sweep.js";

type MaybePromise = void | Promise<void>;

/** What the shutdown needs of the relay session manager. */
export type ShutdownRelaySessions = {
  dispose(): void;
  beginDrain(): void;
  closeIdleRelaySessions(): MaybePromise;
  closeRelaySessions(): MaybePromise;
};

/** What the shutdown needs of the HTTP server (`@hono/node-server`'s `serve`). */
export type ShutdownHttpServer = {
  close(callback: (error?: Error) => void): unknown;
};

export type ServerShutdownDeps = {
  /**
   * Stops of the periodic jobs (undefined when a job is not running). A stop
   * that returns a promise (relay maintenance) resolves once its callbacks in
   * flight settled; the periodic-job step awaits it under its deadline.
   */
  periodicJobStops: ReadonlyArray<(() => MaybePromise) | null | undefined>;
  stopUserDeletionSweep: StopUserDeletionSweep;
  userDeletionSweepClient: StatementBoundedPrismaClient;
  relaySessions: ShutdownRelaySessions;
  /**
   * Flushes the node audit queue (agent and operator actions). Runs right after the relay sessions close
   * (their cancellations are audited) and before the database fence arms, so
   * those events are written; it never rejects and shares the relay-close
   * deadline.
   */
  flushAgentAudit: () => Promise<void>;
  terminalHub: { closeAll(): void };
  /** Live transcription client sessions, including those still waiting for a model. */
  realtimeSessions?: { closeAll(): void };
  /**
   * Waits for live transcription usage writes already started (sessions
   * ended by `realtimeSessions.closeAll`). Runs with the relay close, before
   * the database fence arms; never rejects.
   */
  flushRealtimeMetering?: () => Promise<void>;
  server: ShutdownHttpServer;
  capacityLifecycle?: {
    stopMaintenance(): Promise<void>;
    close(): Promise<void>;
  } | null;
  closeDiagnosticsCapacityRuntime: () => Promise<void>;
  mcpAdmissionGate: { close(): Promise<void> };
  mcpHandler?: { close(): Promise<void> } | null;
  /** The shared request client. */
  shared: { $disconnect(): Promise<void> };
  /** Where SIGTERM / SIGINT are registered (defaults to `process`). */
  signals?: { on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown };
  log?: (message: string) => void;
  runProcessShutdown?: typeof defaultRunProcessShutdown;
  runGracefulShutdownSequence?: typeof defaultRunGracefulShutdownSequence;
  drainHttpWithDeadline?: typeof defaultDrainHttpWithDeadline;
  disconnectDatabaseClients?: typeof defaultDisconnectDatabaseClients;
  shutDownUserDeletionSweep?: typeof defaultShutDownUserDeletionSweep;
};

export type ServerShutdown = {
  /** Starts the shutdown once; later calls are ignored. */
  shutdown(signal: string): void;
};

export function installServerShutdown(deps: ServerShutdownDeps): ServerShutdown {
  const log = deps.log ?? ((message: string) => console.log(message));
  const runProcessShutdown = deps.runProcessShutdown ?? defaultRunProcessShutdown;
  const runGracefulShutdownSequence =
    deps.runGracefulShutdownSequence ?? defaultRunGracefulShutdownSequence;
  const drainHttpWithDeadline = deps.drainHttpWithDeadline ?? defaultDrainHttpWithDeadline;
  const disconnectDatabaseClients =
    deps.disconnectDatabaseClients ?? defaultDisconnectDatabaseClients;
  const shutDownUserDeletionSweep =
    deps.shutDownUserDeletionSweep ?? defaultShutDownUserDeletionSweep;
  const { relaySessions, server } = deps;

  let isShuttingDown = false;
  // The join of the stopped sweep, handed from stopPeriodicJobs (which sets
  // the stop flag only) to the database step (which joins it, bounded).
  let userDeletionSweepStopped: Promise<void> | null = null;

  const runShutdownSequence = () =>
    runGracefulShutdownSequence({
      // Stop the periodic jobs so they can't fire mid-shutdown.
      stopPeriodicJobs: async () => {
        // Every timer is cleared synchronously; the joins of callbacks
        // already running are awaited below, with capacity maintenance.
        const jobJoins = deps.periodicJobStops.map((stop) => stop?.());
        // Sets the stop flag only (no await): the in-flight tick is joined
        // after the DB fence arms, in disconnectPrisma.
        userDeletionSweepStopped = deps.stopUserDeletionSweep();
        relaySessions.dispose();
        // Maintenance only: the capacity runtimes keep serving until the
        // drain ends and are closed in closeCapacityRuntimes. Awaited
        // together, so one slow join does not delay another's start; the step
        // is bounded by PERIODIC_JOBS_STOP_TIMEOUT_MS.
        await Promise.all([...jobJoins, deps.capacityLifecycle?.stopMaintenance()]);
      },
      closeBrowserSockets: () => {
        // Drain flag first, in the same synchronous turn as closeAll(): an
        // upgrade that passed the middleware's drain check before this ran
        // registers after closeAll(), and admitBrowserConnection re-checks
        // the flag at registration and closes it (the HTTP drain below sets
        // the flag again; it is idempotent).
        relaySessions.beginDrain();
        deps.terminalHub.closeAll();
        deps.realtimeSessions?.closeAll();
      },
      closeRelaySessions: async () => {
        await relaySessions.closeRelaySessions();
        await deps.flushRealtimeMetering?.();
        await deps.flushAgentAudit();
      },
      // Admission stops first (relay drain flag makes terminal and CLI
      // upgrades return 503; server.close stops new connections), then the
      // drain deadline starts, then idle CLI sockets close and their DB writes
      // run inside that deadline. At the deadline every lingering connection
      // is forced closed (F8), so a request still reading its body aborts and
      // the MCP admission gate settles.
      drainHttp: () =>
        drainHttpWithDeadline({
          timeoutMs: HTTP_DRAIN_TIMEOUT_MS,
          stopAdmission: () => {
            relaySessions.beginDrain();
            return new Promise<void>((resolve) => {
              server.close((err) => {
                if (err) {
                  // Sanitized (L19): constructor name only.
                  console.error(
                    `[server] Error closing HTTP server: (${err.constructor?.name ?? "Error"})`,
                  );
                }
                resolve();
              });
            });
          },
          closeIdleRelaySessions: () => relaySessions.closeIdleRelaySessions(),
          forceCloseConnections: () => {
            // @hono/node-server's ServerType union does not declare these on
            // every member; Node's http server (what serve() builds) has both.
            const nodeServer = server as {
              closeAllConnections?: () => void;
              closeIdleConnections?: () => void;
            };
            nodeServer.closeAllConnections?.();
            nodeServer.closeIdleConnections?.();
          },
        }),
      // After the HTTP drain, before the MCP gate arms the database fence.
      closeCapacityRuntimes: async () => {
        await Promise.all([
          deps.capacityLifecycle?.close(),
          deps.closeDiagnosticsCapacityRuntime(),
        ]);
      },
      // The gate's close arms the auth DB fence synchronously, aborts every
      // admitted exchange and shadow-awaits them (capped by
      // MCP_CLOSE_SHADOW_AWAIT_MS); the handler closes its per-request
      // servers. The only application-side close() call site.
      closeMcpHandler: async () => {
        await Promise.all([deps.mcpAdmissionGate.close(), deps.mcpHandler?.close()]);
      },
      // Database clients last: the sweep's client (join bounded, quarantine
      // past it, disconnect bounded), then the shared client's bounded
      // disconnect (see disconnectDatabaseClients).
      disconnectPrisma: async () => {
        await disconnectDatabaseClients({
          shutDownSweep: () =>
            shutDownUserDeletionSweep({
              stopped: () => userDeletionSweepStopped ?? deps.stopUserDeletionSweep(),
              client: deps.userDeletionSweepClient,
            }),
          shared: deps.shared,
        });
      },
    });

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log(`[server] Received ${signal} — starting graceful shutdown…`);
    // The process watchdog is armed here, before anything is awaited: the
    // process exits with status 1 at PROCESS_SHUTDOWN_DEADLINE_MS whatever a
    // step is still waiting on, and with status 0 once the sequence finished.
    runProcessShutdown({ sequence: runShutdownSequence });
  };

  const signals = deps.signals ?? process;
  signals.on("SIGTERM", () => shutdown("SIGTERM"));
  signals.on("SIGINT", () => shutdown("SIGINT"));
  return { shutdown };
}
