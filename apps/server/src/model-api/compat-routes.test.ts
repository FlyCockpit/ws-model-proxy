/**
 * Route-level request compatibility on a LOCAL pool member: the runtime's policy shapes the
 * body the engine receives, an engine 400 naming a non-semantic field is learned and retried
 * once on the same member, a semantic field gets a clear 400, and native answers are
 * normalized. The relay is a double: each send returns the next scripted answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../packages/db/prisma/generated/client";
import type { PoolRoute } from "./resolve.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target, key) =>
      key === "BETTER_AUTH_SECRET"
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
  poolRoutes: vi.fn(async (): Promise<PoolRoute[]> => []),
  testRoutes: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("./resolve.js", () => resolve);
type Sent = { headers: Headers; body: string };
const relay = vi.hoisted(() => ({
  sent: [] as Sent[],
  answers: [] as Array<{ status: number; body: string; contentType?: string }>,
}));
vi.mock("./local-send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-send.js")>()),
  startAuthorizedLocalRelayAttempt: vi.fn(
    async (_binding: unknown, args: { headers: Headers; body?: Uint8Array }) => {
      relay.sent.push({
        headers: new Headers(args.headers),
        body: new TextDecoder().decode(args.body ?? new Uint8Array()),
      });
      const answer = relay.answers.shift() ?? { status: 500, body: "{}" };
      const bytes = new TextEncoder().encode(answer.body);
      return {
        requestId: "attempt",
        started: Promise.resolve({
          status: answer.status,
          headers: new Headers({ "content-type": answer.contentType ?? "application/json" }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        }),
        terminal: Promise.resolve({
          ok: answer.status < 400,
          failure: null,
          httpStatusCode: answer.status,
          upstreamStatusCode: answer.status,
          usage: null,
          metrics: null,
          responseBytes: bytes.byteLength,
          requestBytes: 10,
        }),
        cancel: vi.fn(),
      };
    },
  ),
}));

const prisma = (await import("@ws-model-proxy/db")).default;
const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const { createModelApiRoutes, chatTestCompletionsHandler } = await import("./routes.js");
const { ModelApiConcurrencyLimiter } = await import("./limits.js");
const { clearRequestProfileCache } = await import("./compat/profile-store.js");

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
  shareId: null,
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
  fallbackMode: "OFF" as const,
  externalMemberCount: 0,
  externalEquivalentModel: null,
  embeddingContract: null,
  paidWarmProtection: false,
  ownKeyProviderModelId: null,
};

function route(requestCompat: PoolRoute["instance"]["requestCompat"] = {}): PoolRoute {
  return {
    member: { id: "member-1", poolId: "pool-1", shareId: null, weight: 1, active: true },
    target: {
      id: "target-1",
      health: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
      lastRoutedAt: null,
    },
    instance: {
      id: "instance-1",
      handle: "i-1",
      runtimeId: "runtime-1",
      versionId: "version-1",
      launchHash: "launch-1",
      nodeId: "node-1",
      nodeOnline: true,
      ready: true,
      engine: "OTHER",
      hardConcurrencyLimit: null,
      physicalMaxContext: null,
      kvBudgetTokens: null,
      engineCountContext: null,
      countStrategy: "CONSERVATIVE_ESTIMATE",
      imageTokenAllowance: null,
      cacheGeneration: "",
      requestCompat,
      runtimeIdentityKey: "launch-1",
      runtimeModel: "engine-model",
      runtimeRevision: "version-1",
      tokenizer: null,
      tokenizerVersion: null,
      template: null,
      templateVersion: null,
      cacheNamespace: "instance-1",
    },
    model: {
      id: "model-1",
      userId: "owner",
      upstreamModelId: "engine-model",
      capabilities: ["TEXT_GENERATION"],
      type: "LLM",
      transcriptionProfile: null,
      embeddingContract: null,
    },
    pool: {
      id: "pool-1",
      userId: "owner",
      maxWaitMs: 1_000,
      contextCeiling: null,
      contextMargin: 0,
      fallbackMode: "OFF",
      paidWarmProtection: false,
      embeddingContract: null,
      protection: {
        enabled: false,
        evictionFeedback: false,
        windowSeconds: 300,
        minTokens: 0,
        share: "EQUAL_SHARE",
        fixedPercent: null,
      },
      affinity: {
        enabled: false,
        ttlSeconds: 3600,
        maxRecords: 100,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
        residencyWeight: 100,
      },
    },
  };
}

function app() {
  return createModelApiRoutes({
    capacityRuntime: undefined,
    concurrencyLimiter: new ModelApiConcurrencyLimiter(),
    manager: {
      getOnlineNodeIds: () => ["node-1"],
      registerRelayResponseHandlers: vi.fn(),
      sendRelayRequest: vi.fn(),
      cancelRelayRequest: vi.fn(),
      completeRelayRequest: vi.fn(),
      supportsCountContext: () => false,
    },
  });
}

function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app().request("/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer wsmp_key_test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model: "owner/chat",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });
}

const OK = JSON.stringify({
  id: "c",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "eos" }],
});

beforeEach(() => {
  mockReset(db);
  vi.clearAllMocks();
  clearRequestProfileCache();
  relay.sent = [];
  relay.answers = [];
  db.relayRequest.create.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.update.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async () => undefined);
  db.user.findUnique.mockResolvedValue({
    banned: false,
    banExpires: null,
    deletionRequestedAt: null,
  } as never);
  db.runtimeRequestProfile.findFirst.mockResolvedValue(null);
  db.runtimeRequestProfile.create.mockResolvedValue({} as never);
  resolve.authenticateApiKey.mockResolvedValue({
    id: "key-1",
    userId: "owner",
    scope: "ALL_POOLS",
    lookupPrefix: "wsmp_key_test",
    expiresAt: null,
    lastUsedAt: null,
  });
  resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [POOL], tests: [] });
  resolve.poolRoutes.mockResolvedValue([route()]);
});

describe("request compatibility on a local pool member", () => {
  it("applies rewrite rules and normalizes the native answer", async () => {
    resolve.poolRoutes.mockResolvedValue([
      route({
        rewriteRules: [
          { op: "rename", path: "max_completion_tokens", to: "max_tokens" },
          { op: "drop", path: "metadata" },
        ],
        headers: { "openai-beta": "strip" },
      }),
    ]);
    relay.answers.push({ status: 200, body: OK });
    const response = await chat(
      { max_completion_tokens: 5, metadata: { a: 1 } },
      { "openai-beta": "x", "x-api-key": "wsmp_key_test", "api-key": "wsmp_key_test" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(relay.sent).toHaveLength(1);
    const sent = JSON.parse(relay.sent[0]!.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "engine-model", max_tokens: 5 });
    expect(sent.metadata).toBeUndefined();
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(relay.sent[0]!.headers.has("openai-beta")).toBe(false);
    expect(relay.sent[0]!.headers.has("x-api-key")).toBe(false);
    expect(relay.sent[0]!.headers.has("api-key")).toBe(false);
    expect(relay.sent[0]!.headers.has("authorization")).toBe(false);
    expect(db.relayRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "relay-1" },
      data: {
        compat: {
          dropped: ["metadata"],
          rewrites: ["rename:max_completion_tokens>max_tokens"],
          headers: ["openai-beta"],
          retried: false,
        },
      },
    });
  });

  it("learns a rejected non-semantic field and retries once on the same member", async () => {
    relay.answers.push(
      {
        status: 400,
        body: JSON.stringify({
          error: {
            message: "Unrecognized request argument supplied: store",
            type: "invalid_request_error",
          },
        }),
      },
      { status: 200, body: OK },
    );
    const response = await chat({ store: false });
    expect(response.status).toBe(200);
    expect(relay.sent).toHaveLength(2);
    expect(JSON.parse(relay.sent[0]!.body)).toHaveProperty("store", false);
    expect(JSON.parse(relay.sent[1]!.body)).not.toHaveProperty("store");
    expect(db.runtimeRequestProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        runtimeId: "runtime-1",
        launchHash: "launch-1",
        learned: {
          v: 1,
          fixes: { "chat.completions": [{ kind: "drop", path: "store" }] },
          stripHeaders: [],
        },
      }),
    });
  });

  it("remembers nothing when the retry fails too", async () => {
    relay.answers.push(
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unrecognized request argument supplied: store" },
        }),
      },
      { status: 500, body: "{}" },
    );
    await chat({ store: false });
    expect(relay.sent).toHaveLength(2);
    expect(db.runtimeRequestProfile.create).not.toHaveBeenCalled();
    expect(db.runtimeRequestProfile.updateMany).not.toHaveBeenCalled();
  });

  it("strips a rejected header value for this request only and never retries other headers", async () => {
    relay.answers.push(
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unexpected value(s) `x-1` for the `openai-beta` header." },
        }),
      },
      { status: 200, body: OK },
    );
    resolve.poolRoutes.mockResolvedValue([route({ headers: { "openai-beta": "forward" } })]);
    // Forwarded by the operator: the engine's answer passes on, nothing is retried.
    const forwarded = await chat({}, { "openai-beta": "x-1" });
    expect(forwarded.status).toBe(400);
    expect(relay.sent).toHaveLength(1);

    // Automatic: sent once more without the header, which is not remembered.
    relay.sent = [];
    relay.answers = [
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unexpected value(s) `x-1` for the `openai-beta` header." },
        }),
      },
      { status: 200, body: OK },
    ];
    resolve.poolRoutes.mockResolvedValue([route()]);
    const stripped = await chat({}, { "openai-beta": "x-1" });
    expect(stripped.status).toBe(200);
    expect(relay.sent.map((sent) => sent.headers.has("openai-beta"))).toEqual([true, false]);
    expect(db.runtimeRequestProfile.create).not.toHaveBeenCalled();

    relay.sent = [];
    relay.answers = [
      {
        status: 400,
        body: JSON.stringify({ error: { message: "header `accept` is not supported" } }),
      },
    ];
    resolve.poolRoutes.mockResolvedValue([route()]);
    const other = await chat({});
    expect(other.status).toBe(400);
    expect(relay.sent).toHaveLength(1);
  });

  it("retries at most once", async () => {
    const reject = (field: string) => ({
      status: 400,
      body: JSON.stringify({
        error: { message: `Unrecognized request argument supplied: ${field}` },
      }),
    });
    relay.answers.push(reject("store"), reject("user"));
    const response = await chat({ store: false, user: "u" });
    expect(relay.sent).toHaveLength(2);
    // The second rejection is the engine's answer (rendered by the protocol error path).
    expect(response.status).toBe(400);
    expect(JSON.parse(relay.sent[1]!.body)).toHaveProperty("user", "u");
  });

  it("refuses a semantic field the engine rejected, naming it, without a retry", async () => {
    relay.answers.push({
      status: 400,
      body: JSON.stringify({ error: { message: "Unsupported param: logprobs" } }),
    });
    const response = await chat({ logprobs: true });
    expect(relay.sent).toHaveLength(1);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; param: string } };
    expect(body.error.param).toBe("logprobs");
    expect(body.error.message).toContain("Unsupported param: logprobs");
  });

  it("passes an unrelated engine 400 through unchanged", async () => {
    const error = JSON.stringify({ error: { message: "bad temperature range" } });
    relay.answers.push({ status: 400, body: error });
    const response = await chat({ temperature: 9 });
    expect(relay.sent).toHaveLength(1);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { param: unknown } }).error.param).toBeNull();
    expect(db.runtimeRequestProfile.create).not.toHaveBeenCalled();
  });

  it("strict refuses an unknown field before sending anything", async () => {
    db.runtimeRequestProfile.findFirst.mockResolvedValue({
      accepted: {
        v: 1,
        endpoints: { "chat.completions": { p: { model: {}, messages: {}, temperature: {} } } },
      },
      learned: {},
      engineFingerprint: "engine 1",
    } as never);
    resolve.poolRoutes.mockResolvedValue([route({ unknownFieldPolicy: "strict" })]);
    const response = await chat({ metadata: { a: 1 } });
    expect(relay.sent).toHaveLength(0);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { param: string } }).error.param).toBe("metadata");
  });
});

describe("model-name aliases", () => {
  it("routes a hard-coded name to the caller's pool and lists it", async () => {
    resolve.listCallableTargetsForApiKey.mockResolvedValue({
      pools: [POOL],
      tests: [],
      aliases: [{ name: "gpt-4o", poolId: "pool-1" }],
    });
    relay.answers.push({ status: 200, body: OK });
    const response = await chat({ model: "gpt-4o" });
    expect(response.status).toBe(200);
    expect(JSON.parse(relay.sent[0]!.body)).toMatchObject({ model: "engine-model" });
    const models = await app().request("/models", {
      headers: { authorization: "Bearer wsmp_key_test" },
    });
    const ids = ((await models.json()) as { data: Array<{ id: string }> }).data.map(
      (entry) => entry.id,
    );
    expect(ids).toEqual(["owner/chat", "gpt-4o"]);
  });
});

describe("caller credential styles", () => {
  it.each([
    [{ "x-api-key": "wsmp_key_alt" }],
    [{ "api-key": "wsmp_key_alt" }],
    [{ authorization: "Bearer wsmp_key_alt", "x-api-key": "wsmp_key_alt" }],
  ])("authenticates %o and never forwards it", async (credential) => {
    relay.answers.push({ status: 200, body: OK });
    const response = await app().request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...credential },
      body: JSON.stringify({ model: "owner/chat", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    expect(resolve.authenticateApiKey).toHaveBeenCalledWith("wsmp_key_alt");
    for (const name of ["authorization", "x-api-key", "api-key"])
      expect(relay.sent[0]!.headers.has(name)).toBe(false);
  });

  it("refuses two different keys", async () => {
    const response = await app().request("/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wsmp_key_a",
        "x-api-key": "wsmp_key_b",
      },
      body: JSON.stringify({ model: "owner/chat", messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(resolve.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("serves Anthropic Messages with x-api-key", async () => {
    relay.answers.push({
      status: 200,
      body: JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "engine-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "stop",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    resolve.poolRoutes.mockResolvedValue([route()]);
    const response = await app().request("/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "wsmp_key_alt",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "owner/chat",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resolve.authenticateApiKey).toHaveBeenCalledWith("wsmp_key_alt");
    expect(response.status).not.toBe(401);
    expect(relay.sent.every((sent) => !sent.headers.has("x-api-key"))).toBe(true);
  });
});

describe("request compatibility on a direct runtime test", () => {
  it("learns and retries once on the tested instance", async () => {
    const { pool: _pool, member: _member, ...testRoute } = route();
    resolve.listCallableTargetsForUser.mockResolvedValue({
      pools: [],
      tests: [
        {
          target: "TEST",
          id: "model-1",
          modelId: "runtime:runtime-1:engine-model",
          runtimeId: "runtime-1",
          upstreamModelId: "engine-model",
          ownerUserId: "owner",
          ownerUserSlug: "owner",
          maxAttachmentBytes: null,
        },
      ],
    });
    resolve.testRoutes.mockResolvedValue([testRoute]);
    relay.answers.push(
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "Unrecognized request argument supplied: store" },
        }),
      },
      { status: 200, body: OK },
    );
    const response = await chatTestCompletionsHandler({
      request: new Request("http://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "runtime:runtime-1:engine-model",
          messages: [{ role: "user", content: "hi" }],
          store: false,
        }),
      }),
      userId: "owner",
      manager: {
        getOnlineNodeIds: () => ["node-1"],
        registerRelayResponseHandlers: vi.fn(),
        sendRelayRequest: vi.fn(),
        cancelRelayRequest: vi.fn(),
        completeRelayRequest: vi.fn(),
        supportsCountContext: () => false,
      },
      limiter: new ModelApiConcurrencyLimiter(),
    });
    expect(response.status).toBe(200);
    expect(relay.sent).toHaveLength(2);
    expect(JSON.parse(relay.sent[1]!.body)).not.toHaveProperty("store");
    expect(await response.json()).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });
});
