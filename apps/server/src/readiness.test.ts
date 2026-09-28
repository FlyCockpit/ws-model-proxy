import { describe, expect, it } from "vitest";
import { readinessResponse } from "./readiness.js";

describe("readinessResponse", () => {
  it("is ready and not degraded when Postgres answers and the sweep is healthy", () => {
    expect(readinessResponse({ postgres: true, userDeletionSweep: "ok" })).toEqual({
      status: 200,
      body: { ok: true, degraded: false, checks: { postgres: true, userDeletionSweep: "ok" } },
    });
  });

  it("reports a failing sweep as degraded without failing the probe", () => {
    expect(readinessResponse({ postgres: true, userDeletionSweep: "failing" })).toEqual({
      status: 200,
      body: {
        ok: true,
        degraded: true,
        checks: { postgres: true, userDeletionSweep: "failing" },
      },
    });
  });

  it("is not ready when Postgres is unreachable, whatever the sweep reports", () => {
    for (const userDeletionSweep of ["ok", "failing", "not_running"] as const) {
      const { status, body } = readinessResponse({ postgres: false, userDeletionSweep });
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.degraded).toBe(false);
      expect(body.checks.userDeletionSweep).toBe(userDeletionSweep);
    }
  });

  it("carries coarse states only (unauthenticated probe)", () => {
    const { body } = readinessResponse({ postgres: true, userDeletionSweep: "failing" });
    expect(Object.keys(body.checks).sort()).toEqual(["postgres", "userDeletionSweep"]);
    expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}|Error/);
  });
});
