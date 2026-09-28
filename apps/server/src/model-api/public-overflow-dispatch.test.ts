import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRequesterValidityQuery } from "./external-consent.test-helper.js";

const providerHttpsRequest = vi.hoisted(() => vi.fn());
const recordProviderOutcome = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const heartbeatProviderAttempt = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const releaseProviderHealthTrial = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const reconcileProviderBudget = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
/** Current caller-side consent state re-read at dispatch (token and grant). */
const consentState = vi.hoisted(() => ({
  token: null as null | Record<string, unknown>,
  allowlistEntry: null as null | Record<string, unknown>,
  grant: null as null | Record<string, unknown>,
  account: null as null | Record<string, unknown>,
}));
function resetConsentState() {
  consentState.token = {
    userId: "owner",
    scopeMode: "ALL_VISIBLE",
    allowExternal: true,
    revokedAt: null,
    expiresAt: null,
  };
  consentState.allowlistEntry = null;
  consentState.grant = null;
  consentState.account = { banned: false, banExpires: null, deletionRequestedAt: null };
}
const db = vi.hoisted(() => ({
  modelApiToken: { findUnique: vi.fn(async () => consentState.token) },
  modelApiTokenAllowlistEntry: { findUnique: vi.fn(async () => consentState.allowlistEntry) },
  poolGrant: { findUnique: vi.fn(async () => consentState.grant) },
  user: { findUnique: vi.fn(async () => consentState.account) },
  modelPool: { findFirst: vi.fn() },
  poolFallbackPreference: { findFirst: vi.fn() },
  providerAttempt: { groupBy: vi.fn().mockResolvedValue([]) },
  providerPricingVersion: { findFirst: vi.fn() },
  cacheAffinityRecord: { findMany: vi.fn().mockResolvedValue([]) },
  capacityLease: { groupBy: vi.fn().mockResolvedValue([]) },
  capacityWaiter: { groupBy: vi.fn().mockResolvedValue([]) },
  relayRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

const MockDecimal = vi.hoisted(
  () =>
    class MockDecimal {
      value: number;
      constructor(value: string | number | { toString(): string }) {
        this.value = Number(value.toString());
      }
      isFinite() {
        return Number.isFinite(this.value);
      }
      isNegative() {
        return this.value < 0;
      }
      mul(value: string | number | { toString(): string }) {
        return new MockDecimal(this.value * Number(value.toString()));
      }
      plus(value: string | number | { toString(): string }) {
        return new MockDecimal(this.value + Number(value.toString()));
      }
      div(value: string | number | { toString(): string }) {
        return new MockDecimal(this.value / Number(value.toString()));
      }
      toString() {
        return String(this.value);
      }
    },
);

vi.mock("@ws-model-proxy/db", () => ({ default: db, Prisma: { Decimal: MockDecimal } }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-bytes",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 7).toString("base64")}`,
  },
}));
vi.mock("@ws-model-proxy/api/lib/provider-credential-crypto", () => ({
  parseProviderCredentialKeyring: vi.fn(() => ({ active: {}, keys: new Map() })),
  decryptProviderCredential: vi.fn(() => "secret"),
}));
vi.mock("@ws-model-proxy/api/lib/provider-egress", () => ({ providerHttpsRequest }));
vi.mock("./provider-budget.js", () => ({
  admitProviderBudget: vi.fn().mockResolvedValue({
    admitted: true,
    providerAttemptId: "anchor",
    reservationIds: ["reservation"],
  }),
  reconcileProviderBudget,
}));
const rememberAffinity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./cache-affinity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache-affinity.js")>();
  return { ...actual, rememberAffinity };
});
vi.mock("./provider-attempt-runtime.js", () => ({
  allocateProviderFence: vi.fn().mockResolvedValue(1n),
  claimProviderHealthTrial: vi.fn().mockResolvedValue("READY"),
  classifyProviderFailure: vi.fn((status?: number) => (status === 429 ? "RATE_LIMIT" : "SERVER")),
  heartbeatProviderAttempt,
  parseRetryAfter: vi.fn((value?: string) => (value === "37" ? 37_000 : undefined)),
  recordProviderAttemptEvent: vi.fn().mockResolvedValue(undefined),
  recordProviderOutcome,
  releaseProviderHealthTrial,
}));

import { type ExternalEgressConsent, evaluateExternalEgress } from "./external-route.js";
import { claimProviderHealthTrial } from "./provider-attempt-runtime.js";
import { admitProviderBudget } from "./provider-budget.js";
import {
  dispatchPublicOverflow,
  listPublicOverflowTargets,
  matchesChatTestProviderMode,
  orderChatTestProviderTargets,
  providerResponseHeaders,
  rankPublicOverflowTargets,
  targetsForForcedPoolMember,
} from "./public-overflow.js";

beforeEach(() => {
  resetConsentState();
  db.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) =>
    mockRequesterValidityQuery(strings, values, consentDelegates()),
  );
});

/**
 * The consent rows the E0 send-claim transaction locks and re-reads: the same
 * current state the dispatch-entry check reads (pool fixture, token, grant).
 */
function consentDelegates() {
  return {
    modelPool: db.modelPool,
    poolGrant: db.poolGrant,
    modelApiToken: db.modelApiToken,
    modelApiTokenAllowlistEntry: db.modelApiTokenAllowlistEntry,
    user: db.user,
  };
}

/** The consent plus the request identity it is bound to. */
function ownerConsentFields(requesterUserId = "owner") {
  const externalConsent = ownerConsent(requesterUserId);
  return {
    externalConsent,
    requesterUserId: externalConsent.requesterUserId,
    requesterModelApiTokenId: externalConsent.modelApiTokenId,
  };
}

/** Caller consent minted by the egress gate for the pool owner's own request. */
function ownerConsent(requesterUserId = "owner"): ExternalEgressConsent {
  const decision = evaluateExternalEgress({
    requested: true,
    requester: { userId: requesterUserId, source: "API_TOKEN", modelApiTokenId: "token" },
    tokenPermitsPool: true,
    pool: {
      id: "pool",
      ownerUserId: "owner",
      accessGrantId: requesterUserId === "owner" ? null : GRANT_ID,
      fallbackEnabled: true,
      fallbackForGrantees: true,
    },
  });
  if (!decision.granted) throw new Error("expected an issued consent");
  return decision.consent;
}

/** The grant a grantee's request (and its stored-response binding) was resolved under. */
const GRANT_ID = "grant";
const currentGrant = () => ({ id: GRANT_ID, ownerUserId: "owner" });

describe("opaque native provider response headers", () => {
  it.each(["application/json", "text/event-stream"])(
    "preserves validated compression for native %s wire bytes",
    (contentType) => {
      const headers = providerResponseHeaders(
        {
          "content-type": contentType,
          "content-encoding": "gzip",
          "content-length": "123",
          authorization: "secret",
        },
        true,
      );
      expect(headers.get("content-type")).toBe(contentType);
      expect(headers.get("content-encoding")).toBe("gzip");
      expect(headers.get("content-length")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    },
  );

  it("strips encoding from adapted bodies and rejects unrecognized encodings", () => {
    expect(
      providerResponseHeaders({ "content-encoding": "gzip" }, false).get("content-encoding"),
    ).toBeNull();
    expect(
      providerResponseHeaders({ "content-encoding": "unsafe-extension" }, true).get(
        "content-encoding",
      ),
    ).toBeNull();
  });

  it.each([undefined, "text/html", "application/octet-stream"])(
    "does not preserve compression for non-JSON/SSE content type %s",
    (contentType) => {
      const headers = providerResponseHeaders(
        {
          ...(contentType ? { "content-type": contentType } : {}),
          "content-encoding": "gzip",
        },
        true,
      );
      expect(headers.get("content-encoding")).toBeNull();
    },
  );
});

it("applies explicit native and adapted Chat Test modes to provider targets", () => {
  const target = { nativeSurfaces: ["openai-chat"] as const };
  expect(matchesChatTestProviderMode(target, "openai-chat", "REQUIRE_NATIVE")).toBe(true);
  expect(matchesChatTestProviderMode(target, "openai-responses", "REQUIRE_NATIVE")).toBe(false);
  expect(matchesChatTestProviderMode(target, "openai-responses", "REQUIRE_ADAPTED")).toBe(true);
  expect(matchesChatTestProviderMode(target, "openai-chat", "REQUIRE_ADAPTED")).toBe(false);
  expect(
    matchesChatTestProviderMode(
      { nativeSurfaces: ["openai-responses", "openai-chat"] },
      "openai-responses",
      "REQUIRE_ADAPTED",
    ),
  ).toBe(true);
  expect(
    matchesChatTestProviderMode(
      { nativeSurfaces: ["openai-responses"] },
      "openai-responses",
      "REQUIRE_ADAPTED",
    ),
  ).toBe(false);
});

it("constrains a member probe to the selected public-overflow member", () => {
  const targets = [{ poolMemberId: "provider-a" }, { poolMemberId: "provider-b" }];
  expect(targetsForForcedPoolMember(targets, "provider-b")).toEqual([
    { poolMemberId: "provider-b" },
  ]);
  expect(targetsForForcedPoolMember(targets, undefined)).toEqual(targets);
});

it("keeps provider ranking stable within native-first Chat Test classes", () => {
  const adaptedFirst = { id: "adapted", nativeSurfaces: ["openai-chat"] as const };
  const nativeSecond = { id: "native", nativeSurfaces: ["openai-responses"] as const };
  expect(
    orderChatTestProviderTargets(
      [adaptedFirst, nativeSecond],
      "openai-responses",
      "PREFER_NATIVE",
    ).map((target) => target.id),
  ).toEqual(["native", "adapted"]);
});

function dispatchPoolFixture(
  protocol = "openai",
  surface = "openai-chat",
  providerType = "openai",
) {
  return {
    fallbackEnabled: true,
    fallbackForGrantees: false,
    PoolMembers: [
      {
        id: "member-heartbeat",
        publicOrder: 0,
        ExecutionTarget: {
          id: "target-heartbeat",
          ProviderModel: {
            id: "model-heartbeat",
            userId: "owner",
            upstreamModelId: "upstream-model",
            contextWindow: 10_000,
            maxOutputTokens: 1_000,
            nativeCapabilities: {
              protocols: [protocol],
              surfaces: [surface],
              streaming: true,
              features: [],
            },
            healthStatus: "UNAVAILABLE",
            healthNextRetryAt: new Date(0),
            enabled: true,
            deletedAt: null,
            ProviderAccount: {
              id: "account-heartbeat",
              userId: "owner",
              providerType,
              providerVersion: null,
              baseUrl: "https://provider.example",
              authType: "BEARER",
              healthStatus: "UNAVAILABLE",
              healthNextRetryAt: new Date(0),
              enabled: true,
              deletedAt: null,
              CurrentCredential: {
                id: "credential-heartbeat",
                credentialType: "BEARER",
                aadVersion: 1,
                algorithm: "AES-256-GCM",
                keyVersion: "v1",
                ciphertext: new Uint8Array(),
                nonce: new Uint8Array(),
                authTag: new Uint8Array(),
                status: "ACTIVE",
              },
            },
          },
        },
      },
    ],
  };
}

it("excludes protocol-mismatched legacy inventories before egress", async () => {
  const fixture = dispatchPoolFixture();
  const model = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
  model.ProviderAccount.providerType = "anthropic";
  Object.assign(model, {
    nativeCapabilities: {
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: {
          source: "provider",
          confidence: "exact",
          supported: true,
        },
      },
    },
  });
  db.modelPool.findFirst.mockResolvedValue(fixture);
  const listed = await listPublicOverflowTargets("owner", "pool");
  expect(listed.targets).toEqual([]);
  model.ProviderAccount.providerType = "unknown-provider";
  const unknown = await listPublicOverflowTargets("owner", "pool");
  expect(unknown.targets).toEqual([]);
  expect(providerHttpsRequest).not.toHaveBeenCalled();
});

it("lists only external fallback members with the owner's current fallback flags", async () => {
  db.modelPool.findFirst.mockResolvedValue({ ...dispatchPoolFixture(), fallbackForGrantees: true });
  const listed = await listPublicOverflowTargets("owner", "pool");
  expect(listed).toMatchObject({ enabled: true, fallbackForGrantees: true });
  expect(listed.targets[0]).toMatchObject({ contextWindow: 10_000, publicOrder: 0 });
  expect(db.modelPool.findFirst).toHaveBeenLastCalledWith(
    expect.objectContaining({
      select: expect.objectContaining({
        PoolMembers: expect.objectContaining({
          where: expect.objectContaining({ tier: "PUBLIC_OVERFLOW" }),
        }),
      }),
    }),
  );
});

it.each([
  ["provider model", "model"],
  ["provider account", "account"],
] as const)(
  "reports a compatible member whose %s is cooling down as unhealthy, not incompatible",
  async (_label, cooling) => {
    providerHttpsRequest.mockReset();
    const fixture = dispatchPoolFixture();
    const model = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
    const until = new Date(Date.now() + 60_000);
    if (cooling === "model") model.healthNextRetryAt = until;
    else model.ProviderAccount.healthNextRetryAt = until;
    db.modelPool.findFirst.mockResolvedValue(fixture);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed.targets).toEqual([]);
    expect(listed.coolingDown.map((target) => target.poolMemberId)).toEqual(["member-heartbeat"]);
    const request = {
      userId: "owner",
      poolId: "pool",
      requestId: "cooldown",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
      ...ownerConsentFields(),
      requestedProtocol: "openai" as const,
      requestedSurface: "openai-chat" as const,
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode('{"model":"pool","messages":[]}'),
      signal: new AbortController().signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    };
    await expect(dispatchPublicOverflow(request)).resolves.toEqual({
      dispatched: false,
      reason: "PROVIDER_UNHEALTHY",
    });
    // An incompatible request stays incompatible even while the member cools down.
    await expect(
      dispatchPublicOverflow({
        ...request,
        requestedProtocol: "anthropic",
        requestedSurface: "anthropic-messages",
        path: "/v1/messages",
      }),
    ).resolves.toEqual({ dispatched: false, reason: "NO_COMPATIBLE_PROVIDER" });
    expect(request.releaseLocalCapacity).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  },
);

describe("owner consent is re-read at dispatch", () => {
  const baseRequest = (externalConsent: ExternalEgressConsent) => ({
    userId: "owner",
    poolId: "pool",
    requestId: "request-owner-consent",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
    externalConsent,
    requesterUserId: externalConsent.requesterUserId,
    requesterModelApiTokenId: externalConsent.modelApiTokenId,
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-chat" as const,
    stream: false,
    requiredFeatures: [],
    path: "/v1/chat/completions",
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode('{"model":"pool","messages":[]}'),
    signal: new AbortController().signal,
    liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
    releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
    adaptationEnabled: false,
    retrySafe: false,
  });

  it("refuses when the owner turned fallback off after the consent was issued", async () => {
    providerHttpsRequest.mockClear();
    db.modelPool.findFirst.mockResolvedValue({ ...dispatchPoolFixture(), fallbackEnabled: false });
    const request = baseRequest(ownerConsent());
    await expect(dispatchPublicOverflow(request)).resolves.toEqual({
      dispatched: false,
      reason: "POOL_PRIVATE",
    });
    expect(request.releaseLocalCapacity).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  });

  // E0-TOCTOU: the caller-side consent is re-read at dispatch, not trusted
  // from the authentication-time snapshot.
  const expectRefused = async (
    request: ReturnType<typeof baseRequest>,
    reason: string,
  ): Promise<void> => {
    providerHttpsRequest.mockClear();
    // The owner's own flags still allow it (fallback on, pays for grantees).
    db.modelPool.findFirst.mockResolvedValue({
      ...dispatchPoolFixture(),
      fallbackEnabled: true,
      fallbackForGrantees: true,
    });
    await expect(dispatchPublicOverflow(request)).resolves.toEqual({
      dispatched: false,
      reason,
    });
    // No credential decrypt and no bytes sent: local capacity is never even
    // released for the provider attempt.
    expect(request.releaseLocalCapacity).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  };

  it("refuses when the token's allowExternal was turned off after authentication", async () => {
    consentState.token = { ...consentState.token, allowExternal: false };
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
  });

  it("refuses when the token was revoked or expired after authentication", async () => {
    consentState.token = { ...consentState.token, revokedAt: new Date() };
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
    resetConsentState();
    consentState.token = { ...consentState.token, expiresAt: new Date(Date.now() - 1_000) };
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
    resetConsentState();
    consentState.token = null;
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
  });

  it("refuses when an ALLOWLIST token's includeExternal was cleared for the pool", async () => {
    consentState.token = { ...consentState.token, scopeMode: "ALLOWLIST" };
    consentState.allowlistEntry = { target: "MODEL_POOL", includeExternal: false };
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
    // Removing the pool from the allowlist withdraws consent too.
    consentState.allowlistEntry = null;
    await expectRefused(baseRequest(ownerConsent()), "CALLER_CONSENT_WITHDRAWN");
    expect(db.modelApiTokenAllowlistEntry.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          modelApiTokenId_modelPoolId: { modelApiTokenId: "token", modelPoolId: "pool" },
        },
      }),
    );
  });

  it("refuses an API-token grantee whose grant was revoked after authentication", async () => {
    consentState.token = { ...consentState.token, userId: "grantee" };
    consentState.grant = null;
    await expectRefused(baseRequest(ownerConsent("grantee")), "REQUESTER_NOT_VISIBLE");
    expect(db.poolGrant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { poolId_granteeUserId: { poolId: "pool", granteeUserId: "grantee" } },
      }),
    );
  });

  it("refuses a Chat Test grantee whose grant was revoked after authentication", async () => {
    const decision = evaluateExternalEgress({
      requested: true,
      requester: { userId: "grantee", source: "CHAT_TEST", modelApiTokenId: null },
      tokenPermitsPool: false,
      pool: {
        id: "pool",
        ownerUserId: "owner",
        accessGrantId: GRANT_ID,
        fallbackEnabled: true,
        fallbackForGrantees: true,
      },
    });
    if (!decision.granted) throw new Error("expected an issued consent");
    consentState.grant = null;
    await expectRefused(baseRequest(decision.consent), "REQUESTER_NOT_VISIBLE");
    // With the grant still in place the same Chat Test consent passes the
    // caller-side re-check (no token is read for a session).
    db.modelApiToken.findUnique.mockClear();
    consentState.grant = currentGrant();
    providerHttpsRequest.mockClear();
    db.modelPool.findFirst.mockResolvedValue({ ...dispatchPoolFixture(), fallbackEnabled: false });
    await expect(dispatchPublicOverflow(baseRequest(decision.consent))).resolves.toEqual({
      dispatched: false,
      reason: "POOL_PRIVATE",
    });
    expect(db.modelApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a consent that belongs to another requester or token", async () => {
    await expectRefused(
      { ...baseRequest(ownerConsent()), requesterUserId: "someone-else" },
      "CALLER_CONSENT_MISSING",
    );
    await expectRefused(
      { ...baseRequest(ownerConsent()), requesterModelApiTokenId: "other-token" },
      "CALLER_CONSENT_MISSING",
    );
    await expectRefused(
      { ...baseRequest(ownerConsent()), requesterModelApiTokenId: null },
      "CALLER_CONSENT_MISSING",
    );
  });

  it("refuses a grantee when the owner stopped paying for grantees", async () => {
    providerHttpsRequest.mockClear();
    consentState.token = { ...consentState.token, userId: "grantee" };
    consentState.grant = currentGrant();
    db.modelPool.findFirst.mockResolvedValue({
      ...dispatchPoolFixture(),
      fallbackForGrantees: false,
    });
    const request = baseRequest(ownerConsent("grantee"));
    await expect(dispatchPublicOverflow(request)).resolves.toEqual({
      dispatched: false,
      reason: "GRANTEE_NOT_COVERED",
    });
    expect(request.releaseLocalCapacity).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    // Losing the exact grant is permanent even alongside these flags.
    consentState.grant = null;
    consentState.token = { ...consentState.token, allowExternal: false };
    await expect(dispatchPublicOverflow(request)).resolves.toEqual({
      dispatched: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
  });
});

// E0 send boundary (R1): consent withdrawn after the dispatch-entry re-read
// and before the send claim (here: while budget admission is pending, which
// can wait on an advisory lock) must still prevent the send. The send-claim
// transaction re-validates every condition under FOR SHARE row locks.
describe("consent withdrawn between the dispatch-entry read and the send claim", () => {
  type Withdrawal = {
    requester: "owner" | "grantee";
    /** A signed-in Chat Test session instead of an API token. */
    chatTest?: boolean;
    allowlist?: boolean;
    withdraw: (fixture: { fallbackEnabled: boolean; fallbackForGrantees: boolean }) => void;
    reason: string;
  };
  const withdrawals: Array<[string, Withdrawal]> = [
    [
      "token allowExternal",
      {
        requester: "owner",
        withdraw: () => {
          consentState.token = { ...consentState.token, allowExternal: false };
        },
        reason: "CALLER_CONSENT_WITHDRAWN",
      },
    ],
    [
      "allowlist includeExternal",
      {
        requester: "owner",
        allowlist: true,
        withdraw: () => {
          consentState.allowlistEntry = { target: "MODEL_POOL", includeExternal: false };
        },
        reason: "CALLER_CONSENT_WITHDRAWN",
      },
    ],
    [
      "token revocation",
      {
        requester: "grantee",
        withdraw: () => {
          consentState.token = { ...consentState.token, revokedAt: new Date() };
        },
        reason: "CALLER_CONSENT_WITHDRAWN",
      },
    ],
    [
      "pool fallbackEnabled",
      {
        requester: "owner",
        withdraw: (fixture) => {
          fixture.fallbackEnabled = false;
        },
        reason: "POOL_PRIVATE",
      },
    ],
    [
      "pool fallbackForGrantees",
      {
        requester: "grantee",
        withdraw: (fixture) => {
          fixture.fallbackForGrantees = false;
        },
        reason: "GRANTEE_NOT_COVERED",
      },
    ],
    [
      "grant deletion",
      {
        requester: "grantee",
        withdraw: () => {
          consentState.grant = null;
        },
        reason: "REQUESTER_NOT_VISIBLE",
      },
    ],
    // R1-A: revoking the grant the request was resolved under and re-granting
    // creates a different grant row; the replacement is not the same consent.
    [
      "grant replacement",
      {
        requester: "grantee",
        withdraw: () => {
          consentState.grant = { id: "replacement-grant", ownerUserId: "owner" };
        },
        reason: "REQUESTER_NOT_VISIBLE",
      },
    ],
    // R1-C: authentication refuses a deletion-marked or banned account; the
    // send boundary must too (token and Chat Test session requesters).
    [
      "token owner deletion mark",
      {
        requester: "owner",
        withdraw: () => {
          consentState.account = {
            banned: false,
            banExpires: null,
            deletionRequestedAt: new Date(),
          };
        },
        reason: "REQUESTER_ACCESS_BLOCKED",
      },
    ],
    [
      "Chat Test session user deletion mark",
      {
        requester: "grantee",
        chatTest: true,
        withdraw: () => {
          consentState.account = {
            banned: false,
            banExpires: null,
            deletionRequestedAt: new Date(),
          };
        },
        reason: "REQUESTER_ACCESS_BLOCKED",
      },
    ],
    [
      "Chat Test session user ban",
      {
        requester: "owner",
        chatTest: true,
        withdraw: () => {
          consentState.account = { banned: true, banExpires: null, deletionRequestedAt: null };
        },
        reason: "REQUESTER_ACCESS_BLOCKED",
      },
    ],
    [
      "grant replacement alongside token and pool consent",
      {
        requester: "grantee",
        withdraw: (fixture) => {
          consentState.grant = { id: "replacement-grant", ownerUserId: "owner" };
          consentState.token = { ...consentState.token, allowExternal: false };
          fixture.fallbackEnabled = false;
          fixture.fallbackForGrantees = false;
        },
        reason: "REQUESTER_NOT_VISIBLE",
      },
    ],
  ];

  /** Consent fields for the withdrawal's requester kind (API token or Chat Test session). */
  function consentFieldsFor(withdrawal: Withdrawal) {
    if (!withdrawal.chatTest) return ownerConsentFields(withdrawal.requester);
    const decision = evaluateExternalEgress({
      requested: true,
      requester: { userId: withdrawal.requester, source: "CHAT_TEST", modelApiTokenId: null },
      tokenPermitsPool: false,
      pool: {
        id: "pool",
        ownerUserId: "owner",
        accessGrantId: withdrawal.requester === "owner" ? null : GRANT_ID,
        fallbackEnabled: true,
        fallbackForGrantees: true,
      },
    });
    if (!decision.granted) throw new Error("expected an issued consent");
    return {
      externalConsent: decision.consent,
      requesterUserId: decision.consent.requesterUserId,
      requesterModelApiTokenId: null,
    };
  }

  function arrange(withdrawal: Withdrawal, fixture: ReturnType<typeof dispatchPoolFixture>) {
    providerHttpsRequest.mockReset();
    reconcileProviderBudget.mockClear();
    releaseProviderHealthTrial.mockClear();
    recordProviderOutcome.mockClear();
    fixture.fallbackForGrantees = true;
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    consentState.token = { ...consentState.token, userId: withdrawal.requester };
    if (withdrawal.allowlist) {
      consentState.token = { ...consentState.token, scopeMode: "ALLOWLIST" };
      consentState.allowlistEntry = { target: "MODEL_POOL", includeExternal: true };
    }
    if (withdrawal.requester === "grantee") consentState.grant = currentGrant();
    const lockedSql: string[] = [];
    const credential =
      fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.CurrentCredential;
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("").includes('AS "requesterValid"'))
          return mockRequesterValidityQuery(strings, values, consentDelegates());
        lockedSql.push(strings.join("?").replace(/\s+/g, " "));
        return [];
      }),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue(credential),
        update: vi.fn().mockResolvedValue({ id: credential.id }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    // The consent change commits while budget admission is still pending.
    vi.mocked(admitProviderBudget).mockImplementationOnce(async () => {
      withdrawal.withdraw(fixture);
      return { admitted: true, providerAttemptId: "anchor", reservationIds: ["reservation"] };
    });
    return { tx, lockedSql };
  }

  function expectDeniedAtSendBoundary(
    result: Awaited<ReturnType<typeof dispatchPublicOverflow>>,
    reason: string,
    arranged: ReturnType<typeof arrange>,
  ) {
    expect(result).toEqual({ dispatched: false, reason });
    // Nothing left the deployment and no credential was claimed.
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(arranged.tx.providerCredential.update).not.toHaveBeenCalled();
    // The consent rows were locked FOR SHARE inside the send-claim transaction.
    expect(arranged.lockedSql.some((sql) => /FROM model_pool .*FOR SHARE/.test(sql))).toBe(true);
    // The admitted attempt's reservations are settled and its health trial is
    // handed back without a health verdict against the provider.
    expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CANCELLED", poolId: "pool", dispatchOutcome: "NOT_SENT" }),
    );
    expect(releaseProviderHealthTrial).toHaveBeenCalledTimes(1);
    expect(recordProviderOutcome).not.toHaveBeenCalled();
  }

  it.each(withdrawals)(
    "refuses the send when %s is withdrawn during budget admission",
    async (_label, withdrawal) => {
      const arranged = arrange(withdrawal, dispatchPoolFixture());
      const releaseLocalCapacity = vi.fn().mockResolvedValue(undefined);
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "consent-race",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...consentFieldsFor(withdrawal),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: false,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers(),
        body: new TextEncoder().encode(
          '{"model":"pool","messages":[{"role":"user","content":"private data"}]}',
        ),
        signal: new AbortController().signal,
        liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity,
        adaptationEnabled: false,
        // Retry-safe: a consent denial must not fail over to another member.
        retrySafe: true,
      });
      expectDeniedAtSendBoundary(result, withdrawal.reason, arranged);
    },
  );

  it.each([withdrawals[0]!, withdrawals[5]!, withdrawals[6]!, withdrawals[7]!, withdrawals[10]!])(
    "refuses a stored-response DELETE when %s is withdrawn during budget admission",
    async (_label, withdrawal) => {
      const fixture = dispatchPoolFixture("openai", "openai-responses");
      Object.assign(fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount, {
        endpointIdentity: "https://provider.example",
        endpointVersion: 1,
      });
      const arranged = arrange(withdrawal, fixture);
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "consent-race-delete",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...consentFieldsFor(withdrawal),
        requestedProtocol: "openai",
        requestedSurface: "openai-responses",
        stream: false,
        requiredFeatures: [],
        method: "DELETE",
        path: "/v1/responses/resp_bound",
        headers: new Headers(),
        body: new Uint8Array(),
        signal: new AbortController().signal,
        liability: { tokens: 0n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 0n,
        releaseLocalCapacity: async () => undefined,
        adaptationEnabled: false,
        retrySafe: false,
        skipContextValidation: true,
        forcedPoolMemberId: "member-heartbeat",
        exactResponsesBinding: {
          executionTargetId: "target-heartbeat",
          providerAccountId: "account-heartbeat",
          providerModelId: "model-heartbeat",
          endpointIdentity: "https://provider.example",
          endpointVersion: 1,
          upstreamModelId: "upstream-model",
        },
      });
      expectDeniedAtSendBoundary(result, withdrawal.reason, arranged);
    },
  );
});

// R1-B / R1-C: validity that lapses while the send claim waits on the
// provider account/credential locks (time, the unlocked account row) is
// re-evaluated after those waits, before the durable claim.
describe("requester validity lapsing during the send claim's provider-lock wait", () => {
  const start = new Date("2026-09-26T12:00:00.000Z");

  function arrangeLockWait(onAccountLock: () => void) {
    providerHttpsRequest.mockReset();
    reconcileProviderBudget.mockClear();
    releaseProviderHealthTrial.mockClear();
    recordProviderOutcome.mockClear();
    const fixture = dispatchPoolFixture();
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    const credential =
      fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.CurrentCredential;
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("").includes('AS "requesterValid"'))
          return mockRequesterValidityQuery(strings, values, consentDelegates());
        if (strings.join("?").includes("FROM provider_account")) onAccountLock();
        return [];
      }),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue(credential),
        update: vi.fn().mockResolvedValue({ id: credential.id }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([Buffer.from('{"choices":[],"usage":{}}')]);
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      complete: true,
    });
    providerHttpsRequest.mockResolvedValueOnce(upstream);
    return tx;
  }

  const chatRequest = () => ({
    userId: "owner",
    poolId: "pool",
    requestId: "lock-wait",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
    ...ownerConsentFields(),
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-chat" as const,
    stream: false,
    requiredFeatures: [],
    path: "/v1/chat/completions",
    headers: new Headers(),
    body: new TextEncoder().encode(
      '{"model":"pool","messages":[{"role":"user","content":"private data"}]}',
    ),
    signal: new AbortController().signal,
    liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
    requestedOutputTokens: 1n,
    releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
    adaptationEnabled: false,
    retrySafe: true,
  });

  it.each([
    ["no change (control)", (): void => undefined, null],
    [
      "the token expires",
      (): void => {
        vi.setSystemTime(new Date(start.getTime() + 2_000));
      },
      "CALLER_CONSENT_WITHDRAWN",
    ],
    [
      "the account is marked for deletion",
      (): void => {
        consentState.account = { banned: false, banExpires: null, deletionRequestedAt: new Date() };
      },
      "REQUESTER_ACCESS_BLOCKED",
    ],
  ] as const)("while the claim waits on provider locks: %s", async (_label, lapse, reason) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    try {
      consentState.token = { ...consentState.token, expiresAt: new Date(start.getTime() + 1_000) };
      const tx = arrangeLockWait(lapse);
      const result = await dispatchPublicOverflow(chatRequest());
      if (reason === null) {
        expect(result.dispatched).toBe(true);
        if (result.dispatched) {
          await result.response.text();
          await result.terminal;
        }
        expect(providerHttpsRequest).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result).toEqual({ dispatched: false, reason });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(tx.providerCredential.update).not.toHaveBeenCalled();
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "CANCELLED", dispatchOutcome: "NOT_SENT" }),
      );
      expect(releaseProviderHealthTrial).toHaveBeenCalledTimes(1);
      expect(recordProviderOutcome).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// L1a: a send claim that throws before any provider I/O is no evidence about
// the provider: no health verdict, the trial is handed back, and the result
// is a typed transient reason.
describe("send-claim failures before provider I/O", () => {
  it.each([
    ["a lock or connection timeout", "timeout"],
    ["the credential is no longer current", "not-current"],
    ["request argument construction fails after the claim", "request-options"],
  ] as const)("records no provider health verdict for %s", async (_label, failure) => {
    providerHttpsRequest.mockReset();
    reconcileProviderBudget.mockClear();
    releaseProviderHealthTrial.mockClear();
    recordProviderOutcome.mockClear();
    const fixture = dispatchPoolFixture();
    if (failure === "request-options")
      fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.baseUrl = "invalid-url";
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("").includes('AS "requesterValid"'))
          return mockRequesterValidityQuery(strings, values, consentDelegates());
        if (failure === "timeout" && strings.join("?").includes("FROM provider_account"))
          throw new Error("canceling statement due to lock timeout");
        return [];
      }),
      providerCredential: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            failure === "request-options"
              ? fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount
                  .CurrentCredential
              : null,
          ),
        update: vi.fn(),
      },
    };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "claim-throw",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode('{"model":"pool","messages":[]}'),
      signal: new AbortController().signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });

    expect(result).toEqual({
      dispatched: false,
      reason: failure === "request-options" ? "PROVIDER_UNAVAILABLE" : "SEND_CLAIM_FAILED",
    });
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(recordProviderOutcome).not.toHaveBeenCalled();
    expect(releaseProviderHealthTrial).toHaveBeenCalledTimes(1);
    expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "FAILED", dispatchOutcome: "NOT_SENT" }),
    );
  });
});

// R3 + R4: a stored-response operation distinguishes "try again later" from
// "this binding can never be served again".
describe("bound (stored-response) dispatch classification", () => {
  const binding = {
    executionTargetId: "target-heartbeat",
    providerAccountId: "account-heartbeat",
    providerModelId: "model-heartbeat",
    endpointIdentity: "https://provider.example",
    endpointVersion: 1,
    upstreamModelId: "upstream-model",
  };

  function boundFixture() {
    const fixture = dispatchPoolFixture("openai", "openai-responses");
    Object.assign(fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount, {
      endpointIdentity: "https://provider.example",
      endpointVersion: 1,
    });
    return fixture;
  }

  const boundRequest = () => ({
    userId: "owner",
    poolId: "pool",
    requestId: "bound-classification",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
    ...ownerConsentFields(),
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-responses" as const,
    stream: false,
    requiredFeatures: [],
    method: "GET",
    path: "/v1/responses/resp_bound",
    headers: new Headers(),
    body: new Uint8Array(),
    signal: new AbortController().signal,
    liability: { tokens: 0n, accountingVersion: "provider-billable-v1" },
    requestedOutputTokens: 0n,
    releaseLocalCapacity: async () => undefined,
    adaptationEnabled: false,
    retrySafe: false,
    skipContextValidation: true,
    forcedPoolMemberId: "member-heartbeat",
    exactResponsesBinding: binding,
  });

  it.each(["model", "account"] as const)(
    "treats reversible %s disable as unavailable and re-enable as ready",
    async (which) => {
      providerHttpsRequest.mockReset();
      const fixture = boundFixture();
      const model = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
      const disabled = which === "model" ? model : model.ProviderAccount;
      disabled.enabled = false;
      db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
      const listed = await listPublicOverflowTargets("owner", "pool");
      expect(listed.targets).toEqual([]);
      expect(listed.coolingDown).toEqual([]);
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "PROVIDER_UNAVAILABLE",
      });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(listed.unavailable).toHaveLength(1);
      disabled.enabled = true;
      const recovered = await listPublicOverflowTargets("owner", "pool");
      expect(recovered.targets).toHaveLength(1);
      expect(recovered.unavailable).toEqual([]);
      // The same immutable binding becomes dispatchable without recreation.
      vi.mocked(claimProviderHealthTrial).mockResolvedValueOnce("COOLDOWN");
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "PROVIDER_UNHEALTHY",
      });
      // Deleted identities and changed identities remain permanently invalid,
      // including while the same rows are disabled.
      disabled.enabled = false;
      Object.assign(model.ProviderAccount, { endpointVersion: 99 });
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "BOUND_TARGET_INVALID",
      });
      Object.assign(model.ProviderAccount, { endpointVersion: 1 });
      Object.assign(disabled, { deletedAt: new Date() });
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "BOUND_TARGET_INVALID",
      });
    },
  );

  it.each(["missing", "revoked"] as const)(
    "keeps a binding unavailable while its credential is %s",
    async (state) => {
      providerHttpsRequest.mockReset();
      const fixture = boundFixture();
      const account = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount;
      const credential = structuredClone(account.CurrentCredential);
      Object.assign(account, {
        CurrentCredential: state === "missing" ? null : { ...credential, status: "REVOKED" },
      });
      db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "PROVIDER_UNAVAILABLE",
      });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      account.CurrentCredential = credential;
      expect((await listPublicOverflowTargets("owner", "pool")).targets).toHaveLength(1);
    },
  );

  it("reports a binding that no longer matches its endpoint as permanently invalid", async () => {
    providerHttpsRequest.mockReset();
    const fixture = boundFixture();
    fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.healthNextRetryAt =
      new Date(Date.now() + 60_000);
    Object.assign(fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount, {
      endpointVersion: 99,
    });
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    // Cooling or not, a stale endpoint version never matches the binding again.
    await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
      dispatched: false,
      reason: "BOUND_TARGET_INVALID",
    });
    fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.healthNextRetryAt =
      new Date(0);
    await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
      dispatched: false,
      reason: "BOUND_TARGET_INVALID",
    });
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  });

  it.each(["COOLDOWN", "exception"] as const)(
    "reports health-trial %s at dispatch as unhealthy and never sent",
    async (outcome) => {
      providerHttpsRequest.mockReset();
      recordProviderOutcome.mockClear();
      const fixture = boundFixture();
      db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
      reconcileProviderBudget.mockClear();
      // Another request's half-open trial started after this request listed.
      if (outcome === "exception")
        vi.mocked(claimProviderHealthTrial).mockRejectedValueOnce(new Error("trial claim failed"));
      else vi.mocked(claimProviderHealthTrial).mockResolvedValueOnce("COOLDOWN");
      await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
        dispatched: false,
        reason: "PROVIDER_UNHEALTHY",
      });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(recordProviderOutcome).not.toHaveBeenCalled();
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ dispatchOutcome: "NOT_SENT" }),
      );
    },
  );

  it("classifies a member with a live half-open trial as cooling down at listing", async () => {
    const fixture = boundFixture();
    const model = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
    // Backoff elapsed, but another request holds the half-open trial.
    Object.assign(model, { healthHalfOpenAt: new Date(Date.now() - 5_000) });
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed.targets).toEqual([]);
    expect(listed.coolingDown.map((target) => target.poolMemberId)).toEqual(["member-heartbeat"]);
    await expect(dispatchPublicOverflow(boundRequest())).resolves.toEqual({
      dispatched: false,
      reason: "PROVIDER_UNHEALTHY",
    });
    // An expired trial lease no longer blocks the member.
    Object.assign(model, { healthHalfOpenAt: new Date(Date.now() - 120_000) });
    const recovered = await listPublicOverflowTargets("owner", "pool");
    expect(recovered.targets.map((target) => target.poolMemberId)).toEqual(["member-heartbeat"]);
  });
});

describe("public overflow terminal response dispatch", () => {
  it("ranks only overflow-eligible providers and uses immutable pricing, health, and load penalties", async () => {
    const fixture = dispatchPoolFixture();
    const first = fixture.PoolMembers[0]!;
    const second = structuredClone(first);
    first.id = "member-expensive";
    first.publicOrder = 0;
    first.ExecutionTarget.id = "target-expensive";
    first.ExecutionTarget.ProviderModel.id = "model-expensive";
    first.ExecutionTarget.ProviderModel.ProviderAccount.id = "account-expensive";
    second.id = "member-cheap";
    second.publicOrder = 1;
    second.ExecutionTarget.id = "target-cheap";
    second.ExecutionTarget.ProviderModel.id = "model-cheap";
    second.ExecutionTarget.ProviderModel.ProviderAccount.id = "account-cheap";
    fixture.PoolMembers.push(second);
    Object.assign(fixture, {
      affinityEnabled: true,
      affinityTtlSeconds: 600,
      affinityMaxRecords: 100,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    });
    db.modelPool.findFirst.mockResolvedValue(fixture);
    db.providerAttempt.groupBy.mockResolvedValue([
      { providerModelId: "model-expensive", _count: { _all: 1 } },
    ]);
    const schedule = (rate: number, currency = "USD") => ({
      id: `price-${rate}`,
      version: `v-${rate}`,
      currency,
      accountingVersion: "provider-billable-v1",
      confidence: "CALCULATED",
      effectiveAt: new Date(0),
      pricing: { ratesPerMillion: { input: rate, output: rate } },
      chargeRules: {
        unknownCategories: "FAIL_CLOSED",
        inputIncludesCacheRead: true,
        inputIncludesCacheWrite: true,
        outputIncludesReasoning: true,
        outputIncludesTool: true,
        cacheReadAllowanceTokens: 0,
        cacheWriteAllowanceTokens: 0,
        reasoningAllowanceTokens: 0,
        toolAllowanceTokens: 0,
        additionalAllowanceTokens: 0,
      },
    });
    db.providerPricingVersion.findFirst
      .mockResolvedValueOnce(schedule(100))
      .mockResolvedValueOnce(schedule(1));
    const listed = await listPublicOverflowTargets("owner", "pool");
    const request = {
      userId: "owner",
      poolId: "pool",
      requestId: "request",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
      ...ownerConsentFields(),
      requestedProtocol: "openai" as const,
      requestedSurface: "openai-chat" as const,
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode('{"model":"pool","messages":[{"role":"user","content":"x"}]}'),
      signal: new AbortController().signal,
      liability: { accountingVersion: "provider-billable-v1" },
      estimatedInputTokens: 100n,
      requestedOutputTokens: 100n,
      releaseLocalCapacity: vi.fn(),
      adaptationEnabled: false,
      retrySafe: false,
    };
    const ranked = await rankPublicOverflowTargets({
      request,
      policy: listed.affinityPolicy,
      targets: listed.targets,
    });
    expect(ranked.targets.map((target) => target.executionTargetId)).toEqual([
      "target-cheap",
      "target-expensive",
    ]);
    expect(ranked.targets[0]?.affinity?.reason).toContain("publicPenalty:100");
    expect(ranked.targets[1]?.affinity?.reason).toContain("active:1");

    db.providerAttempt.groupBy.mockResolvedValue([]);
    db.providerPricingVersion.findFirst
      .mockResolvedValueOnce(schedule(100, "JPY"))
      .mockResolvedValueOnce(schedule(1, "USD"));
    const mixedCurrency = await rankPublicOverflowTargets({
      request,
      policy: listed.affinityPolicy,
      targets: listed.targets,
    });
    expect(mixedCurrency.targets.map((target) => target.executionTargetId)).toEqual([
      "target-expensive",
      "target-cheap",
    ]);
    expect(mixedCurrency.targets[0]?.affinity?.reason).toContain("costPenalty:0");

    const incomplete = { ...schedule(1), pricing: { ratesPerMillion: { input: 1 } } };
    db.providerPricingVersion.findFirst
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(schedule(1));
    const incompletePricing = await rankPublicOverflowTargets({
      request,
      policy: listed.affinityPolicy,
      targets: listed.targets,
    });
    expect(incompletePricing.targets.map((target) => target.executionTargetId)).toEqual([
      "target-expensive",
      "target-cheap",
    ]);
    expect(incompletePricing.targets[0]?.affinity?.reason).toContain("costPenalty:0");
  });

  it("fails open to configured provider order when affinity ranking is unavailable", async () => {
    const fixture = dispatchPoolFixture();
    Object.assign(fixture, {
      affinityEnabled: true,
      affinityTtlSeconds: 600,
      affinityMaxRecords: 100,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    });
    db.modelPool.findFirst.mockResolvedValue(fixture);
    db.providerAttempt.groupBy.mockRejectedValueOnce(new Error("affinity load unavailable"));
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-heartbeat",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([Buffer.from('{"choices":[],"usage":{}}')]);
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      complete: true,
    });
    providerHttpsRequest.mockResolvedValueOnce(upstream);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-affinity-fail-open",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(
        '{"model":"pool","messages":[{"role":"user","content":"retry me"}]}',
      ),
      signal: new AbortController().signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });

    expect(result).toMatchObject({ dispatched: true, attemptCount: 1 });
    if (!result.dispatched) throw new Error("expected fail-open dispatch");
    expect(result.affinity?.reason).toBe("affinity_error");
    await result.response.text();
    await result.terminal;
  });

  it("decorates a single compatible provider so successful dispatches can build history", async () => {
    const fixture = dispatchPoolFixture();
    Object.assign(fixture, {
      affinityEnabled: true,
      affinityTtlSeconds: 600,
      affinityMaxRecords: 100,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    });
    db.modelPool.findFirst.mockResolvedValue(fixture);
    db.providerAttempt.groupBy.mockResolvedValue([]);
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    const listed = await listPublicOverflowTargets("owner", "pool");
    const ranked = await rankPublicOverflowTargets({
      request: {
        userId: "owner",
        poolId: "pool",
        requestId: "single-history",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: false,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers(),
        body: new TextEncoder().encode(
          '{"model":"pool","messages":[{"role":"user","content":"remember"}]}',
        ),
        signal: new AbortController().signal,
        liability: { accountingVersion: "provider-billable-v1" },
        releaseLocalCapacity: vi.fn(),
        adaptationEnabled: false,
        retrySafe: false,
      },
      policy: listed.affinityPolicy,
      targets: listed.targets,
    });
    expect(ranked.targets[0]?.affinityTarget).toBeDefined();
  });

  it("retries according to affinity-ranked order rather than configured order", async () => {
    providerHttpsRequest.mockClear();
    const fixture = dispatchPoolFixture();
    const expensive = fixture.PoolMembers[0]!;
    const cheap = structuredClone(expensive);
    expensive.id = "member-expensive-retry";
    expensive.ExecutionTarget.id = "target-expensive-retry";
    expensive.ExecutionTarget.ProviderModel.id = "model-expensive-retry";
    expensive.ExecutionTarget.ProviderModel.ProviderAccount.id = "account-expensive-retry";
    expensive.ExecutionTarget.ProviderModel.ProviderAccount.baseUrl = "https://expensive.example";
    cheap.id = "member-cheap-retry";
    cheap.publicOrder = 1;
    cheap.ExecutionTarget.id = "target-cheap-retry";
    cheap.ExecutionTarget.ProviderModel.id = "model-cheap-retry";
    cheap.ExecutionTarget.ProviderModel.ProviderAccount.id = "account-cheap-retry";
    cheap.ExecutionTarget.ProviderModel.ProviderAccount.baseUrl = "https://cheap.example";
    fixture.PoolMembers.push(cheap);
    Object.assign(fixture, {
      affinityEnabled: true,
      affinityTtlSeconds: 600,
      affinityMaxRecords: 100,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    });
    db.modelPool.findFirst.mockResolvedValue(fixture);
    db.providerAttempt.groupBy.mockResolvedValue([
      { providerModelId: "model-expensive-retry", _count: { _all: 10 } },
    ]);
    db.providerPricingVersion.findFirst.mockReset().mockResolvedValue(null);
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-heartbeat",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const retryable = Readable.from([]);
    Object.assign(retryable, { statusCode: 503, headers: {}, complete: true });
    const success = Readable.from([Buffer.from('{"choices":[],"usage":{}}')]);
    Object.assign(success, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      complete: true,
    });
    providerHttpsRequest.mockResolvedValueOnce(retryable).mockResolvedValueOnce(success);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-ranked-retry",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(
        '{"model":"pool","messages":[{"role":"user","content":"retry me"}]}',
      ),
      signal: new AbortController().signal,
      liability: { accountingVersion: "provider-billable-v1" },
      estimatedInputTokens: 100n,
      requestedOutputTokens: 100n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: true,
    });

    expect(result).toMatchObject({ dispatched: true, attemptCount: 2 });
    if (!result.dispatched) throw new Error("expected ranked retry dispatch");
    expect(providerHttpsRequest).toHaveBeenCalledTimes(2);
    expect(String(providerHttpsRequest.mock.calls[0]?.[0])).toContain("cheap.example");
    expect(String(providerHttpsRequest.mock.calls[1]?.[0])).toContain("expensive.example");
    await result.response.text();
    await result.terminal;
  });
  it.each([
    {
      label: "OpenAI partial usage",
      stream: true,
      protocol: "openai",
      surface: "openai-chat",
      path: "/v1/chat/completions",
      chunk:
        'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n',
      expected: { inputTokens: 9n, outputTokens: 1n },
    },
    {
      label: "Anthropic message_start usage",
      stream: true,
      protocol: "anthropic",
      surface: "anthropic-messages",
      path: "/v1/messages",
      chunk:
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      expected: { inputTokens: 12n, outputTokens: 0n },
    },
    {
      label: "non-stream cost-only usage",
      stream: false,
      protocol: "openai",
      surface: "openai-chat",
      path: "/v1/chat/completions",
      chunk: '{"usage":{"cost":1,"currency":"USD","pricing_version":"price-v1"}}',
      expected: { reportedCost: 1 },
    },
  ])("retains $label when the upstream ends before its terminal event", async (fixture) => {
    reconcileProviderBudget.mockClear();
    db.modelPool.findFirst.mockResolvedValue(
      dispatchPoolFixture(fixture.protocol, fixture.surface, fixture.protocol),
    );
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-heartbeat",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([Buffer.from(fixture.chunk)]);
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
      complete: false,
    });
    providerHttpsRequest.mockResolvedValueOnce(upstream);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: `request-${fixture.protocol}`,
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: fixture.protocol as "openai" | "anthropic",
      requestedSurface: fixture.surface as "openai-chat" | "anthropic-messages",
      stream: fixture.stream,
      requiredFeatures: [],
      path: fixture.path,
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"pool","stream":true}'),
      signal: new AbortController().signal,
      liability: { tokens: 100n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 10n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error("expected dispatch");
    await expect(result.response.text()).rejects.toThrow("before transport completion");
    await result.terminal;

    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          ...fixture.expected,
          observationComplete: false,
          rawUsage: expect.anything(),
        }),
      }),
    );
  });

  it.each([
    {
      label: "JSON",
      stream: false,
      chunk: '{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
      contentType: "application/json",
    },
    {
      label: "SSE",
      stream: true,
      chunk:
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      contentType: "text/event-stream",
    },
  ])(
    "does not expose successful $label EOF when durable terminal accounting fails",
    async (fixture) => {
      reconcileProviderBudget.mockReset().mockRejectedValueOnce(new Error("database unavailable"));
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerCredential: {
          findFirst: vi.fn().mockResolvedValue({
            id: "credential-heartbeat",
            credentialType: "BEARER",
            aadVersion: 1,
            algorithm: "AES-256-GCM",
            keyVersion: "v1",
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            authTag: new Uint8Array(),
          }),
          update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
        },
      };
      db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      );
      const upstream = Readable.from([Buffer.from(fixture.chunk)]);
      Object.assign(upstream, {
        statusCode: 200,
        headers: { "content-type": fixture.contentType },
        complete: true,
      });
      providerHttpsRequest.mockResolvedValueOnce(upstream);

      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: `request-accounting-failure-${fixture.label}`,
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: fixture.stream,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode('{"model":"pool"}'),
        signal: new AbortController().signal,
        liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });
      expect(result.dispatched).toBe(true);
      if (!result.dispatched) throw new Error("expected dispatch");
      await expect(result.response.text()).rejects.toThrow("database unavailable");
      await expect(result.terminal).resolves.toEqual({
        ok: false,
        responseBytes: fixture.chunk.length,
      });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
    },
  );

  it("keeps unavailable targets with cooldown metadata eligible for half-open recovery", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      fallbackEnabled: true,
      fallbackForGrantees: false,
      PoolMembers: [
        {
          id: "member",
          publicOrder: 0,
          ExecutionTarget: {
            id: "target",
            ProviderModel: {
              id: "model",
              userId: "owner",
              upstreamModelId: "upstream-model",
              contextWindow: 10_000,
              maxOutputTokens: 1_000,
              nativeCapabilities: {
                protocols: ["openai"],
                surfaces: ["openai-chat"],
                streaming: true,
                features: [],
              },
              healthStatus: "UNAVAILABLE",
              healthNextRetryAt: new Date("2026-08-25T00:00:00.000Z"),
              enabled: true,
              deletedAt: null,
              ProviderAccount: {
                id: "account",
                userId: "owner",
                providerType: "openai",
                providerVersion: null,
                baseUrl: "https://provider.example",
                authType: "BEARER",
                healthStatus: "UNAVAILABLE",
                healthNextRetryAt: new Date("2026-08-25T00:00:00.000Z"),
                enabled: true,
                deletedAt: null,
                CurrentCredential: {
                  id: "credential",
                  credentialType: "BEARER",
                  aadVersion: 1,
                  algorithm: "AES-256-GCM",
                  keyVersion: "v1",
                  ciphertext: new Uint8Array(),
                  nonce: new Uint8Array(),
                  authTag: new Uint8Array(),
                  status: "ACTIVE",
                },
              },
            },
          },
        },
      ],
    });

    const listed = await listPublicOverflowTargets("owner", "pool");

    expect(listed.targets).toHaveLength(1);
    expect(listed.targets[0]?.providerModelId).toBe("model");
  });

  it("returns a non-retry-safe 429 with Retry-After and records its cooldown", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      fallbackEnabled: true,
      fallbackForGrantees: false,
      PoolMembers: [
        {
          id: "member",
          publicOrder: 0,
          ExecutionTarget: {
            id: "target",
            ProviderModel: {
              id: "model",
              userId: "owner",
              upstreamModelId: "upstream-model",
              contextWindow: 10_000,
              maxOutputTokens: 1_000,
              nativeCapabilities: {
                protocols: ["openai"],
                surfaces: ["openai-chat"],
                streaming: true,
                features: [],
              },
              healthStatus: "HEALTHY",
              enabled: true,
              deletedAt: null,
              ProviderAccount: {
                id: "account",
                userId: "owner",
                providerType: "openai",
                providerVersion: null,
                baseUrl: "https://provider.example",
                authType: "BEARER",
                healthStatus: "HEALTHY",
                enabled: true,
                deletedAt: null,
                CurrentCredential: {
                  id: "credential",
                  credentialType: "BEARER",
                  aadVersion: 1,
                  algorithm: "AES-256-GCM",
                  keyVersion: "v1",
                  ciphertext: new Uint8Array(),
                  nonce: new Uint8Array(),
                  authTag: new Uint8Array(),
                  status: "ACTIVE",
                },
              },
            },
          },
        },
      ],
    });
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([Buffer.from('{"error":"limited"}')]);
    Object.assign(upstream, {
      statusCode: 429,
      headers: { "content-type": "application/json", "retry-after": "37" },
      complete: false,
    });
    providerHttpsRequest.mockResolvedValue(upstream);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"pool"}'),
      signal: new AbortController().signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });

    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error("expected dispatch");
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("37");
    expect(await result.response.text()).toBe('{"error":"limited"}');
    await result.terminal;
    expect(recordProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        failureClass: "RATE_LIMIT",
        retryAfterMs: 37_000,
      }),
    );
  });

  it.each([
    {
      label: "cached hit",
      chunk:
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}',
      engineCacheConfirmed: true,
      cacheReadTokens: 5n,
    },
    {
      label: "reported zero",
      chunk:
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0}}}',
      engineCacheConfirmed: false,
      cacheReadTokens: 0n,
    },
    {
      label: "cache fields absent",
      chunk: '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
      engineCacheConfirmed: undefined,
      cacheReadTokens: undefined,
    },
  ])(
    "forwards $label usage polarity to rememberAffinity consistently with reconcile",
    async (fixture) => {
      rememberAffinity.mockClear();
      reconcileProviderBudget.mockClear();
      const pool = dispatchPoolFixture();
      Object.assign(pool, {
        affinityEnabled: true,
        affinityTtlSeconds: 600,
        affinityMaxRecords: 100,
        affinityPrefixWeight: 100,
        affinityConversationWeight: 150,
        affinityConfirmedCacheWeight: 250,
        affinityLoadPenaltyWeight: 100,
      });
      db.modelPool.findFirst.mockResolvedValue(pool);
      db.providerAttempt.groupBy.mockResolvedValue([]);
      db.providerPricingVersion.findFirst.mockResolvedValue(null);
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerCredential: {
          findFirst: vi.fn().mockResolvedValue({
            id: "credential-heartbeat",
            credentialType: "BEARER",
            aadVersion: 1,
            algorithm: "AES-256-GCM",
            keyVersion: "v1",
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            authTag: new Uint8Array(),
          }),
          update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
        },
      };
      db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      );
      const upstream = Readable.from([Buffer.from(fixture.chunk)]);
      Object.assign(upstream, {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        complete: true,
      });
      providerHttpsRequest.mockResolvedValueOnce(upstream);

      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: `request-affinity-${fixture.label.replace(/\s+/g, "-")}`,
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: false,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(
          '{"model":"pool","messages":[{"role":"user","content":"affinity evidence"}]}',
        ),
        signal: new AbortController().signal,
        liability: { accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });

      expect(result.dispatched).toBe(true);
      if (!result.dispatched) throw new Error("expected dispatch");
      await result.response.text();
      await result.terminal;
      // The affinity write is best-effort and errors are swallowed, so the
      // spy must witness the call itself rather than its downstream effects.
      await vi.waitFor(() => expect(rememberAffinity).toHaveBeenCalledTimes(1));
      expect(rememberAffinity.mock.calls[0]?.[0]).toMatchObject({
        engineCacheConfirmed: fixture.engineCacheConfirmed,
      });
      // Both the affinity write and the usage reconcile read the same settled
      // usage, so the observed flag must agree with the reconciled category.
      const reconciled = reconcileProviderBudget.mock.calls.at(-1)?.[0]?.usage;
      expect(reconciled?.cacheReadTokens).toEqual(fixture.cacheReadTokens);
    },
  );

  it("swallows rememberAffinity failures without failing the overflow terminal", async () => {
    rememberAffinity.mockClear();
    rememberAffinity.mockRejectedValueOnce(new Error("affinity store unavailable"));
    const pool = dispatchPoolFixture();
    Object.assign(pool, {
      affinityEnabled: true,
      affinityTtlSeconds: 600,
      affinityMaxRecords: 100,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    });
    db.modelPool.findFirst.mockResolvedValue(pool);
    db.providerAttempt.groupBy.mockResolvedValue([]);
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-heartbeat",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([
      Buffer.from(
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}',
      ),
    ]);
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      complete: true,
    });
    providerHttpsRequest.mockResolvedValueOnce(upstream);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-affinity-swallowed",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(
        '{"model":"pool","messages":[{"role":"user","content":"swallowed write"}]}',
      ),
      signal: new AbortController().signal,
      liability: { accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });

    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error("expected dispatch");
    await result.response.text();
    await expect(result.terminal).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(rememberAffinity).toHaveBeenCalledTimes(1));
    rememberAffinity.mockClear();
    rememberAffinity.mockResolvedValue(undefined);
  });

  it("settles cancellation before provider I/O as not sent with no health verdict", async () => {
    recordProviderOutcome.mockClear();
    db.modelPool.findFirst.mockResolvedValue({
      fallbackEnabled: true,
      fallbackForGrantees: false,
      PoolMembers: [
        {
          id: "member-cancel",
          publicOrder: 0,
          ExecutionTarget: {
            id: "target-cancel",
            ProviderModel: {
              id: "model-cancel",
              userId: "owner",
              upstreamModelId: "upstream-model",
              contextWindow: 10_000,
              maxOutputTokens: 1_000,
              nativeCapabilities: {
                protocols: ["openai"],
                surfaces: ["openai-chat"],
                streaming: true,
                features: [],
              },
              healthStatus: "HEALTHY",
              healthNextRetryAt: null,
              enabled: true,
              deletedAt: null,
              ProviderAccount: {
                id: "account-cancel",
                userId: "owner",
                providerType: "openai",
                providerVersion: null,
                baseUrl: "https://provider.example",
                authType: "BEARER",
                healthStatus: "HEALTHY",
                healthNextRetryAt: null,
                enabled: true,
                deletedAt: null,
                CurrentCredential: {
                  id: "credential-cancel",
                  credentialType: "BEARER",
                  aadVersion: 1,
                  algorithm: "AES-256-GCM",
                  keyVersion: "v1",
                  ciphertext: new Uint8Array(),
                  nonce: new Uint8Array(),
                  authTag: new Uint8Array(),
                  status: "ACTIVE",
                },
              },
            },
          },
        },
      ],
    });
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-cancel",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-cancel" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    providerHttpsRequest.mockReset();
    reconcileProviderBudget.mockClear();

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-cancel",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"pool"}'),
      signal: controller.signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });

    expect(result).toEqual({ dispatched: false, reason: "SEND_CLAIM_FAILED" });
    expect(recordProviderOutcome).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CANCELLED", dispatchOutcome: "NOT_SENT" }),
    );
  });

  it("aborts a pending provider request when heartbeat ownership is lost", async () => {
    vi.useFakeTimers();
    try {
      recordProviderOutcome.mockClear();
      releaseProviderHealthTrial.mockClear();
      heartbeatProviderAttempt.mockResolvedValueOnce(false);
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerCredential: {
          findFirst: vi.fn().mockResolvedValue({
            id: "credential-heartbeat",
            credentialType: "BEARER",
            aadVersion: 1,
            algorithm: "AES-256-GCM",
            keyVersion: "v1",
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            authTag: new Uint8Array(),
          }),
          update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
        },
      };
      db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      );
      let providerSignal: AbortSignal | undefined;
      providerHttpsRequest.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            providerSignal = init.signal;
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );

      const dispatched = dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-heartbeat",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: false,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode('{"model":"pool"}'),
        signal: new AbortController().signal,
        liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(dispatched).resolves.toMatchObject({
        dispatched: false,
        reason: "PROVIDER_UNAVAILABLE",
        providerIoStarted: true,
      });
      expect(providerSignal?.aborted).toBe(true);
      expect(recordProviderOutcome).not.toHaveBeenCalled();
      expect(releaseProviderHealthTrial).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatProviderAttempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record a retryable failure after heartbeat ownership is lost", async () => {
    vi.useFakeTimers();
    try {
      recordProviderOutcome.mockClear();
      reconcileProviderBudget.mockClear();
      releaseProviderHealthTrial.mockClear();
      heartbeatProviderAttempt.mockResolvedValueOnce(false);
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerCredential: {
          findFirst: vi.fn().mockResolvedValue({
            id: "credential-heartbeat",
            credentialType: "BEARER",
            aadVersion: 1,
            algorithm: "AES-256-GCM",
            keyVersion: "v1",
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            authTag: new Uint8Array(),
          }),
          update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
        },
      };
      db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      );
      let resolveProvider!: (response: Readable) => void;
      providerHttpsRequest.mockImplementationOnce(
        () =>
          new Promise<Readable>((resolve) => {
            resolveProvider = resolve;
          }),
      );

      const dispatched = dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-retry-heartbeat",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: false,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode('{"model":"pool"}'),
        signal: new AbortController().signal,
        liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: true,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const upstream = Readable.from([
        Buffer.from(
          '{"usage":{"input_tokens":9,"output_tokens":2,"cost":0.003,"currency":"USD","pricing_version":"price-v1"}}',
        ),
      ]);
      Object.assign(upstream, { statusCode: 503, headers: {}, complete: true });
      resolveProvider(upstream);

      const result = await dispatched;
      expect(result).toMatchObject({ dispatched: true, attemptCount: 1 });
      if (!result.dispatched) throw new Error("expected terminal provider response");
      await result.response.text();
      await result.terminal;
      expect(recordProviderOutcome).not.toHaveBeenCalled();
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "FAILED",
          usageSource: "openai-response",
          usage: expect.objectContaining({
            inputTokens: 9n,
            outputTokens: 2n,
            reportedCost: 0.003,
            rawUsage: expect.objectContaining({ input_tokens: 9, output_tokens: 2 }),
          }),
        }),
      );
      expect(releaseProviderHealthTrial).toHaveBeenCalledWith({
        userId: "owner",
        providerAccountId: "account-heartbeat",
        providerModelId: "model-heartbeat",
        attemptId: expect.any(String),
        fencingToken: 1n,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("own-key dispatch and authoritative send claim", () => {
  function setup() {
    const fixture = {
      ...dispatchPoolFixture(),
      fallbackEnabled: false,
      fallbackForGrantees: false,
      externalEquivalentModel: "vendor/model" as string | null,
    };
    const base = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
    const model = {
      ...base,
      userId: "grantee",
      ExecutionTarget: { id: "own-target", inferenceCapacityId: "own-capacity" },
      ProviderAccount: {
        ...base.ProviderAccount,
        userId: "grantee",
        endpointIdentity: "https://provider.example",
        endpointVersion: 1,
      },
    };
    db.modelPool.findFirst.mockImplementation(async () => fixture);
    const preference = { id: "preference", ProviderModel: model };
    db.poolFallbackPreference.findFirst.mockResolvedValue(preference);
    consentState.token = { ...consentState.token, userId: "grantee" };
    consentState.grant = currentGrant();
    const decision = evaluateExternalEgress({
      requested: true,
      requester: { userId: "grantee", modelApiTokenId: "token", source: "API_TOKEN" },
      tokenPermitsPool: true,
      pool: {
        id: "pool",
        ownerUserId: "owner",
        accessGrantId: GRANT_ID,
        fallbackEnabled: false,
        fallbackForGrantees: false,
        externalEquivalentModel: "vendor/model",
        ownKeyProviderModelId: model.id,
      },
    });
    if (!decision.granted) throw new Error("expected own consent");
    const locks: string[] = [];
    const tx = {
      ...consentDelegates(),
      poolFallbackPreference: db.poolFallbackPreference,
      providerModel: { findFirst: vi.fn().mockResolvedValue(model) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR ")) locks.push(sql);
        return mockRequesterValidityQuery(strings, values, consentDelegates());
      }),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue(model.ProviderAccount.CurrentCredential),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    providerHttpsRequest.mockReset();
    db.cacheAffinityRecord.findMany.mockClear();
    rememberAffinity.mockClear();
    vi.mocked(admitProviderBudget).mockClear();
    providerHttpsRequest.mockResolvedValue(
      Object.assign(
        Readable.from([
          Buffer.from(
            JSON.stringify({
              model: "upstream-model",
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            }),
          ),
        ]),
        { statusCode: 200, headers: { "content-type": "application/json" }, complete: true },
      ),
    );
    const request = {
      userId: "grantee",
      requesterUserId: "grantee",
      requesterModelApiTokenId: "token",
      ownKeyProviderModelId: model.id,
      externalConsent: decision.consent,
      poolId: "pool",
      requestId: "own-request",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
      requestedProtocol: "openai" as const,
      requestedSurface: "openai-chat" as const,
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode('{"messages":[]}'),
      signal: new AbortController().signal,
      liability: { tokens: 100n, accountingVersion: "provider-billable-v1" },
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: true,
    };
    return { fixture, model, request, tx, locks };
  }
  it("persists send intent after consent but before transport, and reports possible I/O on failure", async () => {
    const { request, tx } = setup();
    const beforeProviderSend = vi.fn(async () => {
      expect(tx.providerCredential.update).toHaveBeenCalled();
      expect(providerHttpsRequest).not.toHaveBeenCalled();
    });
    providerHttpsRequest.mockRejectedValueOnce(new Error("connection lost"));
    const result = await dispatchPublicOverflow({
      ...request,
      retrySafe: false,
      beforeProviderSend,
    });
    expect(beforeProviderSend).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      dispatched: false,
      providerIoStarted: true,
      providerFailure: { target: { ownKey: true } },
    });
  });
  it("never sends when durable intent persistence fails", async () => {
    const { request } = setup();
    const result = await dispatchPublicOverflow({
      ...request,
      beforeProviderSend: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(result).toMatchObject({ dispatched: false });
    expect(result).not.toHaveProperty("providerIoStarted");
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchOutcome: "NOT_SENT" }),
    );
  });
  it("retains provider 429 and Retry-After for a rejected precommit response", async () => {
    const { request } = setup();
    providerHttpsRequest.mockResolvedValueOnce(
      Object.assign(Readable.from([Buffer.from('{"error":{"message":"busy"}}')]), {
        statusCode: 429,
        headers: { "content-type": "application/json", "retry-after": "17" },
        complete: true,
      }),
    );
    const result = await dispatchPublicOverflow({ ...request, retrySingleTargetPrecommit: true });
    expect(result).toMatchObject({
      dispatched: false,
      providerIoStarted: true,
      providerFailure: { status: 429, retryAfter: "17", target: { ownKey: true } },
    });
  });
  it("charges the requester and skips affinity even when owner fallback is off", async () => {
    const { request, locks } = setup();
    const result = await dispatchPublicOverflow(request);
    expect(result).toMatchObject({ dispatched: true });
    if (!result.dispatched) return;
    await result.response.text();
    await result.terminal;
    expect(admitProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "grantee", poolId: undefined }),
    );
    expect(db.cacheAffinityRecord.findMany).not.toHaveBeenCalled();
    expect(rememberAffinity).not.toHaveBeenCalled();
    expect(locks.map((sql) => sql.match(/FROM ([a-z_]+)/)?.[1])).toEqual([
      "model_pool",
      "pool_grant",
      "model_api_token",
      "model_api_token_allowlist_entry",
      "provider_account",
      "provider_model",
      "provider_credential",
      "pool_fallback_preference",
    ]);
  });
  it.each([
    "token",
    "allowlist",
    "expired",
    "revoked",
    "grant",
    "ban",
    "deletion",
    "equivalent",
    "preference",
    "model",
    "account",
    "credential",
  ])("refuses %s withdrawal during budget wait before network I/O", async (condition) => {
    const { request, fixture, tx } = setup();
    vi.mocked(admitProviderBudget).mockImplementationOnce(async () => {
      if (condition === "token")
        consentState.token = { ...consentState.token, allowExternal: false };
      if (condition === "allowlist") {
        consentState.token = { ...consentState.token, scopeMode: "ALLOWLIST" };
        consentState.allowlistEntry = null;
      }
      if (condition === "expired")
        consentState.token = { ...consentState.token, expiresAt: new Date(0) };
      if (condition === "revoked")
        consentState.token = { ...consentState.token, revokedAt: new Date() };
      if (condition === "grant") consentState.grant = { id: "replacement", ownerUserId: "owner" };
      if (condition === "ban") consentState.account = { banned: true };
      if (condition === "deletion") consentState.account = { deletionRequestedAt: new Date() };
      if (condition === "equivalent") fixture.externalEquivalentModel = null;
      if (condition === "preference") tx.poolFallbackPreference.findFirst.mockResolvedValue(null);
      if (condition === "model")
        tx.providerModel.findFirst.mockResolvedValue({
          enabled: false,
          ProviderAccount: { enabled: true },
        });
      if (condition === "account")
        tx.providerModel.findFirst.mockResolvedValue({
          enabled: true,
          ProviderAccount: { enabled: false },
        });
      if (condition === "credential") tx.providerCredential.findFirst.mockResolvedValue(null);
      return { admitted: true, providerAttemptId: "anchor", reservationIds: ["reservation"] };
    });
    const beforeProviderSend = vi.fn();
    const result = await dispatchPublicOverflow({ ...request, beforeProviderSend });
    expect(beforeProviderSend).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("providerIoStarted");
    const expectedReason = ["token", "allowlist", "expired", "revoked"].includes(condition)
      ? "CALLER_CONSENT_WITHDRAWN"
      : condition === "grant"
        ? "REQUESTER_NOT_VISIBLE"
        : ["ban", "deletion"].includes(condition)
          ? "REQUESTER_ACCESS_BLOCKED"
          : ["equivalent", "preference"].includes(condition)
            ? "OWN_KEY_CONSENT_WITHDRAWN"
            : condition === "credential"
              ? "SEND_CLAIM_FAILED"
              : "PROVIDER_UNAVAILABLE";
    expect(result).toMatchObject({ dispatched: false, reason: expectedReason });
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(tx.providerCredential.update).not.toHaveBeenCalled();
  });
  it.each([
    "model-owner",
    "account-owner",
    "model-disabled",
    "account-disabled",
    "model-deleted",
    "account-deleted",
    "credential-revoked",
  ])("rejects invalid %s at listing", async (condition) => {
    const { request, model } = setup();
    if (condition === "model-owner") model.userId = "owner";
    if (condition === "account-owner") model.ProviderAccount.userId = "owner";
    if (condition === "model-disabled") model.enabled = false;
    if (condition === "account-disabled") model.ProviderAccount.enabled = false;
    if (condition === "model-deleted") Object.assign(model, { deletedAt: new Date() });
    if (condition === "account-deleted")
      Object.assign(model.ProviderAccount, { deletedAt: new Date() });
    if (condition === "credential-revoked")
      model.ProviderAccount.CurrentCredential.status = "REVOKED";
    expect((await dispatchPublicOverflow(request)).dispatched).toBe(false);
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  });
});

describe("OpenRouter data_collection privacy (D9)", () => {
  function poolFor(providerType: string, allowDataCollection: boolean) {
    const pool = dispatchPoolFixture("openai", "openai-chat", providerType);
    const model = pool.PoolMembers[0]!.ExecutionTarget.ProviderModel;
    Object.assign(model, { healthStatus: "HEALTHY", healthNextRetryAt: null });
    Object.assign(model.ProviderAccount, {
      allowDataCollection,
      healthStatus: "HEALTHY",
      healthNextRetryAt: null,
    });
    return pool;
  }

  async function dispatchWith({
    providerType,
    allowDataCollection,
    body,
    status = 200,
    responseBody = '{"choices":[]}',
  }: {
    providerType: string;
    allowDataCollection: boolean;
    body: string;
    status?: number;
    responseBody?: string;
  }) {
    providerHttpsRequest.mockReset();
    db.modelPool.findFirst.mockResolvedValue(poolFor(providerType, allowDataCollection));
    db.providerAttempt.groupBy.mockResolvedValue([]);
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "credential-heartbeat",
          credentialType: "BEARER",
          aadVersion: 1,
          algorithm: "AES-256-GCM",
          keyVersion: "v1",
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          authTag: new Uint8Array(),
        }),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
      },
    };
    db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    const upstream = Readable.from([Buffer.from(responseBody)]);
    Object.assign(upstream, {
      statusCode: status,
      headers: { "content-type": "application/json" },
      complete: true,
    });
    providerHttpsRequest.mockResolvedValueOnce(upstream);
    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(body),
      signal: new AbortController().signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });
    const sent = providerHttpsRequest.mock.calls[0]?.[1] as { body?: Uint8Array } | undefined;
    const sentBody = sent?.body
      ? (JSON.parse(new TextDecoder().decode(sent.body)) as Record<string, unknown>)
      : undefined;
    return { result, sentBody };
  }

  it("sends provider.data_collection deny to OpenRouter by default", async () => {
    const { result, sentBody } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: false,
      body: '{"model":"pool","messages":[]}',
    });
    expect(result.dispatched).toBe(true);
    expect(sentBody).toMatchObject({
      model: "upstream-model",
      provider: { data_collection: "deny" },
    });
  });

  it("keeps the caller's other provider keys but never lets it relax deny", async () => {
    const { sentBody } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: false,
      body: '{"model":"pool","provider":{"order":["a"],"data_collection":"allow"}}',
    });
    expect(sentBody?.provider).toEqual({ order: ["a"], data_collection: "deny" });
  });

  it("leaves the body alone when the account allows data collection", async () => {
    const { sentBody } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: true,
      body: '{"model":"pool","messages":[]}',
    });
    expect(sentBody).toEqual({ model: "upstream-model", messages: [] });
  });

  it("never adds the field for other provider types", async () => {
    for (const providerType of ["openai", "openai-compatible"]) {
      const { sentBody } = await dispatchWith({
        providerType,
        allowDataCollection: false,
        body: '{"model":"pool","messages":[]}',
      });
      expect(sentBody).toEqual({ model: "upstream-model", messages: [] });
    }
  });

  it("maps OpenRouter's data-policy 404 to a clear 503", async () => {
    const { result } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: false,
      body: '{"model":"pool"}',
      status: 404,
      responseBody:
        '{"error":{"message":"No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy","code":404}}',
    });
    if (!result.dispatched) throw new Error("expected dispatch");
    expect(result.response.status).toBe(503);
    const payload = (await result.response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("provider_data_policy_unavailable");
    expect(payload.error.message).toContain('data_collection: "deny"');
    await result.terminal;
  });

  it("passes other OpenRouter 404s through unchanged", async () => {
    const original = '{"error":{"message":"Model not found","code":404}}';
    const { result } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: false,
      body: '{"model":"pool"}',
      status: 404,
      responseBody: original,
    });
    if (!result.dispatched) throw new Error("expected dispatch");
    expect(result.response.status).toBe(404);
    expect(await result.response.text()).toBe(original);
  });

  it("does not map a data-policy 404 when the account allows data collection", async () => {
    const original =
      '{"error":{"message":"No endpoints found matching your data policy","code":404}}';
    const { result } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: true,
      body: '{"model":"pool"}',
      status: 404,
      responseBody: original,
    });
    if (!result.dispatched) throw new Error("expected dispatch");
    expect(result.response.status).toBe(404);
    expect(await result.response.text()).toBe(original);
  });
});
