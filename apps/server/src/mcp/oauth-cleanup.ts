/**
 * OAuth retention and cleanup (Phase 8, Part J).
 *
 * A periodic, idempotent, predicate-bounded sweep of EXPIRED Better Auth OAuth
 * artifacts: opaque access-token rows, refresh-token rows, client
 * assertions, DPoP proof-replay Verification rows, and expired
 * authorization-code Verification rows. Started/stopped with the SAME
 * in-process cleanup lifecycle the other server jobs use (media sweep,
 * cache-affinity sweep, relay telemetry recovery, provider budget repair,
 * provider attempt expiry): run once on startup + `setInterval` with
 * `unref()`, a reentrancy guard, a stop function wired into
 * `runGracefulShutdownSequence`'s `stopPeriodicJobs` step
 * (apps/server/src/index.ts + graceful-shutdown.ts) — NO parallel scheduler.
 *
 * FENCE / PERMIT DECISION (see packages/db/src/shutdown-fence.ts): this job
 * is ORDINARY FENCED WORK and deliberately does NOT use
 * `runWithDbShutdownPermit`. The permit is reserved for teardown cleanup of
 * ALREADY-OWNED durable work (Part G capacity lease release / attempt
 * terminalization / budget settlement: persisted, identified state with a
 * cleanup obligation that MUST still settle during teardown — and Part I
 * classified human revoke the same way: ordinary fenced work, no permit).
 * A PERIODIC retention sweep owns nothing at fence-arming time: every
 * operation is deferrable by design — the next run after a restart performs
 * the identical idempotent work on the same row-state predicates. Shutdown
 * interaction therefore matches the other periodic jobs exactly:
 *   1. `stop()` (clearInterval) is called in `stopPeriodicJobs`, so no NEW
 *      run is scheduled mid-shutdown;
 *   2. an IN-FLIGHT run checks `isDbShutdownFenceArmed()` before every batch
 *      and returns promptly; if the fence arms between the check and the
 *      next operation, the shared client rejects it with
 *      `DbShutdownFenceError`, the run's catch logs one sanitized
 *      (constructor-name-only) line and exits — aborting between batches is
 *      safe because every batch is an independent, idempotent,
 *      state-predicated delete (no partial harm is possible; the leftover
 *      rows are re-swept after restart).
 *
 * REPLICA SAFETY (no SKIP LOCKED, no destructive SQL): every delete is
 * either (a) a `deleteMany` whose WHERE is purely ROW-STATE (expiresAt
 * cutoffs, identifier prefix), or (b) for the shared Verification table, an
 * exact-ID `deleteMany` additionally predicated on the same state filter.
 * Two replicas running concurrently read overlapping candidate sets and
 * issue converging deletes: Postgres row-locks serialize them, the loser's
 * delete affects 0 rows, and `deleteMany` on absent ids is a count-0 no-op —
 * never an error, never a double effect (deletion is idempotent). No lock
 * is held across an await between a read and its delete (each batch's read
 * and delete are separate statements whose predicates stand alone), so
 * SKIP LOCKED is unnecessary: the worst case is duplicated read work, not
 * divergence. spin-guard: if a full batch's predicated delete affects 0
 * rows (only possible if a concurrent replica removed it between the read
 * and the delete), the loop breaks instead of re-reading the same page.
 *
 * RETENTION SEMANTICS:
 *  - Rotated refresh-family rows (`rotatedAt != null`) are RETAINED until
 *    their expiry (`expiresAt`): the rotation chain is replay /
 *    family-invalidation evidence. This requires no extra predicate — the
 *    delete predicate is `expiresAt <= now - grace`, so any row not yet
 *    expired (rotated or not, revoked or not) is outside it by definition;
 *    a dedicated regression test pins an old-rotated-but-unexpired row is
 *    never in the delete set.
 *  - After an audit grace period (`OAUTH_CLEANUP_AUDIT_GRACE_MS`) expired
 *    access + refresh rows are removed in DEPENDENCY ORDER (see
 *    sweepExpiredOAuthArtifacts), plus expired client assertions.
 *  - DPoP Verification cleanup uses the EXACT identifier prefix
 *    (`dpop-proof:`, from the installed @better-auth/core 1.7.3
 *    `createDpopReplayStore`: `identifier: \`dpop-proof:${key}\``) plus its
 *    own expiry SHIFTED BY A 1s VERIFIER-FLOOR SAFETY MARGIN (no 24h
 *    grace; see DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS — the verifier
 *    floors its clock to seconds and keeps accepting a proof THROUGHOUT
 *    its expiry second, so `expiresAt <= now` would delete live
 *    reservations and reopen replay).
 *  - Authorization codes live in the SHARED `Verification` table with a
 *    TYPE-FREE HASH identifier — there is no safe identifier namespace, so
 *    the type is validated ONLY by parsing the JSON `value` and checking
 *    `value.type === "authorization_code"` (NEVER inferred from the
 *    identifier). Cleanup deletes only exact matching row IDs whose delete
 *    is additionally predicated on the same expiry + marker filters.
 *    Email/OTP verification records are NEVER swept: they cannot match the
 *    type-marker candidate filter (and any wildcard over-match from the
 *    marker's `_` is rejected by the post-parse exact type equality).
 *
 * UNVALIDATED-CANDIDATE CHOICE (deliberate contrast to Part I's revoke):
 * an expired candidate that is oversized, unparseable, or a non-object is
 * RETAINED, not deleted (fail-safe retention). Part I's revoke fails LOUDLY
 * because it must prove enumeration completeness for a security decision;
 * this sweep has no such completeness obligation — deleting an
 * uninspectable row could destroy an unrelated verification record (the one
 * harm that deletion would cause), while retaining it costs only storage and is
 * observable (the retained-row count). Retained rows consume only the scan
 * budget — the scan advances past them via strict id-gt pagination, so they
 * never block collection of valid rows behind them within the scan cap (see
 * OAUTH_CLEANUP_VERIFICATION_SCAN_CAP's progress argument for the ≥50k
 * retained-prefix residual bound). A
 * wrong-TYPE row (fully parsed, `type !== "authorization_code"`) is PROVEN
 * not to be an authorization code and is likewise left untouched — it is
 * another subsystem's record (email/OTP), never this sweep's business.
 *
 * DEFERRED ITEMS (do not implement without separate review):
 *  - AUTOMATIC CIMD-CLIENT DELETION: deferred until a separately reviewed
 *    policy can require `clientDiscoveryId === "cimd"`, a fixed inactivity
 *    cutoff, and absence of EVERY live consent, token, authorization code,
 *    and other authorization artifact; the client/resource link may then
 *    cascade with the client. (Human revoke in Part I deliberately
 *    PRESERVES the shared CIMD client row.)
 *  - AUTOMATIC JWKS DELETION: deferred until the configured JWT
 *    `gracePeriod` contract exists; the future implementation must NEVER
 *    remove the current signing key or a key pinned by an enabled
 *    resource (`OauthResource.signingKeyId`).
 *
 * Rollback note: the job is gated on `WMP_MCP_ENABLED` (null when off), so
 * the emergency rollback (`WMP_MCP_ENABLED=false` + restart) also
 * stops token-data deletion ("do not delete token data during rollback").
 */

import prisma from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import { env } from "@ws-model-proxy/env/server";

/** The one shared fenced client's delegates this sweep touches. */
type OAuthCleanupPrisma = Pick<
  typeof prisma,
  "oauthAccessToken" | "oauthRefreshToken" | "oauthClientAssertion" | "verification"
>;

// ---------------------------------------------------------------------------
// Cutoffs — code constants, not environment variables; `pnpm env:check` must
// stay unchanged). Every value below is a deliberate, documented choice.
// ---------------------------------------------------------------------------

/**
 * Run cadence: hourly, matching the media sweep cadence. Retention cleanup
 * is not latency-sensitive (rows are already expired + past grace).
 */
export const OAUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Audit grace period an expired row must age past before deletion. Keeps a
 * post-incident audit window during which token artifacts (including
 * rotated refresh families and revoked rows) remain inspectable. 24h is the
 * shortest window that spans an on-call day; it is deliberately independent
 * of any token TTL.
 */
export const OAUTH_CLEANUP_AUDIT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Read/delete batch size for token + assertion loops. Bounds each
 * statement's row set (and lock footprint); expired-row volume is drained
 * across iterations and runs.
 */
export const OAUTH_CLEANUP_BATCH = 500;

/**
 * Batch size for the shared-table authorization-code scan (cursor-paginated,
 * like Part I's VERIFICATION_CANDIDATE_BATCH: same table, same parse cost).
 */
export const OAUTH_CLEANUP_VERIFICATION_BATCH = 200;

/**
 * Per-run cap on authorization-code DELETIONS (validated rows actually
 * deleted), NOT on scanned/retained rows. Unlike Part I's revoke (whose cap
 * failing loud proves enumeration completeness for a security decision),
 * this cap merely defers remainder work to the next hourly run — a backlog
 * beyond 5,000 deletable expired codes in one hour is far outside
 * legitimate volume and drains over successive runs (bounded: a fully valid
 * backlog of N drains in ceil(N/5000) runs).
 */
export const OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP = 5000;

/**
 * Per-run cap on authorization-code candidates EXAMINED (the work bound:
 * rows read + parse-inspected per run, whether deleted or retained). The
 * scan advances past retained rows via strict id-gt pagination (see the
 * code-scan loop), so within ONE run every candidate ordered before the
 * scan cap is reached — a valid tail behind up to 50k retained rows is
 * still collected (the reviewers' 5,000-malformed-row probe is covered
 * 10x over). PROGRESS ARGUMENT: (a) lastSeenId strictly advances past every
 * examined row (deleted or retained), so the scan never re-reads within a
 * run and never depends on deleted cursor rows; (b) deletions shrink the
 * candidate set monotonically, so successive runs make bounded progress
 * toward any given deletable row once fewer than the scan cap of rows
 * precede it; (c) the only static residual is a retained (uninspectable)
 * prefix LONGER than the scan cap (≥50k rows) — that is a documented,
 * observable storage-bound residual (the retained count is logged per
 * run), not silent starvation of valid rows behind it being deleted; rows
 * beyond such a prefix are re-examined next run and drained once the
 * prefix shrinks or operators intervene.
 */
export const OAUTH_CLEANUP_VERIFICATION_SCAN_CAP = 50_000;

/**
 * Protective per-value size cap for parsing expired Verification candidates
 * (UTF-16 code units, mirroring Part I's VERIFICATION_VALUE_MAX_LENGTH).
 * An oversized expired candidate is RETAINED, never deleted (see the module
 * header's unvalidated-candidate choice).
 */
export const OAUTH_CLEANUP_VERIFICATION_VALUE_MAX_LENGTH = 1024 * 1024;

/**
 * EXACT DPoP replay-reservation identifier prefix. Source-pinned to the
 * installed @better-auth/core@1.7.3 `createDpopReplayStore`
 * (dist/oauth2/dpop.mjs): `identifier: \`dpop-proof:${key}\``. This is the
 * ONLY Verification identifier namespace this sweep may touch.
 */
export const DPOP_VERIFICATION_IDENTIFIER_PREFIX = "dpop-proof:";

/**
 * Safety margin subtracted from `now` before DPoP reservations become
 * deletion-eligible. DERIVED FROM THE INSTALLED VERIFIER'S CLOCK FLOOR
 * (@better-auth/core@1.7.3 dist/oauth2/dpop.mjs):
 *
 *   :138  `nowSeconds = Math.floor(Date.now() / 1e3)` — verification time is
 *          FLOORED to whole seconds;
 *   :171  a proof is rejected ONLY when `iat > nowSeconds + 5 ||
 *          nowSeconds - iat > proofMaxAgeSeconds` — i.e. it stays ACCEPTABLE
 *          while `floor(now/1000) - iat <= proofMaxAgeSeconds`;
 *   :185  the reservation is stored at `expiresAt = (iat + proofMaxAgeSeconds) * 1000`.
 *
 * Worst case: at real time `expiresAt + 999ms`, `floor(now)` still equals
 * `iat + proofMaxAgeSeconds`, the age check is `maxAge > maxAge` = false, and
 * the IDENTICAL proof is accepted (replay window still open) even though
 * `expiresAt <= now` — the naive expiry predicate would delete the live
 * reservation and REOPEN replay (R105 probe: replay rejected before cleanup,
 * the same proof accepted after cleanup ran at expiry + 500ms).
 *
 * The provably-safe predicate is `expiresAt <= now - 1000`:
 *   `expiresAt + 1000 <= now` ⟺ `floor(now) >= iat + maxAge + 1` (integer
 *   seconds) ⟺ `floor(now) - iat > maxAge` — exactly the verifier's
 *   rejection condition. So a reservation is deleted ONLY once the verifier
 *   is guaranteed to reject a replay of the proof it was minted for.
 *
 * EXACTNESS QUALIFICATION (R107/R108 finding 3): the equivalence above is
 * exact for INTEGER-second `iat`/`maxAge` (the shapes this stack writes;
 * retention ends precisely at `expiresAt + 1000ms`). The installed verifier
 * accepts ANY finite numeric `iat`, including fractional seconds
 * (dpop.mjs:116-118): for e.g. `iat = K + 0.5` rejection begins at second
 * `K + 1` while cleanup waits until `expiresAt + 1000ms = (K + 0.5 + maxAge
 * + 0.5)s` — SAFE but retained up to ~500ms longer than strictly
 * necessary. Safety is unconditional; tightness is integer-only.
 */
export const DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS = 1000;

/**
 * The DPoP-phase deletion cutoff: reservations become eligible strictly past
 * `now - DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS` (see the margin's
 * derivation above). Exported for the verifier-floor regression test.
 */
export function dpopDeletionCutoff(now: Date): Date {
  return new Date(now.getTime() - DPOP_VERIFICATION_EXPIRY_SAFETY_MARGIN_MS);
}

/**
 * Order-independent compact-JSON marker for the DB candidate filter (same
 * construction + LIKE-safety argument as Part I's typeMarker: a STATIC
 * literal containing no `\` (no LIKE-escape false negative) and no `%`;
 * its single `_` can only over-match and over-matched rows are rejected by
 * the post-parse exact `type` equality).
 */
export const AUTHORIZATION_CODE_TYPE_MARKER = JSON.stringify({
  type: "authorization_code",
}).slice(1, -1);

// ---------------------------------------------------------------------------
// Expired-candidate inspection (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Decide whether one EXPIRED Verification candidate is an authorization
 * code that may be deleted. The type is validated ONLY from the parsed
 * `value.type` field — NEVER inferred from the verification `identifier`
 * (a type-free hash; email/OTP verification rows share the table).
 *
 *  - "match": parsed to an object whose `type` is exactly
 *    `"authorization_code"` — safe to delete by exact row ID.
 *  - "retained/wrong-type": fully parsed and PROVEN not to be an
 *    authorization code (another subsystem's record) — never touched.
 *  - "retained/{oversized,unparseable,non-object}": cannot be inspected —
 *    RETAINED (fail-safe retention; see the module header). A non-string
 *    value cannot be this provider's stored code shape either way.
 */
export type ExpiredAuthorizationCodeInspection =
  | { status: "match" }
  | {
      status: "retained";
      reason: "wrong-type" | "oversized" | "unparseable" | "non-object" | "non-string";
    };

export function inspectExpiredAuthorizationCode(
  value: unknown,
): ExpiredAuthorizationCodeInspection {
  if (typeof value !== "string") return { status: "retained", reason: "non-string" };
  if (value.length > OAUTH_CLEANUP_VERIFICATION_VALUE_MAX_LENGTH) {
    return { status: "retained", reason: "oversized" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "retained", reason: "unparseable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "retained", reason: "non-object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorization_code") return { status: "retained", reason: "wrong-type" };
  return { status: "match" };
}

/** Per-phase removal counts (returned for logging/tests). */
export interface OAuthCleanupCounts {
  accessTokens: number;
  refreshTokens: number;
  clientAssertions: number;
  dpopVerifications: number;
  authorizationCodes: number;
  /** Expired candidates retained because they could not be validated. */
  retainedUnvalidated: number;
  /**
   * Marker-matching wrong-type candidates examined and retained (they are
   * permanently non-deletable but consume scan budget, so they must be
   * observable — R107/R108 finding 1).
   */
  retainedWrongType: number;
  /** True when the scan work bound was hit with more rows likely remaining. */
  scanCapReached: boolean;
}

/** Read one bounded batch of matching ids (select id only). */
type IdBatchReader<TWhere> = (where: TWhere, take: number) => Promise<{ id: string }[]>;

/** Prisma deleteMany resolves to { count } (BatchPayload). */
type IdBatchDeleter<TWhere> = (where: TWhere, ids: string[]) => Promise<{ count: number }>;

/**
 * Shared batched delete loop: read a bounded id batch under `where`, delete
 * those EXACT ids re-predicated on the SAME `where` (state-predicated
 * exact-ID deletes), repeat until a short batch. The spin-guard breaks if a
 * full batch's delete affects 0 rows (a concurrent replica removed them
 * between read and delete — the next findMany will not return them once
 * visible; breaking is always safe because the work is idempotent).
 */
async function deleteBatched<TWhere>(
  findIds: IdBatchReader<TWhere>,
  deleteIds: IdBatchDeleter<TWhere>,
  where: TWhere,
): Promise<number> {
  let removed = 0;
  for (;;) {
    if (isDbShutdownFenceArmed()) return removed;
    const rows = await findIds(where, OAUTH_CLEANUP_BATCH);
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.id);
    const { count: deleted } = await deleteIds(where, ids);
    removed += deleted;
    if (rows.length < OAUTH_CLEANUP_BATCH) break;
    if (deleted === 0) break;
  }
  return removed;
}

/**
 * One idempotent cleanup pass. Dependency order (schema-cited,
 * packages/db/prisma/schema/auth.prisma):
 *
 *   1. OauthAccessToken FIRST — it carries the ONLY intra-OAuth FK between
 *      the swept tables: `refreshId` → OauthRefreshToken
 *      (`onDelete: Cascade`). Deleting children first keeps every delete's
 *      effect bounded by its OWN predicate instead of relying on (or
 *      accidentally triggering) unbounded cascade side effects when a
 *      refresh row goes; each statement's row count then equals what its
 *      predicate selected.
 *   2. OauthRefreshToken second — gated on child eligibility: a parent is
 *      deleted only when past grace AND every remaining access child is
 *      itself past grace (the schema's Cascade would otherwise remove
 *      unexpired children; see the inline refresh-phase comment). Parents
 *      are therefore leaves-by-predicate, not leaves-by-ordering.
 *      Rotated (`rotatedAt != null`) and revoked rows are retained until
 *      expiry by the `expiresAt <= cutoff` predicate itself.
 *   3. OauthClientAssertion — independent table (id + expiresAt only).
 *   4. DPoP Verification rows — `dpop-proof:` prefix + own expiry.
 *   5. Authorization-code Verification rows — exact-ID deletes for
 *      PARSE-VALIDATED authorization codes only (shared table; see the
 *      module header).
 *
 * All other FKs on these tables point OUT of the swept set (client, user,
 * session with `onDelete: SetNull`), so no swept delete can cascade into
 * unswept state; McpGrant tombstones have NO relation to OauthClient
 * (deliberate, Part I) and are never deleted by this sweep.
 */
export async function sweepExpiredOAuthArtifacts({
  prisma: client = prisma,
  now = new Date(),
}: {
  prisma?: OAuthCleanupPrisma;
  now?: Date;
} = {}): Promise<OAuthCleanupCounts> {
  // Audit-grace cutoff for token rows + assertions: a row expiring exactly
  // AT the cutoff is deletable (lte — inclusive boundary, pinned by test);
  // anything newer is inside the grace window and retained.
  const graceCutoff = new Date(now.getTime() - OAUTH_CLEANUP_AUDIT_GRACE_MS);

  const accessTokens = await deleteBatched(
    (where, take) => client.oauthAccessToken.findMany({ where, select: { id: true }, take }),
    (where, ids) => client.oauthAccessToken.deleteMany({ where: { ...where, id: { in: ids } } }),
    { expiresAt: { lte: graceCutoff } },
  );

  // Refresh tokens: a parent is deletion-eligible ONLY when it is past
  // grace AND every remaining opaque access child is ITSELF past grace
  // (`oauthAccessTokens: { every: ... }` — vacuously true for childless
  // parents). auth.prisma:311 cascades OauthRefreshToken deletion to ALL
  // referencing OauthAccessToken rows regardless of the child's own
  // expiry, and the provider assigns access/refresh expiries
  // independently (an expired parent with an unexpired child is
  // schema-reachable — R105/R106 executed that counterexample). Gating the
  // parent on child eligibility means the cascade can only ever remove
  // rows that were INDEPENDENTLY grace-eligible, preserving the effect
  // bound: each statement's parent set ≤ batch, cascaded children are all
  // grace-eligible (what the access sweep would delete anyway; they are
  // not double-counted in this phase's count). Parents with a still-live
  // child are retained until a later run — progress is guaranteed once
  // the children expire.
  const refreshTokens = await deleteBatched(
    (where, take) => client.oauthRefreshToken.findMany({ where, select: { id: true }, take }),
    (where, ids) => client.oauthRefreshToken.deleteMany({ where: { ...where, id: { in: ids } } }),
    {
      expiresAt: { lte: graceCutoff },
      oauthAccessTokens: { every: { expiresAt: { lte: graceCutoff } } },
    },
  );

  const clientAssertions = await deleteBatched(
    (where, take) => client.oauthClientAssertion.findMany({ where, select: { id: true }, take }),
    (where, ids) =>
      client.oauthClientAssertion.deleteMany({ where: { ...where, id: { in: ids } } }),
    { expiresAt: { lte: graceCutoff } },
  );

  // DPoP replay reservations: EXACT prefix + their own expiry shifted by
  // the verifier-floor safety margin (NO grace, but never deleted while
  // the proof could still verify — see DPOP_VERIFICATION_EXPIRY_SAFETY_
  // MARGIN_MS). Any other Verification identifier (hashed authorization
  // codes, email/OTP rows) cannot match `startsWith` on this literal
  // prefix. The cutoff is recomputed here so the delete re-assertion (the
  // same `where`) uses the identical margin-justified boundary.
  const dpopCutoff = dpopDeletionCutoff(now);
  const dpopVerifications = await deleteBatched(
    (where, take) => client.verification.findMany({ where, select: { id: true }, take }),
    (where, ids) => client.verification.deleteMany({ where: { ...where, id: { in: ids } } }),
    {
      identifier: { startsWith: DPOP_VERIFICATION_IDENTIFIER_PREFIX },
      expiresAt: { lte: dpopCutoff },
    },
  );

  // Authorization codes: bounded STRICT-ID-ADVANCING scan of EXPIRED
  // (past-grace) candidates carrying the type marker; parse-validate each;
  // delete ONLY exact validated ids re-predicated on the same filters.
  // Pagination NEVER uses a Prisma row cursor: the compiled client
  // resolves `cursor` via `id >= (SELECT id FROM verification WHERE id =
  // $cursor)`, and this loop (or a concurrent replica) DELETES the rows it
  // visits — once the cursor row is gone the subquery is NULL and the next
  // page is empty (R105/R106 probe: an all-valid backlog processed only
  // 200/run). Instead each page filters `id > lastSeenId` (a pure VALUE
  // comparison — lastSeenId need not exist), so the scan provably advances
  // past deleted, retained, and concurrently-removed rows alike. Class
  // sweep over this module's loops: deleteBatched (access/refresh/
  // assertion/DPoP) passes the SAME state-predicated `where` to every read
  // and never uses a cursor — deleted rows simply disappear from the next
  // read; this code loop was the ONLY cursor user and no longer is.
  // Budget: OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP bounds DELETIONS per run;
  // OAUTH_CLEANUP_VERIFICATION_SCAN_CAP bounds rows examined (retained
  // rows consume only scan budget — see its progress argument).
  // Unvalidated/oversized candidates are counted + retained; wrong-type
  // rows are simply not ours. The scan honors the fence per batch.
  let authorizationCodes = 0;
  let retainedUnvalidated = 0;
  // R107/R108 finding 1: wrong-type marker-matching rows (e.g. a value
  // whose NESTED field carries the marker) consume scan budget and are
  // permanently non-deletable, so they MUST be counted and reported —
  // otherwise a scan-cap-sized wrong-type prefix silently starves every
  // later valid code with zero log output (probe: 50,000 wrong-type rows +
  // 1 valid → zero deletions, zero counters, twice).
  let retainedWrongType = 0;
  let scanCapReached = false;
  const codeWhere = {
    expiresAt: { lte: graceCutoff },
    value: { contains: AUTHORIZATION_CODE_TYPE_MARKER },
  };
  let lastSeenId: string | undefined;
  let scanned = 0;
  while (
    authorizationCodes < OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP &&
    scanned < OAUTH_CLEANUP_VERIFICATION_SCAN_CAP
  ) {
    if (isDbShutdownFenceArmed()) break;
    const candidates = await client.verification.findMany({
      where: lastSeenId === undefined ? codeWhere : { ...codeWhere, id: { gt: lastSeenId } },
      orderBy: { id: "asc" },
      take: OAUTH_CLEANUP_VERIFICATION_BATCH,
      select: { id: true, value: true },
    });
    if (candidates.length === 0) break;
    const matchedIds: string[] = [];
    for (const candidate of candidates) {
      const inspection = inspectExpiredAuthorizationCode(candidate.value);
      if (inspection.status === "match") matchedIds.push(candidate.id);
      else if (inspection.reason === "wrong-type") retainedWrongType += 1;
      else retainedUnvalidated += 1;
    }
    if (matchedIds.length > 0 && authorizationCodes < OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP) {
      // Never exceed the deletion cap mid-page.
      const budget = OAUTH_CLEANUP_VERIFICATION_TOTAL_CAP - authorizationCodes;
      const deletableIds = matchedIds.slice(0, budget);
      const { count } = await client.verification.deleteMany({
        where: { ...codeWhere, id: { in: deletableIds } },
      });
      authorizationCodes += count;
    }
    scanned += candidates.length;
    // Pure value cursor: advances past every examined row even if this
    // loop (or a replica) deleted it — no dependence on row existence.
    lastSeenId = candidates[candidates.length - 1]!.id;
    if (candidates.length < OAUTH_CLEANUP_VERIFICATION_BATCH) break;
    if (scanned >= OAUTH_CLEANUP_VERIFICATION_SCAN_CAP) scanCapReached = true;
  }

  return {
    accessTokens,
    refreshTokens,
    clientAssertions,
    dpopVerifications,
    authorizationCodes,
    retainedUnvalidated,
    retainedWrongType,
    scanCapReached,
  };
}

/**
 * Module-level single-instance guard: at most ONE cleanup scheduler per
 * process. A repeated `startOauthCleanup()` is a NO-OP that returns the
 * SAME stop function (it never creates a second immediate sweep or a
 * second interval timer — the pass-1 per-invocation `running` flag could
 * not prevent two independent schedulers). This matches the strongest
 * existing precedent, the module-lifetime singleton shape of
 * `diagnosticsCapacityRuntime` (apps/server/src/model-api — one shared
 * instance per module while enabled). Stopping clears the slot, so a
 * restart after stop (test/re-arming scenarios) creates a fresh scheduler.
 */
let activeOauthCleanupStop: (() => void) | null = null;

/**
 * Start the in-process cleanup job following the established periodic-job
 * lifecycle (cache-affinity-runtime.ts / media/cleanup.ts shape): run once
 * immediately, then on `setInterval` (unref'd so it never holds the event
 * loop open), with a reentrancy guard and a stop function for
 * `stopPeriodicJobs`. Returns `null` when MCP is flag-off (rollback
 * semantics: no token-data deletion while disabled); a SECOND call while a
 * scheduler is active returns the SAME stop function without starting
 * another. Failures are logged with a sanitized constructor-name-only
 * label (L19 terminal log policy).
 */
export function startOauthCleanup({
  intervalMs = OAUTH_CLEANUP_INTERVAL_MS,
  enabled = env.WMP_MCP_ENABLED,
  sweep = sweepExpiredOAuthArtifacts,
}: {
  intervalMs?: number;
  enabled?: boolean;
  sweep?: typeof sweepExpiredOAuthArtifacts;
} = {}): (() => void) | null {
  if (!enabled) return null;
  if (activeOauthCleanupStop !== null) return activeOauthCleanupStop;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await sweep();
      const total =
        counts.accessTokens +
        counts.refreshTokens +
        counts.clientAssertions +
        counts.dpopVerifications +
        counts.authorizationCodes;
      if (
        total > 0 ||
        counts.retainedUnvalidated > 0 ||
        counts.retainedWrongType > 0 ||
        counts.scanCapReached
      ) {
        // R107/R108 finding 1: EVERY retained/starvation signal is
        // observable — wrong-type saturation and scan-cap exhaustion log
        // even when zero rows were removed and zero were unvalidated.
        console.log(
          `[mcp] oauth cleanup removed ${total} expired row(s), retained ${counts.retainedUnvalidated} unvalidated and ${counts.retainedWrongType} wrong-type expired candidate(s)${counts.scanCapReached ? ", scan cap reached (remainder drains next run)" : ""}.`,
        );
      }
    } catch (error) {
      // Sanitized (L19): constructor name / typeof only — Prisma errors can
      // carry SQL + params in their messages.
      console.error(
        "[mcp] oauth cleanup sweep failed:",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    // R107/R108 finding 2: an OBSOLETE stop handle must not clear a NEWER
    // scheduler's singleton slot (start A → stop A → start B → stop A
    // again used to relinquish B's ownership, letting a third scheduler
    // run alongside B). Only the registered instance clears the slot.
    if (activeOauthCleanupStop === stop) {
      activeOauthCleanupStop = null;
    }
  };
  activeOauthCleanupStop = stop;
  return stop;
}
