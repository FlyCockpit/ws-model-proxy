import { describe, expect, it } from "vitest";
import { buildCommit, readinessResponse } from "./readiness.js";

describe("readinessResponse", () => {
  it("is ready and not degraded when Postgres answers and the sweep is healthy", () => {
    expect(readinessResponse({ postgres: true, userDeletionSweep: "ok", commit: null })).toEqual({
      status: 200,
      body: {
        ok: true,
        degraded: false,
        commit: null,
        checks: { postgres: true, userDeletionSweep: "ok" },
      },
    });
  });

  it("reports a failing sweep as degraded without failing the probe", () => {
    expect(
      readinessResponse({ postgres: true, userDeletionSweep: "failing", commit: null }),
    ).toEqual({
      status: 200,
      body: {
        ok: true,
        degraded: true,
        commit: null,
        checks: { postgres: true, userDeletionSweep: "failing" },
      },
    });
  });

  it("is not ready when Postgres is unreachable, whatever the sweep reports", () => {
    for (const userDeletionSweep of ["ok", "failing", "not_running"] as const) {
      const { status, body } = readinessResponse({
        postgres: false,
        userDeletionSweep,
        commit: null,
      });
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.degraded).toBe(false);
      expect(body.checks.userDeletionSweep).toBe(userDeletionSweep);
    }
  });

  it("carries coarse states only (unauthenticated probe)", () => {
    const { body } = readinessResponse({
      postgres: true,
      userDeletionSweep: "failing",
      commit: null,
    });
    expect(Object.keys(body.checks).sort()).toEqual(["postgres", "userDeletionSweep"]);
    expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}|Error/);
  });

  it("passes the build's commit through, also when Postgres is down", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(
      readinessResponse({ postgres: false, userDeletionSweep: "ok", commit: sha }).body.commit,
    ).toBe(sha);
  });
});

describe("buildCommit", () => {
  it("is BUILD_VERSION only when it is a full lowercase 40-hex git SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildCommit(sha)).toBe(sha);
    for (const value of [
      undefined,
      "",
      "v1.0.0",
      "wt-fa1c7aad-84e64fde104f",
      sha.toUpperCase(),
      sha.slice(1),
      `${sha}0`,
      ` ${sha}`,
    ])
      expect(buildCommit(value)).toBeNull();
  });
});
