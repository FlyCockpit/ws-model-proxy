/**
 * MCP admission barrier (Part F pass 3, F8; terminal redesign pass 4).
 *
 * The installed SDK's `close()` only tracks servers that exist — a server is
 * created by the FACTORY, which runs after the request body has been parsed.
 * A request that passed Hono's body cap (a valid under-limit Content-Length
 * passes without buffering) but is still awaiting its body therefore has NO
 * tracked server: after the SDK `close()` resolves, such a request could
 * still proceed to the factory (and tools, and the database) during or after
 * shutdown teardown.
 *
 * This gate closes that pre-factory window with a counter/permit model —
 * deliberately NO session map and NO subscriptions:
 *
 * - `admit()` is called by the /mcp route handler at ENTRY (before any body
 *   handling) and returns a PERMIT: an owned `AbortController` plus an
 *   idempotent `release()`.
 * - RELEASE MEANS WORK STOPPED (the pass-4 terminal invariant): the handler
 *   releases ONLY when its promise SETTLES, and its continuations are fenced
 *   on the permit's abort signal — every stage after the current await is
 *   skipped once the signal aborts, so a release can never leave a
 *   continuation capable of entering the factory or touching the database.
 *   The abort event itself NEVER releases.
 * - `close()` flips the gate closed SYNCHRONOUSLY (arming the shutdown-side
 *   fences via the optional `onClosed` hook — production arms the auth
 *   DB-seam fence; post-close admissions get a safe 503 JSON-RPC error from
 *   the route handler) AND aborts every outstanding permit controller — so
 *   even a never-settling transport is cancelled (the handler's stage
 *   races/fences settle it) and `close()` resolves once every admitted
 *   handler has SETTLED. The handler's abort-path release SHADOW-AWAITS
 *   the still-pending admitted promise with a bounded budget (mcp/auth.ts,
 *   F8 pass 5), so the wait is bounded by construction, never by client
 *   behavior.
 *
 * Normal (non-timeout) drain semantics are unchanged: the graceful-shutdown
 * sequence drains HTTP FIRST (in-flight requests finish normally, their
 * controllers never abort); `close()` runs afterwards and only cancels
 * stragglers the drain could not finish.
 */
export interface McpAdmission {
  /**
   * The handler-OWNED abort controller for this exchange. The route handler
   * races and fences every admitted stage on this signal, builds the
   * canonical verifier request with it, and the transport factory refuses to
   * run once it is aborted. Aborted by the client request signal (peered
   * disconnect) and by {@link McpAdmissionGate.close}.
   */
  readonly controller: AbortController;
  /**
   * Release the admission. Idempotent. MUST be called only when the admitted
   * handler's promise has SETTLED (work stopped per the stage fences) —
   * never from an abort listener.
   */
  release(): void;
}

export interface McpAdmissionGate {
  /** Outstanding (admitted, not yet released) request count. */
  readonly outstanding: number;
  /** Whether {@link McpAdmissionGate.close} has been called. */
  readonly closed: boolean;
  /**
   * Track a newly admitted request. Returns a permit (owned abort controller
   * + idempotent release), or `null` once the gate is closed — the caller
   * must then reject the request without touching the transport.
   */
  admit(): McpAdmission | null;
  /**
   * Stop admitting new requests (synchronously), ABORT every outstanding
   * admitted controller (cancelling their work through the stage fences),
   * and resolve once every outstanding admission has RELEASED — i.e. every
   * admitted handler promise has settled. Resolve is immediate when nothing
   * is outstanding.
   */
  close(): Promise<void>;
}

/**
 * Gate construction options (Part F pass 5). `onClosed` runs SYNCHRONOUSLY
 * at the start of {@link McpAdmissionGate.close} — before the outstanding
 * controllers abort — so shutdown-side fences (the auth DB-seam fence) are
 * armed BEFORE any stray continuation can be resumed by the abort.
 */
export interface CreateMcpAdmissionGateOptions {
  /**
   * Invoked exactly once, synchronously, when close() flips the gate
   * closed. Production (app.ts) passes `armAuthDbShutdownFence` so that no
   * better-auth adapter DB operation can START after shutdown began (the
   * un-cancellable requireMcpAuth verifier continuations are fenced at the
   * Prisma seam — see @ws-model-proxy/auth/auth-db-shutdown-fence).
   */
  onClosed?: () => void;
}

export function createMcpAdmissionGate(
  options: CreateMcpAdmissionGateOptions = {},
): McpAdmissionGate {
  let closed = false;
  let outstanding = 0;
  let waiters: Array<() => void> = [];
  const controllers = new Set<AbortController>();

  const settleIfDrained = () => {
    if (closed && outstanding === 0) {
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    }
  };

  return {
    get outstanding() {
      return outstanding;
    },
    get closed() {
      return closed;
    },
    admit() {
      if (closed) return null;
      outstanding += 1;
      const controller = new AbortController();
      controllers.add(controller);
      let released = false;
      return {
        controller,
        release: () => {
          if (released) return;
          released = true;
          controllers.delete(controller);
          outstanding -= 1;
          settleIfDrained();
        },
      };
    },
    close() {
      // Arm shutdown-side fences FIRST (synchronously): the DB-seam fence
      // must be active before the abort below resumes any continuation, so
      // no stray verifier continuation can slip a NEW database operation
      // between the gate flip and the fence. Exactly once — the second
      // close() of the double-close contract must not re-arm.
      const firstClose = !closed;
      closed = true;
      if (firstClose) options.onClosed?.();
      // Bounded close (pass 4): cancel every outstanding admitted exchange.
      // Aborting the permit controller settles the handler through its
      // abort race (prompt) and stops its continuations through the stage
      // fences (guarantee) — so the release below cannot leave live work
      // behind and close() cannot hang on a never-settling transport.
      // controllers.clear() first: release() may already be racing us.
      const toAbort = [...controllers];
      controllers.clear();
      for (const controller of toAbort) controller.abort();
      settleIfDrained();
      if (outstanding === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
