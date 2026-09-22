import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    // mcp-grants imports @ws-model-proxy/auth/mcp-config, which binds
    // MCP_ISSUER/MCP_RESOURCE_URL from BETTER_AUTH_URL at module load.
    BETTER_AUTH_URL: "https://proxy.example.com",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const permitState = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({
  runWithDbShutdownPermit: (fn: () => unknown) => {
    permitState.calls += 1;
    return fn();
  },
}));

const {
  mcpGrantsRouter,
  inspectAuthorizationCodeVerification,
  authorizationCodeVerificationMarkers,
  assertVerificationUserMarkerLikeSafe,
  VERIFICATION_CANDIDATE_BATCH,
  VERIFICATION_CANDIDATE_TOTAL_CAP,
  VERIFICATION_VALUE_MAX_LENGTH,
} = await import("./mcp-grants");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  mcpGrant: {
    findMany: MockInstance;
    createMany: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
    deleteMany: MockInstance;
  };
  oauthClient: { findUnique: MockInstance; findMany: MockInstance };
  oauthConsent: { findMany: MockInstance; deleteMany: MockInstance };
  oauthRefreshToken: { findMany: MockInstance; updateMany: MockInstance; deleteMany: MockInstance };
  oauthAccessToken: { findMany: MockInstance; updateMany: MockInstance };
  verification: { findMany: MockInstance };
  $transaction: MockInstance;
};

const transactionOptions: unknown[] = [];

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const updatedAt = new Date("2026-01-01T00:00:00.000Z");

function buildContext(userOverride?: Partial<Session["user"]>): Context {
  return {
    session: {
      user: {
        id: "user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        locale: "en-US",
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt,
        updatedAt,
        ...userOverride,
      },
      session: {
        id: "session-id",
        userId: userOverride?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt,
        updatedAt,
      },
    } as Session,
  };
}

function client(): ReturnType<typeof createRouterClient<typeof mcpGrantsRouter>> {
  return createRouterClient(mcpGrantsRouter, { context: buildContext() });
}

beforeEach(() => {
  vi.clearAllMocks();
  permitState.calls = 0;
  transactionOptions.length = 0;
  // Baseline defaults for every read surface (R100 F1 / R101 F1 class:
  // implementations survive vi.clearAllMocks, so a test that omits a mock
  // would otherwise inherit the previous test's fixtures — or undefined,
  // standalone). Every test starts from empty rows and sets what it needs.
  db.mcpGrant.findMany.mockResolvedValue([]);
  db.oauthClient.findMany.mockResolvedValue([]);
  db.oauthClient.findUnique.mockResolvedValue(null);
  db.oauthConsent.findMany.mockResolvedValue([]);
  db.oauthRefreshToken.findMany.mockResolvedValue([]);
  db.oauthAccessToken.findMany.mockResolvedValue([]);
  db.verification.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (work: unknown, options?: unknown) => {
    transactionOptions.push(options);
    return (work as (tx: unknown) => Promise<unknown>)(prisma);
  });
});

// ---------------------------------------------------------------------------
// inspectAuthorizationCodeVerification (pure) + relevance markers
// ---------------------------------------------------------------------------

describe("inspectAuthorizationCodeVerification", () => {
  const codeValue = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "authorization_code",
      query: { client_id: "client-a" },
      userId: "user-id",
      sessionId: "session-id",
      referenceId: "ref-1",
      authTime: 1_750_000_000_000,
      resource: ["https://proxy.example.com/mcp"],
      ...overrides,
    });

  it("accepts an exact authorization_code record with matching user and client", () => {
    expect(inspectAuthorizationCodeVerification(codeValue(), "user-id", "client-a")).toEqual({
      status: "match",
      referenceId: "ref-1",
    });
  });

  it("excludes a wrong-type record even with matching user/client (never infer from identifier)", () => {
    expect(
      inspectAuthorizationCodeVerification(
        codeValue({ type: "email_verify" }),
        "user-id",
        "client-a",
      ),
    ).toEqual({ status: "excluded" });
  });

  it("excludes user and client mismatches", () => {
    expect(inspectAuthorizationCodeVerification(codeValue(), "other-user", "client-a")).toEqual({
      status: "excluded",
    });
    expect(inspectAuthorizationCodeVerification(codeValue(), "user-id", "client-b")).toEqual({
      status: "excluded",
    });
    expect(
      inspectAuthorizationCodeVerification(codeValue({ query: {} }), "user-id", "client-a"),
    ).toEqual({ status: "excluded" });
  });

  it("excludes non-string values; tolerates absent referenceId on a match", () => {
    expect(inspectAuthorizationCodeVerification(42, "user-id", "client-a")).toEqual({
      status: "excluded",
    });
    expect(
      inspectAuthorizationCodeVerification(
        codeValue({ referenceId: undefined }),
        "user-id",
        "client-a",
      ),
    ).toEqual({ status: "match", referenceId: null });
  });

  it("marks oversized values UNINSPECTED — the caller must fail the revoke, never skip (fail-closed)", () => {
    // Exactly at the cap (a real-shaped padded value) still parses…
    const pad = "x".repeat(100);
    expect(inspectAuthorizationCodeVerification(codeValue({ pad }), "user-id", "client-a")).toEqual(
      { status: "match", referenceId: "ref-1" },
    );
    // …but anything over the length cap is uninspectable WITHOUT parsing —
    // "uninspected" (loud failure), not a silent exclusion.
    const oversized = codeValue({ pad: "y".repeat(VERIFICATION_VALUE_MAX_LENGTH) });
    expect(oversized.length).toBeGreaterThan(VERIFICATION_VALUE_MAX_LENGTH);
    expect(inspectAuthorizationCodeVerification(oversized, "user-id", "client-a")).toEqual({
      status: "uninspected",
      reason: "oversized",
    });
    expect(
      inspectAuthorizationCodeVerification(
        "z".repeat(VERIFICATION_VALUE_MAX_LENGTH + 1),
        "user-id",
        "client-a",
      ),
    ).toEqual({ status: "uninspected", reason: "oversized" });
  });

  it("marks unparseable and non-object values UNINSPECTED — a marker-matching row can never be silently dropped", () => {
    expect(inspectAuthorizationCodeVerification("{not json", "user-id", "client-a")).toEqual({
      status: "uninspected",
      reason: "unparseable",
    });
    expect(inspectAuthorizationCodeVerification("[1,2]", "user-id", "client-a")).toEqual({
      status: "uninspected",
      reason: "non-object",
    });
    expect(inspectAuthorizationCodeVerification("null", "user-id", "client-a")).toEqual({
      status: "uninspected",
      reason: "non-object",
    });
  });
});

describe("authorizationCodeVerificationMarkers (DB relevance filter)", () => {
  /**
   * The EXACT shape the installed provider serializes
   * (dist/authorize-9whjxVLJ.mjs ~L5707-5727):
   * JSON.stringify({ type, query, userId, sessionId, referenceId, authTime, resource }).
   */
  const storedValue = (keyOrderOverrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "authorization_code",
      query: {
        client_id: "client-a",
        redirect_uri: "https://relay.example.com/cb",
        state: "xyz",
        scope: "mcp:read offline_access",
      },
      userId: "user-id",
      sessionId: "session-id",
      referenceId: "ref-1",
      authTime: 1_750_000_000_000,
      resource: ["https://proxy.example.com/mcp"],
      ...keyOrderOverrides,
    });

  it("each marker is an exact substring of the REAL stored serialization (type first)", () => {
    const { typeMarker, userMarker } = authorizationCodeVerificationMarkers("user-id");
    const value = storedValue();
    expect(value).toContain(typeMarker);
    expect(value).toContain(userMarker);
    expect(typeMarker).toBe('"type":"authorization_code"');
  });

  it("markers are ORDER-INDEPENDENT: still substrings when type is the LAST key", () => {
    const { typeMarker, userMarker } = authorizationCodeVerificationMarkers("user-id");
    const entry = JSON.parse(storedValue()) as Record<string, unknown>;
    const reordered = { ...entry };
    delete reordered.type;
    const value = JSON.stringify({ ...reordered, type: "authorization_code" });
    expect(value).toContain(typeMarker);
    expect(value).toContain(userMarker);
  });

  it("LIKE-SAFETY (R95/R96): the type marker is a static literal whose LIKE has NO false negatives (no backslash escape, no % wildcard)", () => {
    const { typeMarker } = authorizationCodeVerificationMarkers("user-id");
    // PostgreSQL LIKE treats only `\` (escape), `%`, and `_` as special —
    // the type marker's JSON quotes are pattern-literal. No `\` means no
    // escape can consume a character (the silent false-negative class);
    // no `%` means no unbounded wildcard. The single `_` inside
    // "authorization_code" is a single-char wildcard that can only
    // OVER-match — admitted rows are post-parse rejected by the exact
    // `type` equality. Verified against real PostgreSQL across all 5,040
    // top-level key orders (.review-loop/r95-marker-probe.out.txt).
    expect(typeMarker).toBe('"type":"authorization_code"');
    expect(typeMarker).not.toMatch(/[\\%]/);
    // And it matches the real stored serialization under LIKE semantics
    // (see likeMatches below), not just under String.includes.
    expect(likeMatches(storedValue(), `%${typeMarker}%`)).toBe(true);
  });

  it("LIKE mock fidelity (R98 finding 3): a pattern ending with a bare escape THROWS a 22025-style error, like real PostgreSQL", () => {
    // Real PostgreSQL raises SQLSTATE 22025 for value "ab" / pattern "a\"
    // and "x" / "%\" (probe-verified, .review-loop/r98-probe.out.txt). The
    // mock must THROW the same error class — not return false — so it can
    // never silently mask the error behavior. Production patterns cannot
    // end with a bare escape (Prisma wraps the marker with %…% and both
    // markers end with `"`), pinned by the assertion below.
    for (const [value, pattern] of [
      ["ab", "a\\"],
      ["x", "%\\"],
    ] as const) {
      expect(() => likeMatches(value, pattern)).toThrowError(
        expect.objectContaining({ code: "22025" }),
      );
    }
    const { typeMarker, userMarker } = authorizationCodeVerificationMarkers("user-id");
    for (const marker of [typeMarker, userMarker]) {
      expect(marker.endsWith("\\")).toBe(false);
      // The compiled contains pattern is %marker% — never trailing-escape.
      expect(() => likeMatches(storedValue(), `%${marker}%`)).not.toThrow();
    }
    // R100 finding 2 + R101 finding 2: PostgreSQL only raises 22025 when
    // the scan reaches the dangling escape with the value NOT exhausted;
    // mismatch-first ("x"/"q\") and exhausted-at-escape ("a"/"a\",
    // "a"/"%a\", ""/"\") values return false (probe-verified). Pinned:
    expect(likeMatches("x", "q\\")).toBe(false);
    expect(likeMatches("a", "a\\")).toBe(false);
    expect(likeMatches("a", "%a\\")).toBe(false);
    expect(likeMatches("", "\\")).toBe(false);
  });

  it("LIKE-SAFETY (R95/R96): the user marker for server-generated ids (cuid/uuid/nanoid alphabets) contains no JSON escapes and no % wildcard", () => {
    for (const id of [
      "cmcabcdefghijklmnopqrstuvwx", // cuid-style
      "5f8d3e2a-1b4c-4e8a-9d2f-7a6b5c4d3e2f", // uuid
      "V1StGXR8_Z5jdHi6B-myT", // nanoid (may contain `_` — over-match only)
      "user-id",
    ]) {
      const { userMarker } = authorizationCodeVerificationMarkers(id);
      // The interpolated id needs NO JSON escaping (a `"` or `\` would
      // escape to `\"`/`\\` and introduce a backslash — a silent false
      // negative under LIKE; `%` would over-match). The marker's own JSON
      // delimiter quotes are LIKE-literal and therefore fine. `_` is
      // permitted: it can only OVER-match (single-char wildcard) and
      // over-matched rows are post-parse rejected by the exact userId
      // equality.
      expect(id).not.toMatch(/["\\%]/);
      expect(userMarker).not.toMatch(/[\\%]/);
      expect(userMarker).toBe(`"userId":"${id}"`);
    }
  });

  it("fail-closed guard: a session user id whose JSON serialization adds ANY escape is rejected BEFORE any scan (R98 finding 1)", () => {
    // The guard's predicate is serialization equivalence: safe iff
    // JSON.stringify(userId) === '"' + userId + '"'. Every escape class —
    // quote, backslash, control characters (newline, tab, NUL, US), and
    // lone surrogates — introduces a backslash into the LIKE pattern and
    // is rejected WITHOUT enumerating characters.
    for (const unsafe of [
      'u"ser', // quote → \"
      "u\\ser", // backslash → \\
      "u\nser", // newline → \n (R98's end-to-end probe id class)
      "u\tser", // tab → \t
      "u\x00ser", // NUL → \u0000
      "u\x1fser", // US → \u001f
      "u\x7bser\x03", // mixed control characters
      "\uD800ser", // lone high surrogate → \ud800
      "user\uDC00", // lone low surrogate → \udc00
      "u\x0bser", // vertical tab → \u000b
      "\r", // carriage return alone
    ]) {
      // Property pin: the guard's decision is EXACTLY the serialization
      // equivalence predicate — no more, no less.
      expect(JSON.stringify(unsafe)).not.toBe(`"${unsafe}"`);
      expect(() => assertVerificationUserMarkerLikeSafe(unsafe)).toThrowError(
        expect.objectContaining({ code: "CONFLICT" }),
      );
    }
    // SAFE: every accepted-generator alphabet shape (installed Better
    // Auth 32-alphanumeric default, Prisma cuid2 fallback, plus `_`/`-`
    // and 0x7f DEL — none of which JSON.stringify escapes; `_` and `%`
    // are LIKE wildcards that can only OVER-match, never miss) and the
    // guard passes them.
    for (const safe of [
      "user-id",
      "V1StGXR8_Z5jdHi6B-myT", // nanoid-style (contains `_` — over-match only)
      "u%ser", // `%` is NOT escaped: over-match only, post-parse rejected
      "u\x7fser", // DEL is not escaped by JSON.stringify; LIKE-literal
      "cmcabcdefghijklmnopqrstuvwx", // cuid-style
      "5f8d3e2a-1b4c-4e8a-9d2f-7a6b5c4d3e2f", // uuid
      "Ab3xY9kQ2mZp7LwR5tNv1cDe4fGh6jKl", // installed default: 32 alphanumeric
    ]) {
      expect(JSON.stringify(safe)).toBe(`"${safe}"`);
      expect(() => assertVerificationUserMarkerLikeSafe(safe)).not.toThrow();
    }
  });

  it("guard predicate is EXACTLY serialization equivalence over the R98 admin-supplied-ID shapes (property pin)", () => {
    // R98's probes created admin-supplied ids of these shapes end-to-end
    // (HTTP 200 on /admin/create-user, preserved by forceAllowId and the
    // repo's user-create hook). For every shape — safe or unsafe — the
    // guard's decision must equal JSON.stringify(userId) === '"'+userId+'"',
    // with no character enumeration in between.
    const adminSuppliedShapes = [
      "httpuser", // plain
      "http\nuser", // R98's probe id
      "u\nser", // R98's session-preserved probe id
      'u"user',
      "u\\user",
      "u%user",
      "u_user",
      "tab\tid",
      "nul\x00id",
      "surro\uD800gate",
      "unicode-é-id",
      "32alphanumericAb3xY9kQ2mZp7",
    ];
    for (const id of adminSuppliedShapes) {
      const serializationIsIdentity = JSON.stringify(id) === `"${id}"`;
      try {
        assertVerificationUserMarkerLikeSafe(id);
        expect(serializationIsIdentity).toBe(true);
      } catch (error) {
        expect(error).toMatchObject({ code: "CONFLICT" });
        expect(serializationIsIdentity).toBe(false);
      }
    }
  });

  it("a marker embedded inside a JSON STRING (crafted query.state) is stored ESCAPED and cannot match", () => {
    const { userMarker } = authorizationCodeVerificationMarkers("user-id");
    const crafted = storedValue({
      query: {
        client_id: "client-b",
        state: 'x "userId":"user-id" y', // malicious substring inside a string
      },
      userId: "someone-else",
    });
    expect(crafted).not.toContain(userMarker);
  });
});

// ---------------------------------------------------------------------------
// listMine
// ---------------------------------------------------------------------------

describe("mcpGrants.listMine", () => {
  it("aggregates duplicate generations per client with the exact safe projection", async () => {
    const early = new Date("2026-05-01T00:00:00.000Z");
    const late = new Date("2026-06-01T00:00:00.000Z");
    // ACTIVE refresh rows only: expiresAt strictly in the future relative to
    // the request-time `now` (dynamic dates — fixed past dates would be
    // filtered as expired, which is exactly the Q4 regression).
    const refreshExpiryA = new Date(Date.now() + 3 * 86_400_000);
    const refreshExpiryB = new Date(Date.now() + 4 * 86_400_000);
    db.mcpGrant.findMany.mockResolvedValue([
      // Two generations for client-a (duplicate consent/generation rows).
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt: early },
      { clientId: "client-a", referenceId: "ref-a2", revokedAt: null, createdAt: late },
      // Tombstone-only generation for client-a (hidden as a generation,
      // retained internally for first-authorization history).
      { clientId: "client-a", referenceId: "ref-a0", revokedAt: early, createdAt: early },
      // Tombstone-only client-b: entire client hidden.
      { clientId: "client-b", referenceId: "ref-b1", revokedAt: early, createdAt: early },
    ]);
    db.oauthClient.findMany.mockResolvedValue([
      {
        id: "record-a",
        clientId: "client-a",
        name: "Relay Agent",
        uri: "https://relay.example.com",
        icon: "https://relay.example.com/icon.png",
        redirectUris: ["https://relay.example.com/cb"],
        metadata: { secret: true },
      },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([
      { clientId: "client-a", scopes: ["mcp:read", "offline_access"], referenceId: "ref-a1" },
      { clientId: "client-a", scopes: ["mcp:read", "mcp:write"], referenceId: "ref-a2" },
    ]);
    db.oauthRefreshToken.findMany.mockResolvedValue([
      {
        clientId: "client-a",
        scopes: ["mcp:read"],
        expiresAt: refreshExpiryA,
        confirmation: { jkt: "thumbprint" },
      },
      {
        clientId: "client-a",
        scopes: ["mcp:read"],
        expiresAt: refreshExpiryB,
        confirmation: null,
      },
    ]);

    const result = await client().listMine();

    // Prisma filters by the query's `clientId in` — pin that the
    // tombstone-only client-b is excluded from the client read itself.
    const clientWhere = db.oauthClient.findMany.mock.calls[0]?.[0] as {
      where?: { clientId?: { in?: string[] } };
    };
    expect(clientWhere.where?.clientId?.in).toEqual(["client-a"]);

    // EXACT-shape assertion: none of the forbidden fields (token hashes,
    // reference IDs, session IDs, redirect URIs, metadata JSON, confirmation
    // thumbprints, token/consent row IDs) can appear anywhere in the output.
    expect(result).toEqual([
      {
        clientRecordId: "record-a",
        clientId: "client-a",
        name: "Relay Agent",
        uri: "https://relay.example.com",
        scopes: ["mcp:read", "mcp:write", "offline_access"],
        firstAuthorizedAt: early,
        lastAuthorizedAt: late,
        rollingExpiryAt: refreshExpiryB,
        activeRefreshCount: 2,
        dpop: "some",
      },
    ]);
  });

  it("filters refresh reads to unrevoked AND unexpired rows — strict gt boundary (Q4)", async () => {
    // Self-sufficient fixtures (R101 F1: this test previously inherited the
    // DPoP test's client/consent/refresh implementations and threw
    // "clients is not iterable" when run standalone).
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt },
    ]);
    db.oauthClient.findMany.mockResolvedValue([
      { id: "record-a", clientId: "client-a", name: null, uri: null },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([
      { clientId: "client-a", scopes: ["mcp:read"], referenceId: "ref-a1" },
    ]);
    db.oauthRefreshToken.findMany.mockResolvedValue([]);
    await client().listMine();

    // The WHERE clause is the filtering contract against the real database:
    // active = revoked: null AND expiresAt STRICTLY greater than the
    // request-time now. Boundary: a row whose expiresAt equals the request
    // instant is NOT active (gt, not gte) — the installed provider's
    // refresh handling already rejects such rows as expired
    // (introspect-CbhhXT0E.mjs ~L2128), so "unrevoked" alone can never
    // satisfy "active refresh count".
    const refreshWhere = db.oauthRefreshToken.findMany.mock.calls[0]?.[0] as {
      where?: { revoked?: null; expiresAt?: { gt?: Date; gte?: Date } };
    };
    expect(refreshWhere.where?.revoked).toBeNull();
    expect(refreshWhere.where?.expiresAt?.gte).toBeUndefined();
    expect(refreshWhere.where?.expiresAt?.gt).toBeInstanceOf(Date);
    expect(refreshWhere.where?.expiresAt?.gt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("aggregates count/scopes/rollingExpiry/dpop over ONLY the rows the active filter admits (Q4)", async () => {
    const future = new Date(Date.now() + 86_400_000);
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt },
    ]);
    db.oauthClient.findMany.mockResolvedValue([
      { id: "record-a", clientId: "client-a", name: null, uri: null },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([
      { clientId: "client-a", scopes: ["mcp:read"], referenceId: "ref-a1" },
    ]);
    // What a real DB returns post-filter: expired-unrevoked and
    // expiresAt===now rows are EXCLUDED by the where clause pinned above.
    db.oauthRefreshToken.findMany.mockResolvedValue([
      {
        clientId: "client-a",
        scopes: ["offline_access"],
        expiresAt: future,
        confirmation: null,
      },
    ]);

    const result = await client().listMine();
    expect(result).toEqual([
      {
        clientRecordId: "record-a",
        clientId: "client-a",
        name: null,
        uri: null,
        scopes: ["mcp:read", "offline_access"],
        firstAuthorizedAt: createdAt,
        lastAuthorizedAt: createdAt,
        rollingExpiryAt: future,
        activeRefreshCount: 1,
        dpop: "none",
      },
    ]);
  });

  it("reports rollingExpiryAt null and dpop none when no refresh row passes the active filter", async () => {
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt },
    ]);
    db.oauthClient.findMany.mockResolvedValue([
      { id: "record-a", clientId: "client-a", name: null, uri: null },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([]);
    // Every stored row expired before the request: the where clause admits
    // none of them (a real DB returns an empty set).
    db.oauthRefreshToken.findMany.mockResolvedValue([]);

    const result = await client().listMine();
    expect(result[0]).toMatchObject({
      activeRefreshCount: 0,
      rollingExpiryAt: null,
      dpop: "none",
    });
  });

  it("returns [] when every generation is tombstoned (and queries no other table)", async () => {
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-b", referenceId: "ref-b1", revokedAt: createdAt, createdAt },
    ]);

    await expect(client().listMine()).resolves.toEqual([]);
    expect(db.oauthClient.findMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.findMany).not.toHaveBeenCalled();
    expect(db.oauthRefreshToken.findMany).not.toHaveBeenCalled();
  });

  it("reports DPoP all/none correctly", async () => {
    const expiry = new Date(Date.now() + 86_400_000);
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt },
    ]);
    db.oauthClient.findMany.mockResolvedValue([
      { id: "record-a", clientId: "client-a", name: null, uri: null },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([]);
    db.oauthRefreshToken.findMany
      .mockResolvedValueOnce([
        {
          clientId: "client-a",
          scopes: ["mcp:read"],
          expiresAt: expiry,
          confirmation: { jkt: "t" },
        },
      ])
      .mockResolvedValueOnce([
        {
          clientId: "client-a",
          scopes: ["mcp:read"],
          expiresAt: expiry,
          confirmation: null,
        },
      ]);

    const first = await client().listMine();
    expect(first[0]).toMatchObject({ dpop: "all", rollingExpiryAt: expiry });

    const second = await client().listMine();
    expect(second[0]).toMatchObject({ dpop: "none", rollingExpiryAt: expiry });
  });

  it("always scopes reads to the session user (no caller-supplied user id)", async () => {
    db.mcpGrant.findMany.mockResolvedValue([]);
    await client().listMine();
    const grantWhere = db.mcpGrant.findMany.mock.calls[0]?.[0] as { where?: { userId?: string } };
    expect(grantWhere.where).toEqual({ userId: "user-id" });
  });

  it("a `pat:` grant never surfaces as a connection (explicit personal-token exclusion)", async () => {
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "pat:token-1", referenceId: "ref-pat", revokedAt: null, createdAt },
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: null, createdAt },
    ]);
    // Even a stray OauthClient row carrying a `pat:` id must not resurrect
    // the grant as a connection: the exclusion is early and explicit, not an
    // artifact of the oauthClient join finding no row.
    db.oauthClient.findMany.mockResolvedValue([
      { id: "record-pat", clientId: "pat:token-1", name: "Stray", uri: null },
      { id: "record-a", clientId: "client-a", name: null, uri: null },
    ]);
    db.oauthConsent.findMany.mockResolvedValue([]);
    db.oauthRefreshToken.findMany.mockResolvedValue([]);

    const result = await client().listMine();

    const clientWhere = db.oauthClient.findMany.mock.calls[0]?.[0] as {
      where?: { clientId?: { in?: string[] } };
    };
    expect(clientWhere.where?.clientId?.in).toEqual(["client-a"]);
    expect(result.map((connection) => connection.clientId)).toEqual(["client-a"]);
  });

  it("runs reads OUTSIDE the durable-cleanup permit (no transaction, no permit)", async () => {
    db.mcpGrant.findMany.mockResolvedValue([]);
    await client().listMine();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(permitState.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// revokeMine
// ---------------------------------------------------------------------------

function mockRevokeReads(
  fixtures: {
    client?: { id: string; clientId: string; name: string | null; uri: string | null } | null;
    ownedGrants?: { referenceId: string | null }[];
    txGrants?: { referenceId: string | null }[];
    consents?: { referenceId: string | null }[];
    refreshes?: { referenceId: string | null }[];
    accesses?: { referenceId: string | null }[];
    /** Successive Verification scan batches ({ id, value } rows), popped per query. */
    verificationBatches?: { id: string; value: string }[][];
  } = {},
) {
  db.oauthClient.findUnique.mockResolvedValue(
    fixtures.client === undefined
      ? { id: "record-a", clientId: "client-a", name: "Relay", uri: null }
      : fixtures.client,
  );
  // R100 finding 1 (mock-state leakage): `vi.clearAllMocks()` preserves
  // implementations and UNCONSUMED mockResolvedValueOnce results, so a
  // once-queue set here survived into later tests (the idempotency test
  // only passed by consuming ownership tests' leftovers and threw when run
  // standalone). A stateful implementation with no queue cannot leak: call
  // 1 is always the ownership read, every later call is a transaction read
  // (repeats and Serializable retries included).
  const ownedGrants = fixtures.ownedGrants ?? [{ referenceId: "ref-a1" }];
  const txGrants = fixtures.txGrants ?? [{ referenceId: "ref-a1" }];
  let grantReadIndex = 0;
  db.mcpGrant.findMany.mockImplementation(async () => {
    grantReadIndex += 1;
    return grantReadIndex === 1 ? ownedGrants : txGrants;
  });
  db.oauthConsent.findMany.mockResolvedValue(fixtures.consents ?? [{ referenceId: "ref-a1" }]);
  db.oauthRefreshToken.findMany.mockResolvedValue(
    fixtures.refreshes ?? [{ referenceId: "ref-a1" }],
  );
  db.oauthAccessToken.findMany.mockResolvedValue(fixtures.accesses ?? [{ referenceId: "ref-a1" }]);
  const batches = fixtures.verificationBatches ?? [[]];
  let batchIndex = 0;
  db.verification.findMany.mockImplementation(async () => {
    const batch = batches[Math.min(batchIndex, batches.length - 1)] ?? [];
    batchIndex += 1;
    return batch;
  });
}

/** A pending authorization-code Verification value as the installed provider writes it. */
function codeValue(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "authorization_code",
    query: { client_id: "client-a" },
    userId: "user-id",
    sessionId: "session-id",
    referenceId: "ref-pending-code",
    authTime: 1_750_000_000_000,
    resource: ["https://proxy.example.com/mcp"],
    ...overrides,
  });
}

/**
 * PostgreSQL LIKE semantics, as the installed Prisma compiles `contains`:
 * `value::text LIKE ('%' || $pattern || '%')` with the marker as a RAW
 * pattern parameter (probe-verified, .review-loop/r96-sql.probe.out.txt).
 * `%` matches any sequence, `_` any single character, `\` escapes the next
 * character; everything else (including JSON quotes) is literal.
 * Case-sensitive; anchored full-string when wrapped with surrounding `%`.
 *
 * R95/R96 finding 1 (mock gap): String.includes does NOT model LIKE
 * wildcard/escape semantics, so the previous DB-honoring mock passed
 * despite the production defect (a `\"` in a client marker made the real
 * SQL miss 5,040/5,040 stored key orders that includes matched). ALL
 * contains predicates in DB-honoring mocks go through this matcher.
 *
 * R98 finding 3 (mock fidelity): a pattern whose LAST character is a bare
 * escape (`\`) is a pattern syntax error — real PostgreSQL raises SQLSTATE
 * 22025, but only when the scan REACHES the dangling escape (probe-verified:
 * value "ab" / pattern "a\" and "x" / "%\" raise; value "x" / pattern "q\"
 * returns false because the first character mismatches). The mock mirrors
 * both outcomes. Production patterns can never end with a bare escape
 * (Prisma wraps the marker with `%…%` and the markers end with `"`), so
 * this cannot fire on today's guarded predicates; the behavior exists so
 * the mock cannot silently mask the error class if a future pattern shape
 * reaches it.
 */
const likePatternCache = new Map<string, RegExp>();

function likeMatches(value: string, pattern: string): boolean {
  const cached = likePatternCache.get(pattern);
  if (cached) return cached.test(value);

  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        // R100 finding 2 + R101 finding 2 (trailing-escape fidelity):
        // PostgreSQL evaluates left-to-right and raises SQLSTATE 22025
        // only when the scan actually REACHES the dangling escape with the
        // value NOT yet exhausted. If the value mismatches first ("x" /
        // "q\" → false) or is exhausted exactly at the escape ("a" / "a\",
        // "a" / "%a\", "" / "\" → false), no error is raised. The value
        // "reaches" the escape when it can match the accumulated prefix
        // with at least one character remaining.
        const reaches = new RegExp(`^(?:${source.slice(1)})[\\s\\S]`, "u").test(value);
        if (reaches) {
          throw Object.assign(new Error("LIKE pattern must not end with escape character"), {
            code: "22025",
          });
        }
        return false;
      }
      source += literal(next);
      i += 1;
    } else if (c === "%") {
      source += "[\\s\\S]*";
    } else if (c === "_") {
      source += "[\\s\\S]";
    } else {
      source += literal(c);
    }
  }
  const expression = new RegExp(`${source}$`, "u");
  likePatternCache.set(pattern, expression);
  return expression.test(value);
}

/** Prisma `contains` under real PostgreSQL: LIKE '%'+pattern+'%'. */
function containsMatches(value: string, pattern: string): boolean {
  return likeMatches(value, `%${pattern}%`);
}

/**
 * DB-honoring Verification scan mock: applies the query's contains
 * predicates with REAL PostgreSQL LIKE semantics (not String.includes),
 * plus cursor/skip/take pagination — mirroring the compiled SQL. Rows are
 * pre-sorted by id ascending, matching the query's orderBy.
 */
function mockVerificationScan(rows: { id: string; value: string }[]) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  db.verification.findMany.mockImplementation(
    async (args: {
      where?: { AND?: { value?: { contains?: string } }[] };
      cursor?: { id: string };
      skip?: number;
      take?: number;
    }) => {
      const patterns = (args.where?.AND ?? [])
        .map((cond) => cond.value?.contains)
        .filter((pattern): pattern is string => typeof pattern === "string");
      const relevant = sorted.filter((row) =>
        patterns.every((pattern) => containsMatches(row.value, pattern)),
      );
      const start = args.cursor
        ? relevant.findIndex((row) => row.id === args.cursor?.id) + (args.skip ?? 0)
        : 0;
      return relevant.slice(start, start + (args.take ?? relevant.length));
    },
  );
}

/** The referenceId set of the first mcpGrant.updateMany tombstone write. */
function grantUpdateManyReferenceIds(): string[] {
  const call = db.mcpGrant.updateMany.mock.calls[0]?.[0] as
    | { where: { referenceId: { in: string[] } } }
    | undefined;
  return call ? call.where.referenceId.in : [];
}

describe("mcpGrants.revokeMine", () => {
  it("tombstones every collected generation (existing ACTIVE rows via updateMany, missing via createMany) and revokes/deletes the right rows in ONE Serializable transaction with NO shutdown permit", async () => {
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [{ referenceId: "ref-a1" }, { referenceId: null }],
      refreshes: [{ referenceId: "ref-r" }],
      accesses: [{ referenceId: "ref-x" }],
      verificationBatches: [
        [
          // Pending code with a NEW generation reference.
          { id: "v1", value: codeValue() },
          // Wrong type (email verification) sharing the table — excluded by
          // the parse even if the DB type marker admitted it.
          {
            id: "v2",
            value: JSON.stringify({
              type: "email_verify",
              query: { client_id: "client-a" },
              userId: "user-id",
              referenceId: "ref-email",
            }),
          },
          // Wrong user — excluded.
          {
            id: "v3",
            value: codeValue({ userId: "someone-else", referenceId: "ref-other-user" }),
          },
          // Wrong client — excluded.
          {
            id: "v4",
            value: codeValue({ query: { client_id: "client-b" }, referenceId: "ref-other-client" }),
          },
        ],
      ],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 3 });
    db.oauthRefreshToken.updateMany.mockResolvedValue({ count: 2 });
    db.oauthConsent.deleteMany.mockResolvedValue({ count: 2 });
    db.oauthAccessToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    // ONE Serializable transaction — as ORDINARY FENCED work: revoke runs
    // with ZERO shutdown-permit calls (Q3; the permit is reserved for
    // teardown cleanup of already-owned durable work, and Serializable
    // rollback prevents any half-revoked terminal state).
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(transactionOptions).toEqual([{ isolationLevel: "Serializable" }]);
    expect(permitState.calls).toBe(0);

    // Q1 regression: the EXISTING ACTIVE generation (ref-a1) is tombstoned
    // by updateMany with a revokedAt-null predicate — this is the write the
    // live /mcp grant check depends on (apps/server/src/mcp/auth.ts
    // loadMcpGrant selects revokedAt and rejects when it is non-null, so an
    // untombstoned row keeps existing JWTs alive).
    expect(db.mcpGrant.updateMany).toHaveBeenCalledTimes(1);
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        clientId: "client-a",
        referenceId: {
          in: expect.arrayContaining(["ref-a1", "ref-r", "ref-x", "ref-pending-code"]),
        },
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn.sort()).toEqual(["ref-a1", "ref-pending-code", "ref-r", "ref-x"].sort());

    // Tombstones created ONLY for the MISSING generations (ref-a1 now comes
    // from updateMany, not createMany).
    expect(db.mcpGrant.createMany).toHaveBeenCalledTimes(1);
    expect(db.mcpGrant.createMany.mock.calls[0]?.[0]).toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({ referenceId: "ref-r", revokedAt: expect.any(Date) }),
        expect.objectContaining({ referenceId: "ref-x", revokedAt: expect.any(Date) }),
        expect.objectContaining({ referenceId: "ref-pending-code", revokedAt: expect.any(Date) }),
      ]),
      skipDuplicates: true,
    });
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as { referenceId: string }[];
    expect(created.map((row) => row.referenceId).sort()).toEqual(
      ["ref-pending-code", "ref-r", "ref-x"].sort(),
    );
    expect(db.mcpGrant.update).not.toHaveBeenCalled();
    expect(db.mcpGrant.deleteMany).not.toHaveBeenCalled();

    // Refresh rows are REVOKED, never deleted; consents deleted; access rows
    // revoked; the shared oauthClient cache row is preserved.
    const revokedAt = expect.any(Date);
    expect(db.oauthRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-id", clientId: "client-a", revoked: null },
      data: { revoked: revokedAt },
    });
    expect(db.oauthRefreshToken.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-id", clientId: "client-a" },
    });
    expect(db.oauthAccessToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-id", clientId: "client-a", revoked: null },
      data: { revoked: revokedAt },
    });
  });

  it("tombstones an EXISTING ACTIVE generation (Q1 regression: updateMany runs, revokedAt is set)", async () => {
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-active" }],
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        clientId: "client-a",
        referenceId: { in: ["ref-active"] },
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    // Nothing was missing: createMany never ran.
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
  });

  it("mixed generations: existing-active, existing-tombstoned, and missing all end tombstoned — a tombstone is NEVER cleared (Q1 regression)", async () => {
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-active" }, { referenceId: "ref-tombstoned" }],
      consents: [{ referenceId: "ref-tombstoned" }, { referenceId: "ref-missing" }],
      refreshes: [],
      accesses: [],
      verificationBatches: [],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    // updateMany predicate carries revokedAt: null — the already-tombstoned
    // row cannot be selected, so its tombstone can never be cleared; the
    // active row is flipped.
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        clientId: "client-a",
        referenceId: { in: ["ref-active", "ref-tombstoned", "ref-missing"] },
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    // Only the truly-missing generation is created (born tombstoned).
    expect(db.mcpGrant.createMany).toHaveBeenCalledTimes(1);
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as {
      referenceId: string;
      revokedAt: Date | null;
    }[];
    expect(created.map((row) => row.referenceId)).toEqual(["ref-missing"]);
    expect(created[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("post-revoke listMine hides the client (reviewers' probe: revoke then list)", async () => {
    // First call: revoke with an active generation; second findMany (the
    // in-transaction re-read) sees the same row. Both return ref-a1.
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });
    expect(db.mcpGrant.updateMany).toHaveBeenCalledTimes(1);

    // Post-revoke state: every generation tombstoned — listMine hides the
    // client entirely (active-client set is built from revokedAt === null).
    db.mcpGrant.findMany.mockResolvedValue([
      { clientId: "client-a", referenceId: "ref-a1", revokedAt: new Date(), createdAt },
    ]);
    await expect(client().listMine()).resolves.toEqual([]);
    // listMine returned early: no client lookup for the list (revoke used
    // findUnique; findMany is listMine-only and never ran).
    expect(db.oauthClient.findMany).not.toHaveBeenCalled();
  });

  it("scans Verification candidates in BATCHES over the PER-KEY relevant set: unexpired + type+user+client marker rows (Q2)", async () => {
    mockRevokeReads({ verificationBatches: [[]] });
    await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });
    const call = db.verification.findMany.mock.calls[0]?.[0] as {
      where?: {
        expiresAt?: { gt?: Date };
        AND?: { value?: { contains?: string } }[];
      };
      take?: number;
      orderBy?: unknown;
      cursor?: unknown;
      skip?: unknown;
    };
    // Expired rows excluded (strict gt — a code expiring exactly now is gone,
    // codes live <= 600 s by default).
    expect(call.where?.expiresAt?.gt).toBeInstanceOf(Date);
    expect(call.where?.expiresAt?.gt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    // PER-KEY DB relevance filter: ONE `contains` per marker, combined with
    // AND — only rows that look like THIS user's authorization codes enter
    // the candidate set (String column — JSON path filters are unavailable,
    // per-key `contains` is the strongest filter). There is deliberately NO
    // client marker (R95/R96 finding 1): Prisma compiles contains to a raw
    // PostgreSQL LIKE pattern, and a client id containing `"`, `\`, or a
    // control character JSON-escapes into a marker whose backslash makes
    // the LIKE silently unmatchable (0/5,040 stored key orders). Client
    // discrimination is the post-parse exact equality instead.
    const markers = authorizationCodeVerificationMarkers("user-id");
    expect(call.where?.AND).toEqual([
      { value: { contains: markers.typeMarker } },
      { value: { contains: markers.userMarker } },
    ]);
    expect(call.take).toBe(VERIFICATION_CANDIDATE_BATCH);
    expect(call.orderBy).toEqual({ id: "asc" }); // stable unique cursor key
    expect(call.cursor).toBeUndefined(); // first batch: no cursor
    expect(call.skip).toBeUndefined();
  });

  it("cursor-paginates: the second batch carries cursor+skip, the scan stops at a short batch", async () => {
    mockRevokeReads({
      verificationBatches: [
        Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
          id: `v${i}`,
          // Relevant rows for OTHER users — admitted by the type marker,
          // excluded by the parse.
          value: codeValue({ userId: "someone-else", referenceId: `ref-foreign-${i}` }),
        })),
        [{ id: "v-last", value: codeValue() }], // short second batch → stop
      ],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });

    expect(db.verification.findMany).toHaveBeenCalledTimes(2);
    const second = db.verification.findMany.mock.calls[1]?.[0] as {
      cursor?: { id?: string };
      skip?: number;
    };
    expect(second.cursor?.id).toBe(`v${VERIFICATION_CANDIDATE_BATCH - 1}`);
    expect(second.skip).toBe(1);
    // The displaced-but-relevant code WAS collected: its generation is
    // tombstoned via updateMany membership + created as missing.
    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-pending-code");
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as { referenceId: string }[];
    expect(created.map((row) => row.referenceId)).toContain("ref-pending-code");
  });

  it("DISPLACEMENT regression (reviewers' counterexample): a matching code beyond the old global window is still collected", async () => {
    // The take bound applies to the RELEVANT set (type-marked, unexpired).
    // A full first batch of relevant-but-foreign rows can no longer push
    // the user's code out of the window: the scan continues by cursor.
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [
        Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
          id: `later-${i}`,
          value: codeValue({ userId: "someone-else", referenceId: `ref-not-ours-${i}` }),
        })),
        [{ id: "the-code", value: codeValue({ referenceId: "ref-displaced-code" }) }],
      ],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });

    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-displaced-code");
  });

  it("collects MORE matching codes than one batch size, up to the total cap", async () => {
    const total = VERIFICATION_CANDIDATE_BATCH + 50;
    mockRevokeReads({
      verificationBatches: [
        Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
          id: `c${i}`,
          value: codeValue({ referenceId: `ref-code-${i}` }),
        })),
        Array.from({ length: 50 }, (_, i) => ({
          id: `c${VERIFICATION_CANDIDATE_BATCH + i}`,
          value: codeValue({ referenceId: `ref-code-${VERIFICATION_CANDIDATE_BATCH + i}` }),
        })),
      ],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: total });
    db.mcpGrant.createMany.mockResolvedValue({ count: total });

    await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });

    expect(db.verification.findMany).toHaveBeenCalledTimes(2);
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as { referenceId: string }[];
    expect(created).toHaveLength(total);
    expect(created.map((row) => row.referenceId)).toContain(`ref-code-${total - 1}`);
  });

  it("FAILS CLOSED at the TOTAL CAP: >cap relevant rows → CONFLICT, bounded queries, NO partial writes", async () => {
    // Full batches of genuinely matching rows forever: the loop must
    // terminate at the cap AND the procedure must THROW — never return
    // success while relevant rows may remain unscanned.
    const fullBatch = Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
      id: `cap-${i}`,
      value: codeValue({ referenceId: "ref-over-cap" }),
    }));
    mockRevokeReads({ verificationBatches: [fullBatch] });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const maxQueries = Math.ceil(VERIFICATION_CANDIDATE_TOTAL_CAP / VERIFICATION_CANDIDATE_BATCH);
    expect(db.verification.findMany.mock.calls.length).toBeLessThanOrEqual(maxQueries);
    // No partial revoke escaped the rolled-back transaction.
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(db.oauthAccessToken.updateMany).not.toHaveBeenCalled();
  });

  it("GLOBAL DISPLACEMENT regression (R93 probe 1): 5,000 foreign codes cannot displace the one matching code", async () => {
    // A DB-side mock that HONORS the per-key marker filter with REAL
    // PostgreSQL LIKE semantics (mockVerificationScan), like the real
    // database: foreign-user rows are filtered out BEFORE the take bound.
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: String(i).padStart(6, "0"),
      value: codeValue({ userId: "foreign-user", referenceId: `foreign-${i}` }),
    }));
    rows.push({ id: "999999", value: codeValue({ referenceId: "missed-generation" }) });
    mockRevokeReads({ consents: [], refreshes: [], accesses: [] });
    mockVerificationScan(rows);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    // The single relevant row was found in the FIRST batch — no pagination.
    expect(db.verification.findMany).toHaveBeenCalledTimes(1);
    expect(grantUpdateManyReferenceIds()).toContain("missed-generation");
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as { referenceId: string }[];
    expect(created.map((row) => row.referenceId)).toContain("missed-generation");
  });

  // -------------------------------------------------------------------------
  // R95/R96 finding 1 regressions: PostgreSQL LIKE semantics of the DB
  // predicate (escape/wildcard characters in accepted client ids).
  // -------------------------------------------------------------------------

  it("R95/R96 regression: an ACCEPTED client id containing a QUOTE is collected and tombstoned (old client-marker LIKE matched 0/5,040 key orders)", async () => {
    // https://example.com/a"b.json passes the installed CIMD URL and
    // metadata validators (.review-loop/r95-marker-probe.out.txt). Its
    // stored value JSON-escapes the quote (\"), which used to make the
    // client-marker LIKE silently miss the row BEFORE inspection. With the
    // client marker dropped (discrimination is post-parse exact equality)
    // and a LIKE-honoring mock, the pending code IS collected.
    const clientId = 'https://example.com/a"b.json';
    mockRevokeReads({
      client: { id: "record-a", clientId, name: null, uri: null },
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
    });
    mockVerificationScan([
      {
        id: "v1",
        value: codeValue({ query: { client_id: clientId }, referenceId: "ref-quoted-code" }),
      },
    ]);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    expect(db.verification.findMany).toHaveBeenCalledTimes(1);
    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-quoted-code");
    const created = db.mcpGrant.createMany.mock.calls[0]?.[0].data as { referenceId: string }[];
    expect(created.map((row) => row.referenceId)).toContain("ref-quoted-code");
  });

  it("R95/R96 regression: an ACCEPTED newline-containing client id is collected and tombstoned", async () => {
    // https://example.com/a\nb.json also passes the installed validators
    // and JSON-escapes to \n — same silent-exclusion class under the old
    // client-marker LIKE.
    const clientId = "https://example.com/a\nb.json";
    mockRevokeReads({
      client: { id: "record-a", clientId, name: null, uri: null },
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
    });
    mockVerificationScan([
      {
        id: "v1",
        value: codeValue({ query: { client_id: clientId }, referenceId: "ref-newline-code" }),
      },
    ]);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    expect(grantUpdateManyReferenceIds()).toContain("ref-newline-code");
  });

  it("R95/R96 regression: the user's pending codes for OTHER clients (incl. %-/_-containing ids) are ADMITTED by the DB filter but post-parse EXCLUDED — never collected", async () => {
    // With no client marker in the DB predicate, ALL of this user's
    // pending codes enter the candidate set. Foreign-client rows (wildcard
    // ids included) are rejected by the exact post-parse client equality:
    // never collected, never tombstoned — and the revoke still succeeds
    // when the population is below the cap.
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
    });
    mockVerificationScan([
      {
        id: "v1",
        value: codeValue({
          query: { client_id: "https://example.com/a_b%20.json" },
          referenceId: "ref-foreign-wildcard",
        }),
      },
      {
        id: "v2",
        value: codeValue({ query: { client_id: "client-b" }, referenceId: "ref-plain-other" }),
      },
      { id: "v3", value: codeValue({ referenceId: "ref-own-code" }) },
    ]);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-own-code");
    expect(updateIn).not.toContain("ref-foreign-wildcard");
    expect(updateIn).not.toContain("ref-plain-other");
  });

  it("userMarker `_` (nanoid alphabet) can only OVER-match: wildcard-admitted foreign-user rows are post-parse excluded", async () => {
    // A session user id containing `_` (LIKE single-char wildcard): rows
    // of OTHER users whose ids differ only at that position are admitted
    // by the DB filter but rejected by the exact post-parse userId check.
    const underscoreClient = createRouterClient(mcpGrantsRouter, {
      context: buildContext({ id: "user_id" }),
    });
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
    });
    mockVerificationScan([
      { id: "v1", value: codeValue({ userId: "userXid", referenceId: "ref-overmatch-foreign" }) },
      { id: "v2", value: codeValue({ userId: "user_id", referenceId: "ref-overmatch-own" }) },
    ]);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      underscoreClient.revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });

    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-overmatch-own");
    expect(updateIn).not.toContain("ref-overmatch-foreign");
  });

  it("LIKE-wildcard over-match volume (user's other-client codes beyond the cap) → LOUD CONFLICT, no writes (R95/R96 regression d)", async () => {
    mockRevokeReads({ consents: [], refreshes: [], accesses: [] });
    mockVerificationScan(
      Array.from(
        { length: VERIFICATION_CANDIDATE_TOTAL_CAP + VERIFICATION_CANDIDATE_BATCH },
        (_, i) => ({
          id: String(i).padStart(7, "0"),
          value: codeValue({
            query: { client_id: `https://example.com/other-${i}.json` },
            referenceId: `ref-other-${i}`,
          }),
        }),
      ),
    );
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(db.oauthAccessToken.updateMany).not.toHaveBeenCalled();
  });

  it("fail-closed guard at the router: a session user id whose serialization escapes (quote, backslash, control chars, lone surrogate) throws CONFLICT BEFORE any scan, transaction, or write (R95/R96 regression e, R98 finding 1)", async () => {
    for (const unsafeId of ['u"ser', "u\\ser", "u\nser", "u\tser", "u\x00ser", "\uD800ser"]) {
      const unsafeClient = createRouterClient(mcpGrantsRouter, {
        context: buildContext({ id: unsafeId }),
      });
      await expect(
        unsafeClient.revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(db.oauthClient.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.verification.findMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
  });

  it("R98 regression: an admin-reachable newline user id with a pending code throws CONFLICT — NEVER {revoked:true} without tombstoning the missed generation", async () => {
    // R98 executed this end-to-end against the installed stack: the
    // Better Auth admin /admin/create-user endpoint accepts data.id, the
    // adapter (forceAllowId) and this repo's user-create hook preserve
    // supplied ids, so id "u\nser" reached the session. The old
    // character-list guard passed it; the JSON-escaped user marker made
    // the LIKE predicate a false negative; the router returned
    // {revoked:true} WITHOUT tombstoning the missed pending generation
    // (.review-loop/r98-router-probe.test.ts.txt). The serialization-
    // equivalence guard must fail LOUDLY before any database work.
    const newlineClient = createRouterClient(mcpGrantsRouter, {
      context: buildContext({ id: "u\nser" }),
    });
    // A pending code for this user EXISTS in the store — the revoke must
    // still throw rather than silently miss it under a broken predicate.
    // Mocks are set with plain mockResolvedValue (NOT the Once-queueing
    // mockRevokeReads helper): the guard must throw before ANY database
    // call, so Once values would leak into later tests (clearAllMocks does
    // not drain the once queue).
    db.oauthClient.findUnique.mockResolvedValue({
      id: "record-a",
      clientId: "client-a",
      name: "Relay",
      uri: null,
    });
    db.mcpGrant.findMany.mockResolvedValue([{ referenceId: "ref-a1" }]);
    db.verification.findMany.mockResolvedValue([
      {
        id: "v1",
        value: codeValue({ userId: "u\nser", referenceId: "missed-pending-generation" }),
      },
    ]);
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      newlineClient.revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Loud, not silent: zero database calls of any kind (guard fires
    // before client lookup, transaction, scan, and every write).
    expect(db.oauthClient.findUnique).not.toHaveBeenCalled();
    expect(db.mcpGrant.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.verification.findMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).not.toHaveBeenCalled();
    expect(db.oauthRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(db.oauthAccessToken.updateMany).not.toHaveBeenCalled();
  });

  it("OVERSIZED matching value → THROWS, never a silent skip (R93 probe 2, fail-closed)", async () => {
    const value = codeValue({
      referenceId: "oversized-generation",
      query: { client_id: "client-a", state: "x".repeat(VERIFICATION_VALUE_MAX_LENGTH) },
    });
    expect(value.length).toBeGreaterThan(VERIFICATION_VALUE_MAX_LENGTH);
    mockRevokeReads({
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [[{ id: "only-code", value }]],
    });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // No success, no partial tombstone claims.
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).not.toHaveBeenCalled();
  });

  it("UNPARSEABLE marker-matching value → THROWS (fail-closed: cannot prove it is not ours)", async () => {
    const markers = authorizationCodeVerificationMarkers("user-id");
    // Carries both markers as substrings but is not valid JSON.
    const value = `not json ${markers.typeMarker} ${markers.userMarker}`;
    mockRevokeReads({
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [[{ id: "v-bad", value }]],
    });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("CRAFTED false-positive rows (markers embedded in junk, foreign top level): rejected by post-parse validation, never collected", async () => {
    // Rows that pass the DB substring filter because the markers appear as
    // literal (nested) JSON tokens, but whose TOP-LEVEL validated fields
    // identify a different type/user/client — the parse must EXCLUDE them
    // (never collect their reference). Under the installed writer such
    // rows cannot exist (markers inside strings are stored escaped), so
    // this is pure defense-in-depth for a future writer.
    const falsePositive = (i: number) =>
      JSON.stringify({
        type: "email_verify",
        userId: "foreign-user",
        junk: {
          nested: "x",
          type: "authorization_code",
          userId: "user-id",
          query: { client_id: "client-a" },
        },
        referenceId: `ref-crafted-${i}`,
      });
    mockRevokeReads({
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [
        Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
          id: `crafted-${i}`,
          value: falsePositive(i),
        })),
        // Short second batch with the real matching code.
        [{ id: "real-code", value: codeValue({ referenceId: "ref-real" }) }],
      ],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 1 });

    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).resolves.toEqual({ revoked: true });
    const updateIn = grantUpdateManyReferenceIds();
    expect(updateIn).toContain("ref-real");
    expect(updateIn.some((referenceId) => referenceId.startsWith("ref-crafted-"))).toBe(false);
  });

  it("CRAFTED false-positive rows at cap volume → THROWS, not silent success", async () => {
    // Endless full batches of marker-matching-but-foreign rows: budget
    // exhaustion must surface as a LOUD failure, never a silent success.
    const falsePositive = (i: number) =>
      JSON.stringify({
        type: "email_verify",
        userId: "foreign-user",
        junk: {
          nested: "x",
          type: "authorization_code",
          userId: "user-id",
          query: { client_id: "client-a" },
        },
        referenceId: `ref-crafted-${i}`,
      });
    const fullBatch = Array.from({ length: VERIFICATION_CANDIDATE_BATCH }, (_, i) => ({
      id: `crafted-cap-${i}`,
      value: falsePositive(i),
    }));
    mockRevokeReads({
      consents: [],
      refreshes: [],
      accesses: [],
      verificationBatches: [fullBatch],
    });
    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });

  it("hides foreign connections: no grant rows for this user → NOT_FOUND, no mutation", async () => {
    mockRevokeReads({ ownedGrants: [] });
    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.oauthConsent.deleteMany).not.toHaveBeenCalled();
  });

  it("hides missing client records → NOT_FOUND (same error as foreign)", async () => {
    mockRevokeReads({ client: null });
    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("is idempotent: a repeat call returns the same result with no double effects", async () => {
    mockRevokeReads({
      txGrants: [{ referenceId: "ref-a1" }],
      consents: [],
      refreshes: [],
      accesses: [],
    });
    db.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    db.mcpGrant.createMany.mockResolvedValue({ count: 0 });
    db.oauthRefreshToken.updateMany.mockResolvedValue({ count: 0 });
    db.oauthConsent.deleteMany.mockResolvedValue({ count: 0 });
    db.oauthAccessToken.updateMany.mockResolvedValue({ count: 0 });

    const first = await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });
    const second = await client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });

    expect(first).toEqual({ revoked: true });
    expect(second).toEqual({ revoked: true });
    // Second pass: nothing to create (all generations already recorded),
    // nothing to tombstone (all rows already carry revokedAt), and every
    // bounded update/delete matched zero rows.
    expect(db.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(db.mcpGrant.updateMany).toHaveBeenCalledTimes(2);
    expect(db.oauthConsent.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.oauthRefreshToken.updateMany).toHaveBeenCalledTimes(2);
    expect(db.oauthAccessToken.updateMany).toHaveBeenCalledTimes(2);
  });

  it("rejects the wrong confirmation literal at the schema boundary", async () => {
    await expect(
      client().revokeMine({ clientRecordId: "record-a", confirm: "DELETE" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it("retries the Serializable transaction on a write conflict and succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      mockRevokeReads({
        txGrants: [{ referenceId: "ref-a1" }],
        consents: [],
        refreshes: [],
        accesses: [],
      });
      db.mcpGrant.createMany.mockResolvedValue({ count: 0 });
      const conflict = Object.assign(new Error("serialization failure"), { code: "P2034" });
      let attempts = 0;
      db.$transaction.mockImplementation(async (work: unknown, options?: unknown) => {
        attempts += 1;
        transactionOptions.push(options);
        if (attempts === 1) throw conflict;
        return (work as (tx: unknown) => Promise<unknown>)(prisma);
      });

      const promise = client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });
      // Drain the retry backoff timers.
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toEqual({ revoked: true });
      expect(attempts).toBe(2);
      expect(transactionOptions).toEqual([
        { isolationLevel: "Serializable" },
        { isolationLevel: "Serializable" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps an exhausted retry budget to a stable conflict error, never a raw driver error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      mockRevokeReads();
      const conflict = Object.assign(new Error("serialization failure"), { code: "P2034" });
      db.$transaction.mockRejectedValue(conflict);

      const promise = client().revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" });
      const assertion = expect(promise).rejects.toMatchObject({ code: "CONFLICT" });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unauthenticated sessions (protected procedure)", async () => {
    const anonymous = createRouterClient(mcpGrantsRouter, { context: { session: null } });
    await expect(anonymous.listMine()).rejects.toBeInstanceOf(ORPCError);
    await expect(
      anonymous.revokeMine({ clientRecordId: "record-a", confirm: "REVOKE" }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(db.mcpGrant.findMany).not.toHaveBeenCalled();
  });
});
