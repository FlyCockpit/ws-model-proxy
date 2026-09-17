/**
 * OAuth retention and cleanup tests (MCP plan Phase 8, Part J).
 *
 * Prisma is mocked with mockDeep (`vi.mock("@ws-model-proxy/db")`) and
 * surface-typed via the repo's established `as unknown as {...MockInstance}`
 * alias (same pattern as tools.test.ts) — tests never hit a real database.
 * The shutdown fence is exercised through the REAL module state
 * (armDbShutdownFence/disarmDbShutdownFence) so the between-batch abort
 * behavior runs the production code path.
 */

import { armDbShutdownFence, disarmDbShutdownFence } from "@ws-model-proxy/db/shutdown-fence";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_MCP_ENABLED: false,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import prisma from "@ws-model-proxy/db";
import {
  AUTHORIZATION_CODE_TYPE_MARKER,
  DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS,
  DPOP_VERIFICATION_IDENTIFIER_PREFIX,
  dpopDeletionCutoff,
  inspectExpiredAuthorizationCode,
  OAUTH_CLEANUP_AUDIT_GRACE_MS,
  OAUTH_CLEANUP_BATCH,
  OAUTH_CLEANUP_INTERVAL_MS,
  OAUTH_CLEANUP_VERIFICATION_BATCH,
  OAUTH_CLEANUP_VERIFICATION_SCAN_CAP,
  OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP,
  startOauthCleanup,
  sweepExpiredOAuthArtifacts,
} from "./oauth-cleanup";

const db = prisma as unknown as {
  oauthAccessToken: { findMany: MockInstance; deleteMany: MockInstance };
  oauthRefreshToken: { findMany: MockInstance; deleteMany: MockInstance };
  oauthClientAssertion: { findMany: MockInstance; deleteMany: MockInstance };
  verification: { findMany: MockInstance; deleteMany: MockInstance };
};

/** Marker-safe authorization-code value exactly as the provider stores it. */
function codeValue(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "authorization_code",
    query: { client_id: "https://client.example.com/client.json" },
    userId: "user-1",
    referenceId: "ref-1",
    ...overrides,
  });
}

const NOW = new Date("2026-09-18T12:00:00.000Z");
const GRACE_CUTOFF = new Date(NOW.getTime() - OAUTH_CLEANUP_AUDIT_GRACE_MS);

describe("inspectExpiredAuthorizationCode", () => {
  it("matches only a parsed object with type authorization_code", () => {
    expect(inspectExpiredAuthorizationCode(codeValue())).toEqual({ status: "match" });
  });

  it("retains wrong-type, oversized, unparseable, non-object, and non-string values", () => {
    expect(inspectExpiredAuthorizationCode(JSON.stringify({ type: "delete-email" }))).toEqual({
      status: "retained",
      reason: "wrong-type",
    });
    // Marker over-match (`_` wildcard shape) is rejected post-parse.
    expect(inspectExpiredAuthorizationCode(JSON.stringify({ type: "authorizationXcode" }))).toEqual(
      { status: "retained", reason: "wrong-type" },
    );
    expect(inspectExpiredAuthorizationCode("x".repeat(1024 * 1024 + 1))).toEqual({
      status: "retained",
      reason: "oversized",
    });
    expect(inspectExpiredAuthorizationCode("{not json")).toEqual({
      status: "retained",
      reason: "unparseable",
    });
    expect(inspectExpiredAuthorizationCode(JSON.stringify(["authorization_code"]))).toEqual({
      status: "retained",
      reason: "non-object",
    });
    expect(inspectExpiredAuthorizationCode(null)).toEqual({
      status: "retained",
      reason: "non-string",
    });
  });
});

describe("sweepExpiredOAuthArtifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmDbShutdownFence();
  });
  afterEach(() => {
    disarmDbShutdownFence();
  });

  /** Default: every read surface returns no rows (idempotent empty pass). */
  function seedEmpty() {
    db.oauthAccessToken.findMany.mockResolvedValue([]);
    db.oauthRefreshToken.findMany.mockResolvedValue([]);
    db.oauthClientAssertion.findMany.mockResolvedValue([]);
    db.verification.findMany.mockResolvedValue([]);
  }

  it("is a no-op when nothing matches (idempotent re-run)", async () => {
    seedEmpty();
    await sweepExpiredOAuthArtifacts({ now: NOW });
    await sweepExpiredOAuthArtifacts({ now: NOW });
    expect(db.oauthAccessToken.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthRefreshToken.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthClientAssertion.deleteMany).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes token rows past the grace cutoff with inclusive boundary", async () => {
    db.oauthAccessToken.findMany.mockResolvedValue([{ id: "a1" }]);
    db.oauthAccessToken.deleteMany.mockResolvedValue({ count: 1 });
    db.oauthRefreshToken.findMany.mockResolvedValue([{ id: "r1" }]);
    db.oauthRefreshToken.deleteMany.mockResolvedValue({ count: 1 });
    db.oauthClientAssertion.findMany.mockResolvedValue([]);
    db.verification.findMany.mockResolvedValue([]);

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    // Inclusive lte: a row expiring exactly AT the cutoff is deletable;
    // anything newer is inside the grace window and retained (pinned by the
    // predicate + the cutoff arithmetic below).
    expect(GRACE_CUTOFF.getTime()).toBe(NOW.getTime() - OAUTH_CLEANUP_AUDIT_GRACE_MS);
    expect(db.oauthAccessToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { expiresAt: { lte: GRACE_CUTOFF } } }),
    );
    expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: GRACE_CUTOFF }, id: { in: ["a1"] } },
    });
    expect(db.oauthRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: GRACE_CUTOFF },
        oauthAccessTokens: { every: { expiresAt: { lte: GRACE_CUTOFF } } },
        id: { in: ["r1"] },
      },
    });
    expect(counts.accessTokens).toBe(1);
    expect(counts.refreshTokens).toBe(1);
    expect(counts.clientAssertions).toBe(0);
  });

  it("deletes expired client assertions on the same grace cutoff", async () => {
    seedEmpty();
    db.oauthClientAssertion.findMany.mockResolvedValue([{ id: "c1" }]);
    db.oauthClientAssertion.deleteMany.mockResolvedValue({ count: 1 });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(db.oauthClientAssertion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { expiresAt: { lte: GRACE_CUTOFF } } }),
    );
    expect(db.oauthClientAssertion.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: GRACE_CUTOFF }, id: { in: ["c1"] } },
    });
    expect(counts.clientAssertions).toBe(1);
  });

  it("deletes access rows BEFORE refresh rows (dependency order)", async () => {
    db.oauthAccessToken.findMany.mockResolvedValue([{ id: "a1" }]);
    db.oauthAccessToken.deleteMany.mockResolvedValue({ count: 1 });
    db.oauthRefreshToken.findMany.mockResolvedValue([{ id: "r1" }]);
    db.oauthRefreshToken.deleteMany.mockResolvedValue({ count: 1 });
    db.oauthClientAssertion.findMany.mockResolvedValue([]);
    db.verification.findMany.mockResolvedValue([]);

    await sweepExpiredOAuthArtifacts({ now: NOW });

    const accessOrder = db.oauthAccessToken.deleteMany.mock.invocationCallOrder[0] ?? 0;
    const refreshOrder = db.oauthRefreshToken.deleteMany.mock.invocationCallOrder[0] ?? 0;
    expect(refreshOrder).toBeGreaterThan(accessOrder);
  });

  it("retains rotated-but-unexpired refresh rows (family-invalidation evidence)", async () => {
    seedEmpty();

    await sweepExpiredOAuthArtifacts({ now: NOW });

    // The retention guarantee is the expiry cutoff PLUS child eligibility
    // (an unexpired access child blocks its expired parent's deletion —
    // the Cascade counterexample fix): there is no rotatedAt/revoked term
    // that could widen eligibility, and `expiresAt <= now - grace` excludes
    // EVERY unexpired row (a rotated row with expiresAt one hour from NOW
    // is outside the cutoff by arithmetic).
    const where = db.oauthRefreshToken.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({
      expiresAt: { lte: GRACE_CUTOFF },
      oauthAccessTokens: { every: { expiresAt: { lte: GRACE_CUTOFF } } },
    });
    expect(where).not.toHaveProperty("rotatedAt");
    expect(where).not.toHaveProperty("revoked");
    expect(new Date(NOW.getTime() + 3_600_000).getTime()).toBeGreaterThan(GRACE_CUTOFF.getTime());
  });

  it("gates refresh deletion on access-child eligibility (Cascade counterexamples)", async () => {
    seedEmpty();
    db.oauthRefreshToken.findMany.mockResolvedValue([{ id: "r1" }]);
    db.oauthRefreshToken.deleteMany.mockResolvedValue({ count: 1 });

    await sweepExpiredOAuthArtifacts({ now: NOW });

    // Re-assertion: the DELETE carries the same child-eligibility term as
    // the read (both statements gated, not just the selection).
    const expectedWhere = {
      expiresAt: { lte: GRACE_CUTOFF },
      oauthAccessTokens: { every: { expiresAt: { lte: GRACE_CUTOFF } } },
    };
    expect(db.oauthRefreshToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(db.oauthRefreshToken.deleteMany).toHaveBeenCalledWith({
      where: { ...expectedWhere, id: { in: ["r1"] } },
    });

    // Model the predicate's selection semantics (Prisma `every` is vacuously
    // true for childless parents) over the reviewers' executed states —
    // auth.prisma:311 cascades refresh deletion to ALL children regardless
    // of their expiry, so the PARENT must not be selected unless every
    // remaining child is itself grace-expired.
    const expired = new Date(GRACE_CUTOFF.getTime() - 1000);
    const unexpired = new Date(NOW.getTime() + 3_600_000);
    const parent = (expiresAt: Date) => ({ id: "r", expiresAt });
    const selectable = (
      p: { expiresAt: Date },
      children: { expiresAt: Date; revoked: Date | null }[],
    ) =>
      p.expiresAt.getTime() <= GRACE_CUTOFF.getTime() &&
      children.every((c) => c.expiresAt.getTime() <= GRACE_CUTOFF.getTime());

    // Expired parent + UNEXPIRED child → NEITHER deleted (the access sweep
    // retains the child; the parent is not selected, so no cascade).
    expect(selectable(parent(expired), [{ expiresAt: unexpired, revoked: null }])).toBe(false);
    // Parent + revoked-but-unexpired child → parent retained.
    expect(
      selectable(parent(expired), [
        { expiresAt: unexpired, revoked: new Date(NOW.getTime() - 60_000) },
      ]),
    ).toBe(false);
    // Expired parent + grace-expired child → parent selected (both gone:
    // child via the access sweep, parent via delete — the cascade can then
    // only remove independently eligible rows).
    expect(selectable(parent(expired), [{ expiresAt: expired, revoked: new Date(NOW) }])).toBe(
      true,
    );
    // Childless expired parent → selected (`every` vacuously true).
    expect(selectable(parent(expired), [])).toBe(true);
    // Unexpired parent, any children → retained.
    expect(selectable(parent(unexpired), [{ expiresAt: expired, revoked: null }])).toBe(false);
  });

  it("sweeps DPoP rows by exact prefix plus margin-shifted expiry (no grace)", async () => {
    seedEmpty();
    // First verification read = DPoP phase; second = authorization codes.
    db.verification.findMany
      .mockReset()
      .mockResolvedValueOnce([{ id: "d1" }])
      .mockResolvedValue([]);
    db.verification.deleteMany.mockResolvedValue({ count: 1 });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    const dpopCutoff = dpopDeletionCutoff(NOW);
    expect(dpopCutoff.getTime()).toBe(NOW.getTime() - DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS);
    expect(db.verification.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          identifier: { startsWith: DPOP_VERIFICATION_IDENTIFIER_PREFIX },
          expiresAt: { lte: dpopCutoff },
        },
      }),
    );
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: { startsWith: DPOP_VERIFICATION_IDENTIFIER_PREFIX },
        expiresAt: { lte: dpopCutoff },
        id: { in: ["d1"] },
      },
    });
    expect(counts.dpopVerifications).toBe(1);
  });

  it("never deletes a DPoP reservation whose proof the (floor-clock) verifier could still accept", () => {
    // Models the INSTALLED verifier (@better-auth/core dist/oauth2/dpop.mjs):
    //   :138 nowSeconds = Math.floor(Date.now()/1e3)
    //   :171 reject only when nowSeconds - iat > proofMaxAgeSeconds
    //   :185 reservation expiresAt = (iat + proofMaxAgeSeconds) * 1000
    // A proof is acceptable while floor(now) - iat <= maxAge. The cleanup
    // predicate (deletable ⟺ expiresAt <= now - margin) must NEVER hold
    // while the proof is still acceptable — the R105 probe showed the naive
    // `expiresAt <= now` form reopens replay at expiry + 500ms.
    for (const proofMaxAgeSeconds of [30, 60, 300, 600]) {
      for (const iatSeconds of [1_800_000_000, 1_760_000_123]) {
        const expiresAtMs = (iatSeconds + proofMaxAgeSeconds) * 1000;
        // Sample the whole boundary second densely plus the exact edges.
        const offsets = [
          0, 1, 2, 13, 499, 500, 998, 999, 1000, 1001, 1002, 1500, 1998, 1999, 2000, 2001, 2500,
          3000,
        ];
        for (const offset of offsets) {
          const nowMs = expiresAtMs - 500 + offset;
          const acceptable = Math.floor(nowMs / 1000) - iatSeconds <= proofMaxAgeSeconds;
          const deletable = expiresAtMs <= dpopDeletionCutoff(new Date(nowMs)).getTime();
          if (acceptable) {
            expect(deletable).toBe(false);
          }
          if (!acceptable && nowMs >= expiresAtMs + 1000) {
            expect(deletable).toBe(true);
          }
        }
        // TIGHTNESS: exactly at expiry + 1000ms the proof is already
        // unacceptable and the reservation IS deletable — the margin is the
        // exact floor tolerance, not extra conservatism.
        expect(Math.floor((expiresAtMs + 999) / 1000) - iatSeconds).toBe(proofMaxAgeSeconds);
        expect(expiresAtMs <= dpopDeletionCutoff(new Date(expiresAtMs + 999)).getTime()).toBe(
          false,
        );
        expect(expiresAtMs <= dpopDeletionCutoff(new Date(expiresAtMs + 1000)).getTime()).toBe(
          true,
        );
      }
    }
  });

  it("deletes ONLY exact validated authorization-code ids, never a table sweep", async () => {
    seedEmpty();
    const emailOtp = JSON.stringify({ type: "delete-email", identifier: "a@b.c" });
    const candidates = [
      { id: "v1", value: codeValue() }, // match
      { id: "v2", value: emailOtp }, // wrong type — retained, never deleted
      { id: "v3", value: "{not json" }, // unparseable — retained
    ];
    // First verification read = DPoP phase (empty); second = authorization
    // codes (the candidates).
    db.verification.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(candidates)
      .mockResolvedValue([]);
    db.verification.deleteMany.mockResolvedValue({ count: 1 });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    // Candidate predicate: expired past grace + type marker (never a bare
    // expiresAt-only sweep of the shared Verification table — email/OTP
    // rows can neither match the marker nor survive post-parse).
    expect(db.verification.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          expiresAt: { lte: GRACE_CUTOFF },
          value: { contains: AUTHORIZATION_CODE_TYPE_MARKER },
        },
      }),
    );
    // Delete: exact matched ids ONLY, re-predicated on the same filters.
    expect(db.verification.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: GRACE_CUTOFF },
        value: { contains: AUTHORIZATION_CODE_TYPE_MARKER },
        id: { in: ["v1"] },
      },
    });
    expect(counts.authorizationCodes).toBe(1);
    expect(counts.retainedUnvalidated).toBe(1); // v3 only — v2 is wrong-type
    // R107/R108 finding 1: wrong-type marker-matching rows are COUNTED
    // (they consume scan budget and are permanently non-deletable).
    expect(counts.retainedWrongType).toBe(1); // v2
    expect(counts.scanCapReached).toBe(false);
  });

  it("retains oversized and non-object expired candidates (fail-safe retention)", async () => {
    seedEmpty();
    const candidates = [
      { id: "v1", value: "x".repeat(1024 * 1024 + 1) },
      { id: "v2", value: JSON.stringify(null) },
    ];
    db.verification.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(candidates)
      .mockResolvedValue([]);

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(db.verification.deleteMany).not.toHaveBeenCalled();
    expect(counts.retainedUnvalidated).toBe(2);
    expect(counts.authorizationCodes).toBe(0);
  });

  /**
   * Stateful shared-table mock for the authorization-code scan: the DPoP
   * phase reads return no rows; code-phase reads paginate by STRICT id-gt
   * over a MUTABLE row array (modeling deletes by this sweep AND by a
   * concurrent replica/actor). Marker/expiry filters are treated as
   * pre-satisfied by fixture construction.
   */
  function statefulVerificationMock(rows: { id: string; value: string }[]) {
    const state = { rows: [...rows] };
    db.verification.findMany.mockImplementation((raw) => {
      const args = raw as unknown as {
        where?: { identifier?: unknown; id?: { gt?: string } };
        take?: number;
      };
      if (args.where?.identifier !== undefined) return Promise.resolve([]);
      let pool = state.rows;
      const gt = args.where?.id?.gt;
      if (gt !== undefined) pool = pool.filter((row) => row.id > gt);
      return Promise.resolve(pool.slice(0, args.take));
    });
    db.verification.deleteMany.mockImplementation((raw) => {
      const args = raw as unknown as { where?: { id?: { in?: string[] } } };
      const ids = args.where?.id?.in ?? [];
      state.rows = state.rows.filter((row) => !ids.includes(row.id));
      return Promise.resolve({ count: ids.length });
    });
    return state;
  }

  it("paginates by id-gt (never a row cursor) and drains a multi-page backlog in ONE run", async () => {
    seedEmpty();
    // 450 VALID codes > one 200-row page: with a Prisma row cursor the
    // compiled `id >= (SELECT id ... WHERE id = $cursor)` subquery went
    // NULL after the first page's deletes, stranding the backlog at 200/run
    // (R105/R106 probe). The id-gt scan must reach all 3 pages in one run.
    const rows = Array.from({ length: 450 }, (_, i) => ({
      id: `c${String(i).padStart(3, "0")}`,
      value: codeValue(),
    }));
    const state = statefulVerificationMock(rows);

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(counts.authorizationCodes).toBe(450);
    expect(state.rows).toHaveLength(0);
    // 3 code-phase reads (200 + 200 + 50); every read after the first
    // filters id > the PREVIOUS page's last id — a pure value comparison
    // that works even though those rows no longer exist.
    const codeReads = db.verification.findMany.mock.calls
      .map(
        (call) =>
          call[0] as unknown as {
            where: { identifier?: unknown; id?: { gt?: string } };
            cursor?: unknown;
            take?: number;
          },
      )
      .filter((call) => call.where.identifier === undefined);
    expect(codeReads).toHaveLength(3);
    for (const read of codeReads) expect(read.take).toBe(OAUTH_CLEANUP_VERIFICATION_BATCH);
    expect(codeReads[0]?.where.id).toBeUndefined();
    expect(codeReads[1]?.where.id?.gt).toBe("c199"); // deleted, still the bound
    expect(codeReads[2]?.where.id?.gt).toBe("c399");
    for (const read of codeReads) expect(read.cursor).toBeUndefined();
  });

  it("advances past concurrently-removed rows (cursor row deleted mid-run by another actor)", async () => {
    seedEmpty();
    // Stand-in for a concurrent replica winning every delete: reads return
    // full pages, deletes affect 0 rows, and the would-be cursor row is
    // gone. The id-gt bound is a VALUE comparison, so the scan still
    // advances (and terminates — the short-page break does not depend on
    // the delete count).
    statefulVerificationMock(
      Array.from({ length: 250 }, (_, i) => ({
        id: `c${String(i).padStart(3, "0")}`,
        value: codeValue(),
      })),
    );
    db.verification.deleteMany.mockImplementation((raw) => {
      const args = raw as unknown as { where?: { id?: { in?: string[] } } };
      const ids = args.where?.id?.in ?? [];
      void ids; // replica stand-in: nothing actually removed by this sweep
      return Promise.resolve({ count: 0 });
    });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(counts.authorizationCodes).toBe(0);
    const secondRead = db.verification.findMany.mock.calls
      .map(
        (call) => call[0] as unknown as { where: { identifier?: unknown; id?: { gt?: string } } },
      )
      .filter((call) => call.where.identifier === undefined && call.where.id?.gt !== undefined);
    expect(secondRead).toHaveLength(1); // page 2 was reached despite 0 deletes
    expect(secondRead[0]?.where.id?.gt).toBe("c199");
  });

  it("reaches a valid code behind thousands of retained rows (no starvation)", async () => {
    seedEmpty();
    // The reviewers' R106 probe: 5,000 marker-matching MALFORMED rows in
    // front of ONE valid expired code produced zero deletions on BOTH runs
    // under the pass-1 budget. Retained rows now consume only scan budget
    // (cap 50,000) and the id-gt scan walks past them in the SAME run.
    const malformed = Array.from({ length: 5000 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      value: `${AUTHORIZATION_CODE_TYPE_MARKER}{not json`, // marker-matching
    }));
    const state = statefulVerificationMock([...malformed, { id: "v9999", value: codeValue() }]);

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(counts.authorizationCodes).toBe(1); // valid tail deleted in run 1
    expect(counts.retainedUnvalidated).toBe(5000);
    expect(state.rows).toStrictEqual(malformed); // only the valid row removed
    expect(
      db.verification.deleteMany.mock.calls.filter(
        (call) =>
          ((call[0] as unknown as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [])
            .length > 0,
      ),
    ).toHaveLength(1); // one bounded delete for the single validated id
  });

  it("skips oversized genuine codes without blocking, and caps DELETIONS (not scans) per run", async () => {
    seedEmpty();
    // An oversized genuine code (marker-matching, logged + retained) in
    // front of a valid code: the scan advances past it within the run.
    const oversized = {
      id: "m0000",
      value: `${AUTHORIZATION_CODE_TYPE_MARKER}${"x".repeat(1024 * 1024)}`,
    };
    let state = statefulVerificationMock([oversized, { id: "v0001", value: codeValue() }]);
    let counts = await sweepExpiredOAuthArtifacts({ now: NOW });
    expect(counts.authorizationCodes).toBe(1);
    expect(counts.retainedUnvalidated).toBe(1);
    expect(state.rows).toStrictEqual([oversized]);

    // Deletion cap: 5,200 VALID codes exceed OAUTH_CLEANUP_VERIFICATION_
    // TOTAL_CAP (5,000) — exactly 5,000 deleted, the remainder drains next
    // run; the scan is NOT capped by deletions (25 full pages read).
    seedEmpty();
    state = statefulVerificationMock(
      Array.from({ length: 5200 }, (_, i) => ({
        id: `c${String(i).padStart(4, "0")}`,
        value: codeValue(),
      })),
    );
    counts = await sweepExpiredOAuthArtifacts({ now: NOW });
    expect(counts.authorizationCodes).toBe(OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP);
    expect(state.rows).toHaveLength(200);
    expect(OAUTH_CLEANUP_VERIFICATION_SCAN_CAP).toBeGreaterThan(5200); // work bound not hit
  });

  it("R107/R108 finding 1: wrong-type scan-cap saturation is COUNTED and the log fires with zero deletions", async () => {
    seedEmpty();
    // The reviewers' probe: 50,000 marker-matching WRONG-TYPE rows (a
    // nested field carries the marker) ahead of ONE valid expired code.
    // Pass 2 excluded wrong-type rows from every counter, so this state
    // produced zero deletions, zero retainedUnvalidated, and NO log line —
    // silent starvation on every run. Now the state is observable:
    // retainedWrongType counts it, scanCapReached flags the exhausted
    // work bound, and the scheduler logs despite removing nothing.
    const wrongType = (i: number) => ({
      id: `w${String(i).padStart(5, "0")}`,
      value: JSON.stringify({ type: "other", nested: { type: "authorization_code" } }),
    });
    const validTail = { id: "z9999", value: codeValue() };
    const state = statefulVerificationMock([
      ...Array.from({ length: OAUTH_CLEANUP_VERIFICATION_SCAN_CAP }, (_, i) => wrongType(i)),
      validTail,
    ]);

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(counts.authorizationCodes).toBe(0); // valid tail behind the cap
    expect(counts.retainedUnvalidated).toBe(0);
    expect(counts.retainedWrongType).toBe(OAUTH_CLEANUP_VERIFICATION_SCAN_CAP);
    expect(counts.scanCapReached).toBe(true);
    expect(state.rows).toHaveLength(OAUTH_CLEANUP_VERIFICATION_SCAN_CAP + 1); // nothing deleted
    // Valid rows BELOW the cap still drain: a small wrong-type prefix
    // never starves a following valid code.
    seedEmpty();
    statefulVerificationMock([wrongType(0), wrongType(1), validTail]);
    const smallCounts = await sweepExpiredOAuthArtifacts({ now: NOW });
    expect(smallCounts.authorizationCodes).toBe(1);
    expect(smallCounts.retainedWrongType).toBe(2);
    expect(smallCounts.scanCapReached).toBe(false);
  });

  it("reads bounded batches and loops until a short batch", async () => {
    seedEmpty();
    db.oauthAccessToken.findMany
      .mockReset()
      .mockResolvedValueOnce(
        Array.from({ length: OAUTH_CLEANUP_BATCH }, (_, i) => ({ id: `a${i}` })),
      )
      .mockResolvedValueOnce([{ id: "a-tail" }])
      .mockResolvedValue([]);
    db.oauthAccessToken.deleteMany
      .mockResolvedValueOnce({ count: OAUTH_CLEANUP_BATCH })
      .mockResolvedValueOnce({ count: 1 });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(db.oauthAccessToken.findMany.mock.calls[0]?.[0]?.take).toBe(OAUTH_CLEANUP_BATCH);
    // Full batch -> short batch -> stop (short batch breaks without a third
    // read); each read is followed by exactly one bounded delete.
    expect(db.oauthAccessToken.findMany).toHaveBeenCalledTimes(2);
    expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledTimes(2);
    expect(counts.accessTokens).toBe(OAUTH_CLEANUP_BATCH + 1);
  });

  it("stops between batches once the shutdown fence is armed (no partial harm)", async () => {
    armDbShutdownFence();
    seedEmpty();
    // With the fence armed, the batch-head check returns BEFORE any database
    // call — an in-flight run aborts cleanly between batches and the next
    // run after restart re-sweeps idempotently.
    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });
    expect(db.oauthAccessToken.findMany).not.toHaveBeenCalled();
    expect(db.verification.findMany).not.toHaveBeenCalled();
    expect(counts.accessTokens).toBe(0);
    expect(counts.authorizationCodes).toBe(0);
  });

  it("converges when a concurrent replica already deleted the batch (0-row delete breaks the loop)", async () => {
    seedEmpty();
    db.oauthAccessToken.findMany
      .mockReset()
      .mockResolvedValueOnce(
        Array.from({ length: OAUTH_CLEANUP_BATCH }, (_, i) => ({ id: `a${i}` })),
      )
      .mockResolvedValue([]);
    // FULL batch read but 0 deleted (replica won the race) — the spin-guard
    // must break the loop immediately instead of re-reading the same page
    // forever; completing this test at all proves termination.
    db.oauthAccessToken.deleteMany.mockResolvedValue({ count: 0 });

    const counts = await sweepExpiredOAuthArtifacts({ now: NOW });

    expect(db.oauthAccessToken.findMany).toHaveBeenCalledTimes(1);
    expect(db.oauthAccessToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(counts.accessTokens).toBe(0);
  });
});

describe("startOauthCleanup lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disarmDbShutdownFence();
  });
  afterEach(() => {
    vi.useRealTimers();
    disarmDbShutdownFence();
  });

  const emptyCounts = {
    accessTokens: 0,
    refreshTokens: 0,
    clientAssertions: 0,
    dpopVerifications: 0,
    authorizationCodes: 0,
    retainedUnvalidated: 0,
    retainedWrongType: 0,
    scanCapReached: false,
  };

  it("returns null (no scheduler) when MCP is flag-off", () => {
    const stop = startOauthCleanup({ enabled: false, sweep: vi.fn() });
    expect(stop).toBeNull();
  });

  it("runs once on startup, then periodically, and stops cleanly", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn().mockResolvedValue(emptyCounts);
    const stop = startOauthCleanup({ intervalMs: 100, enabled: true, sweep });
    expect(stop).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1); // startup run
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(2); // periodic run
    stop?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweep).toHaveBeenCalledTimes(2); // stopped — no further runs
  });

  it("does not start a second run while one is in flight (reentrancy guard)", async () => {
    vi.useFakeTimers();
    let releaseSweep: (() => void) | undefined;
    const sweep = vi.fn().mockImplementation(
      () =>
        new Promise<typeof emptyCounts>((resolve) => {
          releaseSweep = () => resolve(emptyCounts);
        }),
    );
    const stop = startOauthCleanup({ intervalMs: 100, enabled: true, sweep });
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(1); // first run still in flight
    releaseSweep?.();
    await vi.advanceTimersByTimeAsync(0);
    stop?.();
  });

  it("returns the SAME stop for a repeated start (module single-instance guard)", async () => {
    vi.useFakeTimers();
    const sweepA = vi.fn().mockResolvedValue(emptyCounts);
    const sweepB = vi.fn().mockResolvedValue(emptyCounts);
    const stopA = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepA });
    const stopB = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepB });
    // Second start: a NO-OP returning the SAME stop function — no second
    // immediate sweep, no second timer (pass-1 created independent
    // schedulers; R105/R106 double-start probe).
    expect(stopB).toBe(stopA);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepA).toHaveBeenCalledTimes(1);
    expect(sweepB).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweepA).toHaveBeenCalledTimes(4); // ONE timer's cadence
    expect(sweepB).not.toHaveBeenCalled();
    stopA?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweepA).toHaveBeenCalledTimes(4); // stopped — the shared stop cleared it
    // After stop, the slot is free: a fresh start works normally.
    const sweepC = vi.fn().mockResolvedValue(emptyCounts);
    const stopC = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepC });
    expect(stopC).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepC).toHaveBeenCalledTimes(1);
    stopC?.();
  });

  it("an OBSOLETE stop handle cannot clear a newer scheduler's singleton slot (R107/R108 finding 2)", async () => {
    vi.useFakeTimers();
    // The reviewers' probe: start A → stop A → start B → stop A AGAIN →
    // start C. Pass 2's stop cleared the module slot unconditionally, so
    // the stale A handle relinquished B's ownership and C scheduled a
    // SECOND concurrent scheduler. Now only the registered instance may
    // clear the slot.
    const sweepA = vi.fn().mockResolvedValue(emptyCounts);
    const sweepB = vi.fn().mockResolvedValue(emptyCounts);
    const sweepC = vi.fn().mockResolvedValue(emptyCounts);
    const stopA = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepA });
    stopA?.(); // slot cleared; A's timer stopped
    const stopB = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepB });
    expect(stopB).toBeTypeOf("function");
    expect(stopB).not.toBe(stopA);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepB).toHaveBeenCalledTimes(1);
    stopA?.(); // STALE handle: must NOT stop B nor clear B's slot
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepB).toHaveBeenCalledTimes(2); // B still on its timer
    const stopC = startOauthCleanup({ intervalMs: 100, enabled: true, sweep: sweepC });
    expect(stopC).toBe(stopB); // singleton still held by B — C is a no-op
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepC).not.toHaveBeenCalled(); // no second scheduler
    stopB?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweepB).toHaveBeenCalledTimes(3); // stopped (startup + t=100 + t=200)
  });

  it("logs wrong-type retention and scan-cap exhaustion even with ZERO removals (R107/R108 finding 1 observability)", async () => {
    vi.useFakeTimers();
    const counts = {
      ...emptyCounts,
      retainedWrongType: 50_000,
      scanCapReached: true,
    };
    const sweep = vi.fn().mockResolvedValue(counts);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const stop = startOauthCleanup({ intervalMs: 100, enabled: true, sweep });
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1); // NOT silent
      const line = logSpy.mock.calls[0]?.join(" ");
      expect(line).toContain("0 expired row(s)");
      expect(line).toContain("50000 wrong-type");
      expect(line).toContain("scan cap reached");
      stop?.();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs sanitized constructor-name-only on sweep failure and keeps scheduling", async () => {
    vi.useFakeTimers();
    const error = new Error("LEAK payload");
    const sweep = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(emptyCounts);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stop = startOauthCleanup({
        intervalMs: OAUTH_CLEANUP_INTERVAL_MS,
        enabled: true,
        sweep,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = errorSpy.mock.calls[0]?.join(" ");
      expect(line).toContain("Error");
      expect(line).not.toContain("LEAK");
      await vi.advanceTimersByTimeAsync(OAUTH_CLEANUP_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(2); // failure did not kill the timer
      stop?.();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
