/**
 * Extracted graceful-shutdown ordering (Phase 4 item 4).
 *
 * The load-bearing ORDER (unit-tested here):
 *
 *   1. stop periodic jobs (timers must not fire mid-shutdown);
 *   2. close browser terminal sockets so they do not hold the HTTP drain;
 *   3. drain HTTP (`drainHttpWithDeadline`). Admission stops FIRST (relay
 *      drain flag + server.close), then the drain deadline starts, then idle
 *      CLI relay sockets close and their DB writes run INSIDE that deadline.
 *      Nothing may serve NEW /mcp work after this point;
 *   4. close relay sessions after the drain, while Prisma is still up, so
 *      in-flight model requests can finish. Its DB writes are bounded too
 *      (`runWithDeadline`), so a locked row cannot hang shutdown;
 *   5. close the module-lifetime MCP handler — aborts in-flight modern MCP
 *      exchanges and closes their per-request servers. AFTER the HTTP drain
 *      so no live request loses its server mid-flight, and BEFORE Prisma
 *      disconnect so an in-flight tool teardown can still touch the DB;
 *   6. disconnect the database clients last (`disconnectDatabaseClients`):
 *      the user-deletion sweep's client under its join and disconnect
 *      deadlines, then the shared client under `SHARED_DISCONNECT_TIMEOUT_MS`.
 *
 * The whole sequence runs under `runProcessShutdown`: a watchdog armed before
 * the first step exits the process with status 1 at
 * `PROCESS_SHUTDOWN_DEADLINE_MS` whatever is still pending, and the normal
 * path exits with status 0 (the invariants are in ./shutdown-timeouts.ts).
 *
 * Each step's failure is logged and swallowed: a failed earlier step must
 * not prevent the later steps from running (otherwise a stuck MCP close
 * would leak Postgres connections).
 */

import { PROCESS_SHUTDOWN_DEADLINE_MS, SHARED_DISCONNECT_TIMEOUT_MS } from "./shutdown-timeouts.js";

export interface ShutdownSequenceDeps {
  stopPeriodicJobs: () => void | Promise<void>;
  /** Close browser terminal sockets before the HTTP drain so they cannot hold it. */
  closeBrowserSockets: () => void | Promise<void>;
  drainHttp: () => Promise<void>;
  /** Cancel terminals and commands, close CLI sockets, mark devices disconnected. */
  closeRelaySessions: () => void | Promise<void>;
  /** Close the module-lifetime MCP handler (`McpHttpHandler.close()`). */
  closeMcpHandler: () => Promise<void>;
  disconnectPrisma: () => Promise<void>;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}

/**
 * Sanitized error label (L19, Part F pass 2): constructor name for Errors,
 * typeof otherwise — NEVER `error.message` or the raw rejection value.
 * Shutdown rejections can be Prisma errors (messages embed SQL + params)
 * or arbitrary objects; the operation name in the static message is all
 * the diagnostic context these lines may carry (Part D terminal policy).
 */
function sanitizedErrorLabel(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

export async function runGracefulShutdownSequence(deps: ShutdownSequenceDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const logError =
    deps.logError ??
    ((message: string, error: unknown) => {
      console.error(`${message} (${sanitizedErrorLabel(error)})`);
    });

  try {
    await deps.stopPeriodicJobs();
  } catch (error) {
    logError("[server] Error stopping periodic jobs during shutdown:", error);
  }

  try {
    await deps.closeBrowserSockets();
    log("[server] Browser terminal sockets closed.");
  } catch (error) {
    logError("[server] Error closing browser terminal sockets:", error);
  }

  try {
    await deps.drainHttp();
    log("[server] HTTP drained.");
  } catch (error) {
    logError("[server] Error draining HTTP server:", error);
  }

  try {
    await deps.closeRelaySessions();
    log("[server] Relay sessions closed.");
  } catch (error) {
    logError("[server] Error closing relay sessions:", error);
  }

  // After HTTP drain, BEFORE Prisma disconnect (see module doc).
  try {
    await deps.closeMcpHandler();
    log("[server] MCP handler closed.");
  } catch (error) {
    logError("[server] Error closing MCP handler:", error);
  }

  try {
    await deps.disconnectPrisma();
    log("[server] Prisma disconnected.");
  } catch (error) {
    logError("[server] Error disconnecting Prisma:", error);
  }
}

type DeadlineLogger = {
  warn?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
};

function defaultWarn(message: string) {
  console.warn(message);
}

function defaultLogError(message: string, error: unknown) {
  console.error(`${message} (${sanitizedErrorLabel(error)})`);
}

/** Resolves "timeout" after `ms`. `cancel` clears the timer. */
function deadlineAfter(ms: number): { reached: Promise<"timeout">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { reached, cancel: () => clearTimeout(timer) };
}

/**
 * Starts `work` and waits for it or the deadline, whichever comes first.
 * Work that misses the deadline keeps running unobserved; its failure is
 * still logged (sanitized) so it cannot become an unhandled rejection.
 */
function settleLogged(
  work: () => void | Promise<void>,
  errorMessage: string,
  logError: (message: string, error: unknown) => void,
): Promise<"done"> {
  return (async () => {
    try {
      await work();
    } catch (error) {
      logError(errorMessage, error);
    }
    return "done" as const;
  })();
}

/**
 * Resolves "done" when `work` settled (its failure is logged) or "timeout"
 * when the deadline came first (a warning is logged; the work keeps running
 * unobserved).
 */
export async function runWithDeadline(
  work: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
  deps: DeadlineLogger = {},
): Promise<"done" | "timeout"> {
  const warn = deps.warn ?? defaultWarn;
  const logError = deps.logError ?? defaultLogError;
  const deadline = deadlineAfter(timeoutMs);
  try {
    const result = await Promise.race([
      settleLogged(work, `[server] Error during ${label}:`, logError),
      deadline.reached,
    ]);
    if (result === "timeout") warn(`[server] ${label} did not finish before its deadline.`);
    return result;
  } finally {
    deadline.cancel();
  }
}

export interface DatabaseClientsTeardownDeps<SweepResult> extends DeadlineLogger {
  /**
   * The user-deletion sweep's bounded shutdown (`shutDownUserDeletionSweep`
   * on the sweep's own client): at most its join plus disconnect deadlines.
   */
  shutDownSweep: () => Promise<SweepResult>;
  /** The shared (request) client. */
  shared: { $disconnect: () => Promise<void> };
  /** Defaults to `SHARED_DISCONNECT_TIMEOUT_MS`. */
  sharedTimeoutMs?: number;
}

export interface DatabaseClientsTeardown<SweepResult> {
  /** The sweep's shutdown outcome; `undefined` when it threw (logged). */
  sweep: SweepResult | undefined;
  /** "timeout": the shared disconnect was abandoned at its deadline. */
  shared: "done" | "timeout";
}

/**
 * Tears down every database client, each under its own bound: the sweep's
 * client first (its bounded shutdown), then the shared client's `$disconnect`
 * under `sharedTimeoutMs`. A shared operation admitted before the DB fence
 * armed can wait on a lock the quarantined sweep backend still holds (its
 * `COMMIT` stalled on the server), and pg-pool's `end()` waits for that
 * checked-out client; past the deadline the disconnect is abandoned with a
 * sanitized warning, and the process exit that follows closes the sockets.
 * No quarantine of the shared pool: the exit ends every socket anyway.
 */
export async function disconnectDatabaseClients<SweepResult>(
  deps: DatabaseClientsTeardownDeps<SweepResult>,
): Promise<DatabaseClientsTeardown<SweepResult>> {
  const warn = deps.warn ?? defaultWarn;
  const logError = deps.logError ?? defaultLogError;
  let sweep: SweepResult | undefined;
  try {
    sweep = await deps.shutDownSweep();
  } catch (error) {
    // The shared client still disconnects after a failed sweep shutdown.
    logError("[server] Error shutting down the user deletion sweep:", error);
  }
  const shared = await runWithDeadline(
    () => deps.shared.$disconnect(),
    deps.sharedTimeoutMs ?? SHARED_DISCONNECT_TIMEOUT_MS,
    "shared database client disconnect",
    { warn, logError },
  );
  if (shared === "timeout") {
    warn(
      "[server] Abandoning the shared database client's connections still in use; the process exit closes them and the server rolls back what they left open.",
    );
  }
  return { sweep, shared };
}

export interface ProcessShutdownDeps {
  /** The whole graceful sequence (`runGracefulShutdownSequence`). */
  sequence: () => Promise<void>;
  /** Defaults to `PROCESS_SHUTDOWN_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Defaults to `process.exit`; injectable for tests. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

/**
 * Runs the shutdown sequence under a process watchdog. The watchdog is armed
 * synchronously, before anything is awaited: at `deadlineMs` it logs and
 * exits with status 1, whatever is still pending (a step without a bound, a
 * hung close). The timer is unref'd, so it never keeps a finished process
 * alive, and it is not cleared: the normal path ends in `exit(0)`, which ends
 * the process before it could fire. Returns the watchdog timer (for tests).
 */
export function runProcessShutdown(deps: ProcessShutdownDeps): {
  watchdog: ReturnType<typeof setTimeout>;
  done: Promise<void>;
} {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const watchdog = setTimeout(() => {
    logError("[server] Shutdown deadline exceeded; exiting.");
    exit(1);
  }, deps.deadlineMs ?? PROCESS_SHUTDOWN_DEADLINE_MS);
  watchdog.unref();
  const done = (async () => {
    try {
      await deps.sequence();
    } catch (error) {
      // runGracefulShutdownSequence swallows step failures; this is a guard.
      logError(`[server] Shutdown sequence failed (${sanitizedErrorLabel(error)}); exiting.`);
      exit(1);
      return;
    }
    log("[server] Shutdown complete.");
    exit(0);
  })();
  return { watchdog, done };
}

export interface HttpDrainDeps extends DeadlineLogger {
  /**
   * Refuse new work synchronously (relay drain flag, server.close). Resolves
   * once the HTTP server has closed. Called before anything touches the DB.
   */
  stopAdmission: () => Promise<void>;
  /** Close idle CLI relay sockets and persist their status (DB writes). */
  closeIdleRelaySessions: () => void | Promise<void>;
  /** Drain timeout: abort every lingering connection. */
  forceCloseConnections: () => void;
  timeoutMs: number;
}

/**
 * Stop admission, start the drain deadline, then run relay persistence inside
 * it. A stalled DB write can use up the deadline but never extend it.
 */
export async function drainHttpWithDeadline(deps: HttpDrainDeps): Promise<void> {
  const warn = deps.warn ?? defaultWarn;
  const logError = deps.logError ?? defaultLogError;
  let closed: Promise<"closed">;
  try {
    closed = deps.stopAdmission().then(
      () => "closed" as const,
      (error: unknown) => {
        logError("[server] Error closing HTTP server:", error);
        return "closed" as const;
      },
    );
  } catch (error) {
    logError("[server] Error stopping HTTP admission:", error);
    closed = Promise.resolve("closed" as const);
  }
  const deadline = deadlineAfter(deps.timeoutMs);
  try {
    const persisted = await Promise.race([
      settleLogged(
        deps.closeIdleRelaySessions,
        "[server] Error closing idle relay sessions:",
        logError,
      ),
      deadline.reached,
    ]);
    if (persisted === "timeout") {
      warn("[server] Idle relay session close did not finish before the drain deadline.");
    }
    const drained = await Promise.race([closed, deadline.reached]);
    if (drained === "timeout") {
      warn("[server] Drain timeout reached, forcing close.");
      try {
        deps.forceCloseConnections();
      } catch (error) {
        logError("[server] Error forcing connections closed:", error);
      }
    }
  } finally {
    deadline.cancel();
  }
}
