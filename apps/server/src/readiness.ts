import type { UserDeletionSweepHealth } from "./user-deletion-sweep.js";

/** What the readiness probe (`GET /ready`, ./app.ts) observed. */
export type ReadinessObservation = {
  /** `SELECT 1` on the shared client answered within its bound. */
  postgres: boolean;
  /** The user-deletion sweep loop's coarse health (./user-deletion-sweep.ts). */
  userDeletionSweep: UserDeletionSweepHealth;
  /** This build's commit ({@link buildCommit}), or null when unknown. */
  commit: string | null;
};

/**
 * The commit this image was built from: `BUILD_VERSION` when it is a full
 * 40-hex git SHA (what the release workflow sets), otherwise null (a tag,
 * a tree id or unset), so a deploy check can accept a deploy by commit.
 */
export function buildCommit(buildVersion: string | undefined): string | null {
  return buildVersion && /^[0-9a-f]{40}$/.test(buildVersion) ? buildVersion : null;
}

/**
 * The readiness probe's answer. Only Postgres decides the status code (503
 * when it is unreachable): a failing background job is no reason for a load
 * balancer or deploy gate to route traffic away. The sweep's health is
 * reported alongside, so an operator (or monitoring that reads the body) sees
 * a sweep that has stopped deleting marked users without reading logs.
 * `degraded` is true when Postgres is up but a background job is failing.
 * The probe is unauthenticated, so it carries coarse states only: no counts,
 * timestamps or error details. `commit` is the build's public commit (or null).
 */
export function readinessResponse(observed: ReadinessObservation): {
  status: 200 | 503;
  body: {
    ok: boolean;
    degraded: boolean;
    commit: string | null;
    checks: { postgres: boolean; userDeletionSweep: UserDeletionSweepHealth };
  };
} {
  const checks = { postgres: observed.postgres, userDeletionSweep: observed.userDeletionSweep };
  return {
    status: observed.postgres ? 200 : 503,
    body: {
      ok: observed.postgres,
      degraded: observed.postgres && observed.userDeletionSweep === "failing",
      commit: observed.commit,
      checks,
    },
  };
}
