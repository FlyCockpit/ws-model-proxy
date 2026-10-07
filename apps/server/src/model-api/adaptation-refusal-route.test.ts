/**
 * Route-level API adaptation (on by default): a request only an adapted member could serve, but
 * that the strict adapter cannot translate, fails closed with a 400 naming the feature.
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
const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const { createModelApiRoutes } = await import("./routes.js");
const { ModelApiConcurrencyLimiter } = await import("./limits.js");

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
  protocolAdaptationEnabled: true,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
  fallbackMode: "OWNER_AND_SHARES" as const,
  externalMemberCount: 0,
  externalEquivalentModel: null,
  embeddingContract: null,
  paidWarmProtection: false,
  ownKeyProviderModelId: null,
};

type PoolRoute = import("./resolve.js").PoolRoute;

/** One local member whose model serves only the Responses API. */
const RESPONSES_ONLY_ROUTE: PoolRoute = {
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
    handle: "responses-only",
    runtimeId: "runtime-1",
    versionId: "version-1",
    launchHash: "hash",
    nodeId: "node-1",
    nodeOnline: true,
    ready: true,
    engine: "OTHER",
    hardConcurrencyLimit: 4,
    physicalMaxContext: 32_000,
    kvBudgetTokens: null,
    engineCountContext: null,
    countStrategy: "CONSERVATIVE_ESTIMATE",
    imageTokenAllowance: null,
    cacheGeneration: "gen",
    runtimeIdentityKey: "hash",
    runtimeModel: "m",
    runtimeRevision: "1",
    tokenizer: null,
    tokenizerVersion: null,
    template: null,
    templateVersion: null,
    cacheNamespace: "ns",
  },
  model: {
    id: "rm-1",
    userId: "owner",
    upstreamModelId: "m",
    capabilities: ["RESPONSES_API"],
    transcriptionProfile: null,
    embeddingContract: null,
  },
  pool: {
    id: "pool-1",
    userId: "owner",
    maxWaitMs: 30_000,
    contextCeiling: null,
    contextMargin: 0,
    fallbackMode: "OWNER_AND_SHARES",
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
      maxRecords: 10_000,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
      residencyWeight: 100,
    },
  },
};

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

beforeEach(() => {
  mockReset(db);
  vi.clearAllMocks();
  db.relayRequest.create.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.update.mockResolvedValue({ id: "relay-1" } as never);
  db.relayRequest.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async () => undefined);
  resolve.authenticateApiKey.mockResolvedValue({
    id: "key-1",
    userId: "owner",
    scope: "ALL_POOLS",
    lookupPrefix: "wsmp_key_test",
    expiresAt: null,
    lastUsedAt: null,
  });
  resolve.listCallableTargetsForApiKey.mockResolvedValue({ pools: [POOL], tests: [] });
  resolve.poolRoutes.mockResolvedValue([RESPONSES_ONLY_ROUTE] as never);
  overflow.listPublicOverflowTargets.mockResolvedValue({
    enabled: false,
    ownerActive: true,
    fallbackForGrantees: false,
    affinityPolicy: null,
    targets: [],
    coolingDown: [],
    unavailable: [],
  } as never);
});

describe("API adaptation on a pool", () => {
  it("refuses a Chat request only an adapted member could serve, naming the untranslatable feature", async () => {
    const response = await app().request("/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer wsmp_key_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "owner/chat",
        messages: [{ role: "user", content: "hello" }],
        logprobs: true,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; param: string | null } };
    expect(body.error.message).toContain("logprobs");
    expect(overflow.dispatchPublicOverflow).not.toHaveBeenCalled();
  });
});
