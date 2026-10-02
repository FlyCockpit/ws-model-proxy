import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embeddedArgumentsRequest, nestedWire } from "./cache-affinity-canonical.test-fixtures.js";
import { CapacityLeaseLostError } from "./capacity/lease-loss.js";
import { mockRequesterValidityQuery } from "./external-consent.test-helper.js";
import {
  createProtocolAdaptationTransform,
  parseCanonicalRequest,
  renderCanonicalRequest,
} from "./protocols/adaptation.js";

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
  /** The pool owner's account when the requester is someone else (#76). */
  ownerAccount: null as null | Record<string, unknown>,
  /** The send claim's target re-read: listed member and provider model rows. */
  member: { id: "member" } as null | Record<string, unknown>,
  providerModel: { enabled: true, ProviderAccount: { enabled: true } } as null | Record<
    string,
    unknown
  >,
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
  consentState.ownerAccount = { banned: false, banExpires: null, deletionRequestedAt: null };
  consentState.member = { id: "member" };
  consentState.providerModel = { enabled: true, ProviderAccount: { enabled: true } };
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
import openRouterUsageFixture from "./fixtures/openrouter-usage.json";
import {
  claimProviderHealthTrial,
  recordProviderAttemptEvent,
} from "./provider-attempt-runtime.js";
import { admitProviderBudget } from "./provider-budget.js";
import { providerBillableTokens } from "./provider-budget-accounting.js";
import {
  dispatchPublicOverflow,
  listPublicOverflowTargets,
  matchesChatTestProviderMode,
  orderChatTestProviderTargets,
  POST_TERMINAL_DRAIN_MAX_BYTES,
  POST_TERMINAL_DRAIN_MAX_MS,
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
    poolOwner: { findUnique: async () => consentState.ownerAccount },
    poolMember: { findFirst: vi.fn(async () => consentState.member) },
    providerModel: { findFirst: vi.fn(async () => consentState.providerModel) },
    // The claim's transaction-local lock_timeout (L1b).
    $executeRaw: vi.fn(async () => 0),
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
    User: {
      banned: false,
      banExpires: null as Date | null,
      deletionRequestedAt: null as Date | null,
    },
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

it.each([
  { carrier: "conversation", body: true, invalid: false },
  { carrier: "conversation_id", body: true, invalid: false },
  { carrier: "prompt_cache_key", body: true, invalid: false },
  { carrier: "session-id", body: false, invalid: false },
  { carrier: "conversation", body: true, invalid: true },
  { carrier: "session-id", body: false, invalid: true },
])(
  "U3 pinned provider rank resolves $carrier invalid=$invalid with tenant isolation",
  async ({ carrier, body, invalid }) => {
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
    db.cacheAffinityRecord.findMany.mockResolvedValue([]);
    db.capacityLease.groupBy.mockResolvedValue([]);
    db.capacityWaiter.groupBy.mockResolvedValue([]);
    const listed = await listPublicOverflowTargets("owner", "pool");
    expect(listed.targets).toHaveLength(1);
    const value = invalid ? "bad#id" : "client";
    const payload = {
      model: "pool",
      messages: [{ role: "user", content: "starter" }],
      ...(body ? { [carrier]: value } : {}),
    };
    const request = {
      userId: "owner",
      poolId: "pool",
      requestId: "carrier-rank",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
      ...ownerConsentFields(),
      requestedProtocol: "openai" as const,
      requestedSurface: "openai-chat" as const,
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      signal: new AbortController().signal,
      liability: { accountingVersion: "provider-billable-v1" as const },
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
      affinityTenantUserId: "tenant",
      affinitySecurityScope: "token",
      affinityAccessGrantId: "grant",
      affinityHeaders: new Headers(body ? {} : { [carrier]: value }),
      body: new TextEncoder().encode(JSON.stringify(payload)),
    };
    const ranked = await rankPublicOverflowTargets({
      request,
      policy: listed.affinityPolicy,
      targets: listed.targets,
    });
    const target = ranked.targets[0]!;
    const { affinityPrefixDigests } = await import("./cache-affinity.js");
    const material = affinityPrefixDigests({
      ownerId: "tenant",
      resourceOwnerId: "owner",
      poolId: "pool",
      securityScope: "token",
      accessGrantId: "grant",
      surface: "openai-chat",
      payload,
      headers: request.affinityHeaders,
      runtimeIdentity: target.affinityTarget!.targetIdentity,
    });
    expect(ranked.decision?.matchedSessionIds?.[target.executionTargetId]).toBe(
      material.clientSessionId,
    );
    expect(material.clientSessionId === undefined).toBe(invalid);
    if (!invalid)
      expect(
        affinityPrefixDigests({
          ownerId: "other-tenant",
          resourceOwnerId: "owner",
          poolId: "pool",
          securityScope: "token",
          accessGrantId: "grant",
          surface: "openai-chat",
          payload,
          headers: request.affinityHeaders,
          runtimeIdentity: target.affinityTarget!.targetIdentity,
        }).clientSessionId,
      ).not.toBe(material.clientSessionId);
  },
);

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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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

// #76 (owner lifecycle) and N6-1 (claim denial vs abort classification): the
// pool owner's account is re-checked at dispatch entry and after the send
// claim's last lock wait; a denial the claim returns is returned as such even
// when the request or its capacity lease was aborted meanwhile, and no other
// member is tried after it.
describe("pool owner lifecycle and claim-denial classification at the send boundary", () => {
  const start = new Date("2026-09-26T12:00:00.000Z");

  function twoMemberFixture() {
    const fixture = dispatchPoolFixture();
    const first = fixture.PoolMembers[0]!;
    const second = structuredClone(first);
    second.id = "member-second";
    second.publicOrder = 1;
    second.ExecutionTarget.id = "target-second";
    second.ExecutionTarget.ProviderModel.id = "model-second";
    second.ExecutionTarget.ProviderModel.ProviderAccount.id = "account-second";
    second.ExecutionTarget.ProviderModel.ProviderAccount.CurrentCredential.id = "credential-second";
    fixture.PoolMembers.push(second);
    fixture.fallbackForGrantees = true;
    return fixture;
  }

  function arrange(onAccountLock: () => void, fixture = twoMemberFixture()) {
    providerHttpsRequest.mockReset();
    reconcileProviderBudget.mockClear();
    releaseProviderHealthTrial.mockClear();
    recordProviderOutcome.mockClear();
    db.$transaction.mockClear();
    consentState.token = { ...consentState.token, userId: "grantee" };
    consentState.grant = currentGrant();
    db.modelPool.findFirst.mockImplementation(async () => structuredClone(fixture));
    const accountLocks: string[] = [];
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("").includes('AS "requesterValid"'))
          return mockRequesterValidityQuery(strings, values, consentDelegates());
        if (strings.join("?").includes("FROM provider_account")) {
          accountLocks.push(String(values[0]));
          onAccountLock();
        }
        return [];
      }),
      // D9: the account's privacy policy, read under the account lock.
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
      providerCredential: {
        findFirst: vi.fn(
          async () =>
            fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount.CurrentCredential,
        ),
        update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
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
    return { tx, accountLocks };
  }

  const granteeRequest = (signal: AbortSignal = new AbortController().signal) => ({
    userId: "owner",
    poolId: "pool",
    requestId: "owner-lifecycle",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
    ...ownerConsentFields("grantee"),
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-chat" as const,
    stream: false,
    requiredFeatures: [],
    path: "/v1/chat/completions",
    headers: new Headers(),
    body: new TextEncoder().encode('{"model":"pool","messages":[]}'),
    signal,
    liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
    requestedOutputTokens: 1n,
    releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
    adaptationEnabled: false,
    // Retry-safe with two members: a non-denial failure would move on.
    retrySafe: true,
  });

  const banned = { banned: true, banExpires: null, deletionRequestedAt: null };

  it.each([
    ["is banned indefinitely", () => banned, "POOL_OWNER_INACTIVE"],
    [
      "gets a temporary ban",
      () => ({
        banned: true,
        banExpires: new Date(Date.now() + 60_000),
        deletionRequestedAt: null,
      }),
      "POOL_OWNER_INACTIVE",
    ],
    [
      "is marked for deletion",
      () => ({ banned: false, banExpires: null, deletionRequestedAt: new Date() }),
      "POOL_OWNER_INACTIVE",
    ],
    ["stays active (control)", () => consentState.ownerAccount, null],
  ] as const)(
    "refuses a grantee's send when the owner %s while the claim waits on provider locks",
    async (_label, ownerState, reason) => {
      const { tx, accountLocks } = arrange(() => {
        consentState.ownerAccount = ownerState();
      });
      const result = await dispatchPublicOverflow(granteeRequest());
      if (reason === null) {
        expect(result.dispatched).toBe(true);
        if (result.dispatched) {
          await result.response.text();
          await result.terminal;
        }
        return;
      }
      expect(result).toEqual({ dispatched: false, reason });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(tx.providerCredential.update).not.toHaveBeenCalled();
      // Request-wide: the second member is never claimed.
      expect(accountLocks).toEqual(["account-heartbeat"]);
    },
  );

  it("serves again once the owner's temporary ban has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    try {
      const expiring = {
        banned: true,
        banExpires: new Date(start.getTime() + 1_000),
        deletionRequestedAt: null,
      };
      const fixture = twoMemberFixture();
      fixture.User = { ...expiring };
      consentState.ownerAccount = { ...expiring };
      arrange(() => undefined, fixture);
      await expect(dispatchPublicOverflow(granteeRequest())).resolves.toEqual({
        dispatched: false,
        reason: "POOL_OWNER_INACTIVE",
      });
      // No claim transaction: refused at dispatch entry.
      expect(db.$transaction).not.toHaveBeenCalled();
      vi.setSystemTime(new Date(start.getTime() + 1_001));
      arrange(() => undefined, fixture);
      const result = await dispatchPublicOverflow(granteeRequest());
      expect(result.dispatched).toBe(true);
      if (result.dispatched) {
        await result.response.text();
        await result.terminal;
      }
      expect(providerHttpsRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // #64 decision: a member removed or a provider model disabled between
  // listing and the claim is not sent to; it is availability, so the next
  // member is tried only for a retry-safe operation.
  it.each([
    ["member removed", "member", true],
    ["member removed", "member", false],
    ["provider model disabled", "model", true],
    ["provider model disabled", "model", false],
  ] as const)(
    "on %s at the claim (retry-safe %s) tries the next member only when retry-safe",
    async (_label, change, retrySafe) => {
      let claims = 0;
      const { tx, accountLocks } = arrange(() => {
        claims += 1;
        if (claims === 1) {
          if (change === "member") consentState.member = null;
          else consentState.providerModel = { enabled: false, ProviderAccount: { enabled: true } };
        } else {
          consentState.member = { id: "member" };
          consentState.providerModel = { enabled: true, ProviderAccount: { enabled: true } };
        }
      });
      const result = await dispatchPublicOverflow({ ...granteeRequest(), retrySafe });
      if (retrySafe) {
        expect(result.dispatched).toBe(true);
        if (result.dispatched) {
          await result.response.text();
          await result.terminal;
        }
        expect(accountLocks).toEqual(["account-heartbeat", "account-second"]);
        expect(providerHttpsRequest).toHaveBeenCalledTimes(1);
        expect(tx.providerCredential.update).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toEqual({ dispatched: false, reason: "PROVIDER_UNAVAILABLE" });
        expect(accountLocks).toEqual(["account-heartbeat"]);
        expect(providerHttpsRequest).not.toHaveBeenCalled();
        expect(tx.providerCredential.update).not.toHaveBeenCalled();
      }
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: expect.any(String), dispatchOutcome: "NOT_SENT" }),
      );
    },
  );

  it.each([
    ["the client disconnected", "client"],
    ["the capacity lease ownership was lost", "lease"],
  ] as const)(
    "returns a claim denial, not SEND_CLAIM_FAILED, when %s during the claim",
    async (_label, abortKind) => {
      const controller = new AbortController();
      const { tx, accountLocks } = arrange(() => {
        // The requester's account is marked for deletion and, in the same
        // window, the request (client) or its lease signal (the dispatcher's
        // request signal is the lease signal) is aborted.
        consentState.account = { banned: false, banExpires: null, deletionRequestedAt: new Date() };
        controller.abort(
          new Error(abortKind === "client" ? "client disconnected" : "capacity lease lost"),
        );
      });
      const result = await dispatchPublicOverflow(granteeRequest(controller.signal));
      expect(result).toEqual({ dispatched: false, reason: "REQUESTER_ACCESS_BLOCKED" });
      expect(accountLocks).toEqual(["account-heartbeat"]);
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(tx.providerCredential.update).not.toHaveBeenCalled();
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "CANCELLED", dispatchOutcome: "NOT_SENT" }),
      );
    },
  );
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      affinityHeaders: new Headers({ "x-session-id": "ranking-client" }),
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

    const { affinityPrefixDigests } = await import("./cache-affinity.js");
    for (const target of ranked.targets) {
      expect(ranked.decision?.matchedSessionIds?.[target.executionTargetId]).toBe(
        affinityPrefixDigests({
          ownerId: "owner",
          resourceOwnerId: "owner",
          poolId: "pool",
          surface: "openai-chat",
          payload: { model: "pool", messages: [{ role: "user", content: "x" }] },
          headers: request.affinityHeaders,
          runtimeIdentity: target.affinityTarget!.targetIdentity,
        }).clientSessionId,
      );
    }

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
    expect(
      mixedCurrency.targets.every((target) => target.affinity?.reason?.includes("costPenalty:0")),
    ).toBe(true);

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
    expect(
      incompletePricing.targets.every((target) =>
        target.affinity?.reason?.includes("costPenalty:0"),
      ),
    ).toBe(true);
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      User: { banned: false, banExpires: null, deletionRequestedAt: null },
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
      User: { banned: false, banExpires: null, deletionRequestedAt: null },
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
        affinityHeaders: new Headers({ "session-id": "overflow-client" }),
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
      expect(rememberAffinity.mock.calls[0]?.[0].headers.get("session-id")).toBe("overflow-client");
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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

  it.each([
    [
      "a client cancellation",
      () => new Error("client disconnected"),
      "CANCELLED",
      "CANCELLED",
      "CANCELLED",
    ],
    // F2-CAP-3: a lost capacity lease is a server-side failure, never a cancel.
    [
      "a capacity lease loss",
      () => new CapacityLeaseLostError("ownership_lost"),
      "FAILED",
      "CAPACITY_LEASE_LOST",
      "FAILED",
    ],
  ] as const)(
    "settles %s before provider I/O as not sent with no health verdict",
    async (_label, abortReason, budgetReason, eventReason, terminalState) => {
      recordProviderOutcome.mockClear();
      db.modelPool.findFirst.mockResolvedValue({
        fallbackEnabled: true,
        User: { banned: false, banExpires: null, deletionRequestedAt: null },
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
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      controller.abort(abortReason());
      providerHttpsRequest.mockReset();
      reconcileProviderBudget.mockClear();
      vi.mocked(recordProviderAttemptEvent).mockClear();

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
        expect.objectContaining({ reason: budgetReason, dispatchOutcome: "NOT_SENT" }),
      );
      expect(recordProviderAttemptEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "TERMINAL", reason: eventReason, terminalState }),
      );
    },
  );

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
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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

  it("rejects a late response without recording a retryable failure after heartbeat ownership is lost", async () => {
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
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      await expect(result.response.text()).rejects.toThrow("provider attempt lease expired");
      expect(await result.terminal).toMatchObject({ ok: false });
      expect(recordProviderOutcome).not.toHaveBeenCalled();
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "FAILED",
          observationComplete: false,
          usageSource: "missing-provider-usage",
          usage: undefined,
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

  // F2-CAP-3 (C1a-4/C1b-2/C1b-1): the capacity wrapper cancels the provider
  // body when its lease is lost (mid-stream or at the hand-off refusal). That
  // cancel must settle the attempt (heartbeat stopped, budget reconciled,
  // terminal resolved) as a server-side FAILED, never as a client CANCELLED;
  // a genuine client cancel keeps CANCELLED.
  it.each([
    [
      "lease loss",
      () => new CapacityLeaseLostError("ownership_lost"),
      "FAILED",
      "CAPACITY_LEASE_LOST",
      "FAILED",
    ],
    [
      "client cancel",
      () => new Error("client disconnected"),
      "CANCELLED",
      "CANCELLED",
      "CANCELLED",
    ],
  ] as const)(
    "settles a cancelled provider body on %s with the right outcome",
    async (_label, abortReason, budgetReason, eventReason, terminalState) => {
      recordProviderOutcome.mockClear();
      reconcileProviderBudget.mockClear();
      vi.mocked(recordProviderAttemptEvent).mockClear();
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      const upstream = new Readable({ read() {} });
      Object.assign(upstream, {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
      });
      providerHttpsRequest.mockImplementationOnce(async () => upstream);
      const controller = new AbortController();
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-cancel-settle",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: true,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode('{"model":"pool","stream":true}'),
        signal: controller.signal,
        liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 1n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });
      if (!result.dispatched) throw new Error("expected a committed provider response");
      // Nothing ever reads the body: only the cancel can settle the attempt.
      const reason = abortReason();
      controller.abort(reason);
      await result.response.body?.cancel(reason);
      await result.terminal;
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: budgetReason }),
      );
      expect(recordProviderAttemptEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "TERMINAL", reason: eventReason, terminalState }),
      );
      expect(recordProviderOutcome).not.toHaveBeenCalled();
    },
  );

  it("records one outcome when a lease loss lands during the settle of a client-cancelled attempt", async () => {
    recordProviderOutcome.mockClear();
    reconcileProviderBudget.mockClear();
    vi.mocked(recordProviderAttemptEvent).mockClear();
    db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
    const upstream = new Readable({ read() {} });
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
    });
    providerHttpsRequest.mockImplementationOnce(async () => upstream);
    const controller = new AbortController();
    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-cancel-race",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(),
      requestedProtocol: "openai",
      requestedSurface: "openai-chat",
      stream: true,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"pool","stream":true}'),
      signal: controller.signal,
      liability: { tokens: 10n, accountingVersion: "provider-billable-v1" },
      requestedOutputTokens: 1n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });
    if (!result.dispatched) throw new Error("expected a committed provider response");
    // Nothing ever reads the body: only the cancel can settle the attempt.
    // The client cancels the body; the lease is then lost DURING the budget
    // write. One attempt must not be split into different outcomes.
    reconcileProviderBudget.mockImplementationOnce(async () => {
      controller.abort(new CapacityLeaseLostError("ownership_lost"));
    });
    await result.response.body?.cancel(new Error("client disconnected"));
    await result.terminal;
    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CANCELLED" }),
    );
    expect(recordProviderAttemptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "TERMINAL",
        reason: "CANCELLED",
        terminalState: "CANCELLED",
      }),
    );
    expect(recordProviderOutcome).not.toHaveBeenCalled();
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
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
    expect(vi.mocked(admitProviderBudget).mock.calls[0]?.[0].poolGrantId).toBeUndefined();
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
  it("settles OpenRouter own-key usage to the requester below the reservation", async () => {
    const { request, model } = setup();
    model.ProviderAccount.providerType = "openrouter";
    reconcileProviderBudget.mockClear();
    providerHttpsRequest.mockReset().mockResolvedValue(
      Object.assign(
        Readable.from([Buffer.from(JSON.stringify(openRouterUsageFixture.nonStream))]),
        {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          complete: true,
        },
      ),
    );
    const liability = { tokens: 5_000n, accountingVersion: "provider-billable-v1" };
    const result = await dispatchPublicOverflow({ ...request, liability });
    if (!result.dispatched) throw new Error("expected dispatch");
    await result.response.text();
    await result.terminal;
    expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
    const settled = reconcileProviderBudget.mock.calls[0]?.[0];
    expect(settled).toMatchObject({
      userId: "grantee",
      poolId: undefined,
      observationComplete: true,
      usage: { categoriesComplete: true, cacheReadTokens: 600n, cacheWriteTokens: 0n },
    });
    expect(providerBillableTokens(settled.usage)).toBe(1_280n);
    expect(providerBillableTokens(settled.usage)! < liability.tokens).toBe(true);
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

describe("OpenRouter owner-paid settlement", () => {
  const liability = { tokens: 5_000n, accountingVersion: "provider-billable-v1" };
  async function startOwnerStream(
    providerType: string,
    upstream:
      | Buffer[]
      | Readable
      | typeof import("@ws-model-proxy/api/lib/provider-egress").providerHttpsRequest,
    requester: "owner" | "grantee" = "owner",
    surface: "openai-chat" | "openai-responses" | "anthropic-messages" = "openai-chat",
    transportComplete = true,
  ) {
    const protocol = surface === "anthropic-messages" ? "anthropic" : "openai";
    reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
    providerHttpsRequest.mockReset();
    db.modelPool.findFirst.mockResolvedValue({
      ...dispatchPoolFixture(protocol, surface, providerType),
      fallbackForGrantees: requester === "grantee",
    });
    if (requester === "grantee") {
      consentState.token = { ...consentState.token, userId: "grantee" };
      consentState.grant = currentGrant();
    }
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: {
        findFirst: vi.fn().mockResolvedValue({ providerType, allowDataCollection: false }),
      },
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
    if (typeof upstream === "function") providerHttpsRequest.mockImplementationOnce(upstream);
    else
      providerHttpsRequest.mockResolvedValueOnce(
        upstream instanceof IncomingMessage
          ? upstream
          : Object.assign(Array.isArray(upstream) ? Readable.from(upstream) : upstream, {
              statusCode: 200,
              headers: { "content-type": "text/event-stream" },
              complete: transportComplete,
            }),
      );
    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: `request-openrouter-${providerType}`,
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      ...ownerConsentFields(requester),
      requestedProtocol: protocol,
      requestedSurface: surface,
      stream: true,
      requiredFeatures: [],
      path:
        surface === "anthropic-messages"
          ? "/v1/messages"
          : surface === "openai-responses"
            ? "/v1/responses"
            : "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"pool","stream":true}'),
      signal: new AbortController().signal,
      liability,
      requestedOutputTokens: 10n,
      releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
      adaptationEnabled: false,
      retrySafe: false,
    });
    if (!result.dispatched) throw new Error("expected dispatch");
    return result;
  }

  async function settleOwnerStream(
    providerType: string,
    upstream: Buffer[],
    requester: "owner" | "grantee" = "owner",
    surface: "openai-chat" | "openai-responses" | "anthropic-messages" = "openai-chat",
  ) {
    const result = await startOwnerStream(providerType, upstream, requester, surface);
    await result.response.text();
    await result.terminal;
    expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
    return reconcileProviderBudget.mock.calls[0]?.[0];
  }

  const pricingRow = () => ({
    id: "price",
    version: "price-1",
    currency: "USD",
    accountingVersion: "provider-billable-v1",
    confidence: "CALCULATED",
    effectiveAt: new Date(0),
    pricing: { ratesPerMillion: { input: "1", output: "4", cacheRead: "0.1" } },
    chargeRules: {
      inputIncludesCacheRead: false,
      inputIncludesCacheWrite: false,
      outputIncludesReasoning: false,
      outputIncludesTool: false,
      reasoningAllowanceTokens: 0,
      toolAllowanceTokens: 0,
      cacheReadAllowanceTokens: 0,
      cacheWriteAllowanceTokens: 0,
      additionalAllowanceTokens: 0,
      unknownCategories: "FAIL_CLOSED",
    },
  });

  describe("terminal billing drain (#140)", () => {
    beforeEach(() => {
      db.providerPricingVersion.findFirst.mockResolvedValue(pricingRow());
    });
    afterEach(() => {
      db.providerPricingVersion.findFirst.mockReset();
    });

    const record = (type: string, payload: Record<string, unknown> = {}) =>
      Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    const responsesUsage = (output: number, cost: number) => ({
      input_tokens: 10,
      output_tokens: output,
      total_tokens: 10 + output,
      cost,
      is_byok: false,
    });
    const messagesUsage = (output: number, cost: number) => ({
      input_tokens: 10,
      output_tokens: output,
      cost,
      is_byok: false,
    });
    const responsesTerminal = record("response.completed", {
      response: { status: "completed", usage: responsesUsage(14, 0.00008) },
    });
    const lowResponsesTerminal = record("response.completed", {
      response: { status: "completed", usage: responsesUsage(1, 0.000015) },
    });
    const messageDelta = (output: number, cost: number) =>
      record("message_delta", { usage: messagesUsage(output, cost) });
    const messageStop = record("message_stop");
    const done = Buffer.from("data: [DONE]\n\n");
    const providers = [
      { providerType: "openrouter", surface: "openai-responses" },
      { providerType: "openrouter", surface: "anthropic-messages" },
      { providerType: "openai-compatible", surface: "openai-responses" },
    ] as const;
    const scenarios = [
      "conflicting usage",
      "trailing failure",
      "invalid JSON",
      "partial record",
      "invalid UTF-8",
      "unfinished UTF-8",
      "clean EOF",
      "clean sentinel",
    ] as const;
    const cases = providers.flatMap((provider) =>
      scenarios.map((scenario) => ({ ...provider, scenario })),
    );

    // The clean controls intentionally pass on master: an honest provider that
    // closes promptly must still settle fully and deliver its terminal bytes.
    // Every adverse row detects discarded records or skipped decoder.finish().
    it.each(cases)(
      "$providerType $surface: $scenario settles identically across byte boundaries",
      async ({ providerType, surface, scenario }) => {
        const messages = surface === "anthropic-messages";
        const terminalRecords = messages
          ? [messageDelta(14, 0.00008), messageStop]
          : [responsesTerminal];
        let records: Buffer[];
        if (scenario === "conflicting usage") {
          records = messages
            ? [messageDelta(1, 0.000015), messageStop, messageDelta(14, 0.00008)]
            : [lowResponsesTerminal, responsesTerminal];
        } else {
          const tail = {
            "trailing failure": record(messages ? "error" : "response.failed", {
              error: { type: "upstream_error" },
            }),
            "invalid JSON": Buffer.from("data: {invalid JSON}\n\n"),
            "partial record": Buffer.from('data: {"usage":'),
            "invalid UTF-8": Buffer.concat([
              Buffer.from("data: "),
              Buffer.from([0xff]),
              Buffer.from("\n\n"),
            ]),
            "unfinished UTF-8": Buffer.from([0xe2, 0x82]),
            "clean EOF": Buffer.alloc(0),
            "clean sentinel": done,
          }[scenario];
          records = [...terminalRecords, ...(tail.length ? [tail] : [])];
        }
        const bytes = Buffer.concat(records);
        const splits = [
          [bytes],
          records,
          // One extra transport boundary inside each record, not just at SSE boundaries.
          records.flatMap((frame) => {
            const mid = Math.max(1, Math.floor(frame.length / 2));
            return [frame.subarray(0, mid), frame.subarray(mid)];
          }),
        ];
        const snapshots = [];
        for (const chunks of splits) {
          expect(Buffer.concat(chunks)).toEqual(bytes);
          const result = await startOwnerStream(providerType, chunks, "owner", surface);
          let streamError: unknown;
          let delivered = "";
          try {
            delivered = await result.response.text();
          } catch (error) {
            streamError = error;
          }
          const terminal = await result.terminal;
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          const settled = reconcileProviderBudget.mock.calls[0]![0];
          const usage = settled.usage;
          // Undecodable bytes in a single chunk can yield no usage at all,
          // while split bytes retain audit evidence. Neither has settleable
          // categories; compare the billing facts, with absence represented as false.
          snapshots.push({
            observationComplete: settled.observationComplete,
            categoriesComplete: usage?.categoriesComplete ?? false,
            billableTokens: usage ? providerBillableTokens(usage) : undefined,
            cost: usage?.reportedCost?.toString(),
            calculatedCost: usage?.calculatedCost?.toString(),
            reason: settled.reason,
            ok: terminal.ok,
            error: streamError instanceof Error ? streamError.message : undefined,
          });
          if (scenario.startsWith("clean")) {
            const terminalFrame = terminalRecords.at(-1)!;
            expect(delivered).toContain(terminalFrame.toString());
            expect(settled.observationComplete).toBe(true);
            expect(terminal.ok).toBe(true);
            if (providerType === "openrouter") {
              expect(usage.categoriesComplete).toBe(true);
              expect(providerBillableTokens(usage)).toBe(24n);
              expect(usage.reportedCost.toString()).toBe("0.00008");
            }
          } else if (scenario === "conflicting usage") {
            expect(usage.categoriesComplete).toBe(false);
            expect(providerBillableTokens(usage)).toBeUndefined();
            // The generic dialect rejects OpenRouter's token vocabulary, but
            // still retains the latest reported cost. It must see the real cost.
            expect(usage.reportedCost?.toString()).toBe(
              providerType === "openrouter" ? undefined : "0.00008",
            );
            expect(settled.observationComplete).toBe(true);
            expect(terminal.ok).toBe(true);
          } else if (scenario === "trailing failure") {
            expect(settled).toMatchObject({ reason: "FAILED", observationComplete: false });
            expect(terminal.ok).toBe(false);
          } else if (scenario === "invalid JSON") {
            // Non-JSON data is valid SSE: the existing OpenRouter collector
            // rejects usage. The generic row is a control that also passes on
            // master: that dialect ignores JSON errors and keeps audit usage.
            expect(streamError).toBeUndefined();
            if (providerType === "openrouter") {
              expect(usage.categoriesComplete).toBe(false);
              expect(usage.reportedCost).toBeUndefined();
            }
          } else {
            expect(settled).toMatchObject({ reason: "FAILED", observationComplete: false });
            expect(terminal.ok).toBe(false);
            expect(streamError).toBeInstanceOf(Error);
          }
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
        expect(snapshots[2]).toEqual(snapshots[0]);
      },
    );

    it.each([false, true])(
      "keeps native compatible-provider accounting (conflict %s)",
      async (conflict) => {
        const nativeTerminal = (output: number, cost: number) =>
          record("response.completed", {
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output, cost },
            },
          });
        const final = nativeTerminal(14, 0.00008);
        const records = conflict ? [nativeTerminal(1, 0.000015), final] : [final, done];
        // The no-conflict row is an inverse-failure control that passes on master.
        // The generic parser accepts the final snapshot in its own vocabulary.
        for (const chunks of [[Buffer.concat(records)], records]) {
          const result = await startOwnerStream(
            "openai-compatible",
            chunks,
            "owner",
            "openai-responses",
          );
          expect(await result.response.text()).toContain("event: response.completed");
          expect(await result.terminal).toMatchObject({ ok: true });
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          const settled = reconcileProviderBudget.mock.calls[0]![0];
          expect(settled.observationComplete).toBe(true);
          expect(settled.usage.categoriesComplete).toBe(true);
          expect(providerBillableTokens(settled.usage)).toBe(24n);
          expect(settled.usage.reportedCost.toString()).toBe("0.00008");
        }
      },
    );

    it("retains liability when EOF follows a terminal without transport completion", async () => {
      const result = await startOwnerStream(
        "openrouter",
        [responsesTerminal],
        "owner",
        "openai-responses",
        false,
      );
      expect(await result.response.text()).toBe(responsesTerminal.toString());
      expect(await result.terminal).toMatchObject({ ok: false });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "FAILED",
          observationComplete: false,
          usage: expect.objectContaining({ categoriesComplete: false }),
        }),
      );
    });

    it("holds a clean EOF terminal until settlement is durable", async () => {
      vi.useFakeTimers();
      const upstream = new Readable({ read() {} });
      let releaseSettlement!: () => void;
      const durable = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      try {
        const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
        vi.mocked(recordProviderAttemptEvent).mockClear();
        reconcileProviderBudget.mockImplementationOnce(() => durable);
        const reader = result.response.body!.getReader();
        let delivered = false;
        const first = reader.read().then((chunk) => {
          delivered = true;
          return chunk;
        });
        upstream.push(responsesTerminal);
        upstream.push(null);
        await vi.advanceTimersByTimeAsync(0);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        releaseSettlement();
        expect(Buffer.from((await first).value!).toString()).toBe(responsesTerminal.toString());
        expect(await reader.read()).toMatchObject({ done: true });
        expect(await result.terminal).toMatchObject({ ok: true });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "COMPLETED",
            observationComplete: true,
            usage: expect.objectContaining({ categoriesComplete: true }),
          }),
        );
        expect(recordProviderAttemptEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: "TERMINAL",
            metadata: expect.objectContaining({ streamComplete: true }),
          }),
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseSettlement();
        upstream.destroy();
        vi.useRealTimers();
      }
    });

    it.each(["before settlement", "during health write", "during budget write"] as const)(
      "snapshots one cancellation outcome: $0",
      async (timing) => {
        vi.useFakeTimers();
        const upstream = new Readable({ objectMode: true, read() {} });
        const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
        const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
        const close = vi.spyOn(ReadableStreamDefaultController.prototype, "close");
        const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
        let releaseSettlement!: () => void;
        const durable = new Promise<void>((resolve) => {
          releaseSettlement = resolve;
        });
        let enteredSettlement = false;
        const hold = async () => {
          enteredSettlement = true;
          await durable;
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let cancellation: Promise<void> | undefined;
        try {
          const result = await startOwnerStream(
            "openrouter",
            upstream,
            "owner",
            "openai-responses",
            false,
          );
          vi.mocked(recordProviderAttemptEvent).mockClear();
          if (timing === "during health write") recordProviderOutcome.mockImplementationOnce(hold);
          if (timing === "during budget write")
            reconcileProviderBudget.mockImplementationOnce(hold);
          reader = result.response.body!.getReader();
          const first = reader.read();
          upstream.push(responsesTerminal);
          await vi.advanceTimersByTimeAsync(0);
          if (timing !== "before settlement") {
            await vi.advanceTimersByTimeAsync(POST_TERMINAL_DRAIN_MAX_MS);
            expect(enteredSettlement).toBe(true);
          }
          cancellation = reader.cancel("client disconnected around settlement");
          releaseSettlement();
          await cancellation;
          expect(await first).toMatchObject({ done: true });
          const cancelled = timing === "before settlement";
          expect(await result.terminal).toMatchObject({ ok: !cancelled });
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          expect(reconcileProviderBudget).toHaveBeenCalledWith(
            expect.objectContaining({
              reason: cancelled ? "CANCELLED" : "COMPLETED",
              observationComplete: false,
            }),
          );
          const terminalEvents = vi
            .mocked(recordProviderAttemptEvent)
            .mock.calls.filter(([event]) => event.eventType === "TERMINAL");
          expect(terminalEvents).toHaveLength(1);
          expect(terminalEvents[0]?.[0]).toMatchObject({
            reason: cancelled ? "CANCELLED" : "COMPLETED",
            terminalState: cancelled ? "CANCELLED" : "COMPLETED",
            metadata: { streamComplete: false },
          });
          expect(upstream.destroyed).toBe(true);
          expect(cancel).toHaveBeenCalledTimes(2); // client and one upstream cancellation
          expect(vi.getTimerCount()).toBe(0);
          vi.useRealTimers();
          for (let turn = 0; turn < 3; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          const upstreamController = enqueue.mock.contexts[0];
          expect(upstreamController).toBeDefined();
          for (const action of [enqueue, close, error]) {
            expect(
              action.mock.contexts.filter((context) => context !== upstreamController),
            ).toEqual([]);
          }
        } finally {
          releaseSettlement();
          await cancellation;
          await reader?.cancel().catch(() => undefined);
          upstream.pause();
          upstream.destroy();
          vi.useRealTimers();
          // Keep spies installed until this adapter's eos callbacks finish,
          // so they cannot be mistaken for the next row's client controller.
          for (let turn = 0; turn < 3; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          cancel.mockRestore();
          enqueue.mockRestore();
          close.mockRestore();
          error.mockRestore();
        }
      },
    );

    it.each(["split", "coalesced", "terminal split"] as const)(
      "does not charge >=256 KiB of pre-terminal content to the drain: $0",
      async (chunking) => {
        const prefix = record("response.output_text.delta", { delta: "é".repeat(160 * 1024) });
        expect(prefix.byteLength).toBeGreaterThanOrEqual(POST_TERMINAL_DRAIN_MAX_BYTES);
        const tail = Buffer.from(": small tail\n\n");
        const chunks =
          chunking === "coalesced"
            ? [Buffer.concat([prefix, responsesTerminal, tail])]
            : chunking === "terminal split"
              ? [
                  Buffer.concat([prefix, responsesTerminal.subarray(0, 19)]),
                  Buffer.concat([responsesTerminal.subarray(19), tail]),
                ]
              : [prefix, responsesTerminal, tail];
        const result = await startOwnerStream("openrouter", chunks, "owner", "openai-responses");
        expect(await result.response.text()).toContain(prefix.toString());
        expect(await result.terminal).toMatchObject({
          ok: true,
          responseBytes: prefix.byteLength + responsesTerminal.byteLength + tail.byteLength,
        });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "COMPLETED",
            observationComplete: true,
            usage: expect.objectContaining({ categoriesComplete: true }),
          }),
        );
      },
    );

    // The small tail is a legitimate control; an oversized tail must retain
    // liability for split, coalesced and partially coalesced transport chunks.
    it.each([
      { name: "small", tailBytes: 8 * 1024, complete: true },
      {
        name: "over budget",
        tailBytes: POST_TERMINAL_DRAIN_MAX_BYTES + 64 * 1024,
        complete: false,
      },
    ])("counts $name trailing bytes inside the held chunk", async ({ tailBytes, complete }) => {
      const tail = Buffer.from(`: ${"x".repeat(tailBytes - 4)}\n\n`);
      expect(tail.byteLength).toBe(tailBytes);
      const chunkings = [
        [responsesTerminal, tail],
        [Buffer.concat([responsesTerminal, tail])],
        [Buffer.concat([responsesTerminal, tail.subarray(0, 1024)]), tail.subarray(1024)],
      ];
      for (const chunks of chunkings) {
        const result = await startOwnerStream("openrouter", chunks, "owner", "openai-responses");
        expect(await result.response.text()).toContain(responsesTerminal.toString());
        expect(await result.terminal).toMatchObject({
          ok: true,
          responseBytes: responsesTerminal.byteLength + tailBytes,
        });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "COMPLETED",
            observationComplete: complete,
            usage: expect.objectContaining({ categoriesComplete: complete }),
          }),
        );
      }
    });

    it("does not restart the drain deadline when post-terminal bytes arrive", async () => {
      vi.useFakeTimers();
      const upstream = new Readable({ objectMode: true, read() {} });
      let body: Promise<string> | undefined;
      try {
        upstream.push(responsesTerminal);
        const result = await startOwnerStream(
          "openrouter",
          upstream,
          "owner",
          "openai-responses",
          false,
        );
        body = result.response.text();
        void body.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(POST_TERMINAL_DRAIN_MAX_MS / 2);
        upstream.push(Buffer.from(": still open\n\n"));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(POST_TERMINAL_DRAIN_MAX_MS / 2 - 1);
        expect(reconcileProviderBudget).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(await body).toBe(responsesTerminal.toString());
        expect(await result.terminal).toMatchObject({ ok: true });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({ observationComplete: false }),
        );
        expect(upstream.destroyed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        upstream.destroy();
        // A failed assertion (including under mutation) must not leave this
        // drain settling into the next case's fresh mocks.
        await body?.catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it("holds the terminal through the time bound and durable settlement, then cancels", async () => {
      vi.useFakeTimers();
      const upstream = new Readable({ read() {} });
      const destroy = vi.spyOn(upstream, "destroy");
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      let releaseSettlement!: () => void;
      const durable = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      try {
        expect(POST_TERMINAL_DRAIN_MAX_MS).toBe(2_000);
        heartbeatProviderAttempt.mockClear();
        upstream.push(responsesTerminal);
        const result = await startOwnerStream(
          "openrouter",
          upstream,
          "owner",
          "openai-responses",
          false,
        );
        reconcileProviderBudget.mockImplementationOnce(() => durable);
        const reader = result.response.body!.getReader();
        let delivered = false;
        const first = reader.read().then((chunk) => {
          delivered = true;
          return chunk;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(2); // heartbeat plus pending accounting read
        await vi.advanceTimersByTimeAsync(POST_TERMINAL_DRAIN_MAX_MS - 1);
        expect(reconcileProviderBudget).not.toHaveBeenCalled();
        expect(delivered).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false); // even at the bound, billing must become durable first
        releaseSettlement();
        expect(Buffer.from((await first).value!).toString()).toBe(responsesTerminal.toString());
        expect(await reader.read()).toMatchObject({ done: true });
        expect(await result.terminal).toMatchObject({ ok: true });
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "COMPLETED",
            observationComplete: false,
            usage: expect.objectContaining({ categoriesComplete: false }),
          }),
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalled();
        expect(upstream.destroyed).toBe(true);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(heartbeatProviderAttempt).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      } finally {
        releaseSettlement();
        upstream.destroy();
        cancel.mockRestore();
        vi.useRealTimers();
      }
    });

    it("stops a post-terminal flood at the byte bound and retains liability", async () => {
      vi.useFakeTimers();
      // Object mode preserves the intentional transport boundaries and avoids
      // Node prefetch coalescing the terminal and the flood into one read.
      const upstream = new Readable({ objectMode: true, read() {} });
      const destroy = vi.spyOn(upstream, "destroy");
      const cancelReader = ReadableStreamDefaultReader.prototype.cancel;
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const processErrors: unknown[] = [];
      const captureError = (error: unknown) => processErrors.push(error);
      process.on("uncaughtException", captureError);
      process.on("unhandledRejection", captureError);
      const bufferedBytesAtCancel: number[] = [];
      // Keep a substantial unread source backlog, rather than the original
      // single spare chunk, when the real Node adapter is cancelled.
      cancel.mockImplementation(function (this: ReadableStreamDefaultReader<Uint8Array>, reason) {
        bufferedBytesAtCancel.push(upstream.readableLength * 1024);
        return cancelReader.call(this, reason);
      });
      try {
        expect(POST_TERMINAL_DRAIN_MAX_BYTES).toBe(256 * 1024);
        heartbeatProviderAttempt.mockClear();
        upstream.push(responsesTerminal);
        const block = Buffer.from(`: ${"x".repeat(1020)}\n\n`);
        expect(block.length).toBe(1024);
        for (let bytes = 0; bytes < POST_TERMINAL_DRAIN_MAX_BYTES * 4; bytes += block.length)
          upstream.push(block);
        const result = await startOwnerStream(
          "openrouter",
          upstream,
          "owner",
          "openai-responses",
          false,
        );
        expect(await result.response.text()).toBe(responsesTerminal.toString());
        const terminal = await result.terminal;
        expect(terminal).toMatchObject({
          ok: true,
          responseBytes: responsesTerminal.length + POST_TERMINAL_DRAIN_MAX_BYTES,
        });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            observationComplete: false,
            usage: expect.objectContaining({ categoriesComplete: false }),
          }),
        );
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(bufferedBytesAtCancel[0]).toBeGreaterThanOrEqual(64 * 1024);
        expect(destroy).toHaveBeenCalled();
        expect(upstream.destroyed).toBe(true);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(heartbeatProviderAttempt).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
        // Flush resume_/flow and destroy/eos callbacks left by Readable.toWeb.
        for (let turn = 0; turn < 3; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        expect(processErrors).toEqual([]);
      } finally {
        upstream.destroy();
        cancel.mockRestore();
        vi.useRealTimers();
        process.off("uncaughtException", captureError);
        process.off("unhandledRejection", captureError);
      }
    });

    const bufferedFloodCases = (["bound hit", "client cancel", "decode error"] as const).flatMap(
      (trigger) => [true, false].map((objectMode) => ({ trigger, objectMode })),
    );
    it.each(bufferedFloodCases)(
      "$trigger safely tears down a buffered flood (objectMode $objectMode)",
      async ({ trigger, objectMode }) => {
        const upstream = new Readable({ objectMode, read() {} });
        const block = Buffer.from(`: ${"x".repeat(1020)}\n\n`);
        const processErrors: unknown[] = [];
        const captureError = (error: unknown) => processErrors.push(error);
        process.on("uncaughtException", captureError);
        process.on("unhandledRejection", captureError);
        const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
        const originalEnqueue = ReadableStreamDefaultController.prototype.enqueue;
        const destroy = vi.spyOn(upstream, "destroy");
        const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
        const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
        const close = vi.spyOn(ReadableStreamDefaultController.prototype, "close");
        const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
        const bufferedBytesAtCancel: number[] = [];
        const pausedAtCancel: boolean[] = [];
        let clientReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let clientCancellation: Promise<void> | undefined;
        let queuedCancel = false;
        let result: Awaited<ReturnType<typeof startOwnerStream>> | undefined;
        cancel.mockImplementation(function (this: ReadableStreamDefaultReader<Uint8Array>, reason) {
          if (this !== clientReader) {
            bufferedBytesAtCancel.push(upstream.readableLength * (objectMode ? block.length : 1));
            pausedAtCancel.push(upstream.isPaused());
          }
          return originalCancel.call(this, reason);
        });
        enqueue.mockImplementation(function (
          this: ReadableStreamDefaultController<Uint8Array>,
          chunk,
        ) {
          upstreamController ??= this;
          originalEnqueue.call(this, chunk);
          if (trigger === "client cancel" && this === upstreamController && !queuedCancel) {
            queuedCancel = true;
            // The terminal read continuation runs first, then cancel while
            // the adapter has prefetched flood data and the source is buffered.
            queueMicrotask(() => {
              clientCancellation = clientReader!.cancel("client disconnected in flood");
            });
          }
        });
        try {
          result = await startOwnerStream(
            "openrouter",
            upstream,
            "owner",
            "openai-responses",
            false,
          );
          clientReader = result.response.body!.getReader();
          const first = clientReader.read();
          // Attach the rejection handler before the decoder can reject a read.
          const firstOutcome = first.then(
            (chunk) => ({ chunk, failure: undefined }),
            (failure: unknown) => ({ chunk: undefined, failure }),
          );
          upstream.push(responsesTerminal);
          if (trigger === "decode error") {
            // Read through part of the flood before the malformed record so
            // byte-mode backpressure has scheduled a source resume at cancel.
            for (let index = 0; index < 32; index++) upstream.push(block);
            upstream.push(
              Buffer.concat([Buffer.from("data: "), Buffer.from([0xff]), Buffer.from("\n\n")]),
            );
          }
          for (let bytes = 0; bytes < POST_TERMINAL_DRAIN_MAX_BYTES * 4; bytes += block.length)
            upstream.push(block);
          const firstResult = await firstOutcome;
          const terminal = await result.terminal;
          await clientCancellation;
          if (trigger === "bound hit") {
            expect(firstResult.failure).toBeUndefined();
            expect(Buffer.from(firstResult.chunk!.value!).toString()).toBe(
              responsesTerminal.toString(),
            );
            expect(await clientReader.read()).toMatchObject({ done: true });
            expect(terminal).toMatchObject({ ok: true });
          } else if (trigger === "client cancel") {
            expect(firstResult.chunk).toMatchObject({ done: true });
            expect(terminal).toMatchObject({ ok: false });
          } else {
            expect(firstResult.failure).toBeInstanceOf(Error);
            expect(terminal).toMatchObject({ ok: false });
          }
          // Real event-loop turns expose pending Node flow ticks, adapter eos
          // callbacks, and unhandled promise rejections after cancellation.
          for (let turn = 0; turn < 3; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          expect(processErrors).toEqual([]);
          expect(bufferedBytesAtCancel).toHaveLength(1);
          expect(bufferedBytesAtCancel[0]).toBeGreaterThanOrEqual(64 * 1024);
          expect(pausedAtCancel).toEqual([true]);
          expect(destroy).toHaveBeenCalled();
          expect(upstream.destroyed).toBe(true);
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          expect(reconcileProviderBudget).toHaveBeenCalledWith(
            expect.objectContaining({
              reason:
                trigger === "bound hit"
                  ? "COMPLETED"
                  : trigger === "client cancel"
                    ? "CANCELLED"
                    : "FAILED",
              observationComplete: false,
              usage: expect.objectContaining({ observationComplete: false }),
            }),
          );
          if (trigger === "client cancel") {
            // Only the real upstream adapter may touch its own controller.
            // No client controller action is allowed after cancellation.
            for (const action of [enqueue, close, error]) {
              expect(
                action.mock.contexts.filter((context) => context !== upstreamController),
              ).toEqual([]);
            }
          }
        } finally {
          upstream.pause();
          upstream.destroy();
          await clientReader?.cancel().catch(() => undefined);
          await result?.terminal;
          for (let turn = 0; turn < 3; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          cancel.mockRestore();
          enqueue.mockRestore();
          close.mockRestore();
          error.mockRestore();
          destroy.mockRestore();
          process.off("uncaughtException", captureError);
          process.off("unhandledRejection", captureError);
        }
      },
    );

    it("cancels the upstream when the post-terminal drain hits a decode error", async () => {
      const upstream = new Readable({ objectMode: true, read() {} });
      const destroy = vi.spyOn(upstream, "destroy");
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      try {
        upstream.push(responsesTerminal);
        upstream.push(
          Buffer.concat([Buffer.from("data: "), Buffer.from([0xff]), Buffer.from("\n\n")]),
        );
        const result = await startOwnerStream(
          "openrouter",
          upstream,
          "owner",
          "openai-responses",
          false,
        );
        await expect(result.response.text()).rejects.toBeInstanceOf(Error);
        expect(await result.terminal).toMatchObject({ ok: false });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "FAILED", observationComplete: false }),
        );
        // The upstream stays open (never ended): only the cleanup can close it.
        expect(cancel).toHaveBeenCalled();
        expect(destroy).toHaveBeenCalled();
        expect(upstream.destroyed).toBe(true);
      } finally {
        upstream.destroy();
        cancel.mockRestore();
      }
    });

    // Abort rows fail without the post-read lifecycle check. Honest EOF,
    // client cancel and bound hit are controls for over-conservative rejection.
    it.each([
      { name: "heartbeat failure during drain", trigger: "heartbeat", draining: true },
      { name: "lease loss during drain", trigger: "lease", draining: true },
      { name: "abort before terminal", trigger: "heartbeat", draining: false },
      { name: "client cancel", trigger: "client", draining: true },
      { name: "honest EOF", trigger: "eof", draining: true },
      { name: "bound hit", trigger: "bound", draining: true },
    ] as const)("classifies lifecycle EOF: $name", async ({ trigger, draining }) => {
      vi.useFakeTimers();
      const upstream = new Readable({ objectMode: true, read() {} });
      const processErrors: unknown[] = [];
      const captureError = (error: unknown) => processErrors.push(error);
      process.on("uncaughtException", captureError);
      process.on("unhandledRejection", captureError);
      heartbeatProviderAttempt.mockReset().mockResolvedValue(true);
      try {
        const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
        const reader = result.response.body!.getReader();
        const readOutcome = (async () => {
          const chunks: Uint8Array[] = [];
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return Buffer.concat(chunks).toString();
            chunks.push(chunk.value);
          }
        })().then(
          (text) => ({ text, failure: undefined }),
          (failure: unknown) => ({ text: undefined, failure }),
        );
        await vi.advanceTimersByTimeAsync(9_990);
        if (draining) upstream.push(lowResponsesTerminal);
        await vi.advanceTimersByTimeAsync(0);
        expect(reconcileProviderBudget).not.toHaveBeenCalled();
        const queueTail = () => {
          for (let i = 0; i < 8; i++)
            upstream.push(record("response.output_text.delta", { delta: "padding" }));
          upstream.push(responsesTerminal);
        };
        if (trigger === "heartbeat" || trigger === "lease") {
          // Queue a higher usage record in the same timer turn as ownership
          // loss. complete=true must not make the cancelled read a clean EOF.
          heartbeatProviderAttempt.mockImplementationOnce(() => {
            queueTail();
            return trigger === "heartbeat"
              ? Promise.reject(new Error("heartbeat database failure"))
              : Promise.resolve(false);
          });
          await vi.advanceTimersByTimeAsync(10);
        } else if (trigger === "client") {
          queueTail();
          await reader.cancel("client disconnected");
        } else if (trigger === "eof") {
          // Identical terminal usage is legitimate and must remain attributable.
          upstream.push(lowResponsesTerminal);
          upstream.push(null);
        } else {
          upstream.push(Buffer.from(`: ${"x".repeat(POST_TERMINAL_DRAIN_MAX_BYTES)}\n\n`));
          upstream.push(responsesTerminal);
        }
        await vi.advanceTimersByTimeAsync(0);
        const outcome = await readOutcome;
        const successful = trigger === "eof" || trigger === "bound";
        expect(await result.terminal).toMatchObject({ ok: successful });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: trigger === "client" ? "CANCELLED" : successful ? "COMPLETED" : "FAILED",
            observationComplete: trigger === "eof",
          }),
        );
        if (trigger === "heartbeat" || trigger === "lease") {
          expect(outcome.failure).toBeInstanceOf(Error);
          expect((outcome.failure as Error).message).toBe(
            trigger === "heartbeat"
              ? "provider attempt heartbeat failed"
              : "provider attempt lease expired",
          );
          if (draining) {
            const usage = reconcileProviderBudget.mock.calls[0]?.[0].usage;
            expect(usage).toMatchObject({
              observationComplete: false,
              categoriesComplete: false,
              inputTokens: 10n,
              outputTokens: 1n,
            });
            expect(providerBillableTokens(usage)).toBeUndefined();
            expect(usage.reportedCost).toBeUndefined();
          }
        } else if (trigger === "client") {
          expect(outcome).toMatchObject({ text: "", failure: undefined });
        } else {
          expect(outcome.failure).toBeUndefined();
          expect(outcome.text).toBe(lowResponsesTerminal.toString());
          if (trigger === "eof")
            expect(reconcileProviderBudget.mock.calls[0]?.[0].usage).toMatchObject({
              categoriesComplete: true,
              inputTokens: 10n,
              outputTokens: 1n,
            });
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
        for (let turn = 0; turn < 3; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        expect(processErrors).toEqual([]);
      } finally {
        upstream.pause();
        upstream.destroy();
        heartbeatProviderAttempt.mockReset().mockResolvedValue(true);
        process.off("uncaughtException", captureError);
        process.off("unhandledRejection", captureError);
        vi.useRealTimers();
      }
    });

    async function socketUpstream() {
      let outgoing!: ServerResponse;
      let resolveSocketClosed!: () => void;
      const socketClosed = new Promise<void>((resolve) => {
        resolveSocketClosed = resolve;
      });
      const server = createServer((request, response) => {
        outgoing = response;
        request.socket.once("close", resolveSocketClosed);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected loopback address");
      const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port: address.port }, resolve);
        request.once("error", reject);
        request.end();
      });
      return {
        incoming,
        outgoing,
        socketClosed,
        async close() {
          incoming.destroy();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    // Native complete/destroy/error behavior is part of the contract. The
    // reset and clean-EOF rows are production controls; heartbeat catches C1b-1.
    it.each(["honest EOF", "reset after terminal", "heartbeat during drain", "bound hit"] as const)(
      "classifies socket-backed EOF: %s",
      async (trigger) => {
        const upstream = await socketUpstream();
        const processErrors: unknown[] = [];
        const captureError = (error: unknown) => processErrors.push(error);
        process.on("uncaughtException", captureError);
        process.on("unhandledRejection", captureError);
        // Keep socket I/O and drain deadlines real; advance only the heartbeat.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        heartbeatProviderAttempt.mockReset().mockResolvedValue(true);
        try {
          const result = await startOwnerStream(
            "openrouter",
            upstream.incoming,
            "owner",
            "openai-responses",
          );
          expect(upstream.incoming.complete).toBe(false);
          const bodyOutcome = result.response.text().then(
            (text) => ({ text, failure: undefined }),
            (failure: unknown) => ({ text: undefined, failure }),
          );
          const receivedTerminal = new Promise<void>((resolve) =>
            upstream.incoming.once("data", () => resolve()),
          );
          upstream.outgoing.write(responsesTerminal);
          await receivedTerminal;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(reconcileProviderBudget).not.toHaveBeenCalled();
          if (trigger === "honest EOF") upstream.outgoing.end();
          else if (trigger === "reset after terminal") upstream.outgoing.socket!.resetAndDestroy();
          else if (trigger === "heartbeat during drain") {
            heartbeatProviderAttempt.mockRejectedValueOnce(new Error("heartbeat database failure"));
            await vi.advanceTimersByTimeAsync(10_000);
          } else {
            upstream.outgoing.write(
              Buffer.from(`: ${"x".repeat(POST_TERMINAL_DRAIN_MAX_BYTES)}\n\n`),
            );
          }
          const outcome = await bodyOutcome;
          const successful = trigger === "honest EOF" || trigger === "bound hit";
          expect(await result.terminal).toMatchObject({ ok: successful });
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          expect(reconcileProviderBudget).toHaveBeenCalledWith(
            expect.objectContaining({
              reason: successful ? "COMPLETED" : "FAILED",
              observationComplete: trigger === "honest EOF",
              usage: expect.objectContaining({ categoriesComplete: trigger === "honest EOF" }),
            }),
          );
          if (successful)
            expect(outcome).toMatchObject({
              text: responsesTerminal.toString(),
              failure: undefined,
            });
          else expect(outcome.failure).toBeInstanceOf(Error);
          if (trigger === "heartbeat during drain")
            expect((outcome.failure as Error).message).toBe("provider attempt heartbeat failed");
          expect(upstream.incoming.complete).toBe(trigger === "honest EOF");
          expect(upstream.incoming.destroyed).toBe(true);
          await upstream.socketClosed;
          expect(vi.getTimerCount()).toBe(0);
          vi.useRealTimers();
          for (let turn = 0; turn < 3; turn++)
            await new Promise<void>((resolve) => setImmediate(resolve));
          expect(processErrors).toEqual([]);
        } finally {
          await upstream.close();
          heartbeatProviderAttempt.mockReset().mockResolvedValue(true);
          process.off("uncaughtException", captureError);
          process.off("unhandledRejection", captureError);
          vi.useRealTimers();
        }
      },
    );

    it.each(["response error", "honest EOF"] as const)(
      "classifies queued EOF with public readable state: %s",
      async (trigger) => {
        const upstream = new Readable({ read() {} });
        const error = new Error("provider egress teardown");
        // Model a read whose EOF was queued immediately before teardown. The
        // transport's public errored property is set synchronously by destroy.
        const read = vi
          .spyOn(ReadableStreamDefaultReader.prototype, "read")
          .mockImplementationOnce(async () => {
            if (trigger === "response error") upstream.destroy(error);
            return { done: true, value: undefined };
          });
        try {
          const result = await startOwnerStream(
            "openrouter",
            upstream,
            "owner",
            "openai-responses",
          );
          const outcome = await result.response.text().then(
            (text) => ({ text, failure: undefined }),
            (failure: unknown) => ({ text: undefined, failure }),
          );
          expect(await result.terminal).toMatchObject({ ok: false });
          expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
          expect(reconcileProviderBudget).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "FAILED", observationComplete: false }),
          );
          if (trigger === "response error") expect(outcome.failure).toBe(error);
          else expect(outcome).toEqual({ text: "", failure: undefined });
        } finally {
          read.mockRestore();
          upstream.destroy();
        }
      },
    );

    // Use the production egress primitive, including its abort and idle-timeout
    // wiring. The test adapter only redirects the URL to a loopback server and
    // supplies an extra source for the combined caller/lease/deadline signal.
    it.each(
      (["idle timeout", "combined abort", "honest EOF"] as const).flatMap((trigger) =>
        (["trailing failure", "conflicting usage", "identical usage"] as const).map((tail) => ({
          trigger,
          tail,
        })),
      ),
    )("classifies real-egress EOF: $trigger / $tail", async ({ trigger, tail }) => {
      const actual = await vi.importActual<
        typeof import("@ws-model-proxy/api/lib/provider-egress")
      >("@ws-model-proxy/api/lib/provider-egress");
      let outgoing!: ServerResponse;
      let incoming: IncomingMessage | undefined;
      const server = createServer((_request, response) => {
        outgoing = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected loopback address");
      const controller = new AbortController();
      const processErrors: unknown[] = [];
      const captureError = (error: unknown) => processErrors.push(error);
      process.on("uncaughtException", captureError);
      process.on("unhandledRejection", captureError);
      try {
        const result = await startOwnerStream(
          "openrouter",
          async (_url, options, policy, protocol, auth) => {
            if (!options.signal) throw new Error("expected combined dispatch signal");
            incoming = await actual.providerHttpsRequest(
              `http://127.0.0.1:${address.port}`,
              { ...options, signal: AbortSignal.any([options.signal, controller.signal]) },
              { ...policy, allowPrivateNetworks: true },
              protocol,
              auth,
            );
            return incoming;
          },
          "owner",
          "openai-responses",
        );
        if (!incoming) throw new Error("expected real egress response");
        const upstream = incoming;
        // Let heldBody auto-pull one delta, then leave the requester stalled.
        const delta = record("response.output_text.delta", { delta: "hi" });
        const receivedDelta = once(upstream, "data");
        outgoing.write(delta);
        await receivedDelta;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const filler = Buffer.from(`: ${"x".repeat(70 * 1024)}\n\n`);
        const receivedPrefix = once(upstream, "data");
        outgoing.write(Buffer.concat([lowResponsesTerminal, filler]));
        await receivedPrefix;
        await vi.waitFor(() => expect(upstream.isPaused()).toBe(true));
        const trailing =
          tail === "trailing failure"
            ? record("response.failed", { error: { type: "upstream_error" } })
            : tail === "conflicting usage"
              ? responsesTerminal
              : lowResponsesTerminal;
        outgoing.end(trailing);
        await vi.waitFor(() => {
          expect(upstream.complete).toBe(true);
          expect(upstream.readableLength).toBeGreaterThanOrEqual(trailing.byteLength);
        });
        expect(reconcileProviderBudget).not.toHaveBeenCalled();
        if (trigger === "idle timeout") {
          upstream.socket.setTimeout(20);
          await vi.waitFor(() => expect(upstream.destroyed).toBe(true));
        } else if (trigger === "combined abort") controller.abort();
        const outcome = await result.response.text().then(
          (text) => ({ text, failure: undefined }),
          (failure: unknown) => ({ text: undefined, failure }),
        );
        const honest = trigger === "honest EOF";
        const successful = honest && tail !== "trailing failure";
        const chargeable = honest && tail === "identical usage";
        expect(await result.terminal).toMatchObject({ ok: successful });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: successful ? "COMPLETED" : "FAILED",
            observationComplete: successful,
          }),
        );
        const usage = reconcileProviderBudget.mock.calls[0]?.[0].usage;
        if (chargeable) {
          expect(usage).toMatchObject({ inputTokens: 10n, outputTokens: 1n });
          expect(providerBillableTokens(usage)).toBe(11n);
          expect(outcome.failure).toBeUndefined();
          expect(outcome.text).toContain(lowResponsesTerminal.toString());
        } else if (!honest || tail === "conflicting usage") {
          expect(usage ? providerBillableTokens(usage) : undefined).toBeUndefined();
          expect(usage?.reportedCost).toBeUndefined();
          if (honest) expect(outcome.failure).toBeUndefined();
          else expect(outcome.failure).toBeInstanceOf(actual.ProviderEgressError);
        } else {
          // A fully read failure may retain usage for audit, but its incomplete
          // settlement observation still keeps the reservation's liability.
          expect(usage).toMatchObject({ observationComplete: false });
          expect(outcome.failure).toBeUndefined();
        }
        expect(upstream.complete).toBe(true);
        for (let turn = 0; turn < 3; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        expect(processErrors).toEqual([]);
      } finally {
        incoming?.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        process.off("uncaughtException", captureError);
        process.off("unhandledRejection", captureError);
      }
    });

    it("cancels a pending accounting drain once without touching the cancelled controller", async () => {
      vi.useFakeTimers();
      const upstream = new Readable({ read() {} });
      const destroy = vi.spyOn(upstream, "destroy");
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
      const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
      const close = vi.spyOn(ReadableStreamDefaultController.prototype, "close");
      try {
        heartbeatProviderAttempt.mockClear();
        upstream.push(responsesTerminal);
        const result = await startOwnerStream(
          "openrouter",
          upstream,
          "owner",
          "openai-responses",
          false,
        );
        const reader = result.response.body!.getReader();
        const pending = reader.read();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(2);
        expect(reconcileProviderBudget).not.toHaveBeenCalled();
        await reader.cancel("client disconnected during drain");
        expect(await pending).toMatchObject({ done: true });
        expect(await result.terminal).toMatchObject({ ok: false });
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "CANCELLED",
            observationComplete: false,
          }),
        );
        expect(cancel).toHaveBeenCalledTimes(2); // caller reader and upstream reader
        expect(cancel).toHaveBeenLastCalledWith("client disconnected during drain");
        expect(destroy).toHaveBeenCalled();
        expect(upstream.destroyed).toBe(true);
        // Node's upstream adapter may report its own cancellation AbortError
        // on an already cancelled controller. It must not mask a pull touching
        // the cancelled client controller (a controller-state error).
        expect(
          error.mock.calls.filter(
            ([cause]) => !(cause instanceof Error && cause.name === "AbortError"),
          ),
        ).toEqual([]);
        // The held terminal is never delivered, and the cancelled controller is
        // never closed or fed after the client went away. Node's upstream
        // adapter owns one enqueue (the terminal chunk it read); a second one
        // would be the held body delivering to its cancelled client.
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(0);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(heartbeatProviderAttempt).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      } finally {
        upstream.destroy();
        cancel.mockRestore();
        enqueue.mockRestore();
        close.mockRestore();
        error.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  // Round 2 (#140): the heartbeat/lease-loss abort runs the shared teardown
  // helper. Reverting it to a bare `response.destroy(error)` leaves the
  // upstream reader uncancelled and the source unpaused at destroy — the G1
  // crash class the helper exists to close.
  it.each(["object", "byte"] as const)(
    "runs the shared teardown on heartbeat ownership loss with a buffered flood (%s mode)",
    async (mode) => {
      vi.useFakeTimers();
      const upstream = new Readable({ objectMode: mode === "object", read() {} });
      const processErrors: unknown[] = [];
      const captureError = (error: unknown) => processErrors.push(error);
      process.on("uncaughtException", captureError);
      process.on("unhandledRejection", captureError);
      const destroyPaused: boolean[] = [];
      const originalDestroy = upstream.destroy.bind(upstream);
      upstream.destroy = (...args: Parameters<Readable["destroy"]>) => {
        destroyPaused.push(upstream.isPaused());
        return originalDestroy(...args);
      };
      const clientCancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const upstreamCancelReasons: unknown[] = [];
      let clientReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
      clientCancel.mockImplementation(function (
        this: ReadableStreamDefaultReader<Uint8Array>,
        reason,
      ) {
        if (this !== clientReader) upstreamCancelReasons.push(reason);
        return originalCancel.call(this, reason);
      });
      let body: Promise<string> | undefined;
      try {
        // A buffered flood (no terminal): the abort fires mid-stream.
        for (let i = 0; i < 16; i++) upstream.push(Buffer.from(`: ${"x".repeat(1022)}\n\n`));
        const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
        body = result.response.text();
        void body.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        heartbeatProviderAttempt.mockResolvedValueOnce(false);
        await vi.advanceTimersByTimeAsync(10_000);
        for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
        await body.catch(() => undefined);
        await result.terminal;
        vi.useRealTimers();
        for (let turn = 0; turn < 3; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        // The helper cancels the upstream reader with the abort reason before
        // destroying a paused source. A bare destroy does neither of these.
        expect(upstreamCancelReasons.map((reason) => (reason as Error)?.message)).toContain(
          "provider attempt lease expired",
        );
        expect(destroyPaused[0]).toBe(true);
        expect(upstream.destroyed).toBe(true);
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
        expect(reconcileProviderBudget).toHaveBeenCalledWith(
          expect.objectContaining({ observationComplete: false }),
        );
        expect(processErrors).toEqual([]);
      } finally {
        upstream.pause();
        upstream.destroy();
        clientCancel.mockRestore();
        process.off("uncaughtException", captureError);
        process.off("unhandledRejection", captureError);
        vi.useRealTimers();
      }
    },
  );

  // Round 2 (#140): never touch the client controller after cancellation,
  // including when the client cancels during the clean-EOF settlement await.
  it("does not deliver a clean EOF terminal once the client cancelled during settlement", async () => {
    vi.useFakeTimers();
    const upstream = new Readable({ read() {} });
    const eofTerminal = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    );
    let releaseSettlement!: () => void;
    const durable = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
    const close = vi.spyOn(ReadableStreamDefaultController.prototype, "close");
    const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
    const cancellationGrace = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    try {
      const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
      vi.mocked(recordProviderAttemptEvent).mockClear();
      reconcileProviderBudget.mockImplementationOnce(() => durable);
      const reader = result.response.body!.getReader();
      const first = reader.read();
      upstream.push(eofTerminal);
      upstream.push(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      // Cancel the client while the clean-EOF settlement is still pending.
      const cancellation = reader.cancel("client disconnected during EOF settlement");
      releaseSettlement();
      await cancellation;
      await first;
      // The cancel landed after the clean-EOF settlement was snapshotted, so
      // the durable outcome stays COMPLETED; the terminal bytes, however, must
      // never reach the cancelled client controller.
      expect(await result.terminal).toMatchObject({ ok: true });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "COMPLETED" }),
      );
      vi.useRealTimers();
      for (let turn = 0; turn < 3; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      // Only the upstream adapter's own controller may act; the cancelled
      // client controller must never be enqueued, closed or errored.
      const upstreamController = enqueue.mock.contexts[0];
      expect(upstreamController).toBeDefined();
      for (const action of [enqueue, close, error]) {
        expect(action.mock.contexts.filter((context) => context !== upstreamController)).toEqual(
          [],
        );
      }
    } finally {
      releaseSettlement();
      upstream.destroy();
      cancellationGrace.mockRestore();
      enqueue.mockRestore();
      close.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  // Round 2 (#140): a decode error plus a client cancel must settle once and
  // must not error the cancelled client controller.
  it("does not error the client controller when a decode error races a client cancel", async () => {
    vi.useFakeTimers();
    const upstream = new Readable({ objectMode: true, read() {} });
    const raceTerminal = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    );
    const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
    const processErrors: unknown[] = [];
    const captureError = (error_: unknown) => processErrors.push(error_);
    process.on("uncaughtException", captureError);
    process.on("unhandledRejection", captureError);
    let releaseSettlement!: () => void;
    const durable = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let clientReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    try {
      upstream.push(raceTerminal);
      const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
      clientReader = result.response.body!.getReader();
      const firstOutcome = clientReader.read().then(
        (chunk) => ({ chunk, failure: undefined }),
        (failure: unknown) => ({ chunk: undefined, failure }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // Park the catch path's reconcile(false), then cancel the client while it
      // is pending, then push the malformed record that triggers the decode
      // error. The catch path resumes with the client already cancelled.
      reconcileProviderBudget.mockImplementation(() => durable);
      upstream.push(
        Buffer.concat([Buffer.from("data: "), Buffer.from([0xff]), Buffer.from("\n\n")]),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      cancellation = clientReader.cancel("client disconnected on decode error");
      releaseSettlement();
      await cancellation.catch(() => undefined);
      const firstResult = await firstOutcome;
      expect(await result.terminal).toMatchObject({ ok: false });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ observationComplete: false }),
      );
      vi.useRealTimers();
      for (let turn = 0; turn < 3; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstResult.failure === undefined || firstResult.failure instanceof Error).toBe(true);
      const upstreamController = enqueue.mock.contexts[0];
      expect(upstreamController).toBeDefined();
      // The cancelled client controller must never be errored.
      expect(error.mock.contexts.filter((context) => context !== upstreamController)).toEqual([]);
      expect(processErrors).toEqual([]);
    } finally {
      releaseSettlement();
      upstream.pause();
      upstream.destroy();
      await cancellation;
      await clientReader?.cancel().catch(() => undefined);
      reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
      enqueue.mockRestore();
      error.mockRestore();
      process.off("uncaughtException", captureError);
      process.off("unhandledRejection", captureError);
      vi.useRealTimers();
    }
  });

  // Round 3 (#140): the catch path's own conservative settlement. When the
  // decode-error catch path is parked on a `reconcile(false)` that then
  // REJECTS while the client cancels during that await, the terminal must
  // resolve once and the already-cancelled client controller must never be
  // errored (the settlement failure is not deliverable to a cancelled client).
  it("settles once and never errors the cancelled client controller when a rejecting reconciliation races a client cancel", async () => {
    vi.useFakeTimers();
    const upstream = new Readable({ objectMode: true, read() {} });
    const error = vi.spyOn(ReadableStreamDefaultController.prototype, "error");
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
    const processErrors: unknown[] = [];
    const captureError = (error_: unknown) => processErrors.push(error_);
    process.on("uncaughtException", captureError);
    process.on("unhandledRejection", captureError);
    let rejectSettlement!: (reason: unknown) => void;
    const declined = new Promise<void>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    let clientReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    try {
      upstream.push(
        Buffer.from(
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        ),
      );
      const result = await startOwnerStream("openrouter", upstream, "owner", "openai-responses");
      clientReader = result.response.body!.getReader();
      const firstOutcome = clientReader.read().then(
        (chunk) => ({ chunk, failure: undefined }),
        (failure: unknown) => ({ chunk: undefined, failure }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // Park the catch path's reconcile(false) on a promise that will reject,
      // then cancel the client while it is pending, then push the malformed
      // record whose invalid UTF-8 throws out of the decoder.
      reconcileProviderBudget.mockImplementation(() => declined);
      upstream.push(
        Buffer.concat([Buffer.from("data: "), Buffer.from([0xff]), Buffer.from("\n\n")]),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      cancellation = clientReader.cancel("client disconnected on rejecting settlement");
      rejectSettlement(new Error("budget settlement rejected"));
      await cancellation.catch(() => undefined);
      const firstResult = await firstOutcome;
      expect(await result.terminal).toMatchObject({ ok: false });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ observationComplete: false }),
      );
      vi.useRealTimers();
      for (let turn = 0; turn < 3; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(firstResult.failure === undefined || firstResult.failure instanceof Error).toBe(true);
      const upstreamController = enqueue.mock.contexts[0];
      expect(upstreamController).toBeDefined();
      // The rejection is resolved before this gated error, and the cancelled
      // client controller must never be errored.
      expect(error.mock.contexts.filter((context) => context !== upstreamController)).toEqual([]);
      expect(processErrors).toEqual([]);
    } finally {
      rejectSettlement(new Error("cleanup"));
      upstream.pause();
      upstream.destroy();
      await cancellation;
      await clientReader?.cancel().catch(() => undefined);
      reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
      enqueue.mockRestore();
      error.mockRestore();
      process.off("uncaughtException", captureError);
      process.off("unhandledRejection", captureError);
      vi.useRealTimers();
    }
  });

  // Round 2 (#140): the reader-less helper callers. The shared teardown's
  // synchronous pause and always-destroy are the only cleanup on these paths
  // (there is no web reader whose cancel could destroy the source), so a
  // regression to an inline destroy would leak the upstream socket.
  it("pauses and destroys the upstream for a retryable body over the accounting limit", async () => {
    const upstream = new Readable({
      read() {
        this.push(Buffer.alloc(512 * 1024, 0x78));
      },
    });
    Object.assign(upstream, { statusCode: 503, headers: {}, complete: true });
    const pauses: boolean[] = [];
    const sequence: string[] = [];
    const destroyReasons: unknown[] = [];
    const originalPause = upstream.pause.bind(upstream);
    upstream.pause = () => {
      pauses.push(upstream.isPaused());
      sequence.push("pause");
      return originalPause();
    };
    const originalDestroy = upstream.destroy.bind(upstream);
    upstream.destroy = (...args: Parameters<Readable["destroy"]>) => {
      destroyReasons.push(args[0]);
      sequence.push(`destroy(paused=${upstream.isPaused()})`);
      return originalDestroy(...args);
    };
    providerHttpsRequest.mockReset().mockResolvedValueOnce(upstream);
    db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
    reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
    try {
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-retry-overflow",
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
        liability: { tokens: 5_000n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 10n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: true,
        retrySingleTargetPrecommit: true,
      });
      expect(result).toMatchObject({ dispatched: false, providerIoStarted: true });
      // The helper pauses the source synchronously before it destroys it, and
      // the destroy carries the overflow reason (not just any destroy call).
      expect(pauses.length).toBeGreaterThanOrEqual(1);
      expect(sequence.indexOf("pause")).toBeLessThan(sequence.indexOf("destroy(paused=true)"));
      expect(
        destroyReasons.some(
          (reason) =>
            reason instanceof Error && reason.message.includes("exceeded accounting limit"),
        ),
      ).toBe(true);
      expect(upstream.destroyed).toBe(true);
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "FAILED" }),
      );
    } finally {
      upstream.pause();
      upstream.destroy();
    }
  });

  it.each([204, 205, 304])(
    "pauses and destroys the upstream for a body-forbidden %i response",
    async (status) => {
      const upstream = new Readable({ objectMode: true, read() {} });
      for (let index = 0; index < 64; index++) upstream.push(Buffer.from("x".repeat(1024)));
      Object.assign(upstream, { statusCode: status, headers: {}, complete: true });
      const pauses: boolean[] = [];
      const sequence: string[] = [];
      const originalPause = upstream.pause.bind(upstream);
      upstream.pause = () => {
        pauses.push(upstream.isPaused());
        sequence.push("pause");
        return originalPause();
      };
      const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
      const cancelSeen: string[] = [];
      ReadableStreamDefaultReader.prototype.cancel = function (reason) {
        cancelSeen.push(`cancel(paused=${upstream.isPaused()})`);
        sequence.push("cancel");
        return originalCancel.call(this, reason);
      };
      providerHttpsRequest.mockReset().mockResolvedValueOnce(upstream);
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        ...consentDelegates(),
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          mockRequesterValidityQuery(strings, values, consentDelegates()),
        ),
        providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
      reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
      try {
        const result = await dispatchPublicOverflow({
          userId: "owner",
          poolId: "pool",
          requestId: `request-body-forbidden-${status}`,
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
          liability: { tokens: 5_000n, accountingVersion: "provider-billing-v1" },
          requestedOutputTokens: 10n,
          releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
          adaptationEnabled: false,
          retrySafe: false,
        });
        expect(result.dispatched).toBe(true);
        expect(upstream.destroyed).toBe(true);
        expect(pauses.length).toBeGreaterThanOrEqual(2); // adapter pause plus helper pause
        expect(cancelSeen).toHaveLength(1);
        expect(sequence.indexOf("pause")).toBeLessThan(sequence.indexOf("cancel"));
        expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      } finally {
        upstream.pause();
        upstream.destroy();
        ReadableStreamDefaultReader.prototype.cancel = originalCancel;
      }
    },
  );

  // Round 2 (#140): the shared teardown absorbs a rejecting reader.cancel so
  // the attempt still settles. Dropping the catch in the helper would abort it
  // before reconcile(false), stranding the attempt with no settlement.
  it("still settles once when the upstream reader cancels with a rejection", async () => {
    const upstream = new Readable({ read() {} });
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
      complete: false,
    });
    providerHttpsRequest.mockReset().mockResolvedValueOnce(upstream);
    db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
    reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
    const processErrors: unknown[] = [];
    const captureError = (error: unknown) => processErrors.push(error);
    process.on("unhandledRejection", captureError);
    const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
    ReadableStreamDefaultReader.prototype.cancel = () =>
      Promise.reject(new Error("reader cancellation failed"));
    try {
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-reader-cancel-rejects",
        reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
        ...ownerConsentFields(),
        requestedProtocol: "openai",
        requestedSurface: "openai-chat",
        stream: true,
        requiredFeatures: [],
        path: "/v1/chat/completions",
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode('{"model":"pool","stream":true}'),
        signal: new AbortController().signal,
        liability: { tokens: 5_000n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 10n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });
      if (!result.dispatched) throw new Error("expected dispatch");
      // Nothing reads the body: only the cancel can settle the attempt.
      await result.response.body?.cancel(new Error("client disconnected"));
      await result.terminal;
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "CANCELLED" }),
      );
      expect(upstream.destroyed).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(processErrors).toEqual([]);
    } finally {
      upstream.destroy();
      ReadableStreamDefaultReader.prototype.cancel = originalCancel;
      process.off("unhandledRejection", captureError);
    }
  });

  // Round 2 (#140): a non-stream body that errors mid-read (socket reset after
  // partial JSON) must tear down, fail closed, and surface the error on the
  // controller. The r1 `if (terminalDecoder)` gate skipped all of that for
  // non-stream requests, leaking the upstream socket.
  it("fails closed when a non-stream body errors mid-read", async () => {
    const upstream = new Readable({ read() {} });
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      complete: false,
    });
    const sequence: string[] = [];
    const originalDestroy = upstream.destroy.bind(upstream);
    upstream.destroy = (...args: Parameters<Readable["destroy"]>) => {
      sequence.push("destroy");
      return originalDestroy(...args);
    };
    const originalPause = upstream.pause.bind(upstream);
    upstream.pause = () => {
      sequence.push("pause");
      return originalPause();
    };
    providerHttpsRequest.mockReset().mockResolvedValueOnce(upstream);
    db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
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
    reconcileProviderBudget.mockReset().mockResolvedValue(undefined);
    try {
      const result = await dispatchPublicOverflow({
        userId: "owner",
        poolId: "pool",
        requestId: "request-nonstream-midbody-error",
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
        liability: { tokens: 5_000n, accountingVersion: "provider-billable-v1" },
        requestedOutputTokens: 10n,
        releaseLocalCapacity: vi.fn().mockResolvedValue(undefined),
        adaptationEnabled: false,
        retrySafe: false,
      });
      if (!result.dispatched) throw new Error("expected dispatch");
      // Push partial JSON, then fail the source mid-read.
      upstream.push(Buffer.from('{"choices":[{"delta":{"content":"partial'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      upstream.destroy(new Error("socket reset after partial JSON"));
      await expect(result.response.text()).rejects.toBeInstanceOf(Error);
      expect(await result.terminal).toMatchObject({ ok: false });
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      expect(reconcileProviderBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "FAILED", observationComplete: false }),
      );
      // The dispatch teardown runs on the non-stream catch path: it pauses the
      // source and destroys it (one extra destroy beyond the caller's trigger).
      expect(sequence.filter((entry) => entry === "pause").length).toBeGreaterThanOrEqual(1);
      expect(sequence.filter((entry) => entry === "destroy").length).toBeGreaterThanOrEqual(2);
      expect(upstream.destroyed).toBe(true);
    } finally {
      upstream.destroy();
    }
  });

  // Round 2 (#140): a transport chunk holding two terminal-classified records
  // must charge the post-terminal budget once, from the FIRST terminal. If a
  // later terminal recomputed it, the bytes between the terminals would fall
  // out of the drain budget and the read would run past the bound.
  it("keeps the drain budget anchored to the first of two terminals in one chunk", async () => {
    db.providerPricingVersion.findFirst.mockResolvedValue(pricingRow());
    const firstTerminal = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    );
    try {
      const pad = Buffer.from(`: ${"x".repeat(1024 - 3)}\n\n`); // one 1024-byte comment
      const padBytes = Array.from({ length: (256 * 1024) / pad.length + 16 }, () => pad);
      // One transport chunk: terminal, then a >=256 KiB tail, then a second
      // terminal. The budget must be consumed by the first terminal's offset.
      const chunk = Buffer.concat([firstTerminal, ...padBytes, firstTerminal]);
      expect(chunk.byteLength).toBeGreaterThan(256 * 1024);
      const result = await startOwnerStream(
        "openrouter",
        [chunk],
        "owner",
        "openai-responses",
        true,
      );
      const terminal = await result.terminal;
      expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
      const settled = reconcileProviderBudget.mock.calls[0]![0];
      // The bytes after the first terminal already exceed the bound, so the
      // drain stops fail-closed instead of reading on to a clean EOF.
      expect(settled.reason).toBe("COMPLETED");
      expect(settled.observationComplete).toBe(false);
      expect(terminal).toMatchObject({ ok: true, responseBytes: chunk.byteLength });
    } finally {
      db.providerPricingVersion.findFirst.mockReset();
    }
  });

  it("does not charge a grant spend cap for the pool owner's own traffic", async () => {
    try {
      await settleOwnerStream("openrouter", [Buffer.from("data: [DONE]\n\n")], "owner");
      expect(vi.mocked(admitProviderBudget).mock.calls[0]?.[0].poolGrantId).toBeUndefined();
    } finally {
      resetConsentState();
    }
  });

  it("returns GRANTEE_BUDGET_EXCEEDED when the grant spend cap refuses admission", async () => {
    vi.mocked(admitProviderBudget).mockResolvedValueOnce({
      admitted: false,
      reason: "GRANTEE_BUDGET_EXCEEDED",
      policyId: "grant-cap",
      ruleId: "rule",
    });
    db.modelPool.findFirst.mockResolvedValue({
      ...dispatchPoolFixture(),
      fallbackForGrantees: true,
    });
    consentState.token = { ...consentState.token, userId: "grantee" };
    consentState.grant = currentGrant();
    const tx = {
      ...consentDelegates(),
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        mockRequesterValidityQuery(strings, values, consentDelegates()),
      ),
      providerAccount: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ providerType: "openai", allowDataCollection: false }),
      },
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
    try {
      await expect(
        dispatchPublicOverflow({
          userId: "owner",
          poolId: "pool",
          requestId: "grant-cap-hit",
          reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
          ...ownerConsentFields("grantee"),
          requestedProtocol: "openai",
          requestedSurface: "openai-chat",
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
        }),
      ).resolves.toEqual({ dispatched: false, reason: "GRANTEE_BUDGET_EXCEEDED" });
      expect(providerHttpsRequest).not.toHaveBeenCalled();
      expect(vi.mocked(admitProviderBudget)).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "owner", poolId: "pool", poolGrantId: GRANT_ID }),
      );
    } finally {
      resetConsentState();
    }
  });

  // #62 AC: pool fallback settles against the pool owner's budget even when a
  // grantee made the request (own-key settles against the requester, above).
  it("settles a grantee's OpenRouter pool fallback against the owner's budget", async () => {
    try {
      const settled = await settleOwnerStream(
        "openrouter",
        [Buffer.from(`${openRouterUsageFixture.stream.join("\n\n")}\n\n`)],
        "grantee",
      );
      expect(settled).toMatchObject({
        userId: "owner",
        poolId: "pool",
        observationComplete: true,
        usage: { categoriesComplete: true },
      });
      expect(providerBillableTokens(settled.usage)).toBe(1_280n);
      expect(vi.mocked(admitProviderBudget)).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: "owner", poolId: "pool", poolGrantId: GRANT_ID }),
      );
    } finally {
      resetConsentState();
    }
  });

  // Live captures: the dispatcher's whole-stream collector is keyed by the
  // upstream surface (Messages: message_delta; Responses: response.completed).
  it.each([
    ["messages-stream-write", "anthropic-messages", "0.0096115"],
    ["responses-stream", "openai-responses", "0.00008"],
    ["chat-stream-write", "openai-chat", "0.0096115"],
  ] as const)("settles the live %s capture through the dispatcher", async (name, surface, cost) => {
    const settled = await settleOwnerStream(
      "openrouter",
      [readFileSync(new URL(`./fixtures/openrouter-live/${name}.raw`, import.meta.url))],
      "owner",
      surface,
    );
    expect(settled).toMatchObject({
      userId: "owner",
      poolId: "pool",
      usage: { categoriesComplete: true },
    });
    expect(settled.usage.reportedCost?.toString()).toBe(cost);
    // OpenRouter's Responses stream sends no `event:` lines and its terminal is
    // deliberately not recognised (read to EOF, full hold): the observation
    // completes only where the terminal is named (Messages `message_stop`,
    // Chat `[DONE]`).
    expect(settled.observationComplete).toBe(surface !== "openai-responses");
  });

  it("does not take a Responses terminal from an event line that disagrees with its type", async () => {
    const raw = readFileSync(
      new URL("./fixtures/openrouter-live/responses-stream.raw", import.meta.url),
      "utf8",
    );
    // A `response.completed` event line on a record of another type is no terminal.
    const text = raw.replace(
      /data: (\{"type":"response\.created")/,
      "event: response.completed\ndata: $1",
    );
    expect(text).not.toBe(raw);
    // The real terminal record is removed, leaving only the mismatching one.
    const withoutTerminal = text.replace(/data: \{"type":"response\.completed".*\n\n/, "");
    expect(withoutTerminal).not.toBe(text);
    const settled = await settleOwnerStream(
      "openrouter",
      [Buffer.from(withoutTerminal)],
      "owner",
      "openai-responses",
    );
    expect(settled.observationComplete).toBe(false);
  });

  // AC 13: an event-less (data-only) Responses record is never a terminal, for
  // any provider type: recognising one would cut the read off at the first
  // such record and make billing depend on transport chunking.
  it.each(["openrouter", "openai", "openai-compatible"] as const)(
    "does not complete an event-less Responses terminal for the %s provider type",
    async (providerType) => {
      // Strip the trailing `data: [DONE]` sentinel so nothing else ends the stream.
      const raw = readFileSync(
        new URL("./fixtures/openrouter-live/responses-stream.raw", import.meta.url),
        "utf8",
      );
      const withoutDone = raw.replace(/data: \[DONE\]\s*$/, "");
      expect(withoutDone).not.toBe(raw);
      const settled = await settleOwnerStream(
        providerType,
        [Buffer.from(withoutDone)],
        "owner",
        "openai-responses",
      );
      expect(settled.observationComplete).toBe(false);
    },
  );

  // AC 14 / M5: Messages stays strict. A data-only `message_stop` with no
  // `event:` line must never be taken as a terminal, even though the record's
  // `type` names it; otherwise a truncated/forged Messages stream would settle.
  it("does not complete a Messages stream whose terminal has no event line", async () => {
    const raw = readFileSync(
      new URL("./fixtures/openrouter-live/messages-stream-write.raw", import.meta.url),
      "utf8",
    );
    const withoutEvents = raw
      .split("\n")
      .filter((line) => !line.startsWith("event:"))
      .join("\n");
    expect(withoutEvents).not.toBe(raw);
    expect(withoutEvents).toContain('data: {"type":"message_stop"}');
    const settled = await settleOwnerStream(
      "openrouter",
      [Buffer.from(withoutEvents)],
      "owner",
      "anthropic-messages",
    );
    expect(settled.observationComplete).toBe(false);
  });

  it.each([
    { providerType: "openrouter", complete: true },
    { providerType: "openai", complete: false },
    { providerType: "openai-compatible", complete: false },
  ])(
    "settles $providerType usage to the pool owner (categoriesComplete $complete)",
    async ({ providerType, complete }) => {
      // Catalog-import-shaped rates (the import always writes reasoning).
      db.providerPricingVersion.findFirst.mockResolvedValue({
        ...pricingRow(),
        pricing: {
          ratesPerMillion: {
            input: "1",
            output: "4",
            cacheRead: "0.1",
            cacheWrite: "1.25",
            reasoning: "4",
          },
        },
      });
      let settled: Awaited<ReturnType<typeof settleOwnerStream>>;
      try {
        settled = await settleOwnerStream(providerType, [
          Buffer.from(`${openRouterUsageFixture.stream.join("\n\n")}\n\n`),
        ]);
      } finally {
        db.providerPricingVersion.findFirst.mockReset();
      }
      expect(settled).toMatchObject({
        userId: "owner",
        poolId: "pool",
        observationComplete: true,
        usage: { categoriesComplete: complete },
      });
      const billed = providerBillableTokens(settled.usage);
      if (complete) {
        expect(billed).toBe(1_280n);
        expect(billed! < liability.tokens).toBe(true);
        // 600*1 + 50*4 + 600*0.1 + 30*4 per million: real prices, not the reservation.
        expect(settled.usage.calculatedCost?.toString()).toBe("0.00098");
        expect(settled.usage.calculatedCostPricingVersion).toBe("price-1");
      } else {
        // Fail closed: settlement keeps the full reservation (liability path).
        expect(billed).toBeUndefined();
      }
    },
  );

  // OpenRouter reports usage once. A second distinct observation (split
  // across the windows) cannot be attributed to one snapshot, so an earlier
  // charge or authoritative total must not settle below the liability.
  it.each([
    {
      label: "an earlier reported cost",
      first: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001, cost: 0.000001 },
      second: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cache_write_tokens: 1000 },
      },
    },
    {
      label: "an earlier authoritative total",
      first: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, billable_tokens: 1 },
      second: { output_tokens: 100 },
    },
    {
      label: "two complete observations",
      first: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001 },
      second: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    },
    // A later observation the parser cannot read still counts.
    ...[
      { total_tokens: 100_000 },
      { future_tokens: 5000 },
      { completion_tokens: "100000" },
      { completion_tokens_details: { image_tokens: 5000 } },
    ].map((second) => ({
      label: `a later unreadable ${JSON.stringify(second)}`,
      first: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0.000001 },
      second,
    })),
  ])(
    "keeps the liability for split observations with $label",
    async ({ first, second }) => {
      db.providerPricingVersion.findFirst.mockResolvedValue(pricingRow());
      try {
        const frame = (usage: Record<string, unknown>) =>
          Buffer.from(`data: ${JSON.stringify({ usage: { ...usage, is_byok: false } })}\n\n`);
        const padding = Array.from({ length: 1100 }, () =>
          Buffer.from(`: ${"x".repeat(1024)}\n\n`),
        );
        for (const upstream of [
          [frame(first), ...padding, frame(second), Buffer.from("data: [DONE]\n\n")],
          // Both observations inside one retained window.
          [...padding, frame(first), frame(second), Buffer.from("data: [DONE]\n\n")],
          // The later observation is outside both retained windows.
          [
            frame(first),
            ...padding.slice(0, 600),
            frame(second),
            ...padding,
            Buffer.from("data: [DONE]\n\n"),
          ],
        ]) {
          const settled = await settleOwnerStream("openrouter", upstream);
          expect(settled.observationComplete).toBe(true);
          expect(settled.usage.categoriesComplete).toBe(false);
          expect(settled.usage.reportedCost).toBeUndefined();
          expect(settled.usage.calculatedCost).toBeUndefined();
          expect(settled.usage.authoritativeBillableTokens).toBeUndefined();
          expect(providerBillableTokens(settled.usage)).toBeUndefined();
        }
      } finally {
        db.providerPricingVersion.findFirst.mockReset();
      }
    },
    60_000,
  );

  it("settles only the usage record the stream itself carried", async () => {
    db.providerPricingVersion.findFirst.mockResolvedValue(pricingRow());
    try {
      const small = {
        prompt_tokens: 1,
        completion_tokens: 0,
        total_tokens: 1,
        cost: 0.000001,
        is_byok: false,
      };
      const big = {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        is_byok: false,
      };
      const data = (value: unknown) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
      const comment = (text: string) => Buffer.from(`: ${text}\n\n`);
      const padding = (count: number) =>
        Array.from({ length: count }, () => comment("x".repeat(1024)));
      const done = Buffer.from("data: [DONE]\n\n");
      // A record whose usage sits in a root `response`, outside both windows.
      const responseContainer = await settleOwnerStream("openrouter", [
        data({ choices: [], usage: small }),
        ...padding(600),
        data({ choices: [], response: big }),
        ...padding(1100),
        done,
      ]);
      // Usage text inside an SSE comment is not a record.
      const commentOnly = await settleOwnerStream("openrouter", [
        comment(JSON.stringify({ usage: small })),
        ...padding(1200),
        done,
      ]);
      // A later record the stream cannot read (non-JSON data) may hide usage.
      const unreadableLater = await settleOwnerStream("openrouter", [
        data({ choices: [], usage: small }),
        Buffer.from(`data: ${JSON.stringify({ choices: [], usage: big })} trailing\n\n`),
        done,
      ]);
      expect(unreadableLater.usage.categoriesComplete).toBe(false);
      for (const settled of [responseContainer, commentOnly, unreadableLater]) {
        expect(settled.usage?.reportedCost).toBeUndefined();
        expect(settled.usage?.calculatedCost).toBeUndefined();
        if (settled.usage) expect(providerBillableTokens(settled.usage)).toBeUndefined();
      }
      // One honest record held by both the prefix and the tail still settles.
      const overlap = await settleOwnerStream("openrouter", [
        ...padding(40),
        data({ choices: [], usage: big }),
        ...padding(1000),
        done,
      ]);
      expect(overlap.usage.categoriesComplete).toBe(true);
      expect(providerBillableTokens(overlap.usage)).toBe(1_100n);
    } finally {
      db.providerPricingVersion.findFirst.mockReset();
    }
  }, 60_000);

  it.each([
    { label: "complete prefix, incomplete tail", writes: [0, 1000], complete: false },
    { label: "incomplete prefix, complete tail", writes: [1000, 0], complete: false },
    { label: "complete prefix and tail", writes: [0, 0], complete: true },
  ])(
    "prices only the merged observation ($label)",
    async ({ writes, complete }) => {
      db.providerPricingVersion.findFirst.mockResolvedValue(pricingRow());
      try {
        const usage = (cacheWrite: number) => ({
          prompt_tokens: 1000,
          completion_tokens: 1,
          total_tokens: 1001,
          is_byok: false,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: cacheWrite },
        });
        const frame = (data: unknown) => Buffer.from(`data: ${JSON.stringify(data)}\n\n`);
        const settled = await settleOwnerStream("openrouter", [
          frame({ usage: usage(writes[0]!) }),
          ...Array.from({ length: 1100 }, () => Buffer.from(`: ${"x".repeat(1024)}\n\n`)),
          frame({ usage: usage(writes[1]!) }),
          Buffer.from("data: [DONE]\n\n"),
        ]);
        expect(settled.usage.categoriesComplete).toBe(complete);
        if (complete) {
          // 1000*1 + 1*4 per million, priced once from the merged categories.
          expect(settled.usage.calculatedCost?.toString()).toBe("0.001004");
          expect(providerBillableTokens(settled.usage)).toBe(1_001n);
        } else {
          expect(settled.usage.calculatedCost).toBeUndefined();
          expect(settled.usage.calculatedCostSource).toBeUndefined();
          expect(providerBillableTokens(settled.usage)).toBeUndefined();
        }
      } finally {
        db.providerPricingVersion.findFirst.mockReset();
      }
    },
    60_000,
  );
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
    claimAllowDataCollection = allowDataCollection,
    body,
    status = 200,
    responseBody = '{"choices":[]}',
  }: {
    providerType: string;
    allowDataCollection: boolean;
    /** The account's setting when the send claim re-reads it under its lock. */
    claimAllowDataCollection?: boolean;
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
      providerAccount: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ providerType, allowDataCollection: claimAllowDataCollection }),
      },
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
    expect(result.dataPolicyRefusal).toBe(true);
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
    expect(result.dataPolicyRefusal).toBeUndefined();
    expect(result.response.status).toBe(404);
    expect(await result.response.text()).toBe(original);
  });

  it("applies an opt-out withdrawn after listing, read under the send-claim lock", async () => {
    const { result, sentBody } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: true,
      claimAllowDataCollection: false,
      body: '{"model":"pool","provider":{"order":["a"],"data_collection":"allow"}}',
    });
    expect(result.dispatched).toBe(true);
    expect(sentBody?.provider).toEqual({ order: ["a"], data_collection: "deny" });
  });

  it("maps the data-policy 404 for a deny added at the send claim", async () => {
    const { result } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: true,
      claimAllowDataCollection: false,
      body: '{"model":"pool"}',
      status: 404,
      responseBody: '{"error":{"message":"No endpoints found matching your data policy"}}',
    });
    if (!result.dispatched) throw new Error("expected dispatch");
    expect(result.dataPolicyRefusal).toBe(true);
    expect(result.response.status).toBe(503);
    await result.terminal;
  });

  it("never sends when a deny added at the send claim cannot be carried", async () => {
    const { result } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: true,
      claimAllowDataCollection: false,
      body: "[1,2,3]",
    });
    expect(result.dispatched).toBe(false);
    expect(providerHttpsRequest).not.toHaveBeenCalled();
  });

  it("never relaxes a deny rendered at listing when the account opts in before the claim", async () => {
    const { sentBody } = await dispatchWith({
      providerType: "openrouter",
      allowDataCollection: false,
      claimAllowDataCollection: true,
      body: '{"model":"pool","messages":[]}',
    });
    expect(sentBody?.provider).toEqual({ data_collection: "deny" });
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

/** The provider account row the send claim re-reads for the D9 policy. */
function claimPrivacyAccount() {
  return { providerType: "openai", allowDataCollection: false };
}

it.each(["openai-chat", "openai-responses"] as const)(
  "R4 public dispatcher propagates %s embedded-depth refusal before budget/send/health",
  async (surface) => {
    vi.clearAllMocks();
    db.modelPool.findFirst.mockResolvedValue(
      dispatchPoolFixture("anthropic", "anthropic-messages", "anthropic"),
    );
    const payload = embeddedArgumentsRequest(surface, nestedWire(257, "object"));
    const canonical = parseCanonicalRequest(surface, payload);
    const request = {
      userId: "owner",
      poolId: "pool",
      requestId: "depth-refusal",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY" as const,
      ...ownerConsentFields(),
      requestedProtocol: "openai" as const,
      requestedSurface: surface,
      stream: false,
      requiredFeatures: [],
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode(JSON.stringify(payload)),
      signal: new AbortController().signal,
      liability: { accountingVersion: "provider-billable-v1" },
      releaseLocalCapacity: vi.fn(),
      adaptationEnabled: true,
      retrySafe: false,
      renderForTarget: async () => ({
        protocol: "anthropic" as const,
        path: "/v1/messages",
        headers: new Headers(),
        body: new TextEncoder().encode(
          JSON.stringify(
            renderCanonicalRequest({
              request: canonical,
              target: "anthropic-messages",
              model: "m",
            }),
          ),
        ),
      }),
    };
    await expect(dispatchPublicOverflow(request)).rejects.toMatchObject({
      code: "request_json_depth_exceeded",
      message: "request JSON nesting exceeds 256 levels",
    });
    expect(admitProviderBudget).not.toHaveBeenCalled();
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(recordProviderOutcome).not.toHaveBeenCalled();
  },
);

it.each(
  ["nonstream", "sse-data", "sse-arguments", "sse-adapter-cancel"].flatMap((mode) =>
    (mode === "sse-adapter-cancel" ? [257] : [20, 257]).map((depth) => ({ mode, depth })),
  ),
)("R6 adapted provider settlement $mode depth=$depth", async ({ mode, depth }) => {
  vi.clearAllMocks();
  const stream = mode !== "nonstream";
  db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
  const tx = {
    ...consentDelegates(),
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      mockRequesterValidityQuery(strings, values, consentDelegates()),
    ),
    providerAccount: { findFirst: vi.fn().mockResolvedValue(claimPrivacyAccount()) },
    providerCredential: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          dispatchPoolFixture().PoolMembers[0]!.ExecutionTarget.ProviderModel.ProviderAccount
            .CurrentCredential,
        ),
      update: vi.fn().mockResolvedValue({ id: "credential-heartbeat" }),
    },
  };
  db.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
    callback(tx),
  );
  const argumentsText = nestedWire(depth, "object");
  const reply = {
    id: "reply",
    object: "chat.completion",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "lookup", arguments: argumentsText },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
  const chunk = (choices: unknown[], extension?: unknown) =>
    Buffer.from(
      `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 0, model: "m", choices, ...(extension === undefined ? {} : { extension }) })}\n\n`,
    );
  const chunks = !stream
    ? [Buffer.from(JSON.stringify(reply))]
    : mode === "sse-data" || mode === "sse-adapter-cancel"
      ? [
          chunk([], JSON.parse(argumentsText)),
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
          Buffer.from(
            'data: {"id":"reply","object":"chat.completion.chunk","created":0,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
          ),
          Buffer.from("data: [DONE]\n\n"),
        ]
      : [
          chunk([
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call",
                    type: "function",
                    function: { name: "lookup", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
          chunk([
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText } }] },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
          Buffer.from("data: [DONE]\n\n"),
        ];
  let initialSent = false;
  const upstream =
    mode === "sse-adapter-cancel"
      ? new Readable({
          read() {
            if (!initialSent) {
              initialSent = true;
              this.push(chunks[0]);
            }
          },
        })
      : Readable.from(chunks);
  providerHttpsRequest.mockResolvedValueOnce(
    Object.assign(upstream, {
      statusCode: 200,
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      complete: mode !== "sse-adapter-cancel",
    }),
  );
  const result = await dispatchPublicOverflow({
    userId: "owner",
    poolId: "pool",
    requestId: "response-depth",
    reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
    ...ownerConsentFields(),
    requestedProtocol: "anthropic",
    requestedSurface: "anthropic-messages",
    stream,
    requiredFeatures: [],
    path: "/v1/messages",
    headers: new Headers(),
    body: new TextEncoder().encode('{"model":"pool"}'),
    signal: new AbortController().signal,
    liability: { accountingVersion: "provider-billable-v1" },
    releaseLocalCapacity: vi.fn(),
    adaptationEnabled: true,
    retrySafe: false,
    renderForTarget: async () => ({
      protocol: "openai",
      path: "/v1/chat/completions",
      headers: new Headers(),
      body: new TextEncoder().encode(
        JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }], stream }),
      ),
    }),
  });
  if (!result.dispatched) throw new Error(`expected dispatch: ${result.reason}`);
  if (mode === "sse-adapter-cancel") {
    const adapted = result.response.body!.pipeThrough(
      createProtocolAdaptationTransform({
        source: "openai-chat",
        target: "anthropic-messages",
        request: parseCanonicalRequest("anthropic-messages", {
          model: "m",
          max_tokens: 8,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );
    if (depth <= 256) await new Response(adapted).text();
    else
      await expect(new Response(adapted).text()).rejects.toMatchObject({
        code: "response_json_depth_exceeded",
      });
  } else await result.response.text();
  expect(await result.terminal).toMatchObject({ ok: depth <= 256 });
  expect(reconcileProviderBudget).toHaveBeenCalledTimes(1);
  expect(reconcileProviderBudget).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: depth <= 256 ? "COMPLETED" : "FAILED",
      ...(!stream
        ? {
            observationComplete: true,
            usage: expect.objectContaining({ inputTokens: 5n, outputTokens: 3n }),
          }
        : {}),
    }),
  );
  expect(recordProviderOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ success: depth <= 256 }),
  );
  expect(recordProviderAttemptEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: "TERMINAL",
      terminalState: depth <= 256 ? "COMPLETED" : "FAILED",
    }),
  );
  expect(heartbeatProviderAttempt).not.toHaveBeenCalled();
});
