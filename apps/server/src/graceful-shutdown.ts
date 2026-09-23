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
 *   6. disconnect Prisma last.
 *
 * Each step's failure is logged and swallowed: a failed earlier step must
 * not prevent the later steps from running (otherwise a stuck MCP close
 * would leak Postgres connections).
 */

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

export async function runWithDeadline(
  work: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
  deps: DeadlineLogger = {},
): Promise<void> {
  const warn = deps.warn ?? defaultWarn;
  const logError = deps.logError ?? defaultLogError;
  const deadline = deadlineAfter(timeoutMs);
  try {
    const result = await Promise.race([
      settleLogged(work, `[server] Error during ${label}:`, logError),
      deadline.reached,
    ]);
    if (result === "timeout") warn(`[server] ${label} did not finish before its deadline.`);
  } finally {
    deadline.cancel();
  }
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
