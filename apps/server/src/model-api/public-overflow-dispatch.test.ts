/**
 * `owner/pool:external` end to end at the dispatch layer, with the database and the provider
 * mocked (no network): consent → cloud member listing → spend admission → health trial → E0
 * send claim → provider request → settlement. Spend admission/settlement themselves are tested
 * in provider-budget.test.ts; here they are spies so the pipeline's order and arguments show.
 */
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEYRING = vi.hoisted(() => `v1:${Buffer.alloc(32, 9).toString("base64")}`);

const world = vi.hoisted(() => ({
  calls: [] as string[],
  mode: "OWNER" as "OFF" | "OWNER" | "OWNER_AND_SHARES",
  credential: null as Record<string, unknown> | null,
  admission: { admitted: true, providerAttemptId: "attempt", reservationIds: ["r1"] } as
    | { admitted: true; providerAttemptId: string; reservationIds: string[] }
    | { admitted: false; reason: string },
  reconciled: [] as Array<Record<string, unknown>>,
  admitted: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ baseUrl: string; path: string; auth: unknown; body: string }>,
  providerStatus: 200,
  /** The credential was rotated after listing: the claim finds none current. */
  rotated: false,
}));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: KEYRING,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  const active = { banned: false, banExpires: null, deletionRequestedAt: null };
  const model = () => ({
    id: "model",
    userId: "owner",
    providerAccountId: "account",
    upstreamModelId: "vendor/model",
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
    nativeCapabilities: { protocols: ["openai"], surfaces: ["openai-chat"], streaming: true },
    health: "HEALTHY",
    healthNextRetryAt: null,
    healthHalfOpenAt: null,
    enabled: true,
    deletedAt: null,
    Target: { id: "target" },
    Account: {
      id: "account",
      userId: "owner",
      providerType: "generic",
      providerVersion: null,
      allowDataCollection: false,
      baseUrl: "https://provider.example/v1",
      endpointIdentity: "endpoint",
      endpointVersion: 1,
      authType: "BEARER",
      healthNextRetryAt: null,
      healthHalfOpenAt: null,
      enabled: true,
      deletedAt: null,
      CurrentCredential: { ...world.credential, status: "ACTIVE" },
    },
  });
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("wsmp_acquire_fences")) {
        world.calls.push("claim");
        return [{ acquired: true }];
      }
      return [];
    },
    pool: {
      findFirst: async () => ({
        Fallback: {
          mode: world.mode,
          paidWarmProtection: false,
          embeddingContract: null,
          ownKeyEquivalentModel: null,
        },
      }),
    },
    share: { findFirst: async () => null },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, ...active })),
    },
    apiKey: { findFirst: async () => ({ expiresAt: null, scope: "ALL_POOLS", Pools: [] }) },
    providerAccount: {
      findFirst: async () => ({ providerType: "generic", allowDataCollection: false }),
    },
    providerModel: {
      findFirst: async () => ({
        enabled: true,
        nativeCapabilities: null,
        Account: { enabled: true },
      }),
    },
    poolMember: { findFirst: async () => ({ id: "member" }) },
    providerCredential: {
      findFirst: async () => (world.rotated ? null : world.credential),
      update: async () => ({}),
    },
  };
  return {
    default: {
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
      pool: {
        findFirst: async () => ({
          id: "pool",
          userId: "owner",
          User: active,
          Fallback: {
            mode: world.mode,
            paidWarmProtection: false,
            embeddingContract: null,
            ownKeyEquivalentModel: null,
          },
          Advanced: null,
          Members: [{ id: "member", cloudOrder: 0, ProviderModel: model() }],
        }),
      },
      user: { findUnique: async () => active },
      share: { findFirst: async () => null },
      apiKey: {
        findFirst: async () => ({ expiresAt: null, scope: "ALL_POOLS", Pools: [] }),
      },
    },
    Prisma,
  };
});

vi.mock("./provider-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-budget.js")>()),
  admitProviderBudget: async (attempt: Record<string, unknown>) => {
    world.calls.push("admit");
    world.admitted.push(attempt);
    return world.admission;
  },
  reconcileProviderBudget: async (terminal: Record<string, unknown>) => {
    world.calls.push(`reconcile:${String(terminal.reason)}`);
    world.reconciled.push(terminal);
  },
}));

vi.mock("./provider-attempt-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-attempt-runtime.js")>()),
  allocateProviderFence: async () => 7n,
  claimProviderHealthTrial: async () => {
    world.calls.push("health");
    return "READY";
  },
  heartbeatProviderAttempt: async () => true,
  recordProviderAttemptEvent: async () => undefined,
  recordProviderOutcome: async () => undefined,
  releaseProviderHealthTrial: async () => true,
}));

vi.mock("./provider-pricing.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./provider-pricing.js")>();
  const { CATALOG_CHARGE_RULES } = await import("@ws-model-proxy/api/lib/provider-catalog-model");
  return {
    ...original,
    resolveActiveProviderPricing: async () =>
      original.parsePricingSchedule({
        id: "pricing",
        version: "p1",
        currency: "USD",
        accountingVersion: "provider-billable-v1",
        confidence: "CALCULATED",
        effectiveAt: new Date("2026-01-01T00:00:00Z"),
        // The shape the providers router stores (per million tokens, fail closed).
        pricing: { ratesPerMillion: { input: "1", output: "2" } },
        chargeRules: CATALOG_CHARGE_RULES,
      }),
  };
});

vi.mock("@ws-model-proxy/api/lib/provider-egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/api/lib/provider-egress")>()),
  providerHttpsRequest: async (
    baseUrl: string,
    options: { path: string; body?: Uint8Array },
    _policy: unknown,
    _protocol: unknown,
    auth: unknown,
  ) => {
    world.calls.push("send");
    world.sent.push({
      baseUrl,
      path: options.path,
      auth,
      body: new TextDecoder().decode(options.body),
    });
    const payload = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "vendor/model",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
    const body = Readable.from([Buffer.from(payload)]);
    return Object.assign(body, {
      statusCode: world.providerStatus,
      headers: { "content-type": "application/json" },
      // IncomingMessage: the whole body arrived.
      complete: true,
    });
  },
}));

import {
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import { evaluateExternalEgress } from "./external-route.js";
import { dispatchPublicOverflow } from "./public-overflow.js";

function consent() {
  const decision = evaluateExternalEgress({
    requested: true,
    requester: { userId: "owner", source: "API_KEY", apiKeyId: "key" },
    pool: {
      id: "pool",
      ownerUserId: "owner",
      shareId: null,
      fallbackMode: "OWNER",
      externalEquivalentModel: null,
      ownKeyProviderModelId: null,
    },
  });
  if (!decision.granted) throw new Error("expected consent");
  return decision.consent;
}

function request() {
  return {
    userId: "owner",
    poolId: "pool",
    requestId: "relay-request",
    reason: "LOCAL_WAIT_EXPIRED" as const,
    externalConsent: consent(),
    requesterUserId: "owner",
    requesterModelApiTokenId: "key",
    requestedProtocol: "openai" as const,
    requestedSurface: "openai-chat" as const,
    stream: false,
    requiredFeatures: [],
    path: "/v1/chat/completions",
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(
      JSON.stringify({
        model: "owner/pool:external",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      }),
    ),
    signal: new AbortController().signal,
    liability: { tokens: 200n, accountingVersion: "provider-billable-v1" },
    requestedOutputTokens: 100n,
    releaseLocalCapacity: async () => undefined,
    adaptationEnabled: false,
    retrySafe: true,
  };
}

beforeEach(() => {
  world.calls.length = 0;
  world.mode = "OWNER";
  world.reconciled.length = 0;
  world.admitted.length = 0;
  world.sent.length = 0;
  world.providerStatus = 200;
  world.rotated = false;
  world.admission = { admitted: true, providerAttemptId: "attempt", reservationIds: ["r1"] };
  const keyring = parseProviderCredentialKeyring(KEYRING);
  const sealed = encryptProviderCredential(
    "sk-provider",
    {
      credentialId: "credential",
      userId: "owner",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
    },
    keyring,
  );
  world.credential = {
    id: "credential",
    credentialType: "BEARER",
    aadVersion: 1,
    algorithm: sealed.algorithm,
    keyVersion: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    authTag: sealed.authTag,
  };
});

describe("owner/pool:external dispatch", () => {
  it("reserves, claims, sends to the cloud member, then settles the attempt", async () => {
    const result = await dispatchPublicOverflow(request());
    expect(result.dispatched).toBe(true);
    if (!result.dispatched) return;
    expect(await result.response.text()).toContain('"content":"hi"');
    await result.terminal;
    expect(world.calls).toEqual(["admit", "health", "claim", "send", "reconcile:COMPLETED"]);
    expect(world.sent[0]).toMatchObject({
      baseUrl: "https://provider.example/v1",
      path: "/v1/chat/completions",
      auth: { type: "BEARER", token: "sk-provider" },
    });
    expect(JSON.parse(world.sent[0]?.body ?? "{}").model).toBe("vendor/model");
    // The liability is priced, in the cap's currency, before anything is sent.
    expect(world.admitted[0]).toMatchObject({
      userId: "owner",
      providerAccountId: "account",
      providerModelId: "model",
      poolId: "pool",
      poolMemberId: "member",
      targetId: "target",
      requestId: "relay-request",
      fencingToken: 7n,
      shareId: undefined,
      liability: { currency: "USD", pricingVersion: "p1" },
    });
    expect(world.reconciled[0]).toMatchObject({
      reason: "COMPLETED",
      fencingToken: 7n,
      revisionKind: "SNAPSHOT",
    });
  });

  it("tries only the members the caller found servable", async () => {
    const result = await dispatchPublicOverflow({
      ...request(),
      eligibleExecutionTargetIds: ["another-target"],
    });
    expect(result).toMatchObject({ dispatched: false, reason: "NO_COMPATIBLE_PROVIDER" });
    expect(world.calls).toEqual([]);
  });

  it("sends nothing when the spend cap refuses the attempt", async () => {
    world.admission = { admitted: false, reason: "BUDGET_EXCEEDED" };
    const result = await dispatchPublicOverflow(request());
    expect(result).toMatchObject({ dispatched: false, reason: "BUDGET_EXCEEDED" });
    expect(world.calls).toEqual(["admit"]);
    expect(world.sent).toEqual([]);
  });

  it("refuses before any reservation when the pool's cloud mode is off", async () => {
    world.mode = "OFF";
    const result = await dispatchPublicOverflow(request());
    // The listing already sees OFF: refused before any reservation.
    expect(result).toMatchObject({ dispatched: false, reason: "POOL_PRIVATE" });
    expect(world.calls).toEqual([]);
  });

  it("settles a never-sent attempt when the credential rotated before the claim", async () => {
    world.rotated = true;
    const result = await dispatchPublicOverflow({ ...request(), retrySafe: false });
    expect(result).toMatchObject({ dispatched: false, reason: "SEND_CLAIM_FAILED" });
    expect(world.sent).toEqual([]);
    expect(world.reconciled[0]).toMatchObject({ dispatchOutcome: "NOT_SENT", reason: "FAILED" });
  });
});
