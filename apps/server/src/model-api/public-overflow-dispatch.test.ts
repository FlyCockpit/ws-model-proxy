import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const providerHttpsRequest = vi.hoisted(() => vi.fn());
const recordProviderOutcome = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const heartbeatProviderAttempt = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const releaseProviderHealthTrial = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const reconcileProviderBudget = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const db = vi.hoisted(() => ({
  modelPool: { findFirst: vi.fn() },
  providerAttempt: { groupBy: vi.fn().mockResolvedValue([]) },
  providerPricingVersion: { findFirst: vi.fn() },
  cacheAffinityRecord: { findMany: vi.fn().mockResolvedValue([]) },
  capacityLease: { groupBy: vi.fn().mockResolvedValue([]) },
  capacityWaiter: { groupBy: vi.fn().mockResolvedValue([]) },
  relayRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  $transaction: vi.fn(),
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
vi.mock("./provider-attempt-runtime.js", () => ({
  allocateProviderFence: vi.fn().mockResolvedValue(1n),
  claimProviderHealthTrial: vi.fn().mockResolvedValue("READY"),
  classifyProviderFailure: vi.fn((status?: number) => (status === 429 ? "RATE_LIMIT" : "SERVER")),
  finishProviderAttempt: vi.fn().mockResolvedValue(true),
  heartbeatProviderAttempt,
  parseRetryAfter: vi.fn((value?: string) => (value === "37" ? 37_000 : undefined)),
  recordProviderAttemptEvent: vi.fn().mockResolvedValue(undefined),
  recordProviderOutcome,
  releaseProviderHealthTrial,
}));

import {
  dispatchPublicOverflow,
  listPublicOverflowTargets,
  rankPublicOverflowTargets,
} from "./public-overflow.js";

function dispatchPoolFixture(
  protocol = "openai",
  surface = "openai-chat",
  providerType = "openai",
) {
  return {
    publicEgressEnabled: true,
    publicEgressAcknowledged: true,
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
      $queryRaw: vi.fn().mockResolvedValue([]),
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
      $queryRaw: vi.fn().mockResolvedValue([]),
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
      protocol: "openai",
      surface: "openai-chat",
      path: "/v1/chat/completions",
      chunk:
        'data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n',
      expected: { inputTokens: 9n, outputTokens: 1n },
    },
    {
      label: "Anthropic message_start usage",
      protocol: "anthropic",
      surface: "anthropic-messages",
      path: "/v1/messages",
      chunk:
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      expected: { inputTokens: 12n, outputTokens: 0n },
    },
  ])("retains $label when the upstream ends before its terminal event", async (fixture) => {
    reconcileProviderBudget.mockClear();
    db.modelPool.findFirst.mockResolvedValue(
      dispatchPoolFixture(fixture.protocol, fixture.surface, fixture.protocol),
    );
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
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
      requestedProtocol: fixture.protocol as "openai" | "anthropic",
      requestedSurface: fixture.surface as "openai-chat" | "anthropic-messages",
      stream: true,
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
    await result.response.text();
    await result.terminal;

    expect(reconcileProviderBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          ...fixture.expected,
          categoriesComplete: false,
          rawUsage: expect.anything(),
        }),
      }),
    );
  });

  it("keeps unavailable targets with cooldown metadata eligible for half-open recovery", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
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
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
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
      $queryRaw: vi.fn().mockResolvedValue([]),
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

  it("does not record client cancellation before response as a provider transport failure", async () => {
    recordProviderOutcome.mockClear();
    db.modelPool.findFirst.mockResolvedValue({
      publicEgressEnabled: true,
      publicEgressAcknowledged: true,
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
      $queryRaw: vi.fn().mockResolvedValue([]),
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
    providerHttpsRequest.mockRejectedValueOnce(controller.signal.reason);

    const result = await dispatchPublicOverflow({
      userId: "owner",
      poolId: "pool",
      requestId: "request-cancel",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
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

    expect(result).toEqual({ dispatched: false, reason: "PROVIDER_UNAVAILABLE" });
    expect(recordProviderOutcome).not.toHaveBeenCalled();
  });

  it("aborts a pending provider request when heartbeat ownership is lost", async () => {
    vi.useFakeTimers();
    try {
      recordProviderOutcome.mockClear();
      releaseProviderHealthTrial.mockClear();
      heartbeatProviderAttempt.mockResolvedValueOnce(false);
      db.modelPool.findFirst.mockResolvedValue(dispatchPoolFixture());
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
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

      await expect(dispatched).resolves.toEqual({
        dispatched: false,
        reason: "PROVIDER_UNAVAILABLE",
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
        $queryRaw: vi.fn().mockResolvedValue([]),
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
