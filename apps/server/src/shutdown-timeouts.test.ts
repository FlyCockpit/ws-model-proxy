import { CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS } from "@ws-model-proxy/db/capacity-lock-order";
import { PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS } from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";
import {
  CAPACITY_RUNTIME_CLOSE_TIMEOUT_MS,
  HTTP_DRAIN_TIMEOUT_MS,
  MCP_CLOSE_SHADOW_AWAIT_MS,
  PERIODIC_JOBS_STOP_TIMEOUT_MS,
  PROCESS_SHUTDOWN_DEADLINE_MS,
  RELAY_CLOSE_TIMEOUT_MS,
  SHARED_DISCONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
  USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
  USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
  USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
} from "./shutdown-timeouts.js";

// F2-07: shutdown waits on the user-deletion sweep for at most the join
// deadline J plus the disconnect deadline D (`shutDownUserDeletionSweep`
// quarantines the sweep's pool when J runs out, and again when D does). No
// server-side bound covers the end of a transaction (a COMMIT can wait on
// synchronous replication after statement_timeout is disarmed), so nothing
// here assumes one: J only has to let an ORDINARY tick settle, one bounded
// statement or one bounded connect plus the rollback margin, so the healthy
// and lock-blocked paths disconnect gracefully without a quarantine.
// Executed against real PostgreSQL in
// packages/api/src/lib/parent-deletion.postgres.integration.test.ts (a COMMIT
// stalled on a missing synchronous standby; statements blocked on locks).
//
// These are the invariants the constants must satisfy, not their values: any
// retuning that keeps them passes, any that breaks one fails here.
describe("shutdown timing invariants", () => {
  // Inside a drain batch and inside the ordered final delete a
  // transaction-local statement_timeout overrides the sweep connection's
  // session one, so a statement in flight at the fence is bounded by the
  // largest of the three.
  const statementBound = Math.max(
    USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
    PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS,
    CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS,
  );
  // What an ordinary tick still needs after the fence: the statement or the
  // connect in flight (never both: a fenced connection's first statement is
  // refused), then its rollback.
  const ordinaryTickEnd =
    Math.max(USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS, statementBound) +
    USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS;

  it("gives every bound a positive value (0 would disable the server-side timeout)", () => {
    for (const bound of [
      USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
      USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS,
      PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS,
      CAPACITY_ORDERED_STATEMENT_TIMEOUT_MS,
      USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
      USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS,
      SHARED_DISCONNECT_TIMEOUT_MS,
      PERIODIC_JOBS_STOP_TIMEOUT_MS,
      HTTP_DRAIN_TIMEOUT_MS,
      RELAY_CLOSE_TIMEOUT_MS,
      CAPACITY_RUNTIME_CLOSE_TIMEOUT_MS,
      MCP_CLOSE_SHADOW_AWAIT_MS,
      PROCESS_SHUTDOWN_DEADLINE_MS,
    ]) {
      expect(Number.isFinite(bound) && bound > 0).toBe(true);
    }
  });

  it("lets a statement in flight, cut off by the largest server-side bound, settle inside the join", () => {
    expect(statementBound + USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS).toBeLessThan(
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
    );
  });

  it("lets a connect in flight, cut off by the connect bound, settle inside the join", () => {
    expect(
      USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS + USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
    ).toBeLessThan(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS);
  });

  it("leaves room in the join for an ordinary transaction end, without padding it far past the bounded work", () => {
    // A healthy tick's COMMIT (one round trip) fits on top of the bounded
    // work, so it is not quarantined...
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS - ordinaryTickEnd).toBeGreaterThanOrEqual(
      USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
    );
    // ...and the join is not an unbounded-looking wait on the sweep.
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS).toBeLessThanOrEqual(2 * ordinaryTickEnd);
  });

  // F2-07d: a cold connect to a remote PostgreSQL over TLS with SCRAM takes
  // several round trips; a bound near 500 ms failed whole ticks on such a
  // link.
  it("lets a cold remote TLS connect finish", () => {
    expect(USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
  });

  it("keeps a disconnect bound shorter than the join it follows", () => {
    expect(USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS).toBeLessThan(
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
    );
    expect(SHARED_DISCONNECT_TIMEOUT_MS).toBeLessThan(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS);
  });

  // The process watchdog is the sum of every step's wait plus a margin, so it
  // never fires before a step that finishes within its term, and it ends any
  // step without a bound (mcpHandler.close()).
  it("sets the process deadline to the sum of the step waits plus a real, bounded margin", () => {
    const steps =
      PERIODIC_JOBS_STOP_TIMEOUT_MS +
      HTTP_DRAIN_TIMEOUT_MS +
      RELAY_CLOSE_TIMEOUT_MS +
      CAPACITY_RUNTIME_CLOSE_TIMEOUT_MS +
      MCP_CLOSE_SHADOW_AWAIT_MS +
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS +
      USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS +
      SHARED_DISCONNECT_TIMEOUT_MS;
    const margin = PROCESS_SHUTDOWN_DEADLINE_MS - steps;
    // Browser socket close and the JavaScript continuations between steps.
    expect(margin).toBeGreaterThanOrEqual(4_000);
    // Not padded far past the steps.
    expect(margin).toBeLessThanOrEqual(10_000);
  });

  it("keeps the documented container stop grace (52 s) above the process deadline", () => {
    // Deployment docs tell operators to set a stop grace of 52 s; SIGKILL
    // before the watchdog would cut the bounded sequence short.
    expect(PROCESS_SHUTDOWN_DEADLINE_MS).toBeLessThan(52_000);
  });
});
