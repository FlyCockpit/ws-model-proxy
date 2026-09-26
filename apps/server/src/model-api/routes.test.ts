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
import type { PublicProviderTarget } from "./public-overflow.js";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  // The real Prisma namespace (Sql builder, error classes) is needed by the
  // usage-rollup writer; the client itself stays a deep mock.
  const actual = await vi.importActual<typeof import("@ws-model-proxy/db")>("@ws-model-proxy/db");
  return { default: mockDeep(), Prisma: actual.Prisma };
});
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://routes-test", NODE_ENV: "test" },
}));

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
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
  },
}));

// The token's external-provider consent (allowExternal / includeExternal).
// Private only unless a test lists pool ids here.
const externalConsent = vi.hoisted(() => ({ poolIds: [] as string[] }));
vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => {
  const listVisibleModelTargetsForToken = vi.fn();
  return {
    authenticateModelApiTokenSecret: vi.fn(),
    listVisibleModelTargetsForUser: vi.fn(),
    listVisibleModelTargetsForToken,
    // Routes read the visible targets and the token's external consent in one
    // call. Tests keep stubbing the targets through the plain listing.
    listVisibleModelTargetsWithExternalPermissionForToken: vi.fn(async (token: unknown) => ({
      targets: await listVisibleModelTargetsForToken(token),
      externalPoolIds: new Set(externalConsent.poolIds),
    })),
  };
});

const {
  captureProviderResponseBinding,
  chatTestCompletionsHandler,
  createModelApiRoutes,
  localAdmissionWaitBudget,
  resumedLocalWaitBudget,
} = await import("./routes.js");
const { contextCounterRegistry } = await import("./capacity/counter-registry.js");
const { MODEL_API_MAX_REQUEST_BODY_BYTES, ModelApiConcurrencyLimiter, ModelApiLimitError } =
  await import("./limits.js");
const tokenAccess = await import("@ws-model-proxy/api/lib/model-api-token-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const MODEL_API_MAX_ACTIVE_PER_TOKEN = 8;

function stringifyPersistenceCalls(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

type SendRelayRequestArgs = Parameters<RelaySessionManager["sendRelayRequest"]>[0];
type CancelRelayRequestArgs = Parameters<RelaySessionManager["cancelRelayRequest"]>[0];

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
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
    updateMany: MockInstance;
  };
  relayExecutionEvent: { create: MockInstance; createMany: MockInstance };
  relayExecutionAttempt: {
    create: MockInstance;
    findFirst: MockInstance;
    updateMany: MockInstance;
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
  allowExternal: false,
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
  fallbackEnabled: false,
  fallbackForGrantees: false,
  externalMemberCount: 0,
  effectiveProviderEgress: false,
  providerAccountLabels: [],
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
};

/** Owner pool with external fallback on and one external member configured. */
const externalPoolTarget: VisibleModelPoolTarget = {
  ...poolTarget,
  fallbackEnabled: true,
  externalMemberCount: 1,
  effectiveProviderEgress: true,
};

const EXTERNAL_MODEL_ID = `${externalPoolTarget.modelId}:external`;

function listedExternalTargets(
  targets: ReturnType<typeof externalProviderTarget>[],
  overrides: { enabled?: boolean; fallbackForGrantees?: boolean } = {},
) {
  return {
    enabled: overrides.enabled ?? true,
    fallbackForGrantees: overrides.fallbackForGrantees ?? false,
    affinityPolicy: {
      enabled: false,
      ttlSeconds: 3600,
      maxRecords: 10_000,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
    },
    targets,
    coolingDown: [],
  };
}

function directRow({
  id = "model-id",
  upstreamModelId = "gpt-4o-mini",
  cliDeviceId = "cli-device-id",
  connected = true,
  embeddings = true,
  audioTranscriptions = true,
  audioTranslations = true,
  audioSpeech = true,
  responses = true,
  capabilityOverrideMetadata = null,
  endpointCapabilityMetadata,
  optimisticBasicTranscription = false,
  physicalMaxContext,
  countStrategy,
  directContextCeiling,
  directContextMargin = 0,
}: {
  id?: string;
  upstreamModelId?: string;
  cliDeviceId?: string;
  connected?: boolean;
  embeddings?: boolean;
  audioTranscriptions?: boolean;
  audioTranslations?: boolean;
  audioSpeech?: boolean;
  responses?: boolean;
  capabilityOverrideMetadata?: Record<string, unknown> | null;
  endpointCapabilityMetadata?: Record<string, unknown> | null;
  optimisticBasicTranscription?: boolean;
  physicalMaxContext?: number;
  countStrategy?: "TOKENIZER" | "TEMPLATE_AWARE" | "ENGINE_REPORTED" | "CONSERVATIVE_ESTIMATE";
  directContextCeiling?: number;
  directContextMargin?: number;
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
  capacityContextCeilingMode,
  capacityContextCeiling,
  capacityContextMargin = 0,
  poolContextCeiling = null,
  poolContextMargin = 0,
  capacityWaitBudgetMode,
  capacityWaitBudgetMs,
  affinityEnabled = false,
  countStrategy,
  externalAfterWaitMs = 2_000,
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
  capacityContextCeilingMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityContextCeiling?: number;
  capacityContextMargin?: number | null;
  poolContextCeiling?: number | null;
  poolContextMargin?: number;
  capacityWaitBudgetMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  capacityWaitBudgetMs?: number | null;
  affinityEnabled?: boolean;
  countStrategy?: "TOKENIZER" | "TEMPLATE_AWARE" | "ENGINE_REPORTED" | "CONSERVATIVE_ESTIMATE";
  externalAfterWaitMs?: number;
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
    capacityContextCeilingMode,
    capacityContextMargin,
    capacityWaitBudgetMode,
    capacityWaitBudgetMs,
    ModelPool: {
      capacityContextCeiling: poolContextCeiling,
      capacityContextMargin: poolContextMargin,
      capacityWaitBudgetMs: 30_000,
      externalAfterWaitMs,
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
        physicalMaxContext === undefined && !affinityEnabled && countStrategy === undefined
          ? null
          : {
              id: `${id}-capacity`,
              hardConcurrencyLimit: 4,
              physicalMaxContext: physicalMaxContext ?? null,
              countStrategy: countStrategy ?? "CONSERVATIVE_ESTIMATE",
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
  capacityRuntime?: CapacityAdmissionRuntime,
  concurrencyLimiter = new ModelApiConcurrencyLimiter(),
) {
  return createModelApiRoutes({
    manager,
    concurrencyLimiter,
    capacityRuntime,
  });
}

function admittingCapacityRuntime(): CapacityAdmissionRuntime {
  return {
    acquire: vi.fn(async (attempt) => {
      const selected = attempt.candidates[0];
      if (!selected) return { state: "CANCELLED" as const };
      return {
        state: "ADMITTED" as const,
        lease: {
          leaseId: `lease-${selected.poolMemberId ?? selected.executionTargetId}`,
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
}

function requestBody(model = directTarget.modelId) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "secret prompt" }],
  });
}

function externalProviderTarget(poolMemberId = "primary-provider-member") {
  return {
    poolMemberId,
    executionTargetId: `${poolMemberId}-target`,
    inferenceCapacityId: `${poolMemberId}-capacity`,
    capacityWaitBudgetMs: 30_000,
    publicOrder: 0,
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
    nativeSurfaces: ["openai-chat"] as PublicProviderTarget["nativeSurfaces"],
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

describe("X1 local wait budgets", () => {
  it("never lets :external wait less locally in total than the plain name", () => {
    // B = member/pool budget, E = externalAfterWaitMs.
    for (const [budget, external] of [
      [30_000, 2_000],
      [1_000, 2_000],
      [0, 2_000],
      [5_000, 0],
    ] as const) {
      const first = localAdmissionWaitBudget(budget, external);
      const resumed = resumedLocalWaitBudget(budget, external);
      expect(first).toBe(Math.min(budget, external));
      expect((first ?? 0) + (resumed ?? 0)).toBe(budget);
    }
    // No budget: the first wait is E, the resumed wait is unbounded again.
    expect(localAdmissionWaitBudget(null, 2_000)).toBe(2_000);
    expect(resumedLocalWaitBudget(null, 2_000)).toBeNull();
    // E >= B leaves "admit only if free now".
    expect(resumedLocalWaitBudget(1_000, 2_000)).toBe(0);
  });
});

describe("model API routes", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (input: unknown) => {
      if (typeof input === "function") return input(db);
      return Promise.all(input as Promise<unknown>[]);
    });
    db.$queryRaw.mockResolvedValue([{ now: new Date("2026-08-26T00:00:00.000Z") }]);
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
    db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
    db.relayExecutionEvent.create.mockResolvedValue({ id: "relay-event-id" });
    db.relayExecutionEvent.createMany.mockResolvedValue({ count: 1 });
    db.relayExecutionAttempt.create.mockResolvedValue({ attemptId: "attempt-id" });
    db.relayExecutionAttempt.updateMany.mockResolvedValue({ count: 1 });
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
    externalConsent.poolIds = [];
    publicOverflow.list.mockResolvedValue({
      enabled: false,
      fallbackForGrantees: false,
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
      coolingDown: [],
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
    // A plain pool name never inspects external (PUBLIC_OVERFLOW) members.
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "cache hit",
      {
        id: "chatcmpl-cache",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      },
      true,
    ],
    [
      "reported-zero cache read",
      {
        id: "chatcmpl-miss",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
      false,
    ],
    [
      "usage without cache fields",
      { id: "chatcmpl-plain", usage: { prompt_tokens: 10, completion_tokens: 3 } },
      undefined,
    ],
  ] as const)(
    "records engine cache confirmation from relayed usage evidence on %s",
    async (_label, responseBody, engineCacheConfirmed) => {
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
      manager.headers(sent.requestId, 200, { "content-type": "application/json" });
      manager.body(sent.requestId, JSON.stringify(responseBody));
      manager.complete(sent.requestId);
      const response = await responsePromise;
      await response.text();
      await vi.waitFor(() => expect(affinity.remember).toHaveBeenCalledTimes(1));
      expect(affinity.remember.mock.calls[0]?.[0]).toMatchObject({
        target: expect.objectContaining({ executionTargetId: "member-b-target" }),
        engineCacheConfirmed,
      });
    },
  );

  it.each([
    ["cache hit reported in message_start", 7, true],
    ["reported-zero cache read in message_start", 0, false],
  ] as const)(
    "records engine cache confirmation from early Anthropic usage on %s in a >1MB relay stream",
    async (_label, cacheReadInputTokens, engineCacheConfirmed) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [poolTarget],
      });
      const anthropicCapabilities = {
        version: 3,
        protocol: "anthropic-compatible",
        surfaces: {
          anthropicMessages: {
            source: "declared",
            confidence: "exact",
            supported: true,
            streaming: true,
            protocolVersion: "2023-06-01",
          },
        },
      };
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "member-a",
          discoveredModelId: "model-a",
          upstreamModelId: "upstream-a",
          cliDeviceId: "cli-a",
          affinityEnabled: true,
          capabilityOverrideMetadata: anthropicCapabilities,
        }),
        poolMemberRow({
          id: "member-b",
          discoveredModelId: "model-b",
          upstreamModelId: "upstream-b",
          cliDeviceId: "cli-b",
          affinityEnabled: true,
          capabilityOverrideMetadata: anthropicCapabilities,
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
      const responsePromise = appWith(manager).request("/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: poolTarget.modelId,
          max_tokens: 32,
          messages: [{ role: "user", content: "secret prompt" }],
        }),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
      // The early message_start event carries the cache evidence, then more
      // than 1MB of content deltas pushes it out of the bounded tail window
      // so only the retained prefix can still witness it.
      const padding = "x".repeat(64 * 1024);
      manager.body(
        sent.requestId,
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":${cacheReadInputTokens}}}}\n\n`,
      );
      for (let index = 0; index < 20; index += 1) {
        manager.body(
          sent.requestId,
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${padding}"}}\n\n`,
        );
      }
      manager.body(
        sent.requestId,
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
      manager.complete(sent.requestId);
      const response = await responsePromise;
      await response.text();
      await vi.waitFor(() => expect(affinity.remember).toHaveBeenCalledTimes(1));
      expect(affinity.remember.mock.calls[0]?.[0]).toMatchObject({
        target: expect.objectContaining({ executionTargetId: "member-b-target" }),
        // Tail-only capture would drop message_start and derive undefined.
        engineCacheConfirmed,
      });
    },
  );

  it("does not serve the legacy completions route", async () => {
    const response = await appWith(new FakeRelayManager()).request("/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({ model: poolTarget.modelId, prompt: "secret prompt" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("names streaming when an adapted Anthropic stream has no initial usage", async () => {
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
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(JSON.parse(await relayBodyText(sent))).toMatchObject({ stream: true });
    const chunk = (value: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-ping",
        object: "chat.completion.chunk",
        created: 0,
        model: "upstream-chat",
        ...value,
      })}\n\n`;
    manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
    manager.body(
      sent.requestId,
      chunk({
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      }),
    );
    const response = await responsePromise;
    manager.body(
      sent.requestId,
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
    manager.body(
      sent.requestId,
      chunk({
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      }),
    );
    manager.body(sent.requestId, "data: [DONE]\n\n");
    manager.complete(sent.requestId);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("Streaming is unavailable for this target.");
    expect(text).toContain("event: message_start");
    expect(text).toContain('"usage":{"input_tokens":1,"output_tokens":0}');
    expect(text).toContain(
      '"delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":9,"output_tokens":3}',
    );
  });

  it.each([
    {
      route: "/responses",
      body: { stream: true, input: "ping" },
      usage: '"usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}',
    },
    {
      route: "/messages",
      body: { max_tokens: 8, stream: true, messages: [{ role: "user", content: "ping" }] },
      usage:
        '"delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":9,"output_tokens":3}',
    },
  ])(
    "serves $route from a llama.cpp Chat member whose finish chunk carries usage",
    async ({ route, body, usage }) => {
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
      const responsePromise = appWith(manager).request(route, {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          ...(route === "/messages" ? { "anthropic-version": "2023-06-01" } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: poolTarget.modelId, ...body }),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      expect(sent.path).toBe("/v1/chat/completions");
      expect(JSON.parse(await relayBodyText(sent))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunk = (value: Record<string, unknown>) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-llama",
          object: "chat.completion.chunk",
          created: 0,
          model: "upstream-chat",
          ...value,
        })}\n\n`;
      manager.headers(sent.requestId, 200, { "content-type": "text/event-stream" });
      manager.body(
        sent.requestId,
        chunk({
          choices: [
            { index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
          ],
        }),
      );
      const response = await responsePromise;
      manager.body(
        sent.requestId,
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
          timings: { prompt_n: 9, predicted_n: 3 },
        }),
      );
      manager.body(sent.requestId, "data: [DONE]\n\n");
      manager.complete(sent.requestId);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("event: error");
      expect(text.split(usage)).toHaveLength(2);
      await vi.waitFor(() =>
        expect(db.relayRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "SUCCEEDED" }),
          }),
        ),
      );
      expect(db.relayRequest.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorClass: "protocol_error" }),
        }),
      );
    },
  );

  it("adapts Claude Code top_k onto a CLI Chat member and drops cache metadata", async () => {
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
              tools: true,
            },
          },
          sampling: { parameters: ["top_k"] },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-chat"];
    const responsePromise = appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        max_tokens: 32,
        top_k: 40,
        metadata: { user_id: "placeholder-metadata" },
        thinking: { type: "disabled" },
        tools: [
          {
            name: "placeholder_tool",
            cache_control: { type: "ephemeral" },
            input_schema: { type: "object" },
          },
        ],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_placeholder",
                name: "placeholder_tool",
                input: {},
                cache_control: { type: "ephemeral" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_placeholder",
                content: [
                  { type: "text", text: "placeholder-result-a" },
                  { type: "text", text: "placeholder-result-b" },
                ],
              },
            ],
          },
        ],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("chat.completions");
    const upstream = JSON.parse(await relayBodyText(sent)) as {
      top_k?: number;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(upstream.top_k).toBe(40);
    expect(JSON.stringify(upstream)).not.toContain("cache_control");
    expect(JSON.stringify(upstream)).not.toContain("placeholder-metadata");
    expect(upstream.messages?.some((message) => message.role === "tool")).toBe(true);
    expect(upstream.messages?.find((message) => message.role === "tool")?.content).toBe(
      "placeholder-result-a\nplaceholder-result-b",
    );
    await completeJsonRelay({
      manager,
      requestId: sent.requestId,
      body: {
        id: "chat_1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await response.text();
  });

  it("does not dispatch top_k to a Responses-only member or enabled thinking without reasoning", async () => {
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
              tools: true,
            },
          },
        },
      }),
    ]);
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-responses"];
    const responses = await appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        max_tokens: 16,
        top_k: 40,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "placeholder-user" }],
      }),
    });
    expect(responses.status).toBe(400);
    expect(manager.sent).toEqual([]);
    await responses.text();

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
            },
          },
        },
      }),
    ]);
    const thinking = await appWith(manager).request("/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: poolTarget.modelId,
        max_tokens: 64,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "placeholder-user" }],
      }),
    });
    expect(thinking.status).toBe(400);
    expect(manager.sent).toEqual([]);
    await thinking.text();
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestedSurface: "OPENAI_CHAT_COMPLETIONS" }),
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          selectedExecutionTargetId: "responses-member-target",
          selectedPoolMemberId: "responses-member",
          selectedPoolMemberTier: "PRIMARY",
          selectedNativeSurface: "OPENAI_RESPONSES",
          adapterMode: "ADAPTED",
          adapterVersion: "1.0.0",
          localAttemptId: sent.requestId,
        }),
      }),
    );
    const persisted = stringifyPersistenceCalls([
      db.relayRequest.create.mock.calls,
      db.relayRequest.update.mock.calls,
      db.relayExecutionEvent.create.mock.calls,
      db.relayExecutionEvent.createMany.mock.calls,
    ]);
    expect(persisted).not.toContain("hello");
    expect(persisted).not.toContain("upstream-responses");
    await vi.waitFor(() => {
      const eventTypes = [
        ...db.relayExecutionEvent.create.mock.calls.map((call) => call[0]?.data?.eventType),
        ...db.relayExecutionEvent.createMany.mock.calls.flatMap((call) =>
          call[0]?.data?.map((event: { eventType: string }) => event.eventType),
        ),
      ];
      expect(eventTypes).toEqual(
        expect.arrayContaining(["ATTEMPT_STARTED", "FIRST_CLIENT_BYTE", "TERMINAL"]),
      );
    });
    expect(db.relayExecutionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptId: sent.requestId,
          requestedSurface: "OPENAI_CHAT_COMPLETIONS",
          nativeSurface: "OPENAI_RESPONSES",
          adapterMode: "ADAPTED",
          adapterVersion: "1.0.0",
          poolId: "pool-id",
          poolMemberId: "responses-member",
          executionTargetId: "responses-member-target",
          memberTier: "PRIMARY",
        }),
      }),
    );
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          completedAt: expect.any(Date),
          durationMs: expect.any(Number),
        }),
      }),
    );
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
    const response = await appWith(manager).request("/chat/completions", {
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

  it("surfaces developer authority loss when Chat adapts through Anthropic", async () => {
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
          protocol: "anthropic-compatible",
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
    const responsePromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: poolTarget.modelId,
        messages: [
          { role: "developer", content: "policy" },
          { role: "user", content: "hello" },
        ],
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    expect(sent.family).toBe("messages");
    expect(JSON.parse(await relayBodyText(sent))).toMatchObject({
      system: [{ type: "text", text: "policy" }],
      messages: [{ role: "user" }],
    });
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(
      sent.requestId,
      JSON.stringify({
        id: "msg",
        type: "message",
        role: "assistant",
        model: "claude-upstream",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    );
    manager.complete(sent.requestId);
    const response = await responsePromise;
    expect(response.headers.get("x-wsmp-adapter-limitations")).toBe(
      "strict_common_subset,anthropic_instruction_authority_collapse",
    );
    await response.text();
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager, capacityRuntime).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/responses", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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
    const responsePromise = appWith(manager).request("/chat/completions", {
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

  function externalMemberListRow(poolId: string) {
    return {
      poolId,
      tier: "PUBLIC_OVERFLOW",
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
    };
  }

  function localMemberListRow(poolId: string) {
    return {
      poolId,
      tier: "PRIMARY",
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
    };
  }

  type ListedModel = {
    id: string;
    supports_vision: boolean;
    supports_audio_input: boolean;
    supports_video_input: boolean;
  };

  async function listedModels() {
    const response = await appWith(new FakeRelayManager()).request("/models", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: ListedModel[] }).data;
  }

  it("lists owner/pool:external only for tokens that can be served that way", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([
      localMemberListRow(externalPoolTarget.id),
      externalMemberListRow(externalPoolTarget.id),
    ]);

    // Private-only token: the plain name only.
    expect((await listedModels()).map((entry) => entry.id)).toEqual([externalPoolTarget.modelId]);

    externalConsent.poolIds = [externalPoolTarget.id];
    const listed = await listedModels();
    expect(listed.map((entry) => entry.id)).toEqual([
      externalPoolTarget.modelId,
      EXTERNAL_MODEL_ID,
    ]);
    // Both entries advertise the LOCAL pool's capabilities, never provider
    // labels or upstream ids.
    for (const entry of listed)
      expect(entry).toMatchObject({
        supports_video_input: true,
        supports_vision: false,
        supports_audio_input: false,
      });
    expect(JSON.stringify(listed)).not.toContain("provider");

    // A grantee is listed only when the owner pays for grantees.
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [{ ...externalPoolTarget, ownerUserId: "pool-owner-id", accessGrantId: "grant" }],
    });
    expect((await listedModels()).map((entry) => entry.id)).toEqual([externalPoolTarget.modelId]);
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [
        {
          ...externalPoolTarget,
          ownerUserId: "pool-owner-id",
          accessGrantId: "grant",
          fallbackForGrantees: true,
        },
      ],
    });
    expect((await listedModels()).map((entry) => entry.id)).toEqual([
      externalPoolTarget.modelId,
      EXTERNAL_MODEL_ID,
    ]);
  });

  it("lists a provider-only pool only as :external with its external capabilities", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.poolMember.findMany.mockResolvedValue([externalMemberListRow(externalPoolTarget.id)]);

    const listed = await listedModels();
    expect(listed.map((entry) => entry.id)).toEqual([EXTERNAL_MODEL_ID]);
    expect(listed[0]).toMatchObject({ supports_vision: true, supports_audio_input: true });
  });

  it("hides :external names and answers them with 403 when the deployment switch is off", async () => {
    const { env } = await import("@ws-model-proxy/env/server");
    const mutableEnv = env as { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: boolean };
    mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
    try {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [externalPoolTarget],
      });
      externalConsent.poolIds = [externalPoolTarget.id];
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.poolMember.findMany.mockResolvedValue([
        localMemberListRow(externalPoolTarget.id),
        externalMemberListRow(externalPoolTarget.id),
      ]);
      expect((await listedModels()).map((entry) => entry.id)).toEqual([externalPoolTarget.modelId]);

      const chat = await appWith(new FakeRelayManager()).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });
      expect(chat.status).toBe(403);
      const chatBody = (await chat.json()) as { error: { code: string; message: string } };
      expect(chatBody.error.code).toBe("external_providers_disabled");
      expect(chatBody.error.message).toContain(`"${externalPoolTarget.modelId}"`);

      const messages = await appWith(new FakeRelayManager()).request("/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: EXTERNAL_MODEL_ID, max_tokens: 8, messages: [] }),
      });
      expect(messages.status).toBe(403);
      await expect(messages.json()).resolves.toMatchObject({
        type: "error",
        error: { type: "permission_error" },
      });
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    } finally {
      mutableEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    }
  });

  it.each([
    ["an unknown variant", `${poolTarget.modelId}:fallback`],
    ["an uppercase variant", `${poolTarget.modelId}:EXTERNAL`],
    ["a stacked variant", `${poolTarget.modelId}:external:external`],
    ["a suffix on a direct model id", `${directTarget.modelId}:external`],
  ])("answers %s with a clear 404 model_not_found", async (_label, model) => {
    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(model),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).not.toBe("Model not found.");
    expect(db.relayRequest.create).not.toHaveBeenCalled();
  });

  it("does not reveal whether an invisible pool exists for a suffixed name", async () => {
    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody("someone-else/private-pool:external"),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found", message: "Model not found." },
    });
  });

  it.each([
    ["/embeddings", { input: "hello" }],
    ["/audio/speech", { input: "hello", voice: "alloy" }],
  ])("rejects :external on %s with external_variant_unsupported", async (path, extra) => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    const response = await appWith(new FakeRelayManager()).request(path, {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({ model: EXTERNAL_MODEL_ID, ...extra }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "external_variant_unsupported" },
    });
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
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

  describe("usage rollups (exactly once per terminal transition)", () => {
    function rollupRow(data: Record<string, unknown>) {
      return {
        id: "relay-request-id",
        userId: token.userId,
        status: data.status,
        source: "API_TOKEN",
        startedAt: new Date("2026-08-26T00:00:00.000Z"),
        completedAt: data.completedAt ?? new Date("2026-08-26T00:00:01.000Z"),
        durationMs: data.durationMs ?? 1000,
        firstClientByteAt: null,
        requestedModelPoolId: null,
        selectedPoolMemberId: null,
        requestedExecutionTargetId: "execution-target-id",
        selectedExecutionTargetId: "execution-target-id",
        attemptCount: 1,
        promptTokens: data.promptTokens ?? null,
        completionTokens: data.completionTokens ?? null,
        cacheReadTokens: data.cacheReadTokens ?? null,
        cacheWriteTokens: data.cacheWriteTokens ?? null,
        usageKnown: data.usageKnown ?? false,
      };
    }

    function rollupStatements() {
      return db.$executeRaw.mock.calls.filter(([sql]) =>
        String((sql as { sql?: string }).sql ?? "").includes("usage_rollup_minute"),
      );
    }

    async function relayDirectSuccess(manager: FakeRelayManager, body: unknown) {
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
      manager.headers(sent.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(sent.requestId, JSON.stringify(body));
      manager.complete(sent.requestId);
      await response.arrayBuffer();
      return response;
    }

    it("parses usage server-side and writes one rollup increment in the terminal transaction", async () => {
      db.$executeRaw.mockResolvedValue(1);
      db.relayRequest.update.mockImplementation(
        async (args: { where: { status?: string }; data: Record<string, unknown> }) =>
          args.where.status === "PENDING" ? rollupRow(args.data) : { id: "relay-request-id" },
      );
      const manager = new FakeRelayManager();
      const response = await relayDirectSuccess(manager, {
        id: "chatcmpl",
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 7,
          total_tokens: 127,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(rollupStatements()).toHaveLength(1));
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "relay-request-id", status: "PENDING" },
          data: expect.objectContaining({
            status: "SUCCEEDED",
            promptTokens: 120,
            completionTokens: 7,
            cacheReadTokens: 100,
            usageKnown: true,
          }),
        }),
      );
      expect(db.relayRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ source: "API_TOKEN" }) }),
      );
      // The increment and the transition share one transaction.
      const transitionTx = db.$transaction.mock.calls.length;
      expect(transitionTx).toBeGreaterThan(0);
    });

    it("writes no increment when another finalizer already moved the request out of PENDING", async () => {
      const { Prisma } = await import("@ws-model-proxy/db");
      db.$executeRaw.mockResolvedValue(1);
      db.relayRequest.update.mockImplementation(async (args: { where: { status?: string } }) => {
        if (args.where.status === "PENDING")
          throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
            code: "P2025",
            clientVersion: "test",
          });
        return { id: "relay-request-id" };
      });
      const manager = new FakeRelayManager();
      const response = await relayDirectSuccess(manager, { id: "chatcmpl", choices: [] });
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(db.relayRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "relay-request-id", status: "PENDING" } }),
        ),
      );
      expect(rollupStatements()).toHaveLength(0);
    });

    it("finalizes a pool request whose member attempt ends non-retryably (client abort before headers) exactly once as CANCELED", async () => {
      // Stateful attempt rows: the ACTIVE -> terminal claim succeeds once per
      // attempt, like the real guarded updateMany.
      const attemptStates = new Map<string, string>();
      db.relayExecutionAttempt.create.mockImplementation(
        async (args: { data: { attemptId: string } }) => {
          attemptStates.set(args.data.attemptId, "ACTIVE");
          return { attemptId: args.data.attemptId };
        },
      );
      db.relayExecutionAttempt.updateMany.mockImplementation(
        async (args: {
          where: { attemptId?: string | { in: string[] }; state?: string };
          data: { state?: string };
        }) => {
          const attemptId = args.where.attemptId;
          if (typeof attemptId !== "string") return { count: 0 };
          if (attemptStates.get(attemptId) !== args.where.state) return { count: 0 };
          if (args.data.state) attemptStates.set(attemptId, args.data.state);
          return { count: 1 };
        },
      );
      let requestStatus = "PENDING";
      db.$executeRaw.mockResolvedValue(1);
      db.relayRequest.update.mockImplementation(
        async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
          if (args.where.status !== "PENDING") return { id: "relay-request-id" };
          if (requestStatus !== "PENDING") {
            const { Prisma } = await import("@ws-model-proxy/db");
            throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
              code: "P2025",
              clientVersion: "test",
            });
          }
          requestStatus = String(args.data.status);
          return {
            ...rollupRow(args.data),
            requestedModelPoolId: "pool-id",
            selectedPoolMemberId: "member-a",
          };
        },
      );
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
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a"];
      const controller = new AbortController();
      const responsePromise = appWith(manager).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(poolTarget.modelId),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      controller.abort();
      await Promise.resolve(responsePromise).catch(() => undefined);

      await vi.waitFor(() => expect(requestStatus).toBe("CANCELED"));
      await vi.waitFor(() => expect(rollupStatements()).toHaveLength(1));
      const [statement] = rollupStatements()[0] as [{ sql: string; values: unknown[] }];
      // VALUES order: bucketStart, ownerUserId, requesterUserId, poolId,
      // poolMemberId, executionTargetId, source, requests, successes, errors,
      // cancels, ...
      const values = statement.values;
      expect(values.slice(3, 5)).toEqual(["pool-id", "member-a"]);
      expect(values.slice(7, 11)).toEqual([1, 0, 0, 1]);
      // One attempt row, claimed once, with its TERMINAL event.
      expect([...attemptStates.values()]).toEqual(["CANCELED"]);
      expect(db.relayExecutionEvent.createMany).toHaveBeenCalledTimes(1);
    });

    /**
     * Stateful finalization mocks: the attempt claim (ACTIVE -> terminal)
     * succeeds once per attempt row and the request transition once per
     * request, like the real guarded writes. Every claim/transition attempt
     * is recorded so tests can count claimants.
     */
    function statefulFinalization({ poolId }: { poolId?: string } = {}) {
      const attemptStates = new Map<string, string>();
      const attemptClaims: string[] = [];
      const transitions: Array<Record<string, unknown>> = [];
      let requestStatus = "PENDING";
      db.relayExecutionAttempt.create.mockImplementation(
        async (args: { data: { attemptId: string } }) => {
          attemptStates.set(args.data.attemptId, "ACTIVE");
          return { attemptId: args.data.attemptId };
        },
      );
      db.relayExecutionAttempt.updateMany.mockImplementation(
        async (args: {
          where: { attemptId?: string | { in: string[] }; state?: string };
          data: { state?: string };
        }) => {
          const attemptId = args.where.attemptId;
          if (typeof attemptId !== "string") return { count: 0 };
          // Terminal claims only (they set a terminal state); first-byte
          // stamps and heartbeats are not claimants.
          if (args.data.state && args.data.state !== "ACTIVE") attemptClaims.push(attemptId);
          if (attemptStates.get(attemptId) !== args.where.state) return { count: 0 };
          if (args.data.state) attemptStates.set(attemptId, args.data.state);
          return { count: 1 };
        },
      );
      db.$executeRaw.mockResolvedValue(1);
      db.relayRequest.update.mockImplementation(
        async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
          if (args.where.status !== "PENDING") return { id: "relay-request-id" };
          transitions.push(args.data);
          if (requestStatus !== "PENDING") {
            const { Prisma } = await import("@ws-model-proxy/db");
            throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
              code: "P2025",
              clientVersion: "test",
            });
          }
          requestStatus = String(args.data.status);
          return {
            ...rollupRow(args.data),
            ...(poolId
              ? {
                  requestedModelPoolId: poolId,
                  selectedPoolMemberId: args.data.selectedPoolMemberId ?? null,
                }
              : {}),
          };
        },
      );
      return { attemptStates, attemptClaims, transitions, status: () => requestStatus };
    }

    it("records the original completion time when finalization only commits on a registry retry", async () => {
      const recovery = await import("./relay-telemetry-recovery.js");
      recovery.resetLocalRelayAttemptRegistryForTests();
      const t0 = new Date("2026-09-24T10:00:30.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(t0);
      try {
        // The DB clock follows the (fake) wall clock, so a finalizer that read
        // it at retry time would record the late time.
        db.$queryRaw.mockImplementation(async () => [{ now: new Date() }]);
        const { transitions } = statefulFinalization();
        const pendingUpdate = db.relayRequest.update.getMockImplementation()!;
        let failFirst = true;
        db.relayRequest.update.mockImplementation(
          async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
            if (args.where.status === "PENDING" && failFirst) {
              failFirst = false;
              transitions.push(args.data);
              throw new Error("database unavailable");
            }
            return pendingUpdate(args);
          },
        );
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const manager = new FakeRelayManager();
        const response = await relayDirectSuccess(manager, {
          id: "chatcmpl",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        });
        expect(response.status).toBe(200);
        await vi.waitFor(() => expect(transitions).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(transitions).toHaveLength(1);

        // Ten minutes later (within the in-flight deadline) the registry
        // retry commits.
        const retryAt = new Date(t0.getTime() + 10 * 60 * 1000);
        vi.setSystemTime(retryAt);
        await expect(
          recovery.retryDeferredLocalAttemptFinalizations(retryAt.getTime()),
        ).resolves.toBe(1);

        expect(transitions).toHaveLength(2);
        const [first, committed] = transitions as [
          Record<string, unknown>,
          Record<string, unknown>,
        ];
        expect(committed.status).toBe("SUCCEEDED");
        expect(committed.completedAt).toEqual(first.completedAt);
        expect((committed.completedAt as Date).getTime()).toBeLessThan(t0.getTime() + 60_000);
        expect(committed.durationMs).toBe(first.durationMs);
        expect(committed.durationMs as number).toBeLessThan(60_000);
        expect(committed).toMatchObject({
          promptTokens: 12,
          completionTokens: 3,
          usageKnown: true,
        });
        // The rollup lands in the original minute bucket, not the retry's.
        const [statement] = rollupStatements().at(-1) as [{ values: unknown[] }];
        expect((statement.values[0] as Date).toISOString()).toBe("2026-09-24T10:00:00.000Z");
      } finally {
        vi.useRealTimers();
        recovery.resetLocalRelayAttemptRegistryForTests();
      }
    });

    it("keeps one claimant and records the served error when holding the direct response throws", async () => {
      const { attemptClaims, transitions } = statefulFinalization();
      const capacityRuntime = admittingCapacityRuntime();
      capacityRuntime.hold = vi.fn(() => {
        throw new Error("capacity hold failed");
      });
      const manager = new FakeRelayManager();
      const responsePromise = appWith(manager, capacityRuntime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const sent = requireSent(manager);
      manager.headers(sent.requestId, 200, { "content-type": "application/json" });
      manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
      manager.complete(sent.requestId);
      const response = await responsePromise;

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(capacityRuntime.hold).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(transitions).toHaveLength(1));
      // Let any (incorrectly) scheduled finalizer run before counting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ status: "FAILED" });
      expect(attemptClaims.filter((id) => id === sent.requestId)).toHaveLength(1);
      expect(rollupStatements()).toHaveLength(1);
    });

    it("records the attempt that served the client when holding a pool member's response throws and the pool retries", async () => {
      const { attemptStates, attemptClaims, transitions } = statefulFinalization({
        poolId: "pool-id",
      });
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
        }),
        poolMemberRow({
          id: "member-b",
          discoveredModelId: "model-b",
          upstreamModelId: "upstream-b",
          cliDeviceId: "cli-b",
        }),
      ]);
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-a", "cli-b"];
      const capacityRuntime = admittingCapacityRuntime();
      let holds = 0;
      capacityRuntime.hold = vi.fn((heldResponse: Response) => {
        holds += 1;
        if (holds > 1) return heldResponse;
        // The first member's transport fails (a retryable member failure)
        // and holding its response throws: the pool must move on.
        manager.error(manager.sent[0]!.requestId, "transport");
        throw new Error("capacity hold failed");
      });
      const responsePromise = appWith(manager, capacityRuntime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(poolTarget.modelId),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      const first = manager.sent[0]!;
      manager.headers(first.requestId, 200, { "content-type": "application/json" });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(2));
      const second = manager.sent[1]!;
      manager.headers(second.requestId, 200, { "content-type": "application/json" });
      const response = await responsePromise;
      manager.body(second.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
      manager.complete(second.requestId);
      await response.arrayBuffer();

      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(transitions).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // One request transition, by the attempt that served the client.
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        status: "SUCCEEDED",
        selectedDiscoveredModelId: second.cliDeviceId === "cli-b" ? "model-b" : "model-a",
        attemptCount: 2,
      });
      expect(second.cliDeviceId).not.toBe(first.cliDeviceId);
      // Each attempt row claimed exactly once: the first as FAILED only.
      expect(attemptClaims.filter((id) => id === first.requestId)).toHaveLength(1);
      expect(attemptClaims.filter((id) => id === second.requestId)).toHaveLength(1);
      expect(attemptStates.get(first.requestId)).toBe("FAILED");
      expect(attemptStates.get(second.requestId)).toBe("SUCCEEDED");
      expect(rollupStatements()).toHaveLength(1);
    });

    it("finalizes early failures through the same guarded transition", async () => {
      db.$executeRaw.mockResolvedValue(1);
      db.relayRequest.update.mockImplementation(
        async (args: { where: { status?: string }; data: Record<string, unknown> }) =>
          args.where.status === "PENDING" ? rollupRow(args.data) : { id: "relay-request-id" },
      );
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [directTarget],
        modelPools: [],
      });
      db.discoveredModel.findUnique.mockResolvedValue(null);
      const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "content-type": "application/json",
        },
        body: requestBody(),
      });
      expect(response.status).toBe(404);
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "relay-request-id", status: "PENDING" },
          data: expect.objectContaining({ status: "FAILED", errorClass: "not_found" }),
        }),
      );
      expect(rollupStatements()).toHaveLength(1);
    });
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

  it("routes v3 OpenAI Chat and Responses surfaces", async () => {
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
      error: { type: "request_too_large", message: "Model API request body is too large." },
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
      error: { type: "request_too_large", message: "Model API request body is too large." },
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
        capacityRuntime: undefined,
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
        capacityRuntime: undefined,
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
          message: "Too many active model API requests.",
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
        embeddings: false,
        audioTranslations: false,
        audioSpeech: false,
        responses: false,
        capabilityOverrideMetadata: overrideCapabilities,
      }),
    );

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

  function externalDispatchResult(
    target: ReturnType<typeof externalProviderTarget>,
    body: unknown = { id: "external", model: target.upstreamModelId },
  ) {
    return {
      dispatched: true,
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target,
      attemptId: `${target.poolMemberId}-attempt`,
      fencingToken: 1n,
      nativeSurface: "openai-chat",
      attemptCount: 1,
      terminal: Promise.resolve({
        ok: true,
        responseBytes: 17,
        usage: { inputTokens: 5n, outputTokens: 3n, cacheReadTokens: 15n },
      }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    };
  }

  // R1-A: a grantee's consent carries the exact grant the request was
  // resolved under, which the send claim requires to still exist.
  it("binds a grantee's :external consent to the grant the request was resolved under", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [
        {
          ...externalPoolTarget,
          ownerUserId: "pool-owner-id",
          accessGrantId: "grant",
          fallbackForGrantees: true,
        },
      ],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const provider = externalProviderTarget("overflow-member");
    publicOverflow.list.mockResolvedValue(
      listedExternalTargets([provider], { fallbackForGrantees: true }),
    );
    publicOverflow.dispatch.mockResolvedValueOnce(externalDispatchResult(provider));

    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );

    expect(response.status).toBe(200);
    expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
      affinityAccessGrantId: "grant",
      externalConsent: expect.objectContaining({ requesterIsOwner: false, accessGrantId: "grant" }),
    });
  });

  it("serves an owner's :external request from external fallback with route headers", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const provider = externalProviderTarget("overflow-member");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([provider]));
    publicOverflow.dispatch.mockResolvedValueOnce(externalDispatchResult(provider));

    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-route")).toBe("pool-external");
    expect(response.headers.get("x-wsmp-fallback-reason")).toBe("no_local_member");
    expect(response.headers.get("x-wsmp-served-model")).toBe("provider-upstream");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-wsmp-route");
    await expect(response.json()).resolves.toMatchObject({ model: "provider-upstream" });
    expect(publicOverflow.list).toHaveBeenCalledWith("user-id", "pool-id");
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = publicOverflow.dispatch.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      poolId: "pool-id",
      userId: "user-id",
      reason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
      externalConsent: expect.objectContaining({ poolId: "pool-id", requesterIsOwner: true }),
    });
    expect(db.relayRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicEgress: true,
          fallbackRoute: "pool-external",
          publicOverflowReason: "NO_COMPATIBLE_HEALTHY_PRIMARY",
          selectedPoolMemberTier: "PUBLIC_OVERFLOW",
        }),
      }),
    );
    // M2: the route is unknown when the request row is created.
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fallbackRoute: null }) }),
    );
    expect(dispatched).toMatchObject({
      requesterUserId: "user-id",
      requesterModelApiTokenId: "token-id",
    });
    // Provider terminal: the same status-guarded transition, with the usage
    // that settled billing mapped to prompt-free facts.
    await vi.waitFor(() =>
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "relay-request-id", status: "PENDING" },
          data: expect.objectContaining({
            status: "SUCCEEDED",
            promptTokens: 20,
            completionTokens: 3,
            cacheReadTokens: 15,
            usageKnown: true,
          }),
        }),
      ),
    );
  });

  it.each([
    ["the plain name", () => requestBody(externalPoolTarget.modelId), [externalPoolTarget.id]],
    ["a token without external consent", () => requestBody(EXTERNAL_MODEL_ID), [] as string[]],
  ])("never lists or dispatches external members for %s", async (_label, body, consentPoolIds) => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = consentPoolIds;
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
      }),
    ]);
    publicOverflow.list.mockResolvedValue(listedExternalTargets([externalProviderTarget()]));
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire: vi.fn(async () => ({ state: "EXPIRED" as const })),
      release: vi.fn(async () => true),
      hold: vi.fn((response) => response),
    };
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const response = await appWith(manager, capacityRuntime).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: body(),
    });

    expect([403, 429]).toContain(response.status);
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    expect(manager.sent).toHaveLength(0);
  });

  it("answers a provider-only pool's plain name with external_required", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    publicOverflow.list.mockResolvedValue(listedExternalTargets([externalProviderTarget()]));

    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(externalPoolTarget.modelId),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("external_required");
    expect(body.error.message).toContain(EXTERNAL_MODEL_ID);
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["the plain name", () => externalPoolTarget.modelId],
    [":external", () => EXTERNAL_MODEL_ID],
  ])(
    "explains that token counting needs local members on a provider-only pool (%s)",
    async (label, model) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [externalPoolTarget],
      });
      externalConsent.poolIds = [externalPoolTarget.id];
      db.poolMember.findMany.mockResolvedValue([]);

      const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
        "/responses/count_tokens",
        {
          method: "POST",
          headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
          body: JSON.stringify({ model: model(), input: "count me" }),
        },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("local_members_required");
      // Never tells the caller to use the name it already sent.
      expect(body.error.message).not.toContain(`Use "${EXTERNAL_MODEL_ID}"`);
      if (label === ":external") expect(body.error.message).toContain("is counted as");
      expect(publicOverflow.list).not.toHaveBeenCalled();
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    },
  );

  it("fails provider-backed routing closed when durable global capacity is unavailable", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    publicOverflow.list.mockResolvedValue(listedExternalTargets([externalProviderTarget()]));

    const response = await appWith(new FakeRelayManager()).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(EXTERNAL_MODEL_ID),
    });

    // X1: a provider-only pool never answers 400 for a transient condition;
    // without durable capacity nothing can be dispatched (503 + header).
    expect(response.status).toBe(503);
    expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "external_unavailable" },
    });
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it("re-admits remaining external members after a retry-safe precommit failure", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const first = externalProviderTarget("overflow-a");
    const second = externalProviderTarget("overflow-b");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([first, second]));
    publicOverflow.dispatch
      .mockResolvedValueOnce({ dispatched: false, reason: "PROVIDER_UNAVAILABLE" })
      .mockResolvedValueOnce(externalDispatchResult(second, { id: "secondary" }));
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

    const response = await appWith(new FakeRelayManager(), capacityRuntime).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
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

  it("ends the external phase on a send-boundary consent denial without trying other members", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const first = externalProviderTarget("overflow-a");
    const second = externalProviderTarget("overflow-b");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([first, second]));
    // The dispatcher's send-claim transaction found the token's consent gone.
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: false,
      reason: "CALLER_CONSENT_WITHDRAWN",
    });
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
    const limiter = new ModelApiConcurrencyLimiter();
    const callerReleases = vi.fn();
    const acquireGlobal = limiter.acquireGlobal.bind(limiter);
    vi.spyOn(limiter, "acquireGlobal").mockImplementation((identity) => {
      const lease = acquireGlobal(identity);
      return {
        release: () => {
          callerReleases();
          lease.release();
        },
      };
    });

    const response = await appWith(new FakeRelayManager(), capacityRuntime, limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "external_unavailable" },
    });
    expect(publicOverflow.dispatch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ poolMemberId: "overflow-a" }));
    expect(callerReleases).toHaveBeenCalledTimes(1);
  });

  it("releases an admitted external lease and the caller lease when dispatch rejects", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const first = externalProviderTarget("overflow-a");
    const second = externalProviderTarget("overflow-b");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([first, second]));
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
    const limiter = new ModelApiConcurrencyLimiter();
    const callerReleases = vi.fn();
    const acquireGlobal = limiter.acquireGlobal.bind(limiter);
    vi.spyOn(limiter, "acquireGlobal").mockImplementation((identity) => {
      const lease = acquireGlobal(identity);
      return {
        release: () => {
          callerReleases();
          lease.release();
        },
      };
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await appWith(new FakeRelayManager(), capacityRuntime, limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
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
    expect(callerReleases).toHaveBeenCalledTimes(1);
  });

  it("serves a grantee locally with x-wsmp-fallback: unavailable when the owner does not pay", async () => {
    const grantedPoolTarget: VisibleModelPoolTarget = {
      ...externalPoolTarget,
      ownerUserId: "pool-owner-id",
      accessGrantId: "grant-id",
      fallbackForGrantees: false,
    };
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [grantedPoolTarget],
    });
    externalConsent.poolIds = [grantedPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
      }),
    ]);
    const capacityRuntime = admittingCapacityRuntime();
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const responsePromise = appWith(manager, capacityRuntime).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(`${grantedPoolTarget.modelId}:external`),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    await completeJsonRelay({ manager, requestId: requireSent(manager).requestId });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-route")).toBe("local");
    expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
    // A grantee's plan has no external route, so the local wait is the
    // member/pool budget, never the external deadline.
    expect(capacityRuntime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({ poolMemberId: "local-primary", waitBudgetMs: 30_000 }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it("bounds an :external caller's local wait by externalAfterWaitMs on the database clock", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
        externalAfterWaitMs: 0,
      }),
    ]);
    const provider = externalProviderTarget("overflow-member");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([provider]));
    publicOverflow.dispatch.mockResolvedValueOnce(externalDispatchResult(provider));
    const acquire = vi.fn(async (attempt: Parameters<CapacityAdmissionRuntime["acquire"]>[0]) => {
      const candidate = attempt.candidates[0]!;
      // The local member is full: its zero budget expires at once. The
      // external member is then admitted.
      if (candidate.poolMemberId === "local-primary") return { state: "EXPIRED" as const };
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
    });
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire,
      release: vi.fn(async () => true),
      hold: vi.fn((response) => response),
    };
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const response = await appWith(manager, capacityRuntime).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(EXTERNAL_MODEL_ID),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-fallback-reason")).toBe("local_wait_expired");
    expect(acquire.mock.calls[0]?.[0].candidates).toEqual([
      expect.objectContaining({ poolMemberId: "local-primary", waitBudgetMs: 0 }),
    ]);
    expect(manager.sent).toHaveLength(0);
    expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
      reason: "LOCAL_WAIT_EXPIRED",
    });
  });

  describe("X1: consented :external with no dispatchable external plan", () => {
    const localMember = () =>
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
        externalAfterWaitMs: 2_000,
      });
    /** Local admission answers from `local`, the provider from `provider`. */
    const scriptedRuntime = (script: {
      local: Array<"ADMITTED" | "EXPIRED">;
      provider: "ADMITTED" | "EXPIRED";
    }) => {
      const localStates = [...script.local];
      const acquire = vi.fn(async (attempt: Parameters<CapacityAdmissionRuntime["acquire"]>[0]) => {
        const candidate = attempt.candidates[0]!;
        const state =
          candidate.poolMemberId === "local-primary"
            ? (localStates.shift() ?? "EXPIRED")
            : script.provider;
        if (state === "EXPIRED") return { state: "EXPIRED" as const };
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
      });
      const runtime: CapacityAdmissionRuntime = {
        acquire,
        release: vi.fn(async () => true),
        hold: vi.fn((response) => response),
      };
      return { acquire, runtime };
    };
    const localBudgets = (acquire: ReturnType<typeof scriptedRuntime>["acquire"]) =>
      acquire.mock.calls
        .map(([attempt]) => attempt.candidates[0])
        .filter((candidate) => candidate?.poolMemberId === "local-primary")
        .map((candidate) => candidate?.waitBudgetMs);

    beforeEach(() => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [externalPoolTarget],
      });
      externalConsent.poolIds = [externalPoolTarget.id];
    });

    it("resumes the local wait for B - min(B, E) when the provider is saturated and serves locally", async () => {
      db.poolMember.findMany.mockResolvedValue([localMember()]);
      publicOverflow.list.mockResolvedValue(
        listedExternalTargets([externalProviderTarget("overflow-member")]),
      );
      const { acquire, runtime } = scriptedRuntime({
        local: ["EXPIRED", "ADMITTED"],
        provider: "EXPIRED",
      });
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];

      const responsePromise = appWith(manager, runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      await completeJsonRelay({ manager, requestId: requireSent(manager).requestId });
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(response.headers.get("x-wsmp-route")).toBe("local");
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
      // Pool budget B = 30 s, E = 2 s: 2 s first, then the remaining 28 s.
      expect(localBudgets(acquire)).toEqual([2_000, 28_000]);
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
      // M2: the local attempt decides the route.
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fallbackRoute: "local" }) }),
      );
    });

    it("fails like the plain name (429) with the header when the resumed wait also expires", async () => {
      db.poolMember.findMany.mockResolvedValue([localMember()]);
      publicOverflow.list.mockResolvedValue(
        listedExternalTargets([externalProviderTarget("overflow-member")]),
      );
      const { acquire, runtime } = scriptedRuntime({
        local: ["EXPIRED", "EXPIRED"],
        provider: "EXPIRED",
      });
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];

      const response = await appWith(manager, runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("x-wsmp-route")).toBe("local");
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
      expect(localBudgets(acquire)).toEqual([2_000, 28_000]);
      // One external phase per request; precommit failover across external
      // members follows the existing retry rules.
      expect(publicOverflow.list).toHaveBeenCalledTimes(1);
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
      expect(manager.sent).toHaveLength(0);
    });

    it("answers 429 (not 400) with the header on a provider-only pool whose provider is saturated", async () => {
      db.poolMember.findMany.mockResolvedValue([]);
      publicOverflow.list.mockResolvedValue(
        listedExternalTargets([externalProviderTarget("overflow-member")]),
      );
      const { runtime } = scriptedRuntime({ local: [], provider: "EXPIRED" });

      const response = await appWith(new FakeRelayManager(), runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(429);
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
      expect(response.headers.get("x-wsmp-route")).toBeNull();
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
      // No route was ever decided for this request (M2).
      expect(db.relayRequest.update).toHaveBeenCalled();
      for (const [update] of db.relayRequest.update.mock.calls)
        expect((update as { data: Record<string, unknown> }).data.fallbackRoute).toBeUndefined();
    });

    it("answers 400 with the header on a provider-only pool with no compatible external target", async () => {
      db.poolMember.findMany.mockResolvedValue([]);
      // A configured, healthy external member that cannot serve this request
      // (no chat surface): incompatible, not temporarily unavailable. Uses
      // the real listing so health and compatibility are both evaluated.
      const realOverflow =
        await vi.importActual<typeof import("./public-overflow.js")>("./public-overflow.js");
      db.modelPool.findFirst.mockResolvedValue(
        cooldownPoolFixture(externalPoolTarget.ownerUserId, "openai-responses"),
      );
      publicOverflow.list.mockImplementation(realOverflow.listPublicOverflowTargets);
      const { runtime } = scriptedRuntime({ local: [], provider: "ADMITTED" });

      const response = await appWith(new FakeRelayManager(), runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
      expect(response.headers.get("x-wsmp-route")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "unsupported_capability" },
      });
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    });

    it.each([
      ["provider model", "model"],
      ["provider account", "account"],
    ] as const)(
      "answers 503 (not 400) on a provider-only pool whose compatible %s is in health cooldown",
      async (_label, cooling) => {
        db.poolMember.findMany.mockResolvedValue([]);
        const realOverflow =
          await vi.importActual<typeof import("./public-overflow.js")>("./public-overflow.js");
        const fixture = cooldownPoolFixture(externalPoolTarget.ownerUserId);
        const model = fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel;
        db.modelPool.findFirst.mockResolvedValue(fixture);
        // Control: the same member is listed while its cooldown has elapsed.
        expect(
          (
            await realOverflow.listPublicOverflowTargets(
              externalPoolTarget.ownerUserId,
              externalPoolTarget.id,
            )
          ).targets,
        ).toHaveLength(1);
        const coolingUntil = new Date(Date.now() + 60_000);
        if (cooling === "model") model.healthNextRetryAt = coolingUntil;
        else model.ProviderAccount.healthNextRetryAt = coolingUntil;
        const listed = await realOverflow.listPublicOverflowTargets(
          externalPoolTarget.ownerUserId,
          externalPoolTarget.id,
        );
        expect(listed.targets).toHaveLength(0);
        expect(listed.coolingDown).toHaveLength(1);
        publicOverflow.list.mockImplementation(realOverflow.listPublicOverflowTargets);
        const { runtime } = scriptedRuntime({ local: [], provider: "ADMITTED" });

        const response = await appWith(new FakeRelayManager(), runtime).request(
          "/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: "Bearer wsmp_model_test",
              "content-type": "application/json",
            },
            body: requestBody(EXTERNAL_MODEL_ID),
          },
        );

        expect(response.status).toBe(503);
        expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
        expect(response.headers.get("x-wsmp-route")).toBeNull();
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "external_unavailable" },
        });
        expect(publicOverflow.dispatch).not.toHaveBeenCalled();
      },
    );

    it("answers 400 when the only cooling-down external member is incompatible anyway", async () => {
      db.poolMember.findMany.mockResolvedValue([]);
      const realOverflow =
        await vi.importActual<typeof import("./public-overflow.js")>("./public-overflow.js");
      const fixture = cooldownPoolFixture(externalPoolTarget.ownerUserId, "openai-responses");
      fixture.PoolMembers[0]!.ExecutionTarget.ProviderModel.healthNextRetryAt = new Date(
        Date.now() + 60_000,
      );
      db.modelPool.findFirst.mockResolvedValue(fixture);
      publicOverflow.list.mockImplementation(realOverflow.listPublicOverflowTargets);
      const { runtime } = scriptedRuntime({ local: [], provider: "ADMITTED" });

      const response = await appWith(new FakeRelayManager(), runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "unsupported_capability" },
      });
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    });

    it("answers 503 with the header when the owner or caller consent is gone at dispatch", async () => {
      db.poolMember.findMany.mockResolvedValue([]);
      const provider = externalProviderTarget("overflow-member");
      publicOverflow.list.mockResolvedValue(listedExternalTargets([provider]));
      publicOverflow.dispatch.mockResolvedValueOnce({
        dispatched: false,
        reason: "CALLER_CONSENT_WITHDRAWN",
      });
      const { runtime } = scriptedRuntime({ local: [], provider: "ADMITTED" });

      const response = await appWith(new FakeRelayManager(), runtime).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "external_unavailable" },
      });
      expect(runtime.release).toHaveBeenCalledWith(
        expect.objectContaining({ poolMemberId: "overflow-member" }),
      );
    });

    it("keeps the plain-name context error plus the header when a needed external dispatch fails", async () => {
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "tiny-local",
          discoveredModelId: "tiny-model",
          upstreamModelId: "tiny-upstream",
          cliDeviceId: "cli-local",
          physicalMaxContext: 1,
        }),
      ]);
      publicOverflow.list.mockResolvedValue(listedExternalTargets([]));
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];

      const response = await appWith(manager, admittingCapacityRuntime()).request(
        "/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
          body: requestBody(EXTERNAL_MODEL_ID),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "context_exceeded" } });
      expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
    });

    it("sends no header when a consented request is served locally before any trigger", async () => {
      db.poolMember.findMany.mockResolvedValue([localMember()]);
      publicOverflow.list.mockResolvedValue(
        listedExternalTargets([externalProviderTarget("overflow-member")]),
      );
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];

      const responsePromise = appWith(manager, admittingCapacityRuntime()).request(
        "/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
          body: requestBody(EXTERNAL_MODEL_ID),
        },
      );
      await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
      await completeJsonRelay({ manager, requestId: requireSent(manager).requestId });
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(response.headers.get("x-wsmp-route")).toBe("local");
      expect(response.headers.get("x-wsmp-fallback")).toBeNull();
      expect(publicOverflow.list).not.toHaveBeenCalled();
    });

    it("R-J: releases the held local lease and the caller lease once when the external tier throws", async () => {
      db.poolMember.findMany.mockResolvedValue([localMember()]);
      publicOverflow.list.mockRejectedValue(new Error("provider listing database error"));
      const realNow = Date.now();
      const runtime = admittingCapacityRuntime();
      const admit = vi.mocked(runtime.acquire).getMockImplementation()!;
      vi.mocked(runtime.acquire).mockImplementation(async (attempt, signal) => {
        const admitted = await admit(attempt, signal);
        // The relay deadline passes while the local lease is held, so the
        // retry loop ends with the lease still admitted.
        vi.spyOn(Date, "now").mockReturnValue(realNow + 60 * 60_000);
        return admitted;
      });
      const limiter = new ModelApiConcurrencyLimiter();
      const callerRelease = vi.fn();
      vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });
      const manager = new FakeRelayManager();
      manager.activeCliDeviceIds = ["cli-local"];

      const response = await appWith(manager, runtime, limiter).request("/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      });

      expect(response.status).toBe(500);
      expect(publicOverflow.list).toHaveBeenCalledTimes(1);
      expect(runtime.release).toHaveBeenCalledTimes(1);
      expect(runtime.release).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: "lease-local-primary" }),
      );
      expect(callerRelease).toHaveBeenCalledTimes(1);
      expect(db.relayRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "relay-request-id", status: "PENDING" },
          data: expect.objectContaining({ status: "FAILED" }),
        }),
      );
    });
  });

  it("returns 429 without going external when the caller's own cap is reached", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
      }),
    ]);
    publicOverflow.list.mockResolvedValue(listedExternalTargets([externalProviderTarget()]));
    const limiter = new ModelApiConcurrencyLimiter();
    const held = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
      limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
    );
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const response = await appWith(manager, admittingCapacityRuntime(), limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );

    expect(response.status).toBe(429);
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    expect(manager.sent).toHaveLength(0);
    for (const lease of held) lease.release();
  });

  it("keeps the context-ceiling error for a plain name but lets :external go external", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "tiny-local",
        discoveredModelId: "tiny-model",
        upstreamModelId: "tiny-upstream",
        cliDeviceId: "cli-local",
        physicalMaxContext: 1,
      }),
    ]);
    const provider = externalProviderTarget("overflow-member");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([provider]));
    publicOverflow.dispatch.mockResolvedValue(externalDispatchResult(provider));
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-local"];

    const plain = await appWith(manager, admittingCapacityRuntime()).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(externalPoolTarget.modelId),
    });
    expect(plain.status).toBe(400);
    await expect(plain.json()).resolves.toMatchObject({ error: { code: "context_exceeded" } });
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();

    const external = await appWith(manager, admittingCapacityRuntime()).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );
    expect(external.status).toBe(200);
    expect(external.headers.get("x-wsmp-fallback-reason")).toBe("local_context_ceiling");
    expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
      reason: "LOCAL_CONTEXT_CEILING",
    });
    expect(manager.sent).toHaveLength(0);
  });

  it("does not let a Chat Test forced member reach an external member on a plain name", async () => {
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
      }),
    ]);
    const provider = externalProviderTarget("overflow-member");
    publicOverflow.list.mockResolvedValue(listedExternalTargets([provider]));
    publicOverflow.dispatch.mockResolvedValue(externalDispatchResult(provider));
    const request = (model: string) =>
      chatTestCompletionsHandler({
        request: new Request("http://chat.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-wsmp-chat-test-member-id": "overflow-member",
          },
          body: requestBody(model),
        }),
        userId: "user-id",
        manager: new FakeRelayManager(),
        limiter: new ModelApiConcurrencyLimiter(),
        capacityRuntime: admittingCapacityRuntime(),
      });

    const plain = await request(externalPoolTarget.modelId);
    expect(plain.status).toBe(400);
    await expect(plain.json()).resolves.toMatchObject({
      error: { code: "forced_member_requires_external" },
    });
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();

    // The signed-in user choosing the `:external` name is their own consent.
    const external = await request(EXTERNAL_MODEL_ID);
    expect(external.status).toBe(200);
    expect(publicOverflow.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ forcedPoolMemberId: "overflow-member" }),
    );
  });

  it("treats a Chat Test forced external member like provider-only for transient outcomes", async () => {
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "local-primary",
        discoveredModelId: "local-model",
        upstreamModelId: "local-upstream",
        cliDeviceId: "cli-local",
      }),
    ]);
    publicOverflow.list.mockResolvedValue(
      listedExternalTargets([externalProviderTarget("overflow-member")]),
    );
    const acquire = vi.fn(async (attempt: Parameters<CapacityAdmissionRuntime["acquire"]>[0]) => {
      const candidate = attempt.candidates[0]!;
      expect(candidate.poolMemberId).toBe("overflow-member");
      return { state: "EXPIRED" as const };
    });
    const capacityRuntime: CapacityAdmissionRuntime = {
      acquire,
      release: vi.fn(async () => true),
      hold: vi.fn((response) => response),
    };
    const response = await chatTestCompletionsHandler({
      request: new Request("http://chat.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wsmp-chat-test-member-id": "overflow-member",
        },
        body: requestBody(EXTERNAL_MODEL_ID),
      }),
      userId: "user-id",
      manager: new FakeRelayManager(),
      limiter: new ModelApiConcurrencyLimiter(),
      capacityRuntime,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("x-wsmp-fallback")).toBe("unavailable");
    expect(response.headers.get("x-wsmp-route")).toBeNull();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    for (const [update] of db.relayRequest.update.mock.calls)
      expect((update as { data: Record<string, unknown> }).data.fallbackRoute).toBeUndefined();
  });

  it("rejects :external from MCP diagnostics without contacting a provider", async () => {
    mockedTokenAccess.listVisibleModelTargetsForUser.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    const response = await chatTestCompletionsHandler({
      request: new Request("http://diagnostic.internal/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      }),
      userId: "user-id",
      manager: new FakeRelayManager(),
      limiter: new ModelApiConcurrencyLimiter(),
      capacityRuntime: admittingCapacityRuntime(),
      source: "MCP",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "external_not_supported_for_mcp" },
    });
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it("never turns a caller cap hit during local retries into external fallback", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "member-a",
        discoveredModelId: "model-a",
        upstreamModelId: "upstream-a",
        cliDeviceId: "cli-a",
      }),
      poolMemberRow({
        id: "member-b",
        discoveredModelId: "model-b",
        upstreamModelId: "upstream-b",
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
    publicOverflow.list.mockResolvedValue(listedExternalTargets([externalProviderTarget()]));
    const limiter = new ModelApiConcurrencyLimiter();
    let globalAcquisitions = 0;
    const acquireGlobal = limiter.acquireGlobal.bind(limiter);
    vi.spyOn(limiter, "acquireGlobal").mockImplementation((identity) => {
      globalAcquisitions += 1;
      // The retry for the second local member finds the caller at its cap.
      if (globalAcquisitions === 2)
        throw new ModelApiLimitError("Too many active model API requests.");
      return acquireGlobal(identity);
    });
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a", "cli-b"];

    const responsePromise = appWith(manager, admittingCapacityRuntime(), limiter).request(
      "/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: requestBody(EXTERNAL_MODEL_ID),
      },
    );
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    manager.headers(requireSent(manager).requestId, 500, { "content-type": "application/json" });
    const response = await responsePromise;

    expect(response.status).toBe(429);
    expect(globalAcquisitions).toBe(2);
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    expect(manager.sent).toHaveLength(1);
  });

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
    const responsePromise = appWith(manager, capacityRuntime, limiter).request(
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
    // Wait budgets travel as durations; the capacity store turns them into
    // database-clock deadlines (a process clock never decides a budget).
    const firstAdmissionCandidates = capacityAttempts[0]?.candidates as Array<{
      poolMemberId: string;
      waitBudgetMs: number | null;
    }>;
    expect(firstAdmissionCandidates.map((candidate) => candidate.waitBudgetMs)).toEqual([50, null]);
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
    const response = await appWith(manager, capacityRuntime).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "context_exceeded",
        message: expect.stringContaining("context exceeds"),
        details: {
          estimatedInputTokens: expect.any(Number),
          estimateMethod: "TOKEN_ESTIMATE",
          contextMarginTokens: 0,
          effectiveContextCeilingTokens: 1,
        },
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

  it("appends context accounting numbers to Anthropic context-exceeded messages", async () => {
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({
        directContextCeiling: 1,
        countStrategy: "CONSERVATIVE_ESTIMATE",
        endpointCapabilityMetadata: {
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
    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/messages",
      {
        method: "POST",
        headers: {
          authorization: "Bearer wsmp_model_test",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: directTarget.modelId,
          max_tokens: 8,
          messages: [{ role: "user", content: "context" }],
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("Estimated input tokens:"),
      },
    });
  });

  it("reports context accounting for a pool ceiling", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [poolTarget],
    });
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "primary",
        discoveredModelId: "primary-model",
        upstreamModelId: "primary-upstream",
        cliDeviceId: "cli-device-id",
        capacityContextCeilingMode: "INHERIT",
        capacityContextMargin: null,
        poolContextCeiling: 31_744,
        poolContextMargin: 1_024,
      }),
    ]);
    const body = JSON.stringify({
      model: poolTarget.modelId,
      messages: [{ role: "user", content: "x".repeat(77 * 1024) }],
    });
    const expectedTokens = Math.ceil((new TextEncoder().encode(body).byteLength / 3) * 1.2);
    const manager = new FakeRelayManager();
    const rejected = await appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body,
    });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "context_exceeded",
        type: "invalid_request_error",
        details: {
          estimatedInputTokens: expectedTokens,
          estimateMethod: "TOKEN_ESTIMATE",
          contextMarginTokens: 1_024,
          effectiveContextCeilingTokens: 31_744,
        },
      },
    });
    expect(manager.sent).toHaveLength(0);
  });

  it("reports the native count and method that rejected the most permissive pool member", async () => {
    const unregisterTight = contextCounterRegistry.register(
      {
        runtimeIdentityKey: "primary-tight-runtime-key",
        runtimeModel: "primary-tight-upstream",
        runtimeRevision: "revision",
        tokenizer: "tokenizer",
        tokenizerVersion: "1",
        template: "chat",
        templateVersion: "1",
      },
      {
        count: vi.fn().mockResolvedValue({ tokens: 5_000, method: "NATIVE", exact: true }),
      },
    );
    const unregisterMostPermissive = contextCounterRegistry.register(
      {
        runtimeIdentityKey: "primary-runtime-key",
        runtimeModel: "primary-upstream",
        runtimeRevision: "revision",
        tokenizer: "tokenizer",
        tokenizerVersion: "1",
        template: "chat",
        templateVersion: "1",
      },
      {
        count: vi.fn().mockResolvedValue({ tokens: 5_000, method: "NATIVE", exact: true }),
      },
    );
    try {
      db.poolMember.findMany.mockResolvedValue([
        poolMemberRow({
          id: "primary-tight",
          discoveredModelId: "primary-tight-model",
          upstreamModelId: "primary-tight-upstream",
          cliDeviceId: "cli-device-id",
          capacityContextCeilingMode: "INHERIT",
          capacityContextMargin: null,
          poolContextCeiling: 5_000,
          poolContextMargin: 1_000,
          countStrategy: "TOKENIZER",
        }),
        poolMemberRow({
          id: "primary",
          discoveredModelId: "primary-model",
          upstreamModelId: "primary-upstream",
          cliDeviceId: "cli-device-id",
          capacityContextCeilingMode: "INHERIT",
          capacityContextMargin: null,
          poolContextCeiling: 4_500,
          poolContextMargin: 100,
          countStrategy: "TOKENIZER",
        }),
      ]);
      const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
        "/chat/completions",
        {
          method: "POST",
          headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
          body: requestBody(poolTarget.modelId),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "context_exceeded",
          details: {
            estimatedInputTokens: 5_000,
            estimateMethod: "NATIVE",
            contextMarginTokens: 100,
            effectiveContextCeilingTokens: 4_500,
          },
        },
      });
    } finally {
      unregisterTight();
      unregisterMostPermissive();
    }
  });

  it("allows the same large pool request when context limits are unlimited", async () => {
    db.poolMember.findMany.mockResolvedValue([
      poolMemberRow({
        id: "primary",
        discoveredModelId: "primary-model",
        upstreamModelId: "primary-upstream",
        cliDeviceId: "cli-device-id",
        capacityContextCeilingMode: "UNLIMITED",
        poolContextCeiling: null,
        poolContextMargin: 0,
      }),
    ]);
    const body = JSON.stringify({
      model: poolTarget.modelId,
      messages: [{ role: "user", content: "x".repeat(77 * 1024) }],
    });
    const manager = new FakeRelayManager();
    const successPromise = appWith(manager).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body,
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ id: "chatcmpl", choices: [] }));
    manager.complete(sent.requestId);
    const success = await successPromise;
    expect(success.status).toBe(200);
    await success.text();
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
    const responsePromise = appWith(manager, capacityRuntime).request("/responses", {
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
    const responsePromise = appWith(manager, capacityRuntime).request("/responses", {
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
    const responsePromise = appWith(manager, capacityRuntime).request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: requestBody(poolTarget.modelId),
    });
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
    const responsePromise = appWith(manager, capacityRuntime).request("/responses", {
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
        source: "API_TOKEN",
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
          fallbackRoute: "pool-external",
        }),
      }),
    );
    resolveUpsert({ id: "binding-id" });
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
  });

  it("round-trips stored provider Responses through one native immutable binding", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.poolMember.findMany.mockResolvedValue([]);
    const providerTarget = {
      ...externalProviderTarget("provider-member"),
      executionTargetId: "provider-target",
      providerAccountId: "provider-account",
      providerModelId: "provider-model",
      endpointIdentity: "https://provider.example/v1",
      endpointVersion: 4,
      upstreamModelId: "gpt-response",
      nativeSurfaces: ["openai-responses" as const],
      capabilityInventory: {
        version: 3 as const,
        protocol: "openai-compatible" as const,
        surfaces: {
          openaiResponses: {
            source: "provider" as const,
            confidence: "exact" as const,
            supported: true,
            streaming: true,
          },
        },
      },
    };
    publicOverflow.list.mockResolvedValue({
      enabled: true,
      fallbackForGrantees: false,
      affinityPolicy: {
        enabled: false,
        ttlSeconds: 3600,
        maxRecords: 10_000,
        prefixWeight: 100,
        conversationWeight: 150,
        confirmedCacheWeight: 250,
        loadPenaltyWeight: 100,
      },
      targets: [providerTarget],
      coolingDown: [],
    });
    const capacityRuntime = admittingCapacityRuntime();
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
    const create = await appWith(new FakeRelayManager(), capacityRuntime).request("/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: EXTERNAL_MODEL_ID, input: "hello", store: true }),
    });
    expect(create.status).toBe(200);
    expect(create.headers.get("x-wsmp-route")).toBe("pool-external");
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
      fallbackRoute: "pool-external",
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
    const retrieve = await appWith(new FakeRelayManager(), capacityRuntime).request(
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

    const releaseCount = vi.mocked(capacityRuntime.release).mock.calls.length;
    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(
        new ReadableStream({
          pull() {
            throw new Error("provider body disconnected");
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
      target: providerTarget,
      attemptId: "provider-attempt-rejecting-body",
      fencingToken: 3n,
      nativeSurface: "openai-responses",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: false, responseBytes: 0 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });
    vi.mocked(capacityRuntime.release)
      .mockRejectedValueOnce(new Error("capacity database disconnected"))
      .mockResolvedValue(true);
    const failedRead = await appWith(new FakeRelayManager(), capacityRuntime).request(
      "/responses/resp_provider",
      {
        headers: { authorization: "Bearer wsmp_model_test" },
      },
    );
    expect(failedRead.status).toBe(500);
    expect(capacityRuntime.release).toHaveBeenCalledTimes(releaseCount + 2);

    const dispatchFailureReleaseCount = vi.mocked(capacityRuntime.release).mock.calls.length;
    publicOverflow.dispatch.mockRejectedValueOnce(new Error("provider dispatch disconnected"));
    vi.mocked(capacityRuntime.release)
      .mockRejectedValueOnce(new Error("capacity database disconnected"))
      .mockResolvedValue(true);
    const failedDispatch = await appWith(new FakeRelayManager(), capacityRuntime).request(
      "/responses/resp_provider",
      {
        headers: { authorization: "Bearer wsmp_model_test" },
      },
    );
    expect(failedDispatch.status).toBe(500);
    expect(capacityRuntime.release).toHaveBeenCalledTimes(dispatchFailureReleaseCount + 2);

    publicOverflow.dispatch.mockResolvedValueOnce({
      dispatched: true,
      response: new Response(null, { status: 204 }),
      target: providerTarget,
      attemptId: "provider-attempt-delete",
      fencingToken: 4n,
      nativeSurface: "openai-responses",
      attemptCount: 1,
      terminal: Promise.resolve({ ok: true, responseBytes: 0 }),
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });
    let acknowledgeRelease!: (released: boolean) => void;
    const releaseAcknowledged = new Promise<boolean>((resolve) => {
      acknowledgeRelease = resolve;
    });
    const deleteReleaseCount = vi.mocked(capacityRuntime.release).mock.calls.length;
    vi.mocked(capacityRuntime.release)
      .mockRejectedValueOnce(new Error("capacity database disconnected"))
      .mockImplementationOnce(() => releaseAcknowledged);
    let deleteSettled = false;
    const deletePromise = appWith(new FakeRelayManager(), capacityRuntime).request(
      "/responses/resp_provider",
      {
        method: "DELETE",
        headers: { authorization: "Bearer wsmp_model_test" },
      },
    );
    void Promise.resolve(deletePromise).then(() => {
      deleteSettled = true;
    });
    await vi.waitFor(() =>
      expect(capacityRuntime.release).toHaveBeenCalledTimes(deleteReleaseCount + 2),
    );
    expect(deleteSettled).toBe(false);
    acknowledgeRelease(true);
    const deleted = await deletePromise;
    expect(deleted.status).toBe(204);
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
    const responsePromise = appWith(manager, capacityRuntime).request("/responses", {
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

    const response = await appWith(manager, capacityRuntime, limiter).request("/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer wsmp_model_test",
        "content-type": "application/json",
      },
      body: requestBody(),
    });

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
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    publicOverflow.list.mockResolvedValue(listedExternalTargets([]));
    db.responseStickinessRecord.findUnique.mockResolvedValue({
      fallbackRoute: "pool-external",
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
    const response = await appWith(manager, admittingCapacityRuntime()).request(
      "/responses/resp_provider",
      {
        headers: { authorization: "Bearer wsmp_model_test" },
      },
    );
    expect(response.status).toBe(404);
    expect(manager.sent).toEqual([]);
    expect(affinity.rank).not.toHaveBeenCalled();
    expect(publicOverflow.list).toHaveBeenCalledWith("user-id", "pool-id");
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  function consentedProviderBinding(overrides: Record<string, unknown> = {}) {
    return {
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
      fallbackRoute: "pool-external",
      upstreamResponseIdDigest: hmacDigestForForwarderPurpose({
        purpose: "responsesStickinessUpstreamId",
        value: "resp_provider",
      }),
      TargetExecutionTarget: null,
      SelectedExecutionTarget: { discoveredModelId: null },
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it("requires :external to continue an externally served response", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.responseStickinessRecord.findUnique.mockResolvedValue(consentedProviderBinding());
    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/responses",
      {
        method: "POST",
        headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
        body: JSON.stringify({
          model: externalPoolTarget.modelId,
          previous_response_id: "resp_provider",
          input: "next",
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("external_required");
    expect(body.error.message).toContain(EXTERNAL_MODEL_ID);
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["retrieve", "GET", "/responses/resp_provider"],
    ["delete", "DELETE", "/responses/resp_provider"],
    ["cancel", "POST", "/responses/resp_provider/cancel"],
    ["compact", "POST", "/responses/resp_provider/compact"],
    ["input items", "GET", "/responses/resp_provider/input_items"],
  ])(
    "refuses %s on an externally served response once the token no longer allows external",
    async (_label, method, path) => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [externalPoolTarget],
      });
      externalConsent.poolIds = [];
      db.responseStickinessRecord.findUnique.mockResolvedValue(consentedProviderBinding());
      const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
        path,
        { method, headers: { authorization: "Bearer wsmp_model_test" } },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "external_not_permitted" },
      });
      expect(publicOverflow.list).not.toHaveBeenCalled();
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    },
  );

  describe("bound provider operations (H1, E0-TOCTOU, C3)", () => {
    // A member that matches consentedProviderBinding() in full: execution
    // target, account, model, endpoint identity and version, upstream model,
    // and native Responses support.
    const boundProvider = () => ({
      ...externalProviderTarget("provider"),
      upstreamModelId: "gpt-response",
      nativeSurfaces: ["openai-responses"] as PublicProviderTarget["nativeSurfaces"],
    });
    const boundOperations = [
      ["follow-up create", "POST", "/responses", true],
      ["retrieve", "GET", "/responses/resp_provider", false],
      ["delete", "DELETE", "/responses/resp_provider", false],
      ["cancel", "POST", "/responses/resp_provider/cancel", false],
      ["compact", "POST", "/responses/resp_provider/compact", false],
      ["input items", "GET", "/responses/resp_provider/input_items", false],
    ] as const;
    const boundRequest = (method: string, create: boolean) => ({
      method,
      headers: {
        authorization: "Bearer wsmp_model_test",
        ...(create ? { "content-type": "application/json" } : {}),
      },
      ...(create
        ? {
            body: JSON.stringify({
              model: EXTERNAL_MODEL_ID,
              previous_response_id: "resp_provider",
              input: "next",
            }),
          }
        : {}),
    });
    const boundDispatch = (
      terminal: Promise<{ ok: boolean; responseBytes: number }> = Promise.resolve({
        ok: true,
        responseBytes: 2,
      }),
    ) => ({
      dispatched: true,
      response: new Response(JSON.stringify({ id: "resp_next", object: "response" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      target: boundProvider(),
      attemptId: "bound-attempt",
      fencingToken: 1n,
      nativeSurface: "openai-responses",
      attemptCount: 1,
      terminal,
      markFirstClientByte: vi.fn().mockResolvedValue(undefined),
      affinity: undefined,
    });

    beforeEach(() => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [externalPoolTarget],
      });
      externalConsent.poolIds = [externalPoolTarget.id];
      db.responseStickinessRecord.findUnique.mockResolvedValue(consentedProviderBinding());
      publicOverflow.list.mockResolvedValue(listedExternalTargets([boundProvider()]));
    });

    it.each(boundOperations)(
      "H1: %s returns 429 at the caller's own cap before any listing or dispatch",
      async (_label, method, path, create) => {
        const limiter = new ModelApiConcurrencyLimiter();
        const held = Array.from({ length: MODEL_API_MAX_ACTIVE_PER_TOKEN }, () =>
          limiter.acquireGlobal({ tokenId: token.id, userId: token.userId }),
        );
        const runtime = admittingCapacityRuntime();

        const response = await appWith(new FakeRelayManager(), runtime, limiter).request(
          path,
          boundRequest(method, create),
        );

        expect(response.status).toBe(429);
        expect(publicOverflow.list).not.toHaveBeenCalled();
        expect(publicOverflow.dispatch).not.toHaveBeenCalled();
        expect(runtime.acquire).not.toHaveBeenCalled();
        for (const lease of held) lease.release();
      },
    );

    it.each(boundOperations)(
      "H1: %s holds the caller lease until the provider terminal settles",
      async (_label, method, path, create) => {
        let settle!: (terminal: { ok: boolean; responseBytes: number }) => void;
        publicOverflow.dispatch.mockResolvedValueOnce(
          boundDispatch(
            new Promise((resolve) => {
              settle = resolve;
            }),
          ),
        );
        const limiter = new ModelApiConcurrencyLimiter();
        const callerRelease = vi.fn();
        const acquireGlobal = vi
          .spyOn(limiter, "acquireGlobal")
          .mockReturnValue({ release: callerRelease });

        const response = await appWith(
          new FakeRelayManager(),
          admittingCapacityRuntime(),
          limiter,
        ).request(path, boundRequest(method, create));

        expect(response.status).toBe(200);
        expect(acquireGlobal).toHaveBeenCalledWith({ tokenId: token.id, userId: token.userId });
        expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
          requesterUserId: "user-id",
          requesterModelApiTokenId: "token-id",
        });
        expect(callerRelease).not.toHaveBeenCalled();
        settle({ ok: true, responseBytes: 2 });
        await vi.waitFor(() => expect(callerRelease).toHaveBeenCalledTimes(1));
        await response.text();
        // M2: the bound request records its route only on commit.
        expect(db.relayRequest.create.mock.calls.at(-1)?.[0].data.fallbackRoute).toBeNull();
        expect(db.relayRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ fallbackRoute: "pool-external" }),
          }),
        );
      },
    );

    it("H1: releases the caller lease exactly once when nothing is dispatched or dispatch throws", async () => {
      const limiter = new ModelApiConcurrencyLimiter();
      const callerRelease = vi.fn();
      vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });

      publicOverflow.dispatch.mockResolvedValueOnce({
        dispatched: false,
        reason: "PROVIDER_UNAVAILABLE",
      });
      const unavailable = await appWith(
        new FakeRelayManager(),
        admittingCapacityRuntime(),
        limiter,
      ).request("/responses/resp_provider", boundRequest("GET", false));
      expect(unavailable.status).toBe(503);
      expect(callerRelease).toHaveBeenCalledTimes(1);

      publicOverflow.dispatch.mockRejectedValueOnce(new Error("provider dispatch disconnected"));
      const thrown = await appWith(
        new FakeRelayManager(),
        admittingCapacityRuntime(),
        limiter,
      ).request("/responses/resp_provider", boundRequest("GET", false));
      expect(thrown.status).toBe(500);
      expect(callerRelease).toHaveBeenCalledTimes(2);

      // A saturated bound target is transient: 429, not "gone".
      const saturated: CapacityAdmissionRuntime = {
        acquire: vi.fn(async () => ({ state: "EXPIRED" as const })),
        release: vi.fn(async () => true),
        hold: vi.fn((response) => response),
      };
      const busy = await appWith(new FakeRelayManager(), saturated, limiter).request(
        "/responses/resp_provider",
        boundRequest("GET", false),
      );
      expect(busy.status).toBe(429);
      expect(callerRelease).toHaveBeenCalledTimes(3);
    });

    it.each(boundOperations)(
      "%s answers 503 (not 404) while the bound provider is in health cooldown",
      async (_label, method, path, create) => {
        publicOverflow.list.mockResolvedValue({
          ...listedExternalTargets([]),
          coolingDown: [boundProvider()],
        });
        const limiter = new ModelApiConcurrencyLimiter();
        const callerRelease = vi.fn();
        vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });
        const runtime = admittingCapacityRuntime();

        const response = await appWith(new FakeRelayManager(), runtime, limiter).request(
          path,
          boundRequest(method, create),
        );

        expect(response.status).toBe(503);
        expect(publicOverflow.dispatch).not.toHaveBeenCalled();
        expect(runtime.acquire).not.toHaveBeenCalled();
        expect(callerRelease).toHaveBeenCalledTimes(1);
      },
    );

    // R1-A: a bound operation's consent carries the binding's own grant, so
    // the send claim refuses it once that grant is replaced.
    it("binds a grantee's bound operation consent to the binding's grant", async () => {
      mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
        directModels: [],
        modelPools: [
          {
            ...externalPoolTarget,
            ownerUserId: "pool-owner-id",
            accessGrantId: "binding-grant",
            fallbackForGrantees: true,
          },
        ],
      });
      db.responseStickinessRecord.findUnique.mockResolvedValue(
        consentedProviderBinding({
          poolGrantId: "binding-grant",
          PoolGrant: {
            id: "binding-grant",
            poolId: "pool-id",
            ownerUserId: "pool-owner-id",
            granteeUserId: "user-id",
          },
        }),
      );
      publicOverflow.dispatch.mockResolvedValueOnce(boundDispatch());

      const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
        "/responses/resp_provider",
        boundRequest("GET", false),
      );

      expect(response.status).toBe(200);
      await response.text();
      expect(publicOverflow.dispatch.mock.calls[0]?.[0]).toMatchObject({
        externalConsent: expect.objectContaining({
          requesterIsOwner: false,
          accessGrantId: "binding-grant",
        }),
      });
    });

    // R4: the cooldown shortcut applies the full binding match. A cooling
    // member whose endpoint version (or upstream model, or native Responses
    // support) no longer matches the binding can never serve it again: 404.
    it.each([
      ["endpoint version", { endpointVersion: 99 }],
      ["endpoint identity", { endpointIdentity: "https://other.example/v1" }],
      ["upstream model", { upstreamModelId: "another-model" }],
      [
        "native Responses support",
        { nativeSurfaces: ["openai-chat"] as PublicProviderTarget["nativeSurfaces"] },
      ],
    ] as const)(
      "answers 404 for a cooling member whose %s no longer matches the binding",
      async (_label, change) => {
        publicOverflow.list.mockResolvedValue({
          ...listedExternalTargets([]),
          coolingDown: [{ ...boundProvider(), ...change }],
        });
        const limiter = new ModelApiConcurrencyLimiter();
        const callerRelease = vi.fn();
        vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });
        const runtime = admittingCapacityRuntime();

        const response = await appWith(new FakeRelayManager(), runtime, limiter).request(
          "/responses/resp_provider",
          boundRequest("GET", false),
        );

        expect(response.status).toBe(404);
        expect(publicOverflow.dispatch).not.toHaveBeenCalled();
        expect(runtime.acquire).not.toHaveBeenCalled();
        expect(callerRelease).toHaveBeenCalledTimes(1);
      },
    );

    it("answers 404 when a listed member no longer matches the binding's endpoint version", async () => {
      publicOverflow.list.mockResolvedValue(
        listedExternalTargets([{ ...boundProvider(), endpointVersion: 99 }]),
      );
      const runtime = admittingCapacityRuntime();
      const response = await appWith(new FakeRelayManager(), runtime).request(
        "/responses/resp_provider",
        boundRequest("GET", false),
      );
      expect(response.status).toBe(404);
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
      expect(runtime.acquire).not.toHaveBeenCalled();
    });

    // R3: only a permanently invalid binding is "gone". Every transient
    // dispatcher outcome after listing is 503 with both leases released.
    it.each([
      ["PROVIDER_UNHEALTHY", 503],
      ["SEND_CLAIM_FAILED", 503],
      ["PROVIDER_UNAVAILABLE", 503],
      ["BUDGET_EXCEEDED", 503],
      ["BOUND_TARGET_INVALID", 404],
      ["REQUESTER_ACCESS_BLOCKED", 403],
    ] as const)("maps a bound dispatch result %s to %i", async (reason, status) => {
      publicOverflow.dispatch.mockResolvedValueOnce({ dispatched: false, reason });
      const limiter = new ModelApiConcurrencyLimiter();
      const callerRelease = vi.fn();
      vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });
      const runtime = admittingCapacityRuntime();

      const response = await appWith(new FakeRelayManager(), runtime, limiter).request(
        "/responses/resp_provider",
        boundRequest("GET", false),
      );

      expect(response.status).toBe(status);
      expect(runtime.release).toHaveBeenCalledTimes(1);
      expect(callerRelease).toHaveBeenCalledTimes(1);
    });

    it.each(boundOperations)(
      "E0-TOCTOU: %s answers 403 when consent is withdrawn between authentication and dispatch",
      async (_label, method, path, create) => {
        // Authentication saw consent; the dispatch-time re-read no longer does.
        publicOverflow.dispatch.mockResolvedValueOnce({
          dispatched: false,
          reason: "CALLER_CONSENT_WITHDRAWN",
        });
        const limiter = new ModelApiConcurrencyLimiter();
        const callerRelease = vi.fn();
        vi.spyOn(limiter, "acquireGlobal").mockReturnValue({ release: callerRelease });
        const runtime = admittingCapacityRuntime();

        const response = await appWith(new FakeRelayManager(), runtime, limiter).request(
          path,
          boundRequest(method, create),
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "external_not_permitted" },
        });
        expect(runtime.release).toHaveBeenCalledTimes(1);
        expect(callerRelease).toHaveBeenCalledTimes(1);
      },
    );

    it("C3 (r1-F3): an :external follow-up after token consent was withdrawn is 403 with no dispatch", async () => {
      externalConsent.poolIds = [];
      const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
        "/responses",
        boundRequest("POST", true),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "external_not_permitted" },
      });
      expect(publicOverflow.list).not.toHaveBeenCalled();
      expect(publicOverflow.dispatch).not.toHaveBeenCalled();
    });
  });

  it("ignores provider bindings created before caller consent existed", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
    db.responseStickinessRecord.findUnique.mockResolvedValue(
      consentedProviderBinding({ fallbackRoute: null }),
    );
    const response = await appWith(new FakeRelayManager(), admittingCapacityRuntime()).request(
      "/responses/resp_provider",
      { headers: { authorization: "Bearer wsmp_model_test" } },
    );
    expect(response.status).toBe(404);
    expect(publicOverflow.list).not.toHaveBeenCalled();
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
  });

  it("keeps an :external follow-up to a locally served response on its local member", async () => {
    mockedTokenAccess.listVisibleModelTargetsForToken.mockResolvedValue({
      directModels: [],
      modelPools: [externalPoolTarget],
    });
    externalConsent.poolIds = [externalPoolTarget.id];
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
      }),
    ]);
    db.discoveredModel.findUnique.mockResolvedValue(
      directRow({ id: "model-a", upstreamModelId: "upstream-a", cliDeviceId: "cli-a" }),
    );
    const manager = new FakeRelayManager();
    manager.activeCliDeviceIds = ["cli-a"];
    const responsePromise = appWith(manager).request("/responses", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_model_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: EXTERNAL_MODEL_ID,
        previous_response_id: "resp_local",
        input: "next",
      }),
    });
    await vi.waitFor(() => expect(manager.sent).toHaveLength(1));
    const sent = requireSent(manager);
    manager.headers(sent.requestId, 200, { "content-type": "application/json" });
    manager.body(sent.requestId, JSON.stringify({ id: "resp_next", object: "response" }));
    manager.complete(sent.requestId);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-wsmp-route")).toBe("local");
    expect(publicOverflow.dispatch).not.toHaveBeenCalled();
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
    const responsePromise = appWith(manager, capacityRuntime).request("/responses/resp_123", {
      headers: { authorization: "Bearer wsmp_model_test" },
    });

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

/**
 * A pool with one external member as `listPublicOverflowTargets` reads it
 * from the database, with every health cooldown elapsed (UNAVAILABLE status,
 * next retry in the past: a half-open candidate).
 */
function cooldownPoolFixture(ownerUserId: string, surface = "openai-chat") {
  return {
    fallbackEnabled: true,
    fallbackForGrantees: false,
    PoolMembers: [
      {
        id: "member-cooldown",
        publicOrder: 0,
        ExecutionTarget: {
          id: "target-cooldown",
          inferenceCapacityId: "capacity-cooldown",
          ProviderModel: {
            id: "model-cooldown",
            userId: ownerUserId,
            upstreamModelId: "upstream-model",
            contextWindow: 10_000,
            maxOutputTokens: 1_000,
            concurrencyLimit: null,
            nativeCapabilities: {
              protocols: ["openai"],
              surfaces: [surface],
              streaming: true,
              features: [],
            },
            healthStatus: "UNAVAILABLE",
            healthNextRetryAt: new Date(0),
            enabled: true,
            deletedAt: null,
            ProviderAccount: {
              id: "account-cooldown",
              userId: ownerUserId,
              providerType: "openai",
              providerVersion: null,
              baseUrl: "https://provider.example",
              endpointIdentity: "https://provider.example",
              endpointVersion: 1,
              authType: "BEARER",
              healthStatus: "UNAVAILABLE",
              healthNextRetryAt: new Date(0),
              enabled: true,
              deletedAt: null,
              CurrentCredential: {
                id: "credential-cooldown",
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
