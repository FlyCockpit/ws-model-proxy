import { PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS } from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";
import {
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
// stalled on a missing synchronous standby; statements blocked on locks);
// this pins the arithmetic so a later change to any constant is visible.
describe("shutdown timing arithmetic", () => {
  const statementBound = Math.max(
    USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS,
    PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS,
  );

  it("lets an in-flight statement cut off by its server-side bound settle inside the join", () => {
    expect(statementBound + USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS).toBeLessThan(
      USER_DELETION_SWEEP_JOIN_TIMEOUT_MS,
    );
  });

  it("lets an in-flight connect cut off by the connect bound settle inside the join", () => {
    expect(
      USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS + USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS,
    ).toBeLessThan(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS);
  });

  it("pins the sweep's whole shutdown wait: join plus disconnect deadlines", () => {
    // What shutdown can spend on the sweep, whatever the database does.
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS).toBe(7_500);
    expect(USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS).toBe(1_000);
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS + USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS).toBe(
      8_500,
    );
    // Room for an ordinary transaction end on top of the bounded work, so a
    // healthy tick is not quarantined; not padded far beyond it.
    const ordinary =
      Math.max(USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS, statementBound) +
      USER_DELETION_SWEEP_ROLLBACK_MARGIN_MS;
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS - ordinary).toBeGreaterThanOrEqual(2_000);
    expect(USER_DELETION_SWEEP_JOIN_TIMEOUT_MS).toBeLessThanOrEqual(2 * ordinary);
  });

  // F2-07d: a cold connect to a remote PostgreSQL over TLS with SCRAM takes
  // several round trips; a bound near 500 ms failed whole ticks on such a
  // link. The sweep holds its connection between ticks, so this bound is only
  // paid on a cold connect, and it stays inside the join above.
  it("lets a cold remote TLS connect finish", () => {
    expect(USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
  });

  it("gives every bound a positive value (0 would disable the server-side timeout)", () => {
    expect(USER_DELETION_SWEEP_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(USER_DELETION_SWEEP_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PARENT_DELETION_DRAIN_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(USER_DELETION_SWEEP_DISCONNECT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
