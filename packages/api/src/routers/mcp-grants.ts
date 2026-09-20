import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { runSerializableTransaction } from "../lib/serializable-transaction";

/**
 * Human MCP grant management (MCP plan Phase 7).
 *
 * Both procedures are HUMAN-ONLY browser-session surfaces: they never accept
 * a caller-supplied user id (identity is always the protected procedure's
 * session), and neither is exposed as an MCP tool — a connected MCP client
 * must not be able to enumerate or revoke the human's OTHER authorizations.
 * The router is therefore listed in MCP_TOOL_EXCLUSIONS
 * (apps/server/src/mcp/tool-manifest.ts) and pinned absent from the tool
 * catalog by tool-manifest.test.ts.
 *
 * Deliberately NOT gated on WMP_MCP_ENABLED: the settings page must stay
 * available during an emergency shutdown so a human can kill outstanding
 * authorization while authorization/discovery/login/consent and /mcp are
 * flag-gated off (invariant 13).
 *
 * All Prisma access flows through the ONE shared fenced client from
 * @ws-model-proxy/db (shutdown + per-request abort fences apply). The
 * revocation transaction is ORDINARY FENCED WORK — it deliberately does NOT
 * run under runWithDbShutdownPermit. The permit contract
 * (packages/db/src/shutdown-fence.ts) reserves the exemption for teardown
 * cleanup of ALREADY-OWNED durable work (Part G capacity lease release /
 * attempt terminalization: persisted state with a cleanup obligation that
 * must still settle during teardown). A human revoke request owns no
 * persisted cleanup obligation at fence-arming time — an ownership read
 * settling after the fence arms must not START a new business mutation
 * under the exemption. Shutdown behavior is exactly as the fence contract
 * prescribes: if shutdown arms mid-revoke, the NEXT delegate operation
 * throws a fence error, which PROPAGATES immediately (runSerializable-
 * Transaction retries only write-conflict codes, never fence errors), the
 * transaction rolls back atomically, and the caller receives an error and
 * must retry after restart (the settings page has error/retry UI for
 * exactly this). If the fence arms after the FINAL delegate operation has
 * already started, that work may still complete and the WHOLE transaction
 * commits — also atomic, so a partial revoke (some effects committed,
 * others not) is never observable either way.
 */

// ---------------------------------------------------------------------------
// Pending-authorization-code relevance filter (Q2).
//
// The installed provider (oauth-provider@1.7.3 redirectWithAuthorizationCode,
// dist/authorize-9whjxVLJ.mjs ~L5707-5727) stores `value` as
// `JSON.stringify({ type: "authorization_code", query, userId, sessionId,
// referenceId, authTime, resource })` where `query` is the validated OAuth
// query object (containing `client_id`). JSON.stringify emits no whitespace
// and `type` is the FIRST key today, but the substring markers below are
// deliberately ORDER-INDEPENDENT (each matches its key anywhere in the
// string) so a future key-reordering upstream cannot silently drop codes
// from the candidate set. Prisma JSON path filters are UNAVAILABLE here:
// the Verification.value column is a plain String (packages/db/prisma/
// schema/auth.prisma), so per-key `contains` is the strongest DB-side
// filter available.
//
// LIKE SEMANTICS (R95/R96 finding 1): the installed Prisma compiler emits
//   value::text LIKE ('%' || $param || '%')
// with the marker passed as a RAW pattern parameter. PostgreSQL LIKE treats
// `\` as a pattern ESCAPE and `%` / `_` as wildcards; every other character
// (including JSON quotes) is literal. A client marker built from an
// ACCEPTED client id containing `"`, `\`, or a control character (e.g.
// https://example.com/a"b.json — accepted by the installed CIMD URL and
// metadata validators; probe-verified) JSON-escapes to `\"` etc.; the
// backslash then consumes the following pattern character and the LIKE can
// NEVER match the stored (escaped) text — the row is silently excluded
// BEFORE inspection, where the fail-closed machinery cannot see it (probe:
// JavaScript substring matched 5,040/5,040 top-level key orders; PostgreSQL
// LIKE matched 0/5,040). The client marker is therefore DROPPED from the
// DB predicate entirely; client discrimination is the post-parse EXACT
// JavaScript equality (`value.query.client_id === clientId` in
// inspectAuthorizationCodeVerification), which is escape-free and exact for
// EVERY accepted id shape (quoted, backslashed, newline, wildcard, Unicode).
//
// The DB predicate is per-key for type AND user ONLY. LIKE-safety per
// marker:
//  - typeMarker `"type":"authorization_code"` is a STATIC literal that
//    contains no `\` (no escape → no silent false negative) and no `%`
//    (no unbounded wildcard). Its single `_` (in "authorization_code")
//    and its JSON quotes are the only non-alphanumerics: quotes are
//    LIKE-literal, and `_` is a single-char wildcard that can only
//    OVER-match (e.g. "authorizationXcode") — such rows are rejected by
//    the post-parse exact `type` equality. So the type marker's LIKE has
//    NO false negatives — pinned by regression test and verified against
//    real PostgreSQL across all 5,040 top-level key orders
//    (.review-loop/r95-marker-probe.out.txt).
//  - userMarker is built from the session user id. Generated ids need no
//    JSON escaping: the INSTALLED Better Auth default generates 32
//    alphanumeric characters, and Prisma's fallback is cuid2 — neither
//    emits `"`, `\`, `%`, or anything JSON.stringify escapes. But this is
//    NOT the bound on accepted ids: the enabled Better Auth admin
//    `/admin/create-user` endpoint accepts `data.id`, its internal
//    adapter preserves supplied ids (`forceAllowId: true`), and this
//    repo's user-create hook preserves them too — R98 probe-created the
//    control-character id "http\nuser" end-to-end over HTTP (200, session
//    preserved). Such an id JSON-escapes into a marker whose backslash
//    makes the LIKE predicate a SILENT false negative. The REAL bound is
//    therefore the guard, not the generators: assertVerificationUser-
//    MarkerLikeSafe below rejects EVERY id whose compact serialization is
//    not the identity (`JSON.stringify(userId) === '"' + userId + '"'`)
//    — covering all escape classes: control characters, quotes,
//    backslashes, lone surrogates — with a fail-closed CONFLICT BEFORE
//    the scan. An id may contain `_` or `%` (neither is JSON-escaped):
//    both are LIKE wildcards that can only OVER-match — wildcard-admitted
//    foreign rows are rejected by the post-parse exact `userId` equality,
//    and at pathological volume they exhaust the scan cap and fail LOUDLY
//    (never silently).
//
// The candidate population is therefore "unexpired rows that look like THIS
// user's authorization codes ACROSS ALL CLIENTS": foreign users' codes and
// unrelated email/OTP rows either do not match the user marker at all or
// (via the `_` / `%` single- and multi-char wildcards an unescaped id may
// carry) are admitted and post-parse excluded — never a silent miss, never
// displacement; THIS user's pending codes for OTHER clients CAN enter and
// are likewise excluded post-parse; if that population ever exceeds the
// scan cap the revoke fails LOUDLY (self-inflicted, documented at
// VERIFICATION_CANDIDATE_TOTAL_CAP). A marker embedded inside a JSON string
// value (e.g. a crafted `query.state`) is stored ESCAPED (\"userId\":...)
// and cannot match the unescaped marker substring; if some future writer
// ever admitted such rows anyway, they are likewise rejected post-parse
// and at volume fail loudly at the cap.
// ---------------------------------------------------------------------------

/**
 * Build the per-key DB relevance markers for one user's pending-code scan.
 * Each marker is the exact compact-JSON serialization fragment of one key
 * of the stored value shape; `contains` per marker (combined with AND, plus
 * expiresAt > now) is the DB-side relevance filter. See the LIKE SEMANTICS
 * note above for why the client id deliberately has NO marker here.
 */
export function authorizationCodeVerificationMarkers(userId: string): {
  typeMarker: string;
  userMarker: string;
} {
  // JSON.stringify of a single-key object emits {"k":"v"}; slice(1,-1)
  // drops the outer braces, leaving "k":"v" with all JSON escaping applied
  // to the value (and, being a JSON token, to the key literal).
  const typeMarker = JSON.stringify({ type: "authorization_code" }).slice(1, -1);
  const userMarker = JSON.stringify({ userId }).slice(1, -1);
  return { typeMarker, userMarker };
}

/**
 * LIKE-safety guard for the user marker's interpolated value. The DB
 * `contains` predicate compiles to a raw PostgreSQL LIKE pattern (see the
 * LIKE SEMANTICS note above). The guard uses serialization equivalence:
 * the id is accepted iff `JSON.stringify(userId) === '"' + userId + '"'`
 * — i.e. compact JSON serialization adds NO escapes. This is a
 * SUFFICIENT, CONSERVATIVE safety condition, not a necessary one: some
 * rejected ids are still LIKE-matchable (R100/R101 probes: PostgreSQL
 * matched stored markers for ids containing `%`+newline, `%`+quote, and
 * `%`+backslash+`%`), so the guard may over-reject — fail-closed and
 * acceptable. What it guarantees is the direction that matters: the
 * escape classes it targets (`"` or `\` serialized as `\"` / `\\`,
 * control characters as `\n` / `\t` / `\u0000` / …, lone surrogates as
 * `\udXXX`) introduce a backslash into the pattern, where PostgreSQL's
 * LIKE escape consumes the next character, so the emitted pattern cannot
 * match the stored serialization of that id (verified for each class) —
 * a false negative the fail-closed scan can never observe. Rather than
 * enumerating forbidden characters, the guard rejects EVERY id whose
 * serialization is not the identity, which covers the entire
 * backslash-introducing class with no list to keep in sync.
 *
 * REACHABILITY (R98 finding 1): generated ids cannot trip this — the
 * installed Better Auth default generates 32 alphanumeric characters and
 * Prisma's fallback is cuid2 — but the enabled Better Auth admin
 * `/admin/create-user` endpoint accepts `data.id`, its internal adapter
 * preserves supplied ids (`forceAllowId: true`), and this repo's
 * user-create hook preserves them too, so control-character ids ARE
 * accepted inputs (R98 probe: id "http\nuser" created over HTTP with
 * 200 and preserved through sign-in/session). The guard therefore fails
 * closed on any escaped-serialization id instead of relying on generator
 * alphabets: throw BEFORE any scan or write rather than revoke under a
 * predicate that may have silently missed codes.
 */
export function assertVerificationUserMarkerLikeSafe(userId: string): void {
  if (JSON.stringify(userId) !== `"${userId}"`) {
    throw new ORPCError("CONFLICT", {
      message:
        "Revocation could not safely enumerate pending authorization codes for this account. Retry the request.",
    });
  }
}

/**
 * Cursor-pagination batch size for the Verification candidate scan. The
 * take bound applies to the RELEVANT set (unexpired rows carrying the type
 * and user markers — see the LIKE SEMANTICS notes above), not a global
 * window: unrelated email/OTP verification rows and OTHER users' codes
 * cannot displace matching authorization codes. THIS user's other-client
 * codes CAN enter the candidate set (no client marker in the DB
 * predicate); they are excluded post-parse and — at pathological volume —
 * fail loudly at the total cap.
 */
export const VERIFICATION_CANDIDATE_BATCH = 200;

/**
 * Total cap on relevant Verification candidates examined per revoke.
 * Reasoning: a legitimate user holds single-digit pending authorization
 * codes at any instant, across ALL clients (codes live <= 600 s by default
 * and each requires a browser consent round-trip), so 5,000 relevant rows
 * is orders of magnitude beyond any legitimate volume while still bounding
 * total scan work. FAIL-CLOSED CONTRACT: if the scan reaches this cap with
 * a full batch (more relevant rows may remain), revocation does NOT return
 * success — it throws a stable CONFLICT error, so the human retries instead
 * of being told a possibly-incomplete revoke succeeded. The residual is a
 * LOUD per-user failure, never a silent miss.
 */
export const VERIFICATION_CANDIDATE_TOTAL_CAP = 5000;

/**
 * Protective per-value size cap. JSON.parse is synchronous, so an
 * unbounded value would tie revoke latency to attacker-controlled row
 * content. Real authorization-code values are a few KiB; this cap is far
 * above any legitimate value. NOTE accuracies (R95/R96 finding 2): the
 * installed provider's query schema does NOT bound the attacker-controlled
 * `state` parameter (introspect-CbhhXT0E.mjs:1038 declares
 * `state: z.string().optional()` with no length limit), so this cap is the
 * ONLY bound on value size; and the threshold is measured in JavaScript
 * UTF-16 code units (String.prototype.length; 1024*1024 units), not MiB of
 * stored bytes. FAIL-CLOSED CONTRACT: a marker-matching row exceeding this
 * cap is NOT silently skipped — the inability to inspect it flips the whole
 * revoke to a LOUD failure (stable CONFLICT error), never a silent success.
 */
export const VERIFICATION_VALUE_MAX_LENGTH = 1024 * 1024;

/** Ceremonial confirmation literal for grant revocation. */
export const REVOKE_CONFIRMATION = "REVOKE";

// ---------------------------------------------------------------------------
// Safe OUTPUT projections — the wire contract is built from ONLY these
// fields. referenceId and confirmation thumbprints ARE selected internally
// (revocation needs reference IDs; DPoP aggregation needs the thumbprint
// presence) but are never placed in the returned objects. Token hashes,
// session IDs, redirect URIs, metadata JSON, JWKs, replay payloads, and
// token/consent row IDs are neither selected nor returned.
// ---------------------------------------------------------------------------

const grantSelection = {
  clientId: true,
  referenceId: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.McpGrantSelect;

const clientDisplaySelection = {
  id: true,
  clientId: true,
  name: true,
  uri: true,
} satisfies Prisma.OauthClientSelect;

const consentSelection = {
  clientId: true,
  scopes: true,
  referenceId: true,
} satisfies Prisma.OauthConsentSelect;

const refreshSelection = {
  clientId: true,
  scopes: true,
  expiresAt: true,
  confirmation: true,
} satisfies Prisma.OauthRefreshTokenSelect;

const referenceIdSelection = { referenceId: true } satisfies Prisma.McpGrantSelect;

/** One current-connection card in the settings page. */
export type McpGrantConnection = {
  /** Internal OauthClient record ID — the revokeMine target. */
  clientRecordId: string;
  /** Verified OAuth client identifier string. */
  clientId: string;
  name: string | null;
  uri: string | null;
  /** Deduplicated union of consented + actively held scopes, sorted. */
  scopes: string[];
  firstAuthorizedAt: Date;
  lastAuthorizedAt: Date;
  /** Latest rolling refresh-inactivity expiry across ACTIVE refresh rows (unrevoked AND unexpired); null when none. */
  rollingExpiryAt: Date | null;
  activeRefreshCount: number;
  /** DPoP state across ACTIVE refresh rows (unrevoked AND unexpired). */
  dpop: "all" | "some" | "none";
};

// ---------------------------------------------------------------------------
// Verification parsing (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Inspect one OAuth Verification candidate's JSON `value` (already admitted
 * by the per-key DB relevance markers) and decide whether it is a pending
 * AUTHORIZATION CODE for the exact (userId, clientId) pair.
 *
 * Outcome is a three-way decision — this is the fail-closed contract:
 *  - "match": parsed and validated as THIS user+client's authorization code.
 *  - "excluded": fully parsed and PROVEN not to be this user/client's code
 *    (wrong type, wrong user, wrong client) — safe to skip.
 *  - "uninspected": the value carries the relevance markers but could not
 *    be proven either way (over the protective size cap, unparseable, or
 *    parsed to a non-object). The caller MUST treat this as a loud
 *    revocation failure — never silently skip a possibly-matching code.
 *
 * The code's type is validated ONLY from the parsed `value.type` field —
 * NEVER inferred from the verification `identifier` (by default the
 * identifier is a HASH of the code produced by the provider's storeToken,
 * not the raw code, and carries no type information either way; email/OTP
 * verification rows share the table).
 */
export type AuthorizationCodeVerificationInspection =
  | { status: "match"; referenceId: string | null }
  | { status: "excluded" }
  | { status: "uninspected"; reason: "oversized" | "unparseable" | "non-object" };

export function inspectAuthorizationCodeVerification(
  value: unknown,
  userId: string,
  clientId: string,
): AuthorizationCodeVerificationInspection {
  // The DB column is a String; a non-string cannot reach here through the
  // scan, and it provably cannot be this user's code either way.
  if (typeof value !== "string") return { status: "excluded" };
  // Pre-parse SIZE CAP (protective; measured in UTF-16 code units — see
  // VERIFICATION_VALUE_MAX_LENGTH): a marker-matching row this large CANNOT be inspected, so the
  // outcome is "uninspected" — the caller fails the whole revoke loudly.
  if (value.length > VERIFICATION_VALUE_MAX_LENGTH) {
    return { status: "uninspected", reason: "oversized" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "uninspected", reason: "unparseable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "uninspected", reason: "non-object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorization_code") return { status: "excluded" };
  if (record.userId !== userId) return { status: "excluded" };
  const query = record.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return { status: "excluded" };
  }
  if ((query as Record<string, unknown>).client_id !== clientId) {
    return { status: "excluded" };
  }
  const referenceId = record.referenceId;
  return { status: "match", referenceId: typeof referenceId === "string" ? referenceId : null };
}

/**
 * Stable error thrown when the pending-code enumeration cannot be PROVEN
 * complete (marker-matching row over the size cap or unparseable, or more
 * relevant rows than the total cap). The Serializable transaction rolls
 * back — no partial revoke is committed — and the human sees the failure
 * and can retry. Never return success with a possibly-missed generation.
 */
function revocationEnumerationIncompleteError() {
  return new ORPCError("CONFLICT", {
    message: "Revocation could not verify every pending authorization code. Retry the request.",
  });
}

function ownershipHidingNotFound() {
  return new ORPCError("NOT_FOUND", { message: "MCP connection not found." });
}

export const mcpGrantsRouter = {
  /**
   * List the current user's live MCP connections (aggregated per client).
   * Tombstone-only generations (every grant revoked) are retained in the
   * database for revocation semantics but HIDDEN from this list.
   */
  listMine: protectedProcedure.handler(async ({ context }): Promise<McpGrantConnection[]> => {
    const userId = context.session.user.id;
    // One timestamp per request: "active" refresh token = unrevoked AND
    // unexpired (expiresAt strictly > now). Boundary choice: a row whose
    // expiresAt EQUALS now is NOT active here. The installed provider's
    // refresh handling compares with strict `<` (introspect-CbhhXT0E.mjs
    // ~L2128: `refreshToken.expiresAt < new Date()`), i.e. it would still
    // accept a row expiring exactly at the comparison instant; this list's
    // strict `gt` is therefore a deliberate STRICTER choice at equality, not
    // an identical replication of the provider's boundary — "unrevoked"
    // alone would over-report. This definition drives ALL four
    // refresh aggregations below (count, scope union, rolling expiry, DPoP)
    // — scopes shown reflect live authorization state, so scopes carried
    // only by expired tokens are not displayed.
    const now = new Date();

    const grants = await prisma.mcpGrant.findMany({
      where: { userId },
      select: grantSelection,
    });

    const activeClientIds = new Set(
      grants.filter((grant) => grant.revokedAt === null).map((grant) => grant.clientId),
    );
    if (activeClientIds.size === 0) return [];

    const clientIdFilter = { clientId: { in: [...activeClientIds] } };
    const clients = await prisma.oauthClient.findMany({
      where: clientIdFilter,
      select: clientDisplaySelection,
    });
    const consents = await prisma.oauthConsent.findMany({
      where: { userId, ...clientIdFilter },
      select: consentSelection,
    });
    const refreshes = await prisma.oauthRefreshToken.findMany({
      where: { userId, ...clientIdFilter, revoked: null, expiresAt: { gt: now } },
      select: refreshSelection,
    });

    const connections: McpGrantConnection[] = [];
    for (const client of clients) {
      const clientGrants = grants.filter((grant) => grant.clientId === client.clientId);
      if (clientGrants.length === 0) continue;
      const clientConsents = consents.filter((row) => row.clientId === client.clientId);
      const clientRefreshes = refreshes.filter((row) => row.clientId === client.clientId);

      const scopes = new Set<string>();
      for (const consent of clientConsents) {
        for (const scope of consent.scopes) scopes.add(scope);
      }
      for (const refresh of clientRefreshes) {
        for (const scope of refresh.scopes) scopes.add(scope);
      }

      let rollingExpiryAt: Date | null = null;
      let dpopBound = 0;
      for (const refresh of clientRefreshes) {
        if (rollingExpiryAt === null || refresh.expiresAt > rollingExpiryAt) {
          rollingExpiryAt = refresh.expiresAt;
        }
        if (refresh.confirmation !== null && refresh.confirmation !== undefined) dpopBound += 1;
      }
      const dpop: McpGrantConnection["dpop"] =
        clientRefreshes.length === 0
          ? "none"
          : dpopBound === clientRefreshes.length
            ? "all"
            : dpopBound === 0
              ? "none"
              : "some";

      connections.push({
        clientRecordId: client.id,
        clientId: client.clientId,
        name: client.name,
        uri: client.uri,
        scopes: [...scopes].sort(),
        firstAuthorizedAt: clientGrants.reduce(
          (earliest, grant) => (grant.createdAt < earliest ? grant.createdAt : earliest),
          clientGrants[0]!.createdAt,
        ),
        lastAuthorizedAt: clientGrants.reduce(
          (latest, grant) => (grant.createdAt > latest ? grant.createdAt : latest),
          clientGrants[0]!.createdAt,
        ),
        rollingExpiryAt,
        activeRefreshCount: clientRefreshes.length,
        dpop,
      });
    }
    return connections;
  }),

  /**
   * Revoke EVERY grant generation of the current user's connection to one
   * client: tombstone every collected generation (existing ACTIVE rows are
   * tombstoned via updateMany with a `revokedAt: null` predicate — an
   * existing tombstone is NEVER cleared; still-missing generations are
   * created directly as tombstones), mark all matching refresh rows revoked
   * (rows are retained as replay evidence — never deleted), delete the
   * remembered consents, and mark matching opaque access rows revoked. The
   * shared CIMD oauthClient cache row is preserved (it may be referenced by
   * other users). Idempotent: a repeat call collects the same (now
   * tombstoned) generations, the updateMany matches nothing, and the
   * createMany set is empty, returning the same result.
   *
   * FAILS CLOSED (never silently incomplete): if the pending-code
   * enumeration cannot be PROVEN complete — the defensive user-marker
   * LIKE-safety guard trips, more relevant rows than the scan cap, or a
   * marker-matching row over the protective size cap / unparseable — the
   * procedure throws a stable CONFLICT error instead of returning success,
   * so a possibly-missed redeemable generation can never hide behind
   * `{revoked:true}`.
   */
  revokeMine: protectedProcedure
    .input(
      z.object({
        clientRecordId: z.string().min(1),
        confirm: z.literal(REVOKE_CONFIRMATION),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      // Defensive LIKE-safety precondition for the DB predicate below:
      // must hold BEFORE any scan or write. Generated ids (32-alphanumeric
      // Better Auth default / Prisma cuid2 fallback) always pass; an
      // admin-supplied id whose JSON serialization adds ANY escape would
      // make the DB `contains` compile to a LIKE pattern that can SILENTLY
      // miss rows — fail closed instead. See
      // assertVerificationUserMarkerLikeSafe.
      assertVerificationUserMarkerLikeSafe(userId);

      // Ownership resolves BEFORE any mutation; a foreign or missing
      // connection is indistinguishable (ownership-hiding NOT_FOUND).
      const client = await prisma.oauthClient.findUnique({
        where: { id: input.clientRecordId },
        select: clientDisplaySelection,
      });
      if (!client) throw ownershipHidingNotFound();

      const ownedGrants = await prisma.mcpGrant.findMany({
        where: { userId, clientId: client.clientId },
        select: referenceIdSelection,
      });
      if (ownedGrants.length === 0) throw ownershipHidingNotFound();

      // ORDINARY FENCED WORK — no shutdown permit (see the module header:
      // this is a newly requested business mutation, not teardown cleanup
      // of already-owned durable work; Serializable rollback prevents any
      // half-revoked terminal state if the fence rejects mid-transaction).
      await runSerializableTransaction(async (tx) => {
        const now = new Date();
        const clientId = client.clientId;

        // Collect reference generations for the exact user/client from
        // every artifact table, re-read INSIDE the transaction.
        const grants = await tx.mcpGrant.findMany({
          where: { userId, clientId },
          select: referenceIdSelection,
        });
        const consents = await tx.oauthConsent.findMany({
          where: { userId, clientId },
          select: referenceIdSelection,
        });
        const refreshes = await tx.oauthRefreshToken.findMany({
          where: { userId, clientId },
          select: referenceIdSelection,
        });
        const accesses = await tx.oauthAccessToken.findMany({
          where: { userId, clientId },
          select: referenceIdSelection,
        });

        const generations = new Set<string>();
        for (const row of [...grants, ...consents, ...refreshes, ...accesses]) {
          if (typeof row.referenceId === "string" && row.referenceId.length > 0) {
            generations.add(row.referenceId);
          }
        }

        // Pending authorization codes: batched cursor-paginated scan over
        // the RELEVANT candidate set — unexpired rows whose value carries
        // BOTH per-key relevance markers (type + THIS user; DB-side per-key
        // `contains` combined with AND — the value column is a String, so
        // JSON path filters are not available — see
        // authorizationCodeVerificationMarkers and the LIKE SEMANTICS
        // notes). There is deliberately NO client marker: client
        // discrimination is the post-parse exact equality, so every
        // accepted client-id shape (quoted, backslashed, newline,
        // wildcard, Unicode) is handled exactly. The two markers are NOT
        // LIKE-exact — their `_` (and any `%` in an unescaped user id) can
        // OVER-match — so foreign-USER rows CAN enter the candidate set;
        // they are rejected by the post-parse exact checks and at
        // pathological volume fail LOUDLY at the scan cap, so they can
        // never silently displace matching codes; THIS user's other-client
        // codes CAN enter and are likewise excluded by
        // inspectAuthorizationCodeVerification's exact checks.
        //
        // FAIL-CLOSED CONTRACT (Q2): success is returned ONLY when this
        // enumeration provably covered the whole relevant population. If
        // ANY admitted candidate cannot be inspected (over the protective
        // per-value size cap, unparseable, non-object), or the total cap
        // is reached with a full batch (more relevant rows may remain),
        // the procedure THROWS — the Serializable transaction rolls back
        // (no partial tombstone claims are committed) and the human sees a
        // revocation failure to retry. NEVER a silent success that may
        // have missed a redeemable pending generation.
        const { typeMarker, userMarker } = authorizationCodeVerificationMarkers(userId);
        let cursorId: string | undefined;
        let scanned = 0;
        let enumerationIncomplete = false;
        while (scanned < VERIFICATION_CANDIDATE_TOTAL_CAP) {
          const candidates = await tx.verification.findMany({
            where: {
              expiresAt: { gt: now },
              AND: [{ value: { contains: typeMarker } }, { value: { contains: userMarker } }],
            },
            orderBy: { id: "asc" },
            take: VERIFICATION_CANDIDATE_BATCH,
            ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
            select: { id: true, value: true },
          });
          if (candidates.length === 0) break;
          for (const candidate of candidates) {
            const inspection = inspectAuthorizationCodeVerification(
              candidate.value,
              userId,
              clientId,
            );
            if (inspection.status === "uninspected") {
              // Marker-matching row we cannot prove is not ours — fail the
              // whole revoke loudly; never skip a possibly-matching code.
              throw revocationEnumerationIncompleteError();
            }
            if (inspection.status === "match" && inspection.referenceId) {
              generations.add(inspection.referenceId);
            }
          }
          scanned += candidates.length;
          cursorId = candidates[candidates.length - 1]!.id;
          if (candidates.length < VERIFICATION_CANDIDATE_BATCH) break;
          // Full batch + cap reached: more relevant rows may remain beyond
          // the cap — the enumeration is not provably complete.
          if (scanned >= VERIFICATION_CANDIDATE_TOTAL_CAP) {
            enumerationIncomplete = true;
            break;
          }
        }
        if (enumerationIncomplete) throw revocationEnumerationIncompleteError();

        // Tombstone every collected generation that is not already a
        // tombstone. Order: updateMany FIRST, then createMany for the
        // still-missing generations (chosen so the createMany rows are born
        // tombstoned and the two writes never overlap; the order is not
        // otherwise observable inside one Serializable transaction). The
        // `revokedAt: null` predicate SETS tombstones only where absent —
        // an existing tombstone can never be cleared.
        if (generations.size > 0) {
          await tx.mcpGrant.updateMany({
            where: {
              userId,
              clientId,
              referenceId: { in: [...generations] },
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
        }
        const existing = new Set(
          grants
            .map((row) => row.referenceId)
            .filter((referenceId): referenceId is string => typeof referenceId === "string"),
        );
        const missing = [...generations].filter((referenceId) => !existing.has(referenceId));
        if (missing.length > 0) {
          await tx.mcpGrant.createMany({
            data: missing.map((referenceId) => ({
              userId,
              clientId,
              referenceId,
              revokedAt: now,
            })),
            skipDuplicates: true,
          });
        }

        // Refresh rows are marked revoked and RETAINED (replay-evidence
        // retention); MCP JWT access dies via the live /mcp grant check
        // (apps/server/src/mcp/auth.ts loadMcpGrant rejects
        // revokedAt !== null), opaque access rows are marked revoked too.
        await tx.oauthRefreshToken.updateMany({
          where: { userId, clientId, revoked: null },
          data: { revoked: now },
        });
        await tx.oauthConsent.deleteMany({ where: { userId, clientId } });
        await tx.oauthAccessToken.updateMany({
          where: { userId, clientId, revoked: null },
          data: { revoked: now },
        });
      });

      return { revoked: true as const };
    }),
};
