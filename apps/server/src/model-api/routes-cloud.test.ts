/**
 * Route-level `owner/pool:external` on a provider-only pool: cloud members are dispatched
 * directly (no capacity lease), and a share holder's own-key tier that does not serve falls
 * through to the owner-paid tier in the same request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target, key) =>
      key === "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED"
        ? true
        : key === "BETTER_AUTH_SECRET"
          ? "test-better-auth-secret-value-32chars!"
          : key === "NODE_ENV"
            ? "test"
            : undefined,
  }),
}));
vi.mock("@ws-model-proxy/db", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/db/prisma/generated/client")
  >("../../../../packages/db/prisma/generated/client");
  return { default: mockDeep<PrismaClient>(), Prisma: actual.Prisma };
});
const resolve = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  listCallableTargetsForUser: vi.fn(),
  listCallableTargetsForApiKey: vi.fn(),
  poolRoutes: vi.fn(async () => []),
  testRoutes: vi.fn(async () => []),
}));
vi.mock("./resolve.js", () => resolve);
const overflow = vi.hoisted(() => ({
  listPublicOverflowTargets: vi.fn(),
  dispatchPublicOverflow: vi.fn(),
}));
vi.mock("./public-overflow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./public-overflow.js")>()),
  ...overflow,
}));

const prisma = (await import("@ws-model-proxy/db")).default;
const { providerModelInventory } = await import(
  "@ws-model-proxy/api/lib/provider-model-capabilities"
);
const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const { createModelApiRoutes } = await import("./routes.js");
const { ModelApiConcurrencyLimiter } = await import("./limits.js");
type ProviderTarget = import("./public-overflow.js").PublicProviderTarget;
type Listing = Awaited<ReturnType<typeof import("./public-overflow.js").listPublicOverflowTargets>>;
type Dispatch = Parameters<typeof import("./public-overflow.js").dispatchPublicOverflow>[0];

const POOL = {
  target: "POOL" as const,
  id: "pool-1",
  modelId: "owner/chat",
  name: "Chat",
  description: null,
  modelType: "LLM" as const,
  ownerUserId: "owner",
  ownerUserSlug: "owner",
  poolSlug: "chat",
  shareId: "share-1",
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
  fallbackMode: "OWNER_AND_SHARES" as const,
  externalMemberCount: 1,
  externalEquivalentModel: "openai/gpt-x",
  embeddingContract: null,
  paidWarmProtection: false,
  ownKeyProviderModelId: "grantee-model",
};

function providerTarget(overrides: Partial<ProviderTarget>): ProviderTarget {
  return {
    poolMemberId: "member-1",
    executionTargetId: "target-owner",
    publicOrder: 0,
    providerModelId: "owner-model",
    upstreamModelId: "openai/gpt-x",
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
    protocol: "openai",
    providerAccountId: "account-owner",
    endpointIdentity: "endpoint",
    endpointVersion: 1,
    concurrencyLimit: null,
    providerVersion: null,
    dataCollectionPolicy: null,
    baseUrl: "https://provider.example",
    authType: "BEARER",
    healthStatus: "HEALTHY",
    nativeProtocols: ["openai"],
    nativeSurfaces: ["openai-chat"],
    supportsStreaming: true,
    supportedFeatures: [],
    credential: {
      id: "credential",
      credentialType: "BEARER",
      keyVersion: "v1",
      aadVersion: 1,
      algorithm: "AES-256-GCM",
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
    },
    ...overrides,
  };
}

function listing(targets: ProviderTarget[]): Listing {
  return {
    enabled: true,
    ownerActive: true,
    fallbackForGrantees: true,
    affinityPolicy: {
      enabled: false,
      ttlSeconds: 3600,
      maxRecords: 10_000,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
      residencyWeight: 100,
    },
    targets,
    coolingDown: [],
    unavailable: [],
  };
}

const OWNER_TARGET = providerTarget({});
const OWN_KEY_TARGET = providerTarget({
  ownKey: true,
  poolMemberId: "",
  executionTargetId: "target-grantee",
  providerModelId: "grantee-model",
  providerAccountId: "account-grantee",
});

/** The caller's concurrency leases, so a test can see each one released. */
let limiter: InstanceType<typeof ModelApiConcurrencyLimiter>;
let leaseReleases: ReturnType<typeof vi.fn>[];

function app() {
  return createModelApiRoutes({
    // The unit-test double: cloud members never need durable capacity admission.
    capacityRuntime: undefined,
    concurrencyLimiter: limiter,
    manager: {
      getOnlineNodeIds: () => [],
      registerRelayResponseHandlers: vi.fn(),
      sendRelayRequest: vi.fn(),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
      supportsCountContext: () => false,
    },
  });
}

function chat(stream = false) {
  return app().request("/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer wsmp_key_test", "content-type": "application/json" },
    body: JSON.stringify({
      model: "owner/chat:external",
      messages: [{ role: "user", content: "hello" }],
      ...(stream ? { stream: true } : {}),
    }),
  });
}

/** An owner-paid dispatch that committed with `response`. */
function dispatched(
  response: Response,
  terminal = Promise.resolve({ ok: true, responseBytes: 10 }),
) {
  return {
    dispatched: true as const,
    response,
    target: OWNER_TARGET,
    attemptId: "attempt-1",
    fencingToken: 1n,
    nativeSurface: "openai-chat" as const,
    attemptCount: 1,
    terminal,
    markFirstClientByte: async () => undefined,
    affinity: undefined,
  };
}

/** Owner-paid only: the share holder has no own-key choice. */
const OWNER_PAID_POOL = { ...POOL, ownKeyProviderModelId: null };

beforeEach(() => {
  mockReset(db);
  vi.clearAllMocks();
  db.relayRequest.create.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.update.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async () => undefined);
  limiter = new ModelApiConcurrencyLimiter();
  leaseReleases = [];
  const acquire = limiter.acquireGlobal.bind(limiter);
  vi.spyOn(limiter, "acquireGlobal").mockImplementation((input) => {
    const lease = acquire(input);
    const release = vi.fn(() => lease.release());
    leaseReleases.push(release);
    return { release };
  });
  resolve.authenticateApiKey.mockResolvedValue({
    id: "key-1",
    userId: "grantee",
    scope: "ALL_POOLS",
    lookupPrefix: "wsmp_key_test",
    expiresAt: null,
    lastUsedAt: null,
  });
  resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [POOL], tests: [] });
  overflow.listPublicOverflowTargets.mockImplementation(
    async (_owner: string, _pool: string, ownKey?: unknown) =>
      listing([ownKey ? OWN_KEY_TARGET : OWNER_TARGET]),
  );
});

describe("cloud members on the model API", () => {
  it("falls through from a share holder's own key to the owner-paid tier, with no capacity lease", async () => {
    const calls: Dispatch[] = [];
    overflow.dispatchPublicOverflow.mockImplementation(async (request: Dispatch) => {
      calls.push(request);
      if (request.ownKeyProviderModelId)
        return { dispatched: false, reason: "OWN_KEY_CONSENT_WITHDRAWN" };
      return {
        dispatched: true,
        response: new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: "openai/gpt-x",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        target: OWNER_TARGET,
        attemptId: "attempt-1",
        fencingToken: 1n,
        nativeSurface: "openai-chat",
        attemptCount: 1,
        terminal: Promise.resolve({ ok: true, responseBytes: 10 }),
        markFirstClientByte: async () => undefined,
        affinity: undefined,
      };
    });

    const response = await chat();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-route")).toBe("pool-fallback");
    expect(response.headers.get("x-wsmp-served-model")).toBe("openai/gpt-x");
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "hi" } }] });
    // Own key first (paid by the share holder), then the owner's members.
    expect(calls.map((call) => [call.userId, call.ownKeyProviderModelId])).toEqual([
      ["grantee", "grantee-model"],
      ["owner", undefined],
    ]);
    // Direct dispatch: the members this tier found servable, never a leased single member.
    expect(calls[1]).toMatchObject({ eligibleExecutionTargetIds: ["target-owner"] });
    expect(calls[1]?.admittedExecutionTargetId).toBeUndefined();
    expect(calls[1]?.forcedPoolMemberId).toBeUndefined();
    // The request log records the cloud route in its real columns (BUG-8: the commit wrote
    // columns relay_request no longer has, so Prisma refused every one).
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          route: "cloud",
          selectedTargetId: "target-owner",
          selectedProviderModelId: "owner-model",
          attemptCount: 1,
        }),
      }),
    );
    expect(db.relayRequest.create.mock.calls[0]?.[0]?.data).toMatchObject({ external: true });
    expect(db.attempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", fencingToken: 1n, kind: "CLOUD" },
      data: {
        nativeSurface: "OPENAI_CHAT_COMPLETIONS",
        adapterMode: "NATIVE",
        adapterVersion: null,
      },
    });
  });

  it("serves the share holder's own key when it dispatches, and never reaches the owner's tier", async () => {
    overflow.dispatchPublicOverflow.mockImplementation(async (request: Dispatch) => ({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: request.ownKeyProviderModelId ? OWN_KEY_TARGET : OWNER_TARGET,
      attemptId: "attempt-1",
      fencingToken: 1n,
      nativeSurface: "openai-chat",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 10 }),
      markFirstClientByte: async () => undefined,
      affinity: undefined,
    }));

    const response = await chat();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-route")).toBe("own-key");
    expect(overflow.dispatchPublicOverflow).toHaveBeenCalledTimes(1);
    expect(overflow.dispatchPublicOverflow.mock.calls[0]?.[0]).toMatchObject({
      userId: "grantee",
      ownKeyProviderModelId: "grantee-model",
    });
  });

  it("streams an owner-paid response through and finalizes it when the stream ends", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [OWNER_PAID_POOL], tests: [] });
    let finish!: (terminal: { ok: boolean; responseBytes: number }) => void;
    const terminal = new Promise<{ ok: boolean; responseBytes: number }>((done) => {
      finish = done;
    });
    const events = [
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    overflow.dispatchPublicOverflow.mockResolvedValue(
      dispatched(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const event of events) controller.enqueue(new TextEncoder().encode(event));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
        terminal,
      ),
    );

    const response = await chat(true);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-wsmp-route")).toBe("pool-fallback");
    expect(overflow.dispatchPublicOverflow.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(await response.text()).toBe(events.join(""));
    // The caller's lease is held until the provider attempt settles.
    expect(leaseReleases[0]).not.toHaveBeenCalled();
    finish({ ok: true, responseBytes: 42 });
    await vi.waitFor(() => expect(leaseReleases[0]).toHaveBeenCalled());
    await vi.waitFor(() => expect(db.$transaction).toHaveBeenCalled());
  });

  it("a hand-off that throws after dispatch ends the request with that attempt's finalizer", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [OWNER_PAID_POOL], tests: [] });
    // A provider error body that fails while it is sanitized for the client.
    overflow.dispatchPublicOverflow.mockResolvedValue(
      dispatched(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("provider body lost"));
            },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const response = await chat();

    expect(response.status).toBe(500);
    expect(overflow.dispatchPublicOverflow).toHaveBeenCalledTimes(1);
    expect(leaseReleases[0]).toHaveBeenCalled();
    // The dispatched attempt's own terminal transition claims the relay row.
    await vi.waitFor(() => expect(db.$transaction).toHaveBeenCalled());
  });

  it("a throw before dispatch commits fails the request and releases the caller's lease", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [OWNER_PAID_POOL], tests: [] });
    overflow.dispatchPublicOverflow.mockRejectedValue(new Error("spend store unavailable"));

    const response = await chat();

    expect(response.status).toBe(500);
    expect(leaseReleases[0]).toHaveBeenCalled();
    // Never left PENDING: the failure's terminal transition is written.
    expect(db.$transaction).toHaveBeenCalled();
  });
});

describe("bounded external nonstream adaptation", () => {
  it.each([false, true])(
    "reads the provider stream directly with oversize=%s",
    async (oversized) => {
      resolve.listCallableTargetsForApiKey.mockResolvedValue({
        pools: [{ ...OWNER_PAID_POOL, protocolAdaptationEnabled: true }],
        tests: [],
      });
      const cancel = vi.fn();
      let pulls = 0;
      const chunk = new Uint8Array(1024 * 1024).fill(120);
      const json = new TextEncoder().encode(
        JSON.stringify({
          id: "chat-1",
          object: "chat.completion",
          model: "openai/gpt-x",
          choices: [
            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      const providerResponse = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (oversized) controller.enqueue(chunk);
            else {
              controller.enqueue(json);
              controller.close();
            }
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      );
      const arrayBuffer = vi.spyOn(providerResponse, "arrayBuffer");
      overflow.dispatchPublicOverflow.mockResolvedValue(dispatched(providerResponse));
      const response = await app().request("/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_key_test",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "owner/chat:external",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 20,
        }),
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      if (oversized) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(cancel).toHaveBeenCalledOnce();
        expect(pulls).toBeLessThanOrEqual(34);
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          type: "message",
          content: [{ type: "text", text: "hello" }],
        });
      }
      expect(overflow.dispatchPublicOverflow).toHaveBeenCalledOnce();
    },
  );
});

describe("provider-only refusals name their cause", () => {
  const MESSAGES_ONLY = providerTarget({
    nativeSurfaces: ["anthropic-messages"],
    nativeProtocols: ["openai"],
    capabilityInventory: providerModelInventory({
      providerType: "openrouter",
      surfaces: ["ANTHROPIC_MESSAGES"],
    }),
  });
  const adaptingPool = { ...OWNER_PAID_POOL, protocolAdaptationEnabled: true };
  const chatBody = (fields: Record<string, unknown>) =>
    app().request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_key_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "owner/chat:external",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 50,
        ...fields,
      }),
    });

  it("a cap without a price is a configuration answer, not a retryable 503 (BUG-2)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [OWNER_PAID_POOL], tests: [] });
    overflow.dispatchPublicOverflow.mockResolvedValue({
      dispatched: false,
      reason: "PRICING_UNAVAILABLE",
    });
    const response = await chat();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "provider_pricing_missing", message: expect.stringMatching(/price/u) },
    });
  });

  it("a request the adapter refuses is a 400 naming the field, never sent (BUG-7 class)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [adaptingPool], tests: [] });
    overflow.listPublicOverflowTargets.mockResolvedValue(listing([MESSAGES_ONLY]));
    const response = await chatBody({ seed: 7 });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/seed/u);
    expect(overflow.dispatchPublicOverflow).not.toHaveBeenCalled();
  });

  it("max_tokens over every external model's limit names the limit (BUG-9)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [OWNER_PAID_POOL], tests: [] });
    const response = await chatBody({ max_tokens: 100_000 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "context_length_exceeded",
        param: "max_tokens",
        message: expect.stringMatching(/100000.*4000 tokens/u),
      },
    });
    expect(overflow.dispatchPublicOverflow).not.toHaveBeenCalled();
    // Responses names its own output field.
    const responses = await app().request("/responses", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_key_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "owner/chat:external",
        input: "hello",
        max_output_tokens: 100_000,
      }),
    });
    expect(responses.status).toBe(400);
    expect(await responses.json()).toMatchObject({
      error: { param: "max_output_tokens", message: expect.stringMatching(/^max_output_tokens/u) },
    });
  });

  it("an adapted tool request without the single-call opt-in says so (BUG-9)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [adaptingPool], tests: [] });
    overflow.listPublicOverflowTargets.mockResolvedValue(listing([MESSAGES_ONLY]));
    const response = await chatBody({
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/parallel_tool_calls/u);
  });

  it("an unknown model is 404 model_not_found, as documented (BUG-9)", async () => {
    const response = await app().request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_key_test", "content-type": "application/json" },
      body: JSON.stringify({ model: "owner/nope", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "model_not_found", param: "model", type: "invalid_request_error" },
    });
  });

  it("a Chat stream asking for usage is adapted to a Messages-only member (BUG-7)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [adaptingPool], tests: [] });
    overflow.listPublicOverflowTargets.mockResolvedValue(listing([MESSAGES_ONLY]));
    overflow.dispatchPublicOverflow.mockResolvedValue({
      dispatched: false,
      reason: "PROVIDER_UNAVAILABLE",
    });
    await chatBody({ stream: true, stream_options: { include_usage: true } });
    expect(overflow.dispatchPublicOverflow).toHaveBeenCalledOnce();
    const sent = overflow.dispatchPublicOverflow.mock.calls[0]?.[0] as Dispatch;
    const rendered = await sent.renderForTarget!(MESSAGES_ONLY, "anthropic-messages");
    expect(rendered.path).toBe("/v1/messages");
    expect(JSON.parse(new TextDecoder().decode(rendered.body))).toMatchObject({
      model: "openai/gpt-x",
      stream: true,
    });
  });
});

describe("/v1/models and external-only pools (BUG-10)", () => {
  const listModels = async () => {
    const response = await app().request("/models", {
      headers: { authorization: "Bearer wsmp_key_test" },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: Array<{ id: string }> }).data.map(
      (model) => model.id,
    );
  };

  it("lists a pool with only cloud members by its :external name (its plain name never serves)", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({
      pools: [OWNER_PAID_POOL],
      tests: [],
      shadowed: new Set(),
    });
    expect(await listModels()).toEqual(["owner/chat:external"]);
  });

  it("lists a pool served only by the caller's own key, whatever its cloud mode", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({
      pools: [{ ...POOL, externalMemberCount: 0, fallbackMode: "OFF" }],
      tests: [],
      shadowed: new Set(),
    });
    expect(await listModels()).toEqual(["owner/chat:external"]);
  });

  it("lists nothing when the cloud mode does not cover the caller, or there is no cloud member", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({
      pools: [{ ...OWNER_PAID_POOL, fallbackMode: "OWNER" }],
      tests: [],
      shadowed: new Set(),
    });
    expect(await listModels()).toEqual([]);
    resolve.listCallableTargetsForApiKey.mockResolvedValue({
      pools: [{ ...OWNER_PAID_POOL, externalMemberCount: 0 }],
      tests: [],
      shadowed: new Set(),
    });
    expect(await listModels()).toEqual([]);
  });
});
