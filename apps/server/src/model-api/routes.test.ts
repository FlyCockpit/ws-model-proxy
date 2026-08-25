import type {
  ModelApiTokenIdentity,
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import { hmacDigestForForwarderPurpose } from "@ws-model-proxy/db/forwarder-security";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ActiveRelayResponseHandlers, RelaySessionManager } from "../relay/session-manager.js";
import { holdCapacityLeaseForResponse } from "./capacity/response-lease.js";
import type { CapacityAdmissionRuntime } from "./capacity/runtime.js";
import officialAnthropicFixture from "./fixtures/anthropic-2023-06-01.json";
import responsesConformanceFixture from "./protocols/fixtures/generated-conformance/openai-responses-sse.json";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const affinity = vi.hoisted(() => ({
  rank: vi.fn(),
  remember: vi.fn(),
}));
const publicOverflow = vi.hoisted(() => ({
  dispatch: vi.fn(),
  list: vi.fn(),
  buildAffinityTargets: vi.fn(),
}));
vi.mock("./public-overflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-overflow.js")>();
  return {
    ...actual,
    dispatchPublicOverflow: publicOverflow.dispatch,
    listPublicOverflowTargets: publicOverflow.list,
    buildProviderAffinityTargets: publicOverflow.buildAffinityTargets,
  };
});
vi.mock("./cache-affinity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache-affinity.js")>();
  return {
    ...actual,
    rankAffinityTargets: affinity.rank,
    rememberAffinity: affinity.remember,
  };
});

// routes.ts now derives the responses-stickiness digest through
// @ws-model-proxy/db/forwarder-security, which reads env.BETTER_AUTH_SECRET.
// Mock the env module so the suite never runs real env validation.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!",
    MODEL_API_TRANSCRIPTION_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES: 101 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_SPOOL_BYTES: 1024 * 1024 * 1024,
    MODEL_API_TRANSCRIPTION_MAX_CONCURRENT_UPLOADS: 4,
    MODEL_API_TRANSCRIPTION_MIN_FREE_BYTES: 0,
    MODEL_API_TRANSCRIPTION_UPLOAD_TIMEOUT_MS: 30_000,
    MODEL_API_ANTHROPIC_ENABLED: true,
  },
}));

vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  authenticateModelApiTokenSecret: vi.fn(),
  listVisibleModelTargetsForUser: vi.fn(),
  listVisibleModelTargetsForToken: vi.fn(),
}));

const { captureProviderResponseBinding, createModelApiRoutes } = await import("./routes.js");
const { MODEL_API_MAX_REQUEST_BODY_BYTES, ModelApiConcurrencyLimiter } = await import(
  "./limits.js"
);
const tokenAccess = await import("@ws-model-proxy/api/lib/model-api-token-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const MODEL_API_MAX_ACTIVE_PER_TOKEN = 8;

function stringifyPersistenceCalls(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  executionTarget: { findUnique: MockInstance };
  discoveredModel: {
    findUnique: MockInstance;
    findMany: MockInstance;
  };
  poolMember: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
  modelPool: {
    findFirst: MockInstance;
    findUnique: MockInstance;
    findMany: MockInstance;
  };
  relayRequest: {
    create: MockInstance;
    update: MockInstance;
  };
  responseStickinessRecord: {
    findUnique: MockInstance;
    upsert: MockInstance;
  };
  appSetting: {
    findUnique: MockInstance;
  };
  mediaAsset: {
    findMany: MockInstance;
  };
};

const mockedTokenAccess = tokenAccess as unknown as {
  authenticateModelApiTokenSecret: MockInstance;
  listVisibleModelTargetsForUser: MockInstance;
  listVisibleModelTargetsForToken: MockInstance;
};

class FakeRelayManager {
  activeCliDeviceIds = ["cli-device-id"];
  sent: SendRelayRequestArgs[] = [];
  cancelled: CancelRelayRequestArgs[] = [];
  completed: string[] = [];
  handlers = new Map<string, ActiveRelayResponseHandlers>();

  getActiveCliDeviceIds() {
    return this.activeCliDeviceIds;
  }

  registerRelayResponseHandlers({
    requestId,
    handlers,
  }: {
    cliDeviceId: string;
    requestId: string;
    handlers: ActiveRelayResponseHandlers;
  }) {
    this.handlers.set(requestId, handlers);
  }

  sendRelayRequest(args: SendRelayRequestArgs) {
    this.sent.push(args);
    const byteLength =
      args.bodySource?.size ??
      args.bodyChunks?.reduce((total, chunk) => total + chunk.byteLength, 0) ??
      0;
    if (byteLength > 0) this.handlers.get(args.requestId)?.onRequestBodySent?.(byteLength);
  }

  cancelRelayRequest(args: CancelRelayRequestArgs) {
    this.cancelled.push(args);
    this.handlers.delete(args.requestId);
  }

  completeRelayRequest(requestId: string) {
    this.completed.push(requestId);
  }

  headers(requestId: string, status: number, headers: Record<string, string>) {
    this.handlers.get(requestId)?.onHeaders({
      type: "relay.response.headers",
      requestId,
      status,
      headers,
    });
  }

  body(requestId: string, text: string) {
    this.bodyBytes(requestId, new TextEncoder().encode(text));
  }

  bodyBytes(requestId: string, bytes: Uint8Array) {
    this.handlers.get(requestId)?.onBody(bytes, {
      type: "relay.response.body",
      requestId,
      chunkId: "0",
    });
  }

  complete(requestId: string) {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onComplete({
      type: "relay.complete",
      requestId,
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    });
  }

  error(requestId: string, failure: "request_too_large" | "transport") {
    const handler = this.handlers.get(requestId);
    this.handlers.delete(requestId);
    handler?.onError({
      type: "relay.error",
      requestId,
      failure,
    });
  }
}

const token: ModelApiTokenIdentity = {
  id: "token-id",
  userId: "user-id",
  scopeMode: "ALL_VISIBLE",
  lookupPrefix: "wsmp_model_lookup",
  expiresAt: null,
  lastUsedAt: null,
};

const directTarget: VisibleDirectModelTarget = {
  target: "DIRECT_MODEL",
  id: "model-id",
  modelId: "owner/desktop/local/gpt-4o-mini",
  upstreamModelId: "gpt-4o-mini",
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  endpointId: "endpoint-id",
  endpointSlug: "local",
  cliDeviceSlug: "desktop",
  maxAttachmentBytes: null,
};

const poolTarget: VisibleModelPoolTarget = {
  target: "MODEL_POOL",
  id: "pool-id",
  modelId: "owner/gpt-4.1-mini",
  name: "GPT 4.1 Mini",
  description: null,
  ownerUserId: "user-id",
  ownerUserSlug: "owner",
  accessGrantId: null,
  poolSlug: "gpt-4.1-mini",
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  publicEgressEnabled: false,
  publicEgressAcknowledged: false,
  effectiveProviderEgress: false,
  providerPrimaryMemberCount: 0,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
};

function directRow({
  id = "model-id",
  upstreamModelId = "gpt-4o-mini",
  cliDeviceId = "cli-device-id",
  connected = true,
  completions = true,
  embeddings = true,
  audioTranscriptions = true,
  audioTranslations = true,
  audioSpeech = true,
  responses = true,
  capabilityOverrideMetadata = null,
  endpointCapabilityMetadata,
  optimisticBasicTranscription = false,
  physicalMaxContext,
  directContextCeiling,
  directContextMargin = 0,
  countStrategy,
}: {
  id?: string;
  upstreamModelId?: string;
  cliDeviceId?: string;
  connected?: boolean;
  completions?: boolean;
  embeddings?: boolean;
  audioTranscriptions?: boolean;
  audioTranslations?: boolean;
  audioSpeech?: boolean;
  responses?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  endpointCapabilityMetadata?: Record<string, unknown> | null;
  optimisticBasicTranscription?: boolean;
  physicalMaxContext?: number;
  directContextCeiling?: number;
  directContextMargin?: number;
  countStrategy?: "TOKENIZER" | "TEMPLATE_AWARE" | "ENGINE_REPORTED" | "CONSERVATIVE_ESTIMATE";
} = {}) {
  return {
    id,
    published: true,
    userId: "user-id",
    upstreamModelId,
    capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
    capabilityOverrideMetadata,
    optimisticBasicTranscription,
    ExecutionTarget: {
      id: `${id}-target`,
      inferenceCapacityId: `${id}-capacity`,
      directContextCeiling,
      directContextMargin,
      InferenceCapacity:
        physicalMaxContext === undefined && countStrategy === undefined
          ? null
          : {
              physicalMaxContext: physicalMaxContext ?? null,
              countStrategy: countStrategy ?? "ENGINE_REPORTED",
              runtimeIdentityKey: `${id}-runtime`,
              runtimeModel: upstreamModelId,
              runtimeRevision: null,
              tokenizer: null,
              tokenizerVersion: null,
              template: null,
              templateVersion: null,
              engine: null,
            },
    },
    Endpoint: {
      id: "endpoint-id",
      slug: "endpoint-default",
      published: true,
      cliDeviceId,
      status: "ONLINE",
      capabilityMetadata:
        endpointCapabilityMetadata === undefined
          ? {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, streaming: true, vision: true },
              completions: { supported: completions, streaming: true },
              embeddings: { supported: embeddings },
              audio: {
                transcriptions: audioTranscriptions,
                translations: audioTranslations,
                speech: audioSpeech,
              },
              responses: {
                supported: responses,
                streaming: true,
                statefulFollowUps: true,
                retrieve: true,
                delete: true,
                cancel: true,
                listInputItems: true,
                countTokens: true,
                compact: true,
              },
            }
          : endpointCapabilityMetadata,
      CliDevice: { status: connected ? "CONNECTED" : "DISCONNECTED" },
    },
  };
}

function poolMemberRow({
  id,
  discoveredModelId,
  upstreamModelId,
  cliDeviceId,
  weight = 1,
  healthStatus = "HEALTHY",
  routingStatus = "ACTIVE",
  connected = true,
  capabilityOverrideMetadata = null,
  physicalMaxContext,
  capacityContextCeiling,
  capacityContextMargin = 0,
  capacityWaitBudgetMode,
  capacityWaitBudgetMs,
  affinityEnabled = false,
}: {
  id: string;
  discoveredModelId: string;
  upstreamModelId: string;
  cliDeviceId: string;
  weight?: number;
  healthStatus?: "UNKNOWN" | "HEALTHY" | "HALF_OPEN" | "DEGRADED" | "UNHEALTHY";
  routingStatus?: "ACTIVE" | "DRAINING" | "DISABLED";
  connected?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  physicalMaxContext?: number;
  capacityContextCeiling?: number;
  capacityContextMargin?: number;
  capacityWaitBudgetMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityWaitBudgetMs?: number | null;
  affinityEnabled?: boolean;
}) {
  return {
    id,
    poolId: "pool-id",
    discoveredModelId,
    weight,
    healthStatus,
    routingStatus,
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
    capacityContextCeiling,
    capacityContextMargin,
    capacityWaitBudgetMode,
    capacityWaitBudgetMs,
    ModelPool: {
      capacityWaitBudgetMs: 30_000,
      affinityEnabled,
      affinityTtlSeconds: 3600,
      affinityMaxRecords: 10_000,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
    },
    ExecutionTarget: {
      id: `${id}-target`,
      inferenceCapacityId: `${id}-capacity`,
      InferenceCapacity:
        physicalMaxContext === undefined && !affinityEnabled
          ? null
          : {
              id: `${id}-capacity`,
              hardConcurrencyLimit: 4,
              physicalMaxContext: physicalMaxContext ?? null,
              countStrategy: "CONSERVATIVE_ESTIMATE",
              runtimeIdentityKey: `${id}-runtime-key`,
              runtimeModel: upstreamModelId,
              runtimeRevision: "revision",
              tokenizer: "tokenizer",
              tokenizerVersion: "1",
              template: "chat",
              templateVersion: "1",
              engine: "engine",
              cacheNamespace: "cache",
            },
      DiscoveredModel: null,
    },
    DiscoveredModel: {
      id: discoveredModelId,
      published: true,
      userId: "user-id",
      upstreamModelId,
      capabilityOverrideMode: capabilityOverrideMetadata ? "OVERRIDE" : "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata,
      Endpoint: {
        id: `${id}-endpoint-id`,
        slug: `${id}-endpoint`,
        published: true,
        cliDeviceId,
        status: "ONLINE",
        capabilityMetadata: directRow().Endpoint.capabilityMetadata,
        CliDevice: { status: connected ? "CONNECTED" : "DISCONNECTED" },
      },
    },
  };
}

function appWith(
  manager: FakeRelayManager,
  anthropicEnabled = true,
  protocolAdaptationEnabled = false,
  capacityRuntime?: CapacityAdmissionRuntime,
  concurrencyLimiter = new ModelApiConcurrencyLimiter(),
) {
  return createModelApiRoutes({
    manager,
    concurrencyLimiter,
    anthropicEnabled,
    protocolAdaptationEnabled,
    capacityEnabled: capacityRuntime !== undefined,
    capacityRuntime,
  });
}

function requestBody(model = directTarget.modelId) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "secret prompt" }],
  });
}

function providerPrimaryTarget(poolMemberId = "primary-provider-member") {
  return {
    poolMemberId,
    executionTargetId: `${poolMemberId}-target`,
    inferenceCapacityId: `${poolMemberId}-capacity`,
    capacityWaitBudgetMs: 30_000,
    publicOrder: 0,
    weight: 1,
    providerModelId: `${poolMemberId}-model`,
    upstreamModelId: "provider-upstream",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    protocol: "openai" as const,
    providerAccountId: "provider-account",
    endpointIdentity: "https://provider.example/v1",
    endpointVersion: 1,
    concurrencyLimit: 4,
    providerVersion: null,
    baseUrl: "https://provider.example/v1",
    authType: "BEARER" as const,
    healthStatus: "HEALTHY" as const,
    nativeProtocols: ["openai" as const],
    nativeSurfaces: ["openai-chat" as const],
    supportsStreaming: true,
    supportedFeatures: [],
    capabilityInventory: {
      version: 3 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiChatCompletions: {
          source: "provider" as const,
          confidence: "exact" as const,
          supported: true,
          streaming: true,
        },
      },
    },
    credential: {
      id: "credential",
      credentialType: "BEARER" as const,
      keyVersion: "v1",
      aadVersion: 1,
      algorithm: "aes-256-gcm",
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
    },
  };
}

function requireSent(manager: FakeRelayManager, index = 0): SendRelayRequestArgs {
  const sent = manager.sent[index];
  if (!sent) throw new Error("Expected relay request to be sent.");
  return sent;
}

function sentHeader(sent: SendRelayRequestArgs, name: string): string | undefined {
  if (sent.headers instanceof Headers) {
    return sent.headers.get(name) ?? undefined;
  }
  return sent.headers[name];
}

function firstBodyChunkText(sent: SendRelayRequestArgs): string {
  const chunk = sent.bodyChunks?.[0];
  if (!chunk) throw new Error("Expected relay body chunk.");
  return new TextDecoder().decode(chunk);
}

async function relayBodyText(sent: SendRelayRequestArgs): Promise<string> {
  if (sent.bodyChunks) {
    return new TextDecoder().decode(Buffer.concat(sent.bodyChunks));
  }
  if (!sent.bodySource) throw new Error("Expected relay body source.");
  const chunks: Uint8Array[] = [];
  for await (const chunk of sent.bodySource.open()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function completeJsonRelay({
  manager,
  requestId,
  body = { id: "ok" },
}: {
  manager: FakeRelayManager;
  requestId: string;
  body?: unknown;
}) {
  manager.headers(requestId, 200, { "content-type": "application/json" });
  manager.body(requestId, JSON.stringify(body));
  manager.complete(requestId);
}

describe("model API routes", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    mockedTokenAccess.authenticateModelApiTokenSecret.mockResolvedValue(token);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [directTarget],
      modelPools: [poolTarget],
    });
    db.discoveredModel.findUnique.mockResolvedValue(directRow());
    db.executionTarget.findUnique.mockResolvedValue({ id: "execution-target-id" });
    db.modelPool.findMany.mockResolvedValue([]);
    db.modelPool.findUnique.mockResolvedValue({
      transformerDiscoveredModelId: null,
      transformerSystemPrompt: null,
      transformerImages: true,
      transformerAudio: false,
      transformerVideo: false,
      transformerCacheMode: "OFF",
      transformerIncludePrimaryTools: false,
      transformerMaxTools: 32,
      transformerMaxToolChars: 8000,
      transformerTimeoutMs: null,
      transformerMaxAssets: null,
    });
    db.relayRequest.create.mockResolvedValue({ id: "relay-request-id" });
    db.appSetting.findUnique.mockResolvedValue(null);
    db.relayRequest.update.mockResolvedValue({ id: "relay-request-id" });
    db.responseStickinessRecord.findUnique.mockResolvedValue(null);
    db.responseStickinessRecord.upsert.mockResolvedValue({ id: "stickiness-id" });
    affinity.rank.mockImplementation(async ({ targets }) => ({
      orderedTargetIds: targets.map(
        (target: { executionTargetId: string }) => target.executionTargetId,
      ),
      scores: {},
      prefixDepths: {},
      conversationMatches: {},
      reasons: {},
      matchedPrefixDepth: 0,
    }));
    affinity.remember.mockResolvedValue(undefined);
    publicOverflow.dispatch.mockResolvedValue({
      dispatched: false,
      reason: "DEPLOYMENT_GATE_DISABLED",
    });
    publicOverflow.list.mockResolvedValue({
      enabled: false,
      acknowledged: false,
      affinityPolicy: {
        enabled: false,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [],
    });
    publicOverflow.buildAffinityTargets.mockImplementation(async ({ targets }) =>
      targets.map((target: { poolMemberId: string; executionTargetId: string }) => ({
        poolMemberId: target.poolMemberId,
        executionTargetId: target.executionTargetId,
        targetIdentity: `identity:${target.executionTargetId}`,
        capacityId: `capacity:${target.executionTargetId}`,
        hardConcurrencyLimit: 4,
        activeLoad: 0,
        waitingLoad: 0,
        healthPenalty: 0,
        publicEgressPenalty: 100,
        costPenalty: 0,
      })),
    );
  });

  it("applies affinity only after pool compatibility and persists it after success", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        affinityEnabled: true,
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
        cliDeviceId: "cli-b",
        affinityEnabled: true,
      }),
    ]);
    affinity.rank.mockResolvedValue({
      orderedTargetIds: ["member-b-target", "member-a-target"],
      scores: { "member-b-target": 200 },
      prefixDepths: { "member-b-target": 2 },
      conversationMatches: { "member-b-target": false },
      reasons: { "member-b-target": "prefix:2;active:0;waiting:0" },
      matchedPrefixDepth: 2,
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.endpointSlug).toBe("member-b-endpoint");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl-affinity" }));
    manager.complete(sent.requestId);
    const response = await responsePromise;
    await response.text();
    await vi.waitFor(() => expect(affinity.remember).toHaveBeenCalledTimes(1));
    expect(affinity.rank).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-id",
        resourceOwnerId: "user-id",
        accessGrantId: null,
      }),
    );
    expect(affinity.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-id",
        resourceOwnerId: "user-id",
        accessGrantId: null,
        target: expect.objectContaining({ executionTargetId: "member-b-target" }),
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          affinityOutcome: "PREDICTED_MATCH",
          affinityScore: 200,
          affinityPrefixDepth: 2,
        }),
      }),
    );
    // Provider-backed and local primaries are discovered before scoring, but
    // successful PRIMARY execution never inspects PUBLIC_OVERFLOW members.
    expect(publicOverflow.list).toHaveBeenCalledWith("user-id", poolTarget.id, "PRIMARY");
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it("adapts an opted-in Chat pool request through a Responses-only member", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    expect(JSON.parse(await relayBodyText(sent))).toMatchObject({
      model: "upstream-responses",
      input: [{ role: "user" }],
    });
    manager.headers(sent.requestId, 200, {
      "content-type": "application/json",
      "x-request-id": "req-adapted",
      "content-encoding": "gzip",
      "content-length": "999",
      etag: '"upstream-representation"',
      digest: "sha-256=upstream-representation",
    });
    manager.body(
      sent.requestId,
      JSON.stringify({
        id: "resp",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "upstream-responses",
        output: [
          {
            id: "message",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        error: null,
        incomplete_details: null,
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [],
        temperature: null,
        top_p: null,
        max_output_tokens: null,
      }),
    );
    manager.complete(sent.requestId);
    const response = await responsePromise;
    expect(response.headers.get("x-wsmp-adapter-version")).toBe("1.0.0");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("digest")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "hello" } }],
    });
  });

  it("rejects strict fields that cannot be adapted before relay dispatch", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              tools: true,
              parallelTools: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const response = await appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
        parallel_tool_calls: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(manager.sent).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
  });

  it("keeps pool adaptation unavailable when the release gate is off", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const response = await appWith(manager, true, false).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });
    expect(response.status).toBe(400);
    expect(manager.sent).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
  });

  it("incrementally adapts a Responses SSE member back to requested Chat SSE", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const [firstEvent, ...remainingEvents] = responsesConformanceFixture.events;
    if (!firstEvent) throw new Error("Expected a conformance event.");
    manager.body(
      sent.requestId,
      `${firstEvent.event ? `event: ${firstEvent.event}\n` : ""}data: ${typeof firstEvent.data === "string" ? firstEvent.data : JSON.stringify(firstEvent.data)}\n\n`,
    );
    const response = await responsePromise;
    for (const record of remainingEvents) {
      manager.body(
        sent.requestId,
        `${record.event ? `event: ${record.event}\n` : ""}data: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}\n\n`,
      );
    }
    manager.complete(sent.requestId);
    const text = await response.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain("data: [DONE]");
  });

  it("uses an alternate adapted surface when the requested native surface lacks streaming", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "multi-surface-member",
        discoveredModelId: "multi-surface-model",
        upstreamModelId: "upstream-multi",
        cliDeviceId: "cli-multi",
        capabilityOverrideMetadata: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "provider",
              confidence: "exact",
              operations: ["create"],
              streaming: false,
            },
            openaiResponses: {
              source: "provider",
              confidence: "exact",
              operations: ["create"],
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-multi"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    for (const record of responsesConformanceFixture.events) {
      manager.body(
        sent.requestId,
        `${record.event ? `event: ${record.event}\n` : ""}data: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}\n\n`,
      );
    }
    manager.complete(sent.requestId);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data: [DONE]");
  });

  it("renders one requested-protocol error when adapted SSE fails after commitment", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const release = vi.fn().mockResolvedValue(true);
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "lease-responses-member",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release,
      hold: (response, lease, signal) =>
        holdCapacityLeaseForResponse({
          response,
          lease,
          signal,
          heartbeatIntervalMs: 0,
          store: { heartbeat: vi.fn().mockResolvedValue(true), release },
        }),
    };
    const responsePromise = appWith(manager, true, true, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: JSON.stringify({
          model: poolTarget.modelId,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const first = responsesConformanceFixture.events[0];
    if (!first) throw new Error("Expected a conformance event.");
    manager.body(
      sent.requestId,
      `${first.event ? `event: ${first.event}\n` : ""}data: ${JSON.stringify(first.data)}\n\n`,
    );
    const response = await responsePromise;
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    manager.body(sent.requestId, 'event: response.unknown\ndata: {"type":"response.unknown"}\n\n');
    manager.complete(sent.requestId);
    const text = await response.text();
    expect(text.match(/"code":"protocol_error"/g)).toHaveLength(1);
    expect(text).not.toContain("data: [DONE]");
    expect(manager.sent).toHaveLength(1);
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED", errorClass: "protocol_error" }),
        }),
      ),
    );
    expect(
      db.poolMember.update.mock.calls.filter(([call]) => call?.where?.id === "responses-member"),
    ).toHaveLength(1);
  });

  it("keeps Responses sequence numbers contiguous when a committed adapted stream fails", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "chat-member",
        discoveredModelId: "chat-model",
        upstreamModelId: "upstream-chat",
        cliDeviceId: "cli-chat",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-chat"];
    const responsePromise = appWith(manager, true, true).request("/responses", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({ model: poolTarget.modelId, stream: true, input: "hello" }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    manager.body(
      sent.requestId,
      'data: {"id":"chatcmpl","object":"chat.completion.chunk","created":0,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
    );
    const response = await responsePromise;
    manager.body(sent.requestId, "data: {not-json}\n\n");
    manager.complete(sent.requestId);
    const text = await response.text();
    const sequences = [...text.matchAll(/"sequence_number":(\d+)/g)].map((match) =>
      Number(match[1]),
    );
    expect(sequences).toEqual(sequences.map((_, index) => index));
    expect(text.match(/event: error/g)).toHaveLength(1);
    expect(text).toContain(`"sequence_number":${sequences.length - 1}`);
  });

  it("prefers native members, then falls back to an adaptable member before commitment", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        weight: 100,
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
            },
          },
        },
      }),
      poolMemberRow({
        id: "chat-member",
        discoveredModelId: "chat-model",
        upstreamModelId: "upstream-chat",
        cliDeviceId: "cli-chat",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              supported: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses", "cli-chat"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    manager.headers(sent.requestId, 500, { "content-type": "application/json" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    const adapted = requireSent(manager, 1);
    expect(adapted.family).toBe("responses");
    expect(adapted.path).toBe("/v1/responses");
    manager.headers(adapted.requestId, 200, { "content-type": "application/json" });
    manager.body(
      adapted.requestId,
      JSON.stringify({
        id: "resp-fallback",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "upstream-responses",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        error: null,
        incomplete_details: null,
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [],
        temperature: null,
        top_p: null,
        max_output_tokens: null,
      }),
    );
    manager.complete(adapted.requestId);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ object: "chat.completion" });
  });

  it("falls back when an adapted non-streaming member returns malformed JSON before commitment", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue(
      ["first", "second"].map((suffix) =>
        poolMemberRow({
          id: `${suffix}-responses-member`,
          discoveredModelId: `${suffix}-responses-model`,
          upstreamModelId: `${suffix}-upstream-responses`,
          cliDeviceId: `cli-${suffix}`,
          capabilityOverrideMetadata: {
            version: 3,
            protocol: "openai-compatible",
            surfaces: {
              openaiResponses: {
                source: "declared",
                confidence: "exact",
                supported: true,
              },
            },
          },
        }),
      ),
    );
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-first", "cli-second"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const malformed = requireSent(manager);
    manager.headers(malformed.requestId, 200, { "content-type": "application/json" });
    manager.body(malformed.requestId, '{"object":"response"');
    manager.complete(malformed.requestId);

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    expect(manager.cancelled).toContainEqual({
      cliDeviceId: "cli-first",
      requestId: malformed.requestId,
      reason: "protocol_error",
    });
    const fallback = requireSent(manager, 1);
    await completeJsonRelay({
      manager,
      requestId: fallback.requestId,
      body: {
        id: "resp-fallback",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "second-upstream-responses",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        error: null,
        incomplete_details: null,
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [],
        temperature: null,
        top_p: null,
        max_output_tokens: null,
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ object: "chat.completion" });
    expect(manager.sent).toHaveLength(2);
  });

  it("falls back when an adapted member returns the wrong successful content type", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue(
      ["first", "second"].map((suffix) =>
        poolMemberRow({
          id: `${suffix}-responses-member`,
          discoveredModelId: `${suffix}-responses-model`,
          upstreamModelId: `${suffix}-upstream-responses`,
          cliDeviceId: `cli-${suffix}`,
          capabilityOverrideMetadata: {
            version: 3,
            protocol: "openai-compatible",
            surfaces: {
              openaiResponses: {
                source: "declared",
                confidence: "exact",
                supported: true,
                streaming: true,
              },
            },
          },
        }),
      ),
    );
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-first", "cli-second"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const mismatch = requireSent(manager);
    manager.headers(mismatch.requestId, 200, { "content-type": "application/json" });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    expect(manager.cancelled).toContainEqual({
      cliDeviceId: "cli-first",
      requestId: mismatch.requestId,
      reason: "protocol_error",
    });
    const fallback = requireSent(manager, 1);
    manager.headers(fallback.requestId, 200, { "content-type": "text/event-stream" });
    for (const record of responsesConformanceFixture.events) {
      manager.body(
        fallback.requestId,
        `${record.event ? `event: ${record.event}\n` : ""}data: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}\n\n`,
      );
    }
    manager.complete(fallback.requestId);
    const response = await responsePromise;
    await expect(response.text()).resolves.toContain("data: [DONE]");
    expect(manager.sent).toHaveLength(2);
  });

  it("falls back when an adapted SSE member fails before its first rendered event", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue(
      ["first", "second"].map((suffix) =>
        poolMemberRow({
          id: `${suffix}-responses-member`,
          discoveredModelId: `${suffix}-responses-model`,
          upstreamModelId: `${suffix}-upstream-responses`,
          cliDeviceId: `cli-${suffix}`,
          capabilityOverrideMetadata: {
            version: 3,
            protocol: "openai-compatible",
            surfaces: {
              openaiResponses: {
                source: "declared",
                confidence: "exact",
                supported: true,
                streaming: true,
              },
            },
          },
        }),
      ),
    );
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-first", "cli-second"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const malformed = requireSent(manager);
    manager.headers(malformed.requestId, 200, { "content-type": "text/event-stream" });
    manager.body(malformed.requestId, "event: response.created\ndata: {not-json}\n\n");
    manager.complete(malformed.requestId);

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    const fallback = requireSent(manager, 1);
    manager.headers(fallback.requestId, 200, { "content-type": "text/event-stream" });
    for (const record of responsesConformanceFixture.events) {
      manager.body(
        fallback.requestId,
        `${record.event ? `event: ${record.event}\n` : ""}data: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}\n\n`,
      );
    }
    manager.complete(fallback.requestId);

    const response = await responsePromise;
    const text = await response.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain("data: [DONE]");
    expect(manager.sent).toHaveLength(2);
  });

  it("does not append a second terminal error to a completed adapted Chat stream", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    for (const record of responsesConformanceFixture.events) {
      manager.body(
        sent.requestId,
        `${record.event ? `event: ${record.event}\n` : ""}data: ${typeof record.data === "string" ? record.data : JSON.stringify(record.data)}\n\n`,
      );
    }
    const response = await responsePromise;
    manager.body(sent.requestId, "event: response.unknown\ndata: {not-json}\n\n");
    manager.complete(sent.requestId);
    const text = await response.text();
    expect(text.split("data: [DONE]")).toHaveLength(2);
    expect(text).not.toContain('"code":"protocol_error"');
    expect(text).not.toContain("event: error");
  });

  it("keeps the live Chat stop barrier when Anthropic fails before message_stop", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "anthropic-member",
        discoveredModelId: "anthropic-model",
        upstreamModelId: "claude-upstream",
        cliDeviceId: "cli-anthropic",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-anthropic"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    manager.body(
      sent.requestId,
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","content":[],"model":"claude-upstream","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    );
    const response = await responsePromise;
    manager.body(
      sent.requestId,
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":0}}\n\n',
    );
    manager.body(sent.requestId, "event: unknown\ndata: {}\n\n");
    manager.complete(sent.requestId);
    const text = await response.text();
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.split('"finish_reason":"stop"')).toHaveLength(2);
    expect(text).not.toContain('"code":"protocol_error"');
    expect(text).not.toContain("data: [DONE]");
  });

  it("propagates adapted downstream cancellation and performs relay cleanup exactly once", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "responses-member",
        discoveredModelId: "responses-model",
        upstreamModelId: "upstream-responses",
        cliDeviceId: "cli-responses",
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const first = responsesConformanceFixture.events[0];
    if (!first) throw new Error("Expected a conformance event.");
    manager.body(
      sent.requestId,
      `${first.event ? `event: ${first.event}\n` : ""}data: ${JSON.stringify(first.data)}\n\n`,
    );

    const response = await responsePromise;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected a response body.");
    await reader.read();
    await reader.cancel("caller stopped reading");

    await vi.waitFor(() => expect(manager.cancelled).toHaveLength(1));
    expect(manager.cancelled).toEqual([
      { cliDeviceId: "cli-responses", requestId: sent.requestId, reason: "cancelled" },
    ]);
    expect(manager.completed.filter((requestId) => requestId === sent.requestId)).toHaveLength(1);
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CANCELED", attemptCount: 1 }),
        }),
      ),
    );
    expect(
      db.relayRequest.update.mock.calls.filter(
        ([call]) => call?.data?.attemptCount === 1 && call?.data?.status === "CANCELED",
      ),
    ).toHaveLength(1);
    expect(db.poolMember.update).not.toHaveBeenCalled();
  });

  it("filters adapted pool candidates against both tool and image requirements", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
    });
    const adaptedMember = (id: string, tools: boolean, inputImages: boolean) =>
      poolMemberRow({
        id,
        discoveredModelId: `${id}-model`,
        upstreamModelId: `${id}-upstream`,
        cliDeviceId: `cli-${id}`,
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: {
              source: "declared",
              confidence: "exact",
              supported: true,
              tools,
              inputImages,
            },
          },
        },
      });
    db.poolMember.findMany.mockResolvedValue([
      adaptedMember("no-tools", false, true),
      adaptedMember("no-images", true, false),
      adaptedMember("fully-capable", true, true),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-no-tools", "cli-no-images", "cli-fully-capable"];
    const responsePromise = appWith(manager, true, true).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
            ],
          },
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
        parallel_tool_calls: false,
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.cliDeviceId).toBe("cli-fully-capable");
    expect(JSON.parse(await relayBodyText(sent))).toMatchObject({
      model: "fully-capable-upstream",
      tools: [{ type: "function", name: "lookup" }],
    });
    await completeJsonRelay({
      manager,
      requestId: sent.requestId,
      body: {
        id: "resp-tools-images",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "fully-capable-upstream",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        error: null,
        incomplete_details: null,
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [],
        temperature: null,
        top_p: null,
        max_output_tokens: null,
      },
    });
    expect((await responsePromise).status).toBe(200);
    expect(manager.sent).toHaveLength(1);
  });

  it("filters native pool candidates using features profiled from the raw request", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    const nativeMember = (id: string, capable: boolean) =>
      poolMemberRow({
        id,
        discoveredModelId: `${id}-model`,
        upstreamModelId: `${id}-upstream`,
        cliDeviceId: `cli-${id}`,
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "declared",
              confidence: "exact",
              supported: true,
              ...(capable
                ? {
                    tools: true,
                    parallelTools: true,
                    structuredOutput: true,
                    reasoning: true,
                    hostedTools: true,
                    inputImages: true,
                    inputAudio: true,
                    inputVideo: true,
                    outputImages: true,
                    outputAudio: true,
                    outputVideo: true,
                  }
                : {}),
            },
          },
        },
      });
    db.poolMember.findMany.mockResolvedValue([
      nativeMember("basic", false),
      nativeMember("featureful", true),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-basic", "cli-featureful"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
              { type: "input_audio", input_audio: { data: "QUJDRA==", format: "wav" } },
              { type: "video_url", video_url: { url: "https://example.test/video.mp4" } },
            ],
          },
        ],
        tools: [{ type: "web_search_preview" }],
        parallel_tool_calls: true,
        response_format: { type: "json_schema", json_schema: { name: "answer", schema: {} } },
        reasoning_effort: "high",
        modalities: ["text", "audio", "image", "video"],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.cliDeviceId).toBe("cli-featureful");
    expect(JSON.parse(await relayBodyText(sent))).toMatchObject({ model: "featureful-upstream" });
    await completeJsonRelay({ manager, requestId: sent.requestId });
    expect((await responsePromise).status).toBe(200);
  });

  it("lists only model targets visible to the bearer token", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: directTarget.id,
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: {
            supported: true,
            streaming: true,
            vision: true,
            video: true,
            audio: true,
          },
        },
        Endpoint: { capabilityMetadata: null },
      },
    ]);
    db.poolMember.findMany.mockResolvedValue([]);

    const manager = new FakeRelayManager();
    const response = await appWith(manager).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: directTarget.modelId,
          object: "model",
          created: 0,
          owned_by: "owner",
          supports_vision: true,
          supports_video_input: true,
          supports_audio_input: true,
          supports_audio_output: false,
          supports_audio_transcription: false,
          supports_audio_translation: false,
          capabilities: {
            vision: true,
            video_input: true,
            audio_input: true,
            audio_output: false,
            audio_transcription: false,
            audio_translation: false,
          },
          architecture: {
            input_modalities: ["text", "image", "audio", "video"],
            output_modalities: ["text"],
            modality: "text+image+audio+video->text",
          },
        },
        {
          id: poolTarget.modelId,
          object: "model",
          created: 0,
          owned_by: "owner",
          // Empty pool → text-only advertisement defaults.
          supports_vision: false,
          supports_video_input: false,
          supports_audio_input: false,
          supports_audio_output: false,
          supports_audio_transcription: false,
          supports_audio_translation: false,
          capabilities: {
            vision: false,
            video_input: false,
            audio_input: false,
            audio_output: false,
            audio_transcription: false,
            audio_translation: false,
          },
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
            modality: "text->text",
          },
        },
      ],
    });
    expect(mockedTokenAccess.authenticateModelApiTokenSecret).toHaveBeenCalledWith(
      "wsmp_model_test",
    );
  });

  it("falls back to endpoint capabilities when OVERRIDE metadata is unparseable", async () => {
    // Mirrors effectiveDirectCapabilities: OVERRIDE + bad override JSON still
    // advertises endpoint vision so /v1/models matches request-time routing.
    db.discoveredModel.findMany.mockResolvedValue([
      {
        id: directTarget.id,
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrideMetadata: { not: "a valid capabilities object" },
        Endpoint: {
          capabilityMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
        },
      },
    ]);
    db.poolMember.findMany.mockResolvedValue([]);

    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; supports_vision: boolean }>;
    };
    const direct = body.data.find((entry) => entry.id === directTarget.modelId);
    expect(direct?.supports_vision).toBe(true);
  });

  it("unions enabled provider PRIMARY modalities into provider-only and mixed pool listings", async () => {
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: poolTarget.id,
        ExecutionTarget: {
          DiscoveredModel: null,
          ProviderModel: {
            enabled: true,
            deletedAt: null,
            nativeCapabilities: {
              version: 3,
              protocol: "openai-compatible",
              surfaces: {
                openaiChatCompletions: {
                  source: "declared",
                  confidence: "exact",
                  supported: true,
                  inputImages: true,
                  inputAudio: true,
                },
              },
            },
            ProviderAccount: { enabled: true, deletedAt: null },
          },
        },
        DiscoveredModel: null,
      },
      {
        poolId: poolTarget.id,
        ExecutionTarget: {
          DiscoveredModel: {
            capabilityOverrideMode: "OVERRIDE",
            capabilityOverrideMetadata: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, streaming: true, video: true },
            },
            Endpoint: { capabilityMetadata: null },
          },
          ProviderModel: null,
        },
        DiscoveredModel: null,
      },
    ]);

    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        supports_vision: boolean;
        supports_audio_input: boolean;
        supports_video_input: boolean;
      }>;
    };
    expect(body.data.find((entry) => entry.id === poolTarget.modelId)).toMatchObject({
      supports_vision: true,
      supports_audio_input: true,
      supports_video_input: true,
    });
    expect(db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tier: "PRIMARY" }),
      }),
    );
    expect(stringifyPersistenceCalls(db.poolMember.findMany.mock.calls)).not.toContain(
      "PUBLIC_OVERFLOW",
    );
  });

  it("rejects missing or invalid bearer tokens with 401", async () => {
    mockedTokenAccess.authenticateModelApiTokenSecret.mockResolvedValue(null);

    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "authentication_error", code: "access_denied" },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("relays direct chat completion requests over the registered CLI websocket", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sentHeader(sent, "authorization")).toBeUndefined();
    expect(firstBodyChunkText(sent)).toContain('"model":"gpt-4o-mini"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "chatcmpl", choices: [] });
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "SUCCEEDED",
            promptTokens: 3,
            completionTokens: 5,
            totalTokens: 8,
            errorClass: null,
          }),
        }),
      ),
    );
  });

  it("strips every inbound provider credential alias before endpoint authentication", async () => {
    const manager = new FakeRelayManager();
    const pending = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
        "x-api-key": "client-x-api-key",
        "api-key": "client-api-key",
        "openai-api-key": "client-openai-key",
        "anthropic-api-key": "client-anthropic-key",
      },
      body: requestBody(),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    for (const name of ["x-api-key", "api-key", "openai-api-key", "anthropic-api-key"]) {
      expect(sentHeader(sent, name)).toBeUndefined();
    }
    await completeJsonRelay({ manager, requestId: sent.requestId, body: { choices: [] } });
    expect((await pending).status).toBe(200);
  });

  it("routes v3 OpenAI Chat, Responses, and native-only Completions surfaces", async () => {
    const v3OnlyRow = directRow({
      endpointCapabilityMetadata: null,
      capabilityOverrideMetadata: {
        version: 3,
        protocol: "openai-compatible",
        surfaces: {
          openaiChatCompletions: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
          },
          openaiResponses: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
          },
          openaiCompletions: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
          },
        },
      },
    });
    db.discoveredModel.findUnique.mockResolvedValue(v3OnlyRow);
    for (const [route, expectedPath, body] of [
      [
        "/chat/completions",
        "/v1/chat/completions",
        { messages: [{ role: "user", content: "hi" }] },
      ],
      ["/responses", "/v1/responses", { input: "hi" }],
      ["/completions", "/v1/completions", { prompt: "hi" }],
    ] as const) {
      const manager = new FakeRelayManager();
      const pending = appWith(manager).request(route, {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: JSON.stringify({ model: directTarget.modelId, ...body }),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      expect(sent.path).toBe(expectedPath);
      await completeJsonRelay({ manager, requestId: sent.requestId, body: { id: "native" } });
      expect((await pending).status).toBe(200);
    }
  });

  it("relays native Anthropic Messages with strict WSMP/upstream header isolation", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
              betaFeatures: ["prompt-caching-2024-07-31"],
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": " prompt-caching-2024-07-31 ",
        cookie: "must-not-forward=1",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "secret prompt" }],
        unknown_native_field: { preserve: true },
        tools: [
          {
            name: "lookup",
            description: "native",
            input_schema: { type: "object", additionalProperties: true },
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("messages");
    expect(sent.path).toBe("/v1/messages");
    expect(sentHeader(sent, "authorization")).toBeUndefined();
    expect(sentHeader(sent, "x-api-key")).toBeUndefined();
    expect(sentHeader(sent, "cookie")).toBeUndefined();
    expect(sentHeader(sent, "anthropic-version")).toBe("2023-06-01");
    expect(sentHeader(sent, "anthropic-beta")).toBe("prompt-caching-2024-07-31");
    expect(JSON.parse(firstBodyChunkText(sent))).toMatchObject({
      model: "gpt-4o-mini",
      unknown_native_field: { preserve: true },
      tools: [{ name: "lookup", input_schema: { additionalProperties: true } }],
    });

    manager.headers(sent.requestId, 200, {
      "content-type": "application/json",
      "request-id": "req_anthropic",
    });
    const response = await responsePromise;
    const nativeBody = { id: "msg_123", type: "message", content: [] };
    manager.body(sent.requestId, JSON.stringify(nativeBody));
    manager.complete(sent.requestId);
    expect(response.headers.get("request-id")).toBe("req_anthropic");
    await expect(response.json()).resolves.toEqual(nativeBody);
  });

  it("passes native Anthropic SSE through byte-for-byte with safe response headers only", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              protocolVersion: officialAnthropicFixture.protocolVersion,
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": officialAnthropicFixture.protocolVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...officialAnthropicFixture.request,
        model: directTarget.modelId,
        stream: true,
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, {
      "content-type": "text/event-stream",
      "request-id": "req_stream_fixture",
      "cache-control": "no-cache",
      "set-cookie": "private=secret",
      "x-upstream-private": "must-not-leak",
    });
    const response = await responsePromise;
    manager.body(sent.requestId, officialAnthropicFixture.stream);
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("request-id")).toBe("req_stream_fixture");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-private")).toBeNull();
    await expect(response.text()).resolves.toBe(officialAnthropicFixture.stream);
  });

  it("gates Anthropic routes off explicitly", async () => {
    const response = await appWith(new FakeRelayManager(), false).request("/messages", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "anthropic-version": "2023-06-01" },
    });
    expect(response.status).toBe(404);
  });

  it("returns the official Anthropic request-too-large envelope for oversized bodies", async () => {
    const response = await appWith(new FakeRelayManager()).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": officialAnthropicFixture.protocolVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        padding: "x".repeat(MODEL_API_MAX_REQUEST_BODY_BYTES),
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "request_too_large", message: "Request body is too large." },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("maps relay request-too-large failures to the Anthropic error type", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              protocolVersion: officialAnthropicFixture.protocolVersion,
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": officialAnthropicFixture.protocolVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...officialAnthropicFixture.request, model: directTarget.modelId }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    manager.error(requireSent(manager).requestId, "request_too_large");

    const response = await responsePromise;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "request_too_large", message: "Request body is too large." },
    });
  });

  it("relays Anthropic count_tokens with the published-spec-derived fixture shape", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const countManager = new FakeRelayManager();
    const countPromise = appWith(countManager).request("/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: officialAnthropicFixture.countTokensRequest.messages,
      }),
    });
    await vi.waitFor(() => expect(countManager.sent).toHaveLength(1));
    const countSent = requireSent(countManager);
    expect(countSent.path).toBe("/v1/messages/count_tokens");
    await completeJsonRelay({
      manager: countManager,
      requestId: countSent.requestId,
      body: officialAnthropicFixture.countTokensResponse,
    });
    await expect((await countPromise).json()).resolves.toEqual(
      officialAnthropicFixture.countTokensResponse,
    );

    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              countTokens: false,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const rejectedCount = await appWith(new FakeRelayManager()).request("/messages/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, messages: [] }),
    });
    expect(rejectedCount.status).toBe(400);
    await expect(rejectedCount.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it("uses Anthropic-shaped errors for authentication, version, and beta rejection", async () => {
    const app = appWith(new FakeRelayManager());
    const unauthenticated = await app.request("/messages", { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });

    const unsupportedVersion = await app.request("/messages", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "anthropic-version": "2099-01-01" },
    });
    expect(unsupportedVersion.status).toBe(400);
    await expect(unsupportedVersion.json()).resolves.toMatchObject({ type: "error" });

    const upstreamCredentialAttempt = await app.request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "x-api-key": "must-not-be-accepted",
      },
    });
    expect(upstreamCredentialAttempt.status).toBe(400);
    await expect(upstreamCredentialAttempt.json()).resolves.toMatchObject({ type: "error" });
  });

  it("does not fail over direct model requests after an upstream failure", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 500, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ error: { message: "upstream failed" } }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(500);
    await response.text();
    expect(manager.sent).toHaveLength(1);
    expect(manager.cancelled).toEqual([]);
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            selectedDiscoveredModelId: "model-id",
            status: "FAILED",
            errorClass: "upstream_5xx",
          }),
        }),
      ),
    );
  });

  it("preserves streaming SSE chunks without buffering the full answer first", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        messages: [{ role: "user", content: "secret prompt" }],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'data: {"choices":[]}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  });

  it("returns not found for model IDs outside token visibility", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [],
    });

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody("owner/private/model"),
    });

    expect(response.status).toBe(404);
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("fails oversized request bodies before metadata is created or body text is persisted", async () => {
    const oversizedBody = JSON.stringify({
      model: directTarget.modelId,
      input: "secret oversized body",
      padding: "x".repeat(MODEL_API_MAX_REQUEST_BODY_BYTES),
    });

    const response = await appWith(new FakeRelayManager()).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: oversizedBody,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(db.relayRequest.create).not.toHaveBeenCalled();
    expect(JSON.stringify(db.relayRequest.update.mock.calls)).not.toContain(
      "secret oversized body",
    );
  });

  it("records concurrency limit failures with duration metadata and no request body text", async () => {
    const limiter = new ModelApiConcurrencyLimiter();
    const leases = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
      limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
    );

    try {
      const response = await createModelApiRoutes({
        manager: new FakeRelayManager(),
        concurrencyLimiter: limiter,
      }).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(),
      });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "rate_limited" },
      });
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
            errorClass: "rate_limited",
            durationMs: expect.any(Number),
          }),
        }),
      );
      const metadataCalls = stringifyPersistenceCalls([
        db.relayRequest.create.mock.calls,
        db.relayRequest.update.mock.calls,
      ]);
      expect(metadataCalls).not.toContain("secret prompt");
    } finally {
      for (const lease of leases) lease.release();
    }
  });

  it("returns Anthropic's rate-limit envelope and status for local admission failures", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 3,
          protocol: "anthropic-compatible",
          surfaces: {
            anthropicMessages: {
              source: "declared",
              confidence: "exact",
              supported: true,
              streaming: true,
              countTokens: true,
              protocolVersion: "2023-06-01",
            },
          },
        },
      }),
    );
    const limiter = new ModelApiConcurrencyLimiter();
    const leases = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
      limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
    );

    try {
      const response = await createModelApiRoutes({
        manager: new FakeRelayManager(),
        concurrencyLimiter: limiter,
      }).request("/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: directTarget.modelId, max_tokens: 8, messages: [] }),
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "The request could not be completed.",
        },
      });
    } finally {
      for (const lease of leases) lease.release();
    }
  });

  it("returns retryable 503 when the selected CLI is disconnected", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ connected: false }));

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "disconnected" },
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "disconnected",
        }),
      }),
    );
  });

  it("returns a clear OpenAI error when completions are unsupported", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ completions: false }));

    const response = await appWith(new FakeRelayManager()).request("/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, prompt: "secret prompt" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "unsupported_capability",
        }),
      }),
    );
  });

  it("does not persist prompt text or image payload bytes in relay metadata", async () => {
    const manager = new FakeRelayManager();
    const imageDataUrl = "data:image/png;base64,SECRET_IMAGE_BYTES";
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "secret prompt" },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);
    await response.text();

    expect(firstBodyChunkText(sent)).toContain(imageDataUrl);
    await vi.waitFor(() => expect(db.relayRequest.update).toHaveBeenCalled());
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret prompt");
    expect(metadataCalls).not.toContain("SECRET_IMAGE_BYTES");
  });

  it("rejects an inline attachment above the selected model's limit before relaying", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [{ ...directTarget, maxAttachmentBytes: 3 }],
      modelPools: [],
    });
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } }],
          },
        ],
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("relays embeddings requests with the selected upstream model", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        input: "secret embedding input",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("embeddings");
    expect(sent.path).toBe("/v1/embeddings");
    expect(firstBodyChunkText(sent)).toContain('"model":"gpt-4o-mini"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ object: "list", data: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ object: "list", data: [] });
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret embedding input");
  });

  it("uses per-model capability overrides instead of endpoint defaults across endpoint families", async () => {
    const overrideCapabilities = {
      version: 1,
      protocol: "openai-compatible",
      chatCompletions: { supported: true, streaming: true },
      completions: { supported: false, streaming: false },
      embeddings: { supported: true },
      audio: {
        transcriptions: false,
        translations: true,
        speech: true,
      },
      responses: {
        supported: true,
        streaming: true,
        statefulFollowUps: true,
        retrieve: true,
        delete: true,
        cancel: true,
        listInputItems: true,
        countTokens: true,
        compact: true,
      },
    };
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        completions: true,
        embeddings: false,
        audioTranslations: false,
        audioSpeech: false,
        responses: false,
        capabilityOverrideMetadata: overrideCapabilities,
      }),
    );

    const rejectedCompletion = await appWith(new FakeRelayManager()).request("/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, prompt: "secret prompt" }),
    });
    expect(rejectedCompletion.status).toBe(400);
    await expect(rejectedCompletion.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });

    const embeddingsManager = new FakeRelayManager();
    const embeddingsResponsePromise = appWith(embeddingsManager).request("/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, input: "secret embedding input" }),
    });
    await vi.waitFor(() => expect(embeddingsManager.sent).toHaveLength(1));
    await completeJsonRelay({
      manager: embeddingsManager,
      requestId: requireSent(embeddingsManager).requestId,
      body: { object: "list", data: [] },
    });
    await expect((await embeddingsResponsePromise).json()).resolves.toEqual({
      object: "list",
      data: [],
    });

    const translationBody = new FormData();
    translationBody.set("model", directTarget.modelId);
    translationBody.set("file", new Blob(["SECRET_AUDIO_BYTES"], { type: "audio/wav" }));
    const translationManager = new FakeRelayManager();
    const translationResponsePromise = appWith(translationManager).request("/audio/translations", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: translationBody,
    });
    await vi.waitFor(() => expect(translationManager.sent).toHaveLength(1), { timeout: 5000 });
    expect(requireSent(translationManager).path).toBe("/v1/audio/translations");
    await completeJsonRelay({
      manager: translationManager,
      requestId: requireSent(translationManager).requestId,
      body: { text: "translation" },
    });
    await expect((await translationResponsePromise).json()).resolves.toEqual({
      text: "translation",
    });

    const speechManager = new FakeRelayManager();
    const speechResponsePromise = appWith(speechManager).request("/audio/speech", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        input: "secret speech input",
        voice: "alloy",
      }),
    });
    await vi.waitFor(() => expect(speechManager.sent).toHaveLength(1));
    expect(requireSent(speechManager).path).toBe("/v1/audio/speech");
    await completeJsonRelay({
      manager: speechManager,
      requestId: requireSent(speechManager).requestId,
      body: { ok: true },
    });
    expect((await speechResponsePromise).status).toBe(200);

    const responsesManager = new FakeRelayManager();
    const responsesResponsePromise = appWith(responsesManager).request("/responses/count_tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, input: "secret response input" }),
    });
    await vi.waitFor(() => expect(responsesManager.sent).toHaveLength(1));
    expect(requireSent(responsesManager).path).toBe("/v1/responses/count_tokens");
    await completeJsonRelay({
      manager: responsesManager,
      requestId: requireSent(responsesManager).requestId,
      body: { total_tokens: 9 },
    });
    await expect((await responsesResponsePromise).json()).resolves.toEqual({ total_tokens: 9 });

    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("secret embedding input");
    expect(metadataCalls).not.toContain("SECRET_AUDIO_BYTES");
    expect(metadataCalls).not.toContain("secret speech input");
    expect(metadataCalls).not.toContain("secret response input");
  });

  it("relays multipart audio transcription requests without persisting uploaded bytes", async () => {
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["SECRET_AUDIO_BYTES"], { type: "audio/wav" }), "input.wav");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1), { timeout: 5000 });
    const sent = requireSent(manager);
    expect(sent.family).toBe("audio");
    expect(sent.path).toBe("/v1/audio/transcriptions");
    expect(sentHeader(sent, "content-type")).toContain("multipart/form-data");
    const relayedBody = await relayBodyText(sent);
    expect(relayedBody).toContain("gpt-4o-mini");
    expect(relayedBody).not.toContain(directTarget.modelId);

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ text: "transcript" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await response.text();
    const metadataCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
    ]);
    expect(metadataCalls).not.toContain("SECRET_AUDIO_BYTES");
  });

  it.each([
    ["missing_model", (body: FormData) => body.delete("model")],
    ["duplicate_model", (body: FormData) => body.append("model", "second/model")],
    ["missing_file", (body: FormData) => body.delete("file")],
    ["duplicate_file", (body: FormData) => body.append("file", new Blob(["two"]), "two.wav")],
  ] as const)("rejects malformed transcription form data with %s", async (code, mutate) => {
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    mutate(body);
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(manager.sent).toEqual([]);
  });

  it("preserves transcription fields and passes successful SSE through without retrying", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        capabilityOverrideMetadata: {
          version: 2,
          protocol: "openai-compatible",
          audio: {
            transcriptions: {
              supported: true,
              streaming: true,
              timestampGranularities: ["word", "segment"],
              diarization: true,
              languages: ["fr"],
              responseFormats: ["verbose_json"],
            },
          },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["SSE_AUDIO"], { type: "audio/wav" }), "input.wav");
    body.set("stream", "true");
    body.set("language", "fr");
    body.set("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "word");
    body.set("diarization", "true");
    body.set("vendor_extension", "preserve-me");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1), { timeout: 5000 });
    const sent = requireSent(manager);
    const relayedBody = await relayBodyText(sent);
    expect(relayedBody).toContain('name="stream"\r\n\r\ntrue');
    expect(relayedBody).toContain('name="language"\r\n\r\nfr');
    expect(relayedBody).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(relayedBody).toContain('name="timestamp_granularities[]"\r\n\r\nword');
    expect(relayedBody).toContain('name="diarization"\r\n\r\ntrue');
    expect(relayedBody).toContain('name="vendor_extension"\r\n\r\npreserve-me');
    expect(relayedBody).toContain('name="model"\r\n\r\ngpt-4o-mini');
    expect(relayedBody).not.toContain(directTarget.modelId);

    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'event: transcript.text.delta\ndata: {"delta":"bon"}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe(
      'event: transcript.text.delta\ndata: {"delta":"bon"}\n\ndata: [DONE]\n\n',
    );
    expect(manager.sent).toHaveLength(1);
    expect(manager.cancelled).toEqual([]);
  });

  it.each([
    [
      "json",
      "application/json",
      new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 34, 120, 34, 125]),
    ],
    [
      "verbose_json",
      "application/json; charset=utf-8",
      new Uint8Array([123, 34, 119, 111, 114, 100, 115, 34, 58, 91, 93, 125]),
    ],
    ["text", "text/plain; charset=utf-8", new Uint8Array([104, 105, 10])],
    ["srt", "application/x-subrip", new Uint8Array([49, 10, 48, 48, 58, 48, 48])],
    ["vtt", "text/vtt", new Uint8Array([87, 69, 66, 86, 84, 84, 10])],
    ["diarized_json", "application/vnd.vendor.diarized+json", new Uint8Array([0, 255, 1, 128])],
  ] as const)(
    "passes %s transcription response content type and bytes through unchanged",
    async (responseFormat, contentType, output) => {
      db.discoveredModel.findUnique.mockResolvedValue(
        directRow({
          capabilityOverrideMetadata: {
            version: 2,
            protocol: "openai-compatible",
            audio: {
              transcriptions: {
                supported: true,
                diarization: responseFormat === "diarized_json",
                responseFormats: [responseFormat],
              },
            },
          },
        }),
      );
      const manager = new FakeRelayManager();
      const body = new FormData();
      body.set("model", directTarget.modelId);
      body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
      body.set("response_format", responseFormat);

      const responsePromise = appWith(manager).request("/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test" },
        body,
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 200, { "content-type": contentType, "x-upstream": "kept" });
      const response = await responsePromise;
      manager.bodyBytes(sent.requestId, output);
      manager.complete(sent.requestId);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("x-upstream")).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(output);
      expect(manager.sent).toHaveLength(1);
    },
  );

  it("uses a persisted opt-in only for direct basic transcription with unknown support", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        optimisticBasicTranscription: true,
        capabilityOverrideMetadata: {
          version: 2,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, audio: false },
        },
      }),
    );
    const manager = new FakeRelayManager();
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    await completeJsonRelay({
      manager,
      requestId: requireSent(manager).requestId,
      body: { text: "ok" },
    });
    expect((await responsePromise).status).toBe(200);

    const advanced = new FormData();
    advanced.set("model", directTarget.modelId);
    advanced.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    advanced.set("stream", "true");
    const denied = await appWith(new FakeRelayManager()).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: advanced,
    });
    expect(denied.status).toBe(400);
  });

  it("enforces a direct model's attachment limit for transcription uploads", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [{ ...directTarget, maxAttachmentBytes: 3 }],
      modelPools: [],
    });
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("enforces a pool's attachment limit for transcription uploads", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...poolTarget, maxAttachmentBytes: 3 }],
    });
    const body = new FormData();
    body.set("model", poolTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");
    const manager = new FakeRelayManager();

    const response = await appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
    expect(manager.sent).toHaveLength(0);
  });

  it("rejects audio endpoints when effective model capabilities do not allow them", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ audioTranscriptions: false }));
    const body = new FormData();
    body.set("model", directTarget.modelId);
    body.set("file", new Blob(["audio"], { type: "audio/wav" }), "input.wav");

    const response = await appWith(new FakeRelayManager()).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_capability" },
    });
  });

  it("relays a one-member pool whose member is still UNKNOWN (the create default)", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        healthStatus: "UNKNOWN",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.cliDeviceId).toBe("cli-a");
    expect(firstBodyChunkText(sent)).toContain('"model":"upstream-a"');

    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "chatcmpl", choices: [] });
  });

  it("queries only concrete PRIMARY targets when a pool has mixed local and public tiers", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockImplementation(async (args: { where?: unknown }) => {
      expect(args.where).toEqual({
        poolId: poolTarget.id,
        tier: "PRIMARY",
        ExecutionTarget: { DiscoveredModel: { isNot: null } },
      });
      // A real database applies the predicate and excludes the provider-backed
      // PUBLIC_OVERFLOW row; return the surviving primary row here.
      return [
        poolMemberRow({
          id: "local-primary",
          discoveredModelId: "local-model",
          upstreamModelId: "local-upstream",
          cliDeviceId: "cli-local",
        }),
      ];
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    expect(requireSent(manager).cliDeviceId).toBe("cli-local");
    await completeJsonRelay({ manager, requestId: requireSent(manager).requestId });
    expect((await responsePromise).status).toBe(200);
  });

  it("routes provider PRIMARY before public overflow without silently changing tiers", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    publicOverflow.list.mockResolvedValueOnce({
      enabled: false,
      acknowledged: false,
      affinityPolicy: {
        enabled: false,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [providerPrimaryTarget()],
    });
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: false,
      reason: "NO_COMPATIBLE_PROVIDER",
    });
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "overflow" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: {
        poolMemberId: "overflow-member",
        executionTargetId: "overflow-target",
        providerAccountId: "provider-account",
        providerModelId: "provider-model",
        endpointIdentity: "https://provider.example/v1",
        endpointVersion: 1,
        upstreamModelId: "provider-upstream",
      },
      attemptId: "overflow-attempt",
      fencingToken: 1n,
      nativeSurface: "openai-chat",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 17 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    expect(response.status).toBe(200);
    expect(publicOverflow.dispatch.mock.calls.map(([input]) => input.memberTier)).toEqual([
      "PRIMARY",
      "PUBLIC_OVERFLOW",
    ]);
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicEgress: true,
          selectedPoolMemberTier: "PUBLIC_OVERFLOW",
        }),
      }),
    );
  });

  it("records provider PRIMARY as external egress without an overflow reason", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    publicOverflow.list.mockResolvedValueOnce({
      enabled: false,
      acknowledged: false,
      affinityPolicy: {
        enabled: true,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [providerPrimaryTarget()],
    });
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "primary" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: {
        poolMemberId: "primary-provider-member",
        executionTargetId: "primary-provider-target",
        providerAccountId: "provider-account",
        providerModelId: "provider-model",
        endpointIdentity: "https://provider.example/v1",
        endpointVersion: 1,
        upstreamModelId: "provider-upstream",
      },
      attemptId: "primary-attempt",
      fencingToken: 1n,
      nativeSurface: "openai-chat",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 16 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    expect(response.status).toBe(200);
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(1);
    expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({ memberTier: "PRIMARY" });
    expect(affinity.rank).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-id",
        resourceOwnerId: "user-id",
        targets: [expect.objectContaining({ poolMemberId: "primary-provider-member" })],
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicEgress: true,
          publicOverflowReason: null,
          selectedPoolMemberTier: "PRIMARY",
        }),
      }),
    );
  });

  it("re-admits remaining provider overflow members after a retry-safe precommit failure", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    const first = providerPrimaryTarget("overflow-a");
    const second = providerPrimaryTarget("overflow-b");
    publicOverflow.list.mockImplementation(
      async (_userId: string, _poolId: string, tier: "PRIMARY" | "PUBLIC_OVERFLOW") => ({
        enabled: tier === "PUBLIC_OVERFLOW",
        acknowledged: tier === "PUBLIC_OVERFLOW",
        affinityPolicy: {
          enabled: false,
          ttlSeconds: 3600,
          maxRecords: 10_000,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
        },
        targets: tier === "PUBLIC_OVERFLOW" ? [first, second] : [],
      }),
    );
    publicOverflow.dispatch
      .mockResolvedValueOnce({ dispatched: false, reason: "PROVIDER_UNAVAILABLE" })
      .mockResolvedValueOnce({
        dispatched: true,
        response: new Response(JSON.stringify({ id: "secondary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        target: second,
        attemptId: "secondary-attempt",
        fencingToken: 2n,
        nativeSurface: "openai-chat",
        attemptCount: 1,
        terminal: Promise.resolve({ ok: true, responseBytes: 18 }),
        markFirstClientByte: vi.fn().mockResolvedValue(undefined),
        affinity: undefined,
      });
    const admittedMembers: string[][] = [];
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        admittedMembers.push(
          attempt.candidates.map((candidate: { poolMemberId?: string }) => candidate.poolMemberId!),
        );
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: `lease-${candidate.poolMemberId}`,
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: BigInt(admittedMembers.length),
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn(async () => true),
      hold: vi.fn((response) => response),
    };

    const response = await appWith(new FakeRelayManager(), true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(poolTarget.modelId),
      },
    );

    expect(response.status).toBe(200);
    expect(admittedMembers).toEqual([["overflow-a", "overflow-b"], ["overflow-b"]]);
    expect(publicOverflow.dispatch.mock.calls.map(([input]) => input.forcedPoolMemberId)).toEqual([
      "overflow-a",
      "overflow-b",
    ]);
    expect(capacityRuntime.release).toHaveBeenCalledTimes(1);
    expect(capacityRuntime.hold).toHaveBeenCalledTimes(1);
  });

  it("releases an admitted provider lease when dispatch rejects without re-admitting", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    const first = providerPrimaryTarget("overflow-a");
    const second = providerPrimaryTarget("overflow-b");
    publicOverflow.list.mockImplementation(
      async (_userId: string, _poolId: string, tier: "PRIMARY" | "PUBLIC_OVERFLOW") => ({
        enabled: tier === "PUBLIC_OVERFLOW",
        acknowledged: tier === "PUBLIC_OVERFLOW",
        affinityPolicy: {
          enabled: false,
          ttlSeconds: 3600,
          maxRecords: 10_000,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
        },
        targets: tier === "PUBLIC_OVERFLOW" ? [first, second] : [],
      }),
    );
    const dispatchError = new Error("provider dispatch rejected");
    publicOverflow.dispatch.mockRejectedValueOnce(dispatchError);
    const release = vi.fn(async () => true);
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: `lease-${candidate.poolMemberId}`,
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release,
      hold: vi.fn((response) => response),
    };

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await appWith(new FakeRelayManager(), true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(poolTarget.modelId),
      },
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(dispatchError);

    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-overflow-a", poolMemberId: "overflow-a" }),
    );
    expect(capacityRuntime.hold).not.toHaveBeenCalled();
  });

  it("admits local and provider PRIMARY members through one scored capacity candidate set", async () => {
    const grantedPoolTarget = {
      ...poolTarget,
      ownerUserId: "pool-owner-id",
      accessGrantId: "grant-id",
    };
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [grantedPoolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
        weight: 1,
        affinityEnabled: true,
      }),
    ]);
    const provider = { ...providerPrimaryTarget(), weight: 5 };
    publicOverflow.list.mockResolvedValue({
      enabled: false,
      acknowledged: false,
      affinityPolicy: {
        enabled: true,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [provider],
    });
    publicOverflow.dispatch.mockResolvedValue({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "provider-primary" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: provider,
      attemptId: "provider-attempt",
      fencingToken: 7n,
      nativeSurface: "openai-chat",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 25 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const selected = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "provider-lease",
            attemptId: attempt.attemptId,
            capacityId: selected.capacityId,
            executionTargetId: selected.executionTargetId,
            poolMemberId: selected.poolMemberId,
            fencingToken: 3n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn(async () => true),
      hold: vi.fn((response) => response),
    };
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const responsePromise = appWith(manager, true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(grantedPoolTarget.modelId),
      },
    );
    await vi.waitFor(() => {
      expect(publicOverflow.dispatch.mock.calls.length + manager.sent.length).toBeGreaterThan(0);
    });
    if (manager.sent[0]) await completeJsonRelay({ manager, requestId: manager.sent[0].requestId });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "pool-owner-id",
        candidates: expect.arrayContaining([
          expect.objectContaining({ poolMemberId: provider.poolMemberId }),
          expect.objectContaining({ poolMemberId: "local-primary" }),
        ]),
      }),
      expect.any(AbortSignal),
    );
    expect(affinity.rank).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-id",
        resourceOwnerId: "pool-owner-id",
        accessGrantId: "grant-id",
        targets: expect.arrayContaining([
          expect.objectContaining({ poolMemberId: provider.poolMemberId }),
          expect.objectContaining({ poolMemberId: "local-primary" }),
        ]),
      }),
    );
    expect(publicOverflow.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ affinityAccessGrantId: "grant-id" }),
    );
  });

  it("releases a pre-admitted provider PRIMARY lease once when dispatch rejects", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    const provider = providerPrimaryTarget();
    publicOverflow.list.mockResolvedValue({
      enabled: false,
      acknowledged: false,
      affinityPolicy: {
        enabled: false,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [provider],
    });
    const dispatchError = new Error("pre-admitted provider dispatch rejected");
    publicOverflow.dispatch.mockRejectedValueOnce(dispatchError);
    const release = vi.fn(async () => true);
    const hold = vi.fn((response) => response);
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const selected = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "pre-admitted-provider-lease",
            attemptId: attempt.attemptId,
            capacityId: selected.capacityId,
            executionTargetId: selected.executionTargetId,
            poolMemberId: selected.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release,
      hold,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await appWith(new FakeRelayManager(), true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(poolTarget.modelId),
      },
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(dispatchError);
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(1);
    expect(publicOverflow.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        memberTier: "PRIMARY",
        forcedPoolMemberId: provider.poolMemberId,
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "pre-admitted-provider-lease" }),
    );
    expect(hold).not.toHaveBeenCalled();
  });

  it.each([
    { nativeKind: "provider" as const, expectedMember: "provider-primary" },
    { nativeKind: "local" as const, expectedMember: "local-primary" },
  ])(
    "keeps the $nativeKind native PRIMARY ahead of an affinity-preferred adapted target",
    async ({ nativeKind, expectedMember }) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [{ ...poolTarget, protocolAdaptationEnabled: true }],
      });
      const responsesOnly = {
        version: 3 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiResponses: {
            source: "declared" as const,
            confidence: "exact" as const,
            supported: true,
            streaming: true,
          },
        },
      };
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "local-primary",
          discoveredModelId: "local-model",
          upstreamModelId: "local-upstream",
          cliDeviceId: "cli-local",
          affinityEnabled: true,
          capabilityOverrideMetadata: nativeKind === "provider" ? responsesOnly : null,
        }),
      ]);
      const provider = {
        ...providerPrimaryTarget("provider-primary"),
        ...(nativeKind === "local"
          ? {
              nativeSurfaces: ["openai-responses" as const],
              capabilityInventory: responsesOnly,
            }
          : {}),
      };
      publicOverflow.list.mockResolvedValue({
        enabled: false,
        acknowledged: false,
        affinityPolicy: {
          enabled: true,
          ttlSeconds: 3600,
          maxRecords: 10_000,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
        },
        targets: [provider],
      });
      // Deliberately prefer the adapted target. Affinity may reorder only
      // within a native/adapted class, never across that compatibility boundary.
      affinity.rank.mockResolvedValue({
        orderedTargetIds:
          nativeKind === "provider"
            ? ["local-primary-target", "provider-primary-target"]
            : ["provider-primary-target", "local-primary-target"],
        scores: {},
        prefixDepths: {},
        conversationMatches: {},
        reasons: {},
        matchedPrefixDepth: 0,
      });
      const selectedMembers: string[] = [];
      const capacityRuntime: CapacityAdmissionRuntime = {
        acquire: vi.fn(async (attempt) => {
          const selected = attempt.candidates[0]!;
          selectedMembers.push(selected.poolMemberId!);
          return {
            state: "ADMITTED" as const,
            lease: {
              leaseId: "lease",
              attemptId: attempt.attemptId,
              capacityId: selected.capacityId,
              executionTargetId: selected.executionTargetId,
              poolMemberId: selected.poolMemberId,
              fencingToken: 1n,
              expiresAt: new Date(Date.now() + 30_000),
            },
          };
        }),
        release: vi.fn(async () => true),
        hold: vi.fn((response) => response),
      };
      publicOverflow.dispatch.mockResolvedValue({
        dispatched: true,
        response: new Response(JSON.stringify({ id: "provider" }), {
          headers: { "content-type": "application/json" },
        }),
        target: provider,
        attemptId: "attempt",
        fencingToken: 1n,
        nativeSurface: nativeKind === "provider" ? "openai-chat" : "openai-responses",
        attemptCount: 1,
        terminal: Promise.resolve({ ok: true, responseBytes: 10 }),
        markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      });
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];
      const responsePromise = appWith(manager, true, true, capacityRuntime).request(
        "/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
          body: requestBody(poolTarget.modelId),
        },
      );
      await vi.waitFor(() => expect(selectedMembers).toHaveLength(1));
      expect(selectedMembers[0]).toBe(expectedMember);
      if (nativeKind === "local") {
        await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
        await completeJsonRelay({ manager, requestId: requireSent(manager).requestId });
      }
      expect((await responsePromise).status).toBe(200);
    },
  );

  it("returns Anthropic-shaped pool compatibility failures", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-openai",
        discoveredModelId: "model-openai",
        upstreamModelId: "upstream-openai",
        cliDeviceId: "cli-openai",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-openai"];
    const response = await appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: poolTarget.modelId, max_tokens: 8, messages: [] }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(manager.sent).toHaveLength(0);
  });

  it("fails over pool requests across every currently routable member before returning success", async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        capacityWaitBudgetMode: "LIMITED",
        capacityWaitBudgetMs: 50,
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
        cliDeviceId: "cli-b",
        capacityWaitBudgetMode: "UNLIMITED",
      }),
    ]);
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });

    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];
    const capacityEvents: string[] = [];
    const limiter = new ModelApiConcurrencyLimiter();
    const acquireGlobal = limiter.acquireGlobal.bind(limiter);
    vi.spyOn(limiter, "acquireGlobal").mockImplementation((identity) => {
      capacityEvents.push("local:global:acquire");
      const lease = acquireGlobal(identity);
      return {
        release: () => {
          capacityEvents.push("local:global:release");
          lease.release();
        },
      };
    });
    const acquireCli = limiter.acquireCli.bind(limiter);
    vi.spyOn(limiter, "acquireCli").mockImplementation((cliDeviceId) => {
      capacityEvents.push(`local:cli:acquire:${cliDeviceId}`);
      const lease = acquireCli(cliDeviceId);
      return {
        release: () => {
          capacityEvents.push(`local:cli:release:${cliDeviceId}`);
          lease.release();
        },
      };
    });
    const capacityAttempts: Array<{ requestId: string; attemptId: string; candidates: unknown[] }> =
      [];
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        capacityEvents.push(`acquire:${attempt.candidates[0]?.poolMemberId ?? "none"}`);
        capacityAttempts.push({
          requestId: attempt.requestId,
          attemptId: attempt.attemptId,
          candidates: [...attempt.candidates],
        });
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: `lease-${candidate.poolMemberId}`,
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: BigInt(capacityAttempts.length),
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn(async (lease) => {
        capacityEvents.push(`release:${lease.poolMemberId}`);
        return true;
      }),
      hold: vi.fn((response, lease) => {
        capacityEvents.push(`hold:${lease.poolMemberId}`);
        return response;
      }),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime, limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(poolTarget.modelId),
      },
    );

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const failed = requireSent(manager);
    expect(failed.cliDeviceId).toBe("cli-a");
    expect(firstBodyChunkText(failed)).toContain('"model":"upstream-a"');
    manager.headers(failed.requestId, 500, { "content-type": "application/json" });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    expect(capacityAttempts).toHaveLength(2);
    expect(capacityAttempts[0]?.requestId).not.toBe(capacityAttempts[1]?.requestId);
    expect(capacityAttempts[0]?.attemptId).not.toBe(capacityAttempts[1]?.attemptId);
    expect(capacityAttempts[0]?.candidates).toHaveLength(2);
    const firstAdmissionCandidates = capacityAttempts[0]?.candidates as Array<{
      poolMemberId: string;
      deadlineAt: Date;
    }>;
    expect(firstAdmissionCandidates[1]!.deadlineAt.getTime()).toBeGreaterThan(
      firstAdmissionCandidates[0]!.deadlineAt.getTime() + 1_000,
    );
    expect(capacityAttempts[1]?.candidates).toMatchObject([{ poolMemberId: "member-b" }]);
    expect(capacityEvents).toEqual([
      "acquire:member-a",
      "local:global:acquire",
      "local:cli:acquire:cli-a",
      "local:cli:release:cli-a",
      "local:global:release",
      "release:member-a",
      "acquire:member-b",
      "local:global:acquire",
      "local:cli:acquire:cli-b",
    ]);
    const retried = requireSent(manager, 1);
    expect(retried.cliDeviceId).toBe("cli-b");
    expect(firstBodyChunkText(retried)).toContain('"model":"upstream-b"');
    expect(retried.timeoutMs).toBeLessThan(failed.timeoutMs);
    expect(manager.cancelled).toContainEqual({
      cliDeviceId: "cli-a",
      requestId: failed.requestId,
      reason: "upstream_5xx",
    });
    expect(db.poolMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "member-a" } }),
    );

    manager.headers(retried.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(retried.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(retried.requestId);

    expect(response.status).toBe(200);
    await response.text();
    expect(capacityEvents).toContain("hold:member-b");
    expect(capacityRuntime.release).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            selectedDiscoveredModelId: "model-b",
            status: "SUCCEEDED",
          }),
        }),
      ),
    );
    const firstRequestBytes = Buffer.concat(failed.bodyChunks ?? []).byteLength;
    const secondRequestBytes = Buffer.concat(retried.bodyChunks ?? []).byteLength;
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestBytes: BigInt(firstRequestBytes + secondRequestBytes),
        }),
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptCount: 2, responseBytes: expect.any(BigInt) }),
      }),
    );
    now.mockRestore();
  });

  it("rejects direct context ceilings before durable admission", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(directRow({ directContextCeiling: 1 }));
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(),
      release: vi.fn(),
      hold: vi.fn((response) => response),
    };
    const manager = new FakeRelayManager();
    const response = await appWith(manager, true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "context_exceeded",
        message: expect.stringContaining("context exceeds"),
      },
    });
    expect(capacityRuntime.acquire).not.toHaveBeenCalled();
    expect(manager.sent).toHaveLength(0);
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextTokenCount: expect.any(Number),
          contextCountMethod: "TOKEN_ESTIMATE",
          contextCountConfidence: "CONSERVATIVE",
          contextCountExact: false,
          contextSafetyMargin: 1.2,
          contextSerializedChars: expect.any(Number),
        }),
      }),
    );
  });

  it("uses a bounded native Responses count before direct admission", async () => {
    const manager = new FakeRelayManager();
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "native-count-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn().mockResolvedValue(true),
      hold: vi.fn((response) => response),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: directTarget.modelId, input: "hello" }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const count = requireSent(manager);
    expect(count.path).toBe("/v1/responses/count_tokens");
    expect(sentHeader(count, "authorization")).toBeUndefined();
    expect(capacityRuntime.acquire).not.toHaveBeenCalled();
    manager.headers(count.requestId, 200, { "content-type": "application/json" });
    manager.body(count.requestId, JSON.stringify({ input_tokens: 7 }));
    manager.complete(count.requestId);

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    const inference = requireSent(manager, 1);
    expect(inference.path).toBe("/v1/responses");
    manager.headers(inference.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(inference.requestId, JSON.stringify({ id: "resp", object: "response" }));
    manager.complete(inference.requestId);
    await response.text();
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextTokenCount: 7,
          contextCountMethod: "NATIVE",
          contextCountConfidence: "EXACT",
          contextCountExact: true,
        }),
      }),
    );
  });

  it("honors a selected capacity's conservative strategy without dispatching native count", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({ countStrategy: "CONSERVATIVE_ESTIMATE" }),
    );
    const manager = new FakeRelayManager();
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => ({
        state: "ADMITTED" as const,
        lease: {
          leaseId: "estimate-lease",
          attemptId: attempt.attemptId,
          capacityId: attempt.candidates[0]!.capacityId,
          executionTargetId: attempt.candidates[0]!.executionTargetId,
          fencingToken: 1n,
          expiresAt: new Date(Date.now() + 30_000),
        },
      })),
      release: vi.fn().mockResolvedValue(true),
      hold: vi.fn((response) => response),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request("/responses", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({ model: directTarget.modelId, input: "hello" }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const inference = requireSent(manager);
    expect(inference.path).toBe("/v1/responses");
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    manager.headers(inference.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(inference.requestId, JSON.stringify({ id: "resp", object: "response" }));
    manager.complete(inference.requestId);
    await response.text();
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextCountMethod: "TOKEN_ESTIMATE",
          contextCountExact: false,
        }),
      }),
    );
  });

  it("filters over-context pool members before admission", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "too-small",
        discoveredModelId: "small-model",
        upstreamModelId: "small-upstream",
        cliDeviceId: "cli-small",
        capacityContextCeiling: 1,
      }),
      poolMemberRow({
        id: "fits",
        discoveredModelId: "fits-model",
        upstreamModelId: "fits-upstream",
        cliDeviceId: "cli-fits",
        capacityContextCeiling: 10_000,
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-small", "cli-fits"];
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "context-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn().mockResolvedValue(true),
      hold: vi.fn((response) => response),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(poolTarget.modelId),
      },
    );
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    expect(requireSent(manager).cliDeviceId).toBe("cli-fits");
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ poolMemberId: "fits" })],
      }),
      expect.anything(),
    );
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);
    await response.text();
  });

  it("uses per-target native counts to filter pool admission candidates", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "large-count",
        discoveredModelId: "large-model",
        upstreamModelId: "large-upstream",
        cliDeviceId: "cli-large",
        capacityContextCeiling: 50,
      }),
      poolMemberRow({
        id: "small-count",
        discoveredModelId: "small-model",
        upstreamModelId: "small-upstream",
        cliDeviceId: "cli-small",
        capacityContextCeiling: 50,
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-large", "cli-small"];
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "pool-native-count-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn().mockResolvedValue(true),
      hold: vi.fn((response) => response),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request("/responses", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({ model: poolTarget.modelId, input: "hello" }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    for (const sent of manager.sent) {
      expect(sent.path).toBe("/v1/responses/count_tokens");
      manager.headers(sent.requestId, 200, { "content-type": "application/json" });
      manager.body(
        sent.requestId,
        JSON.stringify({ input_tokens: sent.cliDeviceId === "cli-large" ? 100 : 10 }),
      );
      manager.complete(sent.requestId);
    }
    await vi.waitFor(() => expect(manager.sent).toHaveLength(3));
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ poolMemberId: "small-count" })],
      }),
      expect.anything(),
    );
    const inference = requireSent(manager, 2);
    expect(inference.cliDeviceId).toBe("cli-small");
    manager.headers(inference.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(inference.requestId, JSON.stringify({ id: "resp", object: "response" }));
    manager.complete(inference.requestId);
    await response.text();
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contextTokenCount: 10,
          contextCountMethod: "NATIVE",
          contextCountExact: true,
        }),
      }),
    );
  });

  it("replays a spooled transcription across compatible pool members and accounts both attempts", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "asr-a",
        cliDeviceId: "cli-a",
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "asr-b",
        cliDeviceId: "cli-b",
      }),
    ]);
    db.poolMember.findUnique.mockResolvedValue({
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt: null,
      halfOpenTrialStartedAt: null,
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];
    const form = new FormData();
    form.set("model", poolTarget.modelId);
    form.set("file", new Blob(["REPLAY_AUDIO_SENTINEL"], { type: "audio/wav" }), "voice.wav");

    const responsePromise = appWith(manager).request("/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test" },
      body: form,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const first = requireSent(manager);
    const firstBody = await relayBodyText(first);
    expect(firstBody).toContain("REPLAY_AUDIO_SENTINEL");
    expect(firstBody).toContain("asr-a");
    manager.headers(first.requestId, 500, { "content-type": "application/json" });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
    const second = requireSent(manager, 1);
    const secondBody = await relayBodyText(second);
    expect(secondBody).toContain("REPLAY_AUDIO_SENTINEL");
    expect(secondBody).toContain("asr-b");
    expect(secondBody).not.toContain("asr-a");
    manager.headers(second.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(second.requestId, JSON.stringify({ text: "done" }));
    manager.complete(second.requestId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "done" });
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attemptCount: 2,
            requestBytes: BigInt((first.bodySource?.size ?? 0) + (second.bodySource?.size ?? 0)),
          }),
        }),
      ),
    );
  });

  it("returns a no-routable pool error when every member is skipped", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
        connected: false,
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
        cliDeviceId: "cli-b",
        routingStatus: "DISABLED",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = [];

    const response = await appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(poolTarget.modelId),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "disconnected" },
    });
    expect(manager.sent).toEqual([]);
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorClass: "disconnected",
        }),
      }),
    );
  });

  it("relays Responses API create streams and stores only sticky routing metadata", async () => {
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        stream: true,
        input: "secret response prompt",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    const response = await responsePromise;
    manager.body(sent.requestId, 'data: {"id":"resp_123","object":"response"}\n\n');
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("resp_123");
    await vi.waitFor(() => expect(db.responseStickinessRecord.upsert).toHaveBeenCalled());
    const persistenceCalls = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
      db.responseStickinessRecord.upsert.mock.calls,
    ]);
    expect(persistenceCalls).not.toContain("secret response prompt");
    expect(persistenceCalls).not.toContain("resp_123");
    expect(db.responseStickinessRecord.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: {
        routingVersion: 2,
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: "model-id",
        targetExecutionTargetId: "execution-target-id",
        selectedDiscoveredModelId: "model-id",
        selectedExecutionTargetId: "execution-target-id",
      },
    });
  });

  it("does not expose provider Responses EOF until the v3 binding is durable", async () => {
    let resolveUpsert!: (value: { id: string }) => void;
    db.responseStickinessRecord.upsert.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    const wrapped = captureProviderResponseBinding({
      response: new Response(JSON.stringify({ id: "resp_provider", object: "response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      streaming: false,
      requester: {
        userId: "user-id",
        modelApiTokenId: "token-id",
        modelApiTokenLookupPrefix: "wsmp_model_lookup",
        limitKey: "token-id",
      },
      targetModelPoolId: "pool-id",
      poolGrantId: null,
      target: {
        executionTargetId: "provider-target",
        providerAccountId: "provider-account",
        providerModelId: "provider-model",
        endpointIdentity: "https://provider.example/v1",
        endpointVersion: 4,
        upstreamModelId: "gpt-response",
      },
      terminal: Promise.resolve({ ok: true }),
    });
    const reader = wrapped.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const eof = reader.read();
    let eofObserved = false;
    void eof.then(() => {
      eofObserved = true;
    });
    await vi.waitFor(() => expect(db.responseStickinessRecord.upsert).toHaveBeenCalled());
    expect(eofObserved).toBe(false);
    expect(db.responseStickinessRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          routingVersion: 3,
          userId: "user-id",
          modelApiTokenId: "token-id",
          targetModelPoolId: "pool-id",
          selectedExecutionTargetId: "provider-target",
          providerAccountId: "provider-account",
          providerModelId: "provider-model",
          providerEndpointIdentity: "https://provider.example/v1",
          providerEndpointVersion: 4,
          providerUpstreamModelId: "gpt-response",
          poolGrantId: null,
          nativeSurface: "OPENAI_RESPONSES",
        }),
      }),
    );
    resolveUpsert({ id: "binding-id" });
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
  });

  it("round-trips stored provider Responses through one native immutable binding", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([]);
    const providerTarget = {
      poolMemberId: "provider-member",
      executionTargetId: "provider-target",
      providerAccountId: "provider-account",
      providerModelId: "provider-model",
      endpointIdentity: "https://provider.example/v1",
      endpointVersion: 4,
      upstreamModelId: "gpt-response",
    };
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "resp_provider", object: "response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: providerTarget,
      attemptId: "provider-attempt-create",
      fencingToken: 1n,
      nativeSurface: "openai-responses",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 48 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });
    const create = await appWith(new FakeRelayManager()).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: poolTarget.modelId, input: "hello", store: true }),
    });
    expect(create.status).toBe(200);
    await expect(create.json()).resolves.toMatchObject({ id: "resp_provider" });
    await vi.waitFor(() => expect(db.responseStickinessRecord.upsert).toHaveBeenCalled());
    const binding = db.responseStickinessRecord.upsert.mock.calls.at(-1)?.[0].create;
    expect(binding).toMatchObject({
      routingVersion: 3,
      targetModelPoolId: "pool-id",
      selectedExecutionTargetId: "provider-target",
      providerAccountId: "provider-account",
      providerModelId: "provider-model",
      providerEndpointIdentity: "https://provider.example/v1",
      providerEndpointVersion: 4,
      providerUpstreamModelId: "gpt-response",
      poolGrantId: null,
      nativeSurface: "OPENAI_RESPONSES",
    });
    expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
      requestedSurface: "openai-responses",
      requireNativeSurface: "openai-responses",
      adaptationEnabled: false,
    });

    db.responseStickinessRecord.findUnique.mockResolvedValue({
      ...binding,
      userId: "user-id",
      modelApiTokenId: "token-id",
      PoolGrant: null,
      TargetExecutionTarget: null,
      SelectedExecutionTarget: { discoveredModelId: null },
    });
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "resp_provider", object: "response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: providerTarget,
      attemptId: "provider-attempt-retrieve",
      fencingToken: 2n,
      nativeSurface: "openai-responses",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 48 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });
    const retrieve = await appWith(new FakeRelayManager()).request(
      "/responses/resp_provider?include[]=output",
      { headers: { authorization: "Bearer wsmp_model_test" } },
    );
    expect(retrieve.status).toBe(200);
    await retrieve.text();
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(2);
    expect(publicOverflow.dispatch.mock.calls[1]?.[0]).toMatchObject({
      method: "GET",
      path: "/v1/responses/resp_provider?include[]=output",
      retrySafe: false,
      adaptationEnabled: false,
      exactResponsesBinding: {
        executionTargetId: "provider-target",
        providerAccountId: "provider-account",
        providerModelId: "provider-model",
        endpointIdentity: "https://provider.example/v1",
        endpointVersion: 4,
        upstreamModelId: "gpt-response",
      },
    });
    expect(db.relayRequest.create.mock.calls.at(-1)?.[0].data.operation).toBe("responses.retrieve");
  });

  it("uses metadata-only sticky routing for Responses API follow-up requests", async () => {
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 2,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: null,
      targetModelPoolId: null,
      selectedDiscoveredModelId: null,
      TargetExecutionTarget: { discoveredModelId: "model-id" },
      SelectedExecutionTarget: { discoveredModelId: "model-id" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const release = vi.fn().mockResolvedValue(true);
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "sticky-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release,
      hold: (response, lease, signal) =>
        holdCapacityLeaseForResponse({
          response,
          lease,
          signal,
          heartbeatIntervalMs: 0,
          store: { heartbeat: vi.fn().mockResolvedValue(true), release },
        }),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: directTarget.modelId,
        previous_response_id: "resp_123",
        input: "follow-up prompt",
      }),
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.path).toBe("/v1/responses");
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "DIRECT",
        candidates: [
          expect.objectContaining({
            capacityId: "model-id-capacity",
            executionTargetId: "model-id-target",
          }),
        ],
      }),
      expect.anything(),
    );
    expect(release).not.toHaveBeenCalled();
    manager.body(sent.requestId, JSON.stringify({ id: "resp_456", object: "response" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
    await response.text();
    expect(release).toHaveBeenCalledTimes(1);
    const findCall = JSON.stringify(db.responseStickinessRecord.findUnique.mock.calls);
    expect(findCall).not.toContain("resp_123");
    expect(manager.sent).toHaveLength(1);
  });

  it("releases every admitted direct-request permit when relay startup throws", async () => {
    const manager = new FakeRelayManager();
    vi.spyOn(manager, "registerRelayResponseHandlers").mockImplementation(() => {
      throw new Error("relay transport closed during startup");
    });
    const limiter = new ModelApiConcurrencyLimiter();
    const globalRelease = vi.fn();
    const cliRelease = vi.fn(() => {
      throw new Error("local CLI release failed");
    });
    vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: globalRelease });
    vi.spyOn(limiter, "acquireCli").mockReturnValue({ release: cliRelease });
    const capacityRelease = vi.fn().mockResolvedValue(true);
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "startup-failure-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: capacityRelease,
      hold: vi.fn((response) => response),
    };

    const response = await appWith(manager, true, false, capacityRuntime, limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(),
      },
    );

    expect(response.status).toBe(500);
    expect(cliRelease).toHaveBeenCalledTimes(1);
    expect(globalRelease).toHaveBeenCalledTimes(1);
    expect(capacityRelease).toHaveBeenCalledTimes(1);
    expect(capacityRuntime.hold).not.toHaveBeenCalled();
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", attemptCount: 1 }),
      }),
    );
  });

  it.each([
    ["follow-up create", "/responses", "POST", true],
    ["retrieve", "/responses/resp_123", "GET", false],
    ["delete", "/responses/resp_123", "DELETE", false],
    ["cancel", "/responses/resp_123/cancel", "POST", false],
    ["input items", "/responses/resp_123/input_items", "GET", false],
    ["compact", "/responses/resp_123/compact", "POST", false],
  ] as const)(
    "never fails over stateful Responses %s after a 5xx",
    async (_name, path, method, create) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.responseStickinessRecord.findUnique.mockResolvedValue({
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: null,
        targetModelPoolId: "pool-id",
        selectedDiscoveredModelId: "model-a",
        expiresAt: new Date(Date.now() + 60_000),
      });
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
          affinityEnabled: true,
        }),
        poolMemberRow({
          id: "member-b",
          discoveredModelId: "model-b",
          upstreamModelId: "upstream-b",
          cliDeviceId: "cli-b",
          affinityEnabled: true,
        }),
      ]);
      db.discoveredModel.findUnique.mockResolvedValue(
        directRow({ id: "model-a", upstreamModelId: "upstream-a", cliDeviceId: "cli-a" }),
      );
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a", "cli-b"];
      const responsePromise = appWith(manager).request(path, {
        method,
        headers: {
          authorization: "Bearer wsmp_model_test",
          ...(create ? { "content-type": "application/json" } : {}),
        },
        body: create
          ? JSON.stringify({
              model: poolTarget.modelId,
              previous_response_id: "resp_123",
              input: "follow-up",
            })
          : undefined,
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 500, { "content-type": "application/json" });
      manager.body(sent.requestId, JSON.stringify({ error: { message: "failed" } }));
      manager.complete(sent.requestId);
      const response = await responsePromise;
      expect(response.status).toBe(500);
      await response.text();
      expect(manager.sent).toHaveLength(1);
      expect(affinity.rank).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["follow-up create", "/responses", "POST", true],
    ["retrieve", "/responses/resp_123", "GET", false],
    ["delete", "/responses/resp_123", "DELETE", false],
    ["cancel", "/responses/resp_123/cancel", "POST", false],
    ["input items", "/responses/resp_123/input_items", "GET", false],
    ["compact", "/responses/resp_123/compact", "POST", false],
  ] as const)(
    "never fails over stateful Responses %s after a relay failure",
    async (_name, path, method, create) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.responseStickinessRecord.findUnique.mockResolvedValue({
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: null,
        targetModelPoolId: "pool-id",
        selectedDiscoveredModelId: "model-a",
        expiresAt: new Date(Date.now() + 60_000),
      });
      db.discoveredModel.findUnique.mockResolvedValue(
        directRow({ id: "model-a", upstreamModelId: "upstream-a", cliDeviceId: "cli-a" }),
      );
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a", "cli-b"];
      const responsePromise = appWith(manager).request(path, {
        method,
        headers: {
          authorization: "Bearer wsmp_model_test",
          ...(create ? { "content-type": "application/json" } : {}),
        },
        body: create
          ? JSON.stringify({
              model: poolTarget.modelId,
              previous_response_id: "resp_123",
              input: "follow-up",
            })
          : undefined,
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      manager.error(requireSent(manager).requestId, "transport");
      const response = await responsePromise;
      expect(response.status).toBe(502);
      expect(manager.sent).toHaveLength(1);
    },
  );

  it("routes Responses retrieve through the sticky selected model with no request body", async () => {
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 1,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: "model-id",
      targetModelPoolId: null,
      selectedDiscoveredModelId: "model-id",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const responsePromise = appWith(manager).request("/responses/resp_123?include[]=output", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("responses");
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe("/v1/responses/resp_123?include[]=output");
    expect(sent.bodyChunks).toEqual([]);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "resp_123", object: "response" }));
    manager.complete(sent.requestId);

    expect(response.status).toBe(200);
  });

  it("never falls back to a relay or adapter when an exact provider binding is unavailable", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 3,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: null,
      targetModelPoolId: "pool-id",
      selectedDiscoveredModelId: null,
      selectedExecutionTargetId: "provider-target",
      providerAccountId: "provider-account",
      providerModelId: "provider-model",
      providerEndpointIdentity: "https://provider.example/v1",
      providerEndpointVersion: 1,
      providerUpstreamModelId: "gpt-response",
      poolGrantId: null,
      PoolGrant: null,
      nativeSurface: "OPENAI_RESPONSES",
      upstreamResponseIdDigest: hmacDigestForForwarderPurpose({
        purpose: "responsesStickinessUpstreamId",
        value: "resp_provider",
      }),
      TargetExecutionTarget: null,
      SelectedExecutionTarget: { discoveredModelId: null },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const response = await appWith(manager).request("/responses/resp_provider", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(404);
    expect(manager.sent).toEqual([]);
    expect(affinity.rank).not.toHaveBeenCalled();
  });

  it("does not resurrect a grantee binding after its exact grant is replaced", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [
        {
          ...poolTarget,
          ownerUserId: "pool-owner-id",
          accessGrantId: "replacement-grant",
        },
      ],
    });
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 3,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: null,
      targetModelPoolId: "pool-id",
      selectedDiscoveredModelId: null,
      selectedExecutionTargetId: "provider-target",
      providerAccountId: "provider-account",
      providerModelId: "provider-model",
      providerEndpointIdentity: "https://provider.example/v1",
      providerEndpointVersion: 1,
      providerUpstreamModelId: "gpt-response",
      nativeSurface: "OPENAI_RESPONSES",
      poolGrantId: "original-grant",
      PoolGrant: {
        id: "original-grant",
        poolId: "pool-id",
        ownerUserId: "pool-owner-id",
        granteeUserId: "user-id",
      },
      upstreamResponseIdDigest: hmacDigestForForwarderPurpose({
        purpose: "responsesStickinessUpstreamId",
        value: "resp_grantee",
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await appWith(new FakeRelayManager()).request("/responses/resp_grantee", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(404);
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "deleted selected target",
      {
        routingVersion: 2,
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: "model-id",
        targetModelPoolId: null,
        selectedDiscoveredModelId: "model-id",
        TargetExecutionTarget: { discoveredModelId: "model-id" },
        SelectedExecutionTarget: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      404,
    ],
    [
      "different token",
      {
        routingVersion: 2,
        userId: "user-id",
        modelApiTokenId: "other-token",
        targetDiscoveredModelId: "model-id",
        targetModelPoolId: null,
        selectedDiscoveredModelId: "model-id",
        TargetExecutionTarget: { discoveredModelId: "model-id" },
        SelectedExecutionTarget: { discoveredModelId: "model-id" },
        expiresAt: new Date(Date.now() + 60_000),
      },
      404,
    ],
    [
      "expired binding",
      {
        routingVersion: 2,
        userId: "user-id",
        modelApiTokenId: "token-id",
        targetDiscoveredModelId: "model-id",
        targetModelPoolId: null,
        selectedDiscoveredModelId: "model-id",
        TargetExecutionTarget: { discoveredModelId: "model-id" },
        SelectedExecutionTarget: { discoveredModelId: "model-id" },
        expiresAt: new Date(Date.now() - 1),
      },
      404,
    ],
  ] as const)("fails closed for v2 Responses lifecycle with %s", async (_label, record, status) => {
    db.responseStickinessRecord.findUnique.mockResolvedValue(record);
    const manager = new FakeRelayManager();
    const response = await appWith(manager).request("/responses/resp_123", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(status);
    expect(manager.sent).toEqual([]);
  });

  it("rejects a v2 direct binding when its original target is no longer visible", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [{ ...directTarget, id: "other-model-id", modelId: "owner/other" }],
      modelPools: [],
    });
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 2,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: "model-id",
      targetModelPoolId: null,
      selectedDiscoveredModelId: "model-id",
      TargetExecutionTarget: { discoveredModelId: "model-id" },
      SelectedExecutionTarget: { discoveredModelId: "model-id" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const manager = new FakeRelayManager();
    const response = await appWith(manager).request("/responses/resp_123", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(401);
    expect(manager.sent).toEqual([]);
  });

  it("admits a sticky pool lifecycle request through its exact bound member", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      routingVersion: 2,
      userId: "user-id",
      modelApiTokenId: "token-id",
      targetDiscoveredModelId: null,
      targetModelPoolId: "pool-id",
      selectedDiscoveredModelId: "model-a",
      TargetExecutionTarget: null,
      SelectedExecutionTarget: { discoveredModelId: "model-a" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({ id: "model-a", upstreamModelId: "upstream-a", cliDeviceId: "cli-a" }),
    );
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a"];
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async (attempt) => {
        const candidate = attempt.candidates[0]!;
        return {
          state: "ADMITTED" as const,
          lease: {
            leaseId: "pool-sticky-lease",
            attemptId: attempt.attemptId,
            capacityId: candidate.capacityId,
            executionTargetId: candidate.executionTargetId,
            poolMemberId: candidate.poolMemberId,
            fencingToken: 1n,
            expiresAt: new Date(Date.now() + 30_000),
          },
        };
      }),
      release: vi.fn().mockResolvedValue(true),
      hold: vi.fn((response) => response),
    };
    const responsePromise = appWith(manager, true, false, capacityRuntime).request(
      "/responses/resp_123",
      { headers: { authorization: "Bearer wsmp_model_test" } },
    );

    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "POOL",
        candidates: [
          expect.objectContaining({
            capacityId: "member-a-capacity",
            executionTargetId: "member-a-target",
            poolMemberId: "member-a",
          }),
        ],
      }),
      expect.anything(),
    );
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    const response = await responsePromise;
    manager.body(sent.requestId, JSON.stringify({ id: "resp_123", object: "response" }));
    manager.complete(sent.requestId);
    await response.text();
    expect(capacityRuntime.acquire).toHaveBeenCalledTimes(1);
    expect(capacityRuntime.hold).toHaveBeenCalledTimes(1);
  });

  describe("pool media transformer", () => {
    const transformerId = "transformer-model-id";
    const transformerUpstream = "vlm-upstream";

    function enablePoolTransformer(overrides: Record<string, unknown> = {}) {
      db.modelPool.findUnique.mockResolvedValue({
        transformerDiscoveredModelId: transformerId,
        transformerSystemPrompt: null,
        transformerImages: true,
        transformerAudio: false,
        transformerVideo: false,
        transformerCacheMode: "OFF",
        transformerIncludePrimaryTools: false,
        transformerMaxTools: 32,
        transformerMaxToolChars: 8000,
        transformerTimeoutMs: null,
        transformerMaxAssets: null,
        ...overrides,
      });
      db.discoveredModel.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === transformerId) {
          const row = directRow();
          return {
            ...row,
            id: transformerId,
            upstreamModelId: transformerUpstream,
            Endpoint: {
              ...row.Endpoint,
              id: "transformer-endpoint-id",
              slug: "transformer-endpoint",
              cliDeviceId: "cli-transformer",
            },
          };
        }
        return {
          ...directRow(),
          id: args.where.id,
        };
      });
    }

    it("transforms media then forwards rewritten chat to the pool primary", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
              ],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const transformReq = requireSent(manager, 0);
      expect(transformReq.cliDeviceId).toBe("cli-transformer");
      expect(transformReq.path).toBe("/v1/chat/completions");
      expect(firstBodyChunkText(transformReq)).toContain("data:image/png;base64,abc");
      expect(firstBodyChunkText(transformReq)).toContain(`"stream":false`);
      // Nested transform must not reuse client Idempotency-Key
      const transformHeaders =
        transformReq.headers instanceof Headers
          ? transformReq.headers
          : new Headers(transformReq.headers as Record<string, string>);
      expect(transformHeaders.get("idempotency-key")).toBeNull();

      manager.headers(transformReq.requestId, 200, { "content-type": "application/json" });
      manager.body(
        transformReq.requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "A red button labeled Save." } }],
        }),
      );
      manager.complete(transformReq.requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      const primaryReq = requireSent(manager, 1);
      expect(primaryReq.cliDeviceId).toBe("cli-a");
      const primaryBody = firstBodyChunkText(primaryReq);
      expect(primaryBody).not.toContain("image_url");
      expect(primaryBody).toContain("wmp_media_transform");
      // Plain-text description for the primary model (not base64).
      expect(primaryBody).toContain("A red button labeled Save.");
      expect(primaryBody).toContain("untrusted perception");
      expect(primaryBody).toContain("wmp-media-transform-policy:v1");
      expect(primaryBody).not.toContain('encoding="base64"');

      manager.headers(primaryReq.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primaryReq.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
      manager.complete(primaryReq.requestId);
      expect(response.status).toBe(200);
    });

    it("preserves multi-turn placement: each image stays on its originating message", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "first" },
                { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
              ],
            },
            { role: "assistant", content: "ok" },
            {
              role: "user",
              content: [
                { type: "text", text: "second" },
                { type: "image_url", image_url: { url: "data:image/png;base64,bbb" } },
              ],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      manager.headers(requireSent(manager, 0).requestId, 200, {
        "content-type": "application/json",
      });
      manager.body(
        requireSent(manager, 0).requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "desc-first" } }],
        }),
      );
      manager.complete(requireSent(manager, 0).requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      manager.headers(requireSent(manager, 1).requestId, 200, {
        "content-type": "application/json",
      });
      manager.body(
        requireSent(manager, 1).requestId,
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "desc-second" } }],
        }),
      );
      manager.complete(requireSent(manager, 1).requestId);

      await vi.waitFor(() => expect(manager.sent).toHaveLength(3));
      const primaryBody = JSON.parse(firstBodyChunkText(requireSent(manager, 2))) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMessages = primaryBody.messages.filter((m) => m.role === "user");
      expect(JSON.stringify(userMessages[0])).toContain("desc-first");
      expect(JSON.stringify(userMessages[0])).not.toContain("desc-second");
      expect(JSON.stringify(userMessages[1])).toContain("desc-second");
      expect(JSON.stringify(userMessages[1])).not.toContain("desc-first");
      expect(JSON.stringify(primaryBody)).not.toContain("image_url");

      manager.headers(requireSent(manager, 2).requestId, 200, {
        "content-type": "application/json",
      });
      const response = await responsePromise;
      manager.body(requireSent(manager, 2).requestId, "{}");
      manager.complete(requireSent(manager, 2).requestId);
      expect(response.status).toBe(200);
    });

    it("fails closed when the transformer errors", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
            },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const transformReq = requireSent(manager, 0);
      manager.headers(transformReq.requestId, 500, { "content-type": "application/json" });
      manager.body(transformReq.requestId, JSON.stringify({ error: "boom" }));
      manager.complete(transformReq.requestId);

      const response = await responsePromise;
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(manager.sent).toHaveLength(1);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.objectContaining({ message: expect.stringMatching(/transformer/i) }),
      });
    });

    it("advertises vision on pools only when transformer actually supports it", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.poolMember.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([
        {
          id: poolTarget.id,
          transformerDiscoveredModelId: transformerId,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
        },
      ]);
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: true,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);

      const response = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool = body.data.find((row) => row.id === poolTarget.modelId);
      expect(pool?.supports_vision).toBe(true);

      // Text-only transformer + image toggle should not advertise vision
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: true,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: false },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);
      const response2 = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      const body2 = (await response2.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool2 = body2.data.find((row) => row.id === poolTarget.modelId);
      expect(pool2?.supports_vision).toBe(false);
    });

    it("does not advertise transformer modalities when the transformer is unpublished", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      db.poolMember.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([
        {
          id: poolTarget.id,
          transformerDiscoveredModelId: transformerId,
          transformerImages: true,
          transformerAudio: false,
          transformerVideo: false,
        },
      ]);
      db.discoveredModel.findMany.mockResolvedValue([
        {
          id: transformerId,
          published: false,
          capabilityOverrideMode: "OVERRIDE",
          capabilityOverrideMetadata: {
            version: 1,
            protocol: "openai-compatible",
            chatCompletions: { supported: true, streaming: true, vision: true },
          },
          Endpoint: { published: true, capabilityMetadata: null },
        },
      ]);

      const response = await appWith(new FakeRelayManager()).request("/models", {
        headers: { authorization: "Bearer wsmp_model_test" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ id: string; supports_vision?: boolean }>;
      };
      const pool = body.data.find((row) => row.id === poolTarget.modelId);
      expect(pool?.supports_vision).toBe(false);
    });

    it("does not fail text-only pool requests when the transformer is unpublished", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.discoveredModel.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === transformerId) {
          const row = directRow();
          return {
            ...row,
            id: transformerId,
            published: false,
            upstreamModelId: transformerUpstream,
            Endpoint: {
              ...row.Endpoint,
              id: "transformer-endpoint-id",
              slug: "transformer-endpoint",
              cliDeviceId: "cli-transformer",
              published: true,
            },
          };
        }
        return { ...directRow(), id: args.where.id };
      });
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a", "cli-transformer"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [{ role: "user", content: "plain text only, no media" }],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const primary = requireSent(manager, 0);
      expect(primary.cliDeviceId).toBe("cli-a");
      expect(firstBodyChunkText(primary)).toContain("plain text only");
      manager.headers(primary.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primary.requestId, "{}");
      manager.complete(primary.requestId);
      expect(response.status).toBe(200);
    });

    it("skips retransform when history only has envelopes but still injects policy", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      enablePoolTransformer();
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-transformer", "cli-a"];

      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          messages: [
            {
              role: "user",
              content: `<wmp_media_transform model="x" assets="1">\nold desc\n</wmp_media_transform>`,
            },
            { role: "user", content: "follow up without new media" },
          ],
        }),
      });

      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const primary = requireSent(manager, 0);
      expect(primary.cliDeviceId).toBe("cli-a");
      const body = firstBodyChunkText(primary);
      expect(body).toContain("old desc");
      expect(body).toContain("untrusted perception");
      expect(body).toContain("wmp-media-transform-policy:v1");
      expect(manager.sent).toHaveLength(1);
      manager.headers(primary.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(primary.requestId, "{}");
      manager.complete(primary.requestId);
      expect(response.status).toBe(200);
    });
  });
});
