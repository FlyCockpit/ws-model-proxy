/**
 * Extracted graceful-shutdown ordering (Phase 4 item 4).
 *
 * The load-bearing ORDER (unit-tested here):
 *
 *   1. stop periodic jobs (timers must not fire mid-shutdown);
 *   2. drain HTTP (stop accepting connections, let in-flight requests
 *      finish) — nothing may serve NEW /mcp work after this point;
 *   3. close the module-lifetime MCP handler — aborts in-flight modern MCP
 *      exchanges and closes their per-request servers. AFTER the HTTP drain
 *      so no live request loses its server mid-flight, and BEFORE Prisma
 *      disconnect so an in-flight tool teardown can still touch the DB;
 *   4. disconnect Prisma last.
 *
 * Each step's failure is logged and swallowed: a failed earlier step must
 * not prevent the later steps from running (otherwise a stuck MCP close
 * would leak Postgres connections).
 */

export interface ShutdownSequenceDeps {
  stopPeriodicJobs: () => void | Promise<void>;
  drainHttp: () => Promise<void>;
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
    await deps.drainHttp();
    log("[server] HTTP drained.");
  } catch (error) {
    logError("[server] Error draining HTTP server:", error);
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
