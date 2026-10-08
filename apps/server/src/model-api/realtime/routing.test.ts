import { beforeEach, describe, expect, it, vi } from "vitest";

// The server env validates on import; nothing these tests reach reads it, so
// the strict (empty-env) unit run gets an empty one.
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const callable = vi.hoisted(() => ({
  targets: { pools: [] as unknown[], tests: [] as unknown[] },
  userCalls: [] as string[],
  keyCalls: [] as string[],
}));
vi.mock("../resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../resolve.js")>("../resolve.js");
  return {
    ...actual,
    listCallableTargetsForUser: vi.fn(async (userId: string) => {
      callable.userCalls.push(userId);
      return callable.targets;
    }),
    listCallableTargetsForApiKey: vi.fn(async (key: { id: string }) => {
      callable.keyCalls.push(key.id);
      return { pools: callable.targets.pools, tests: [] };
    }),
  };
});

const health = vi.hoisted(() => ({
  recordTargetRelayFailure: vi.fn(async () => ({ retryable: false, update: null })),
  markTargetRelaySuccess: vi.fn(async () => undefined),
  markTargetHalfOpenTrial: vi.fn(async () => 1),
  releaseTargetHalfOpenTrial: vi.fn(async () => true),
  returnTargetTrial: vi.fn(async () => undefined),
}));
vi.mock("@ws-model-proxy/api/lib/pool-routing", async () => {
  const actual = await vi.importActual<typeof import("@ws-model-proxy/api/lib/pool-routing")>(
    "@ws-model-proxy/api/lib/pool-routing",
  );
  return {
    ...actual,
    recordTargetRelayFailure: health.recordTargetRelayFailure,
    markTargetRelaySuccess: health.markTargetRelaySuccess,
    markTargetHalfOpenTrial: health.markTargetHalfOpenTrial,
    releaseTargetHalfOpenTrial: health.releaseTargetHalfOpenTrial,
    returnTargetTrial: health.returnTargetTrial,
  };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  createRealtimeRouter,
  liveCapabilities,
  poolCandidates,
  recheckRealtimeAccess,
  resolveRealtimeModel,
  testCandidates,
} = await import("./routing.js");
type PoolRoute = import("../resolve.js").PoolRoute;
type TestRoute = import("../resolve.js").TestRoute;
type CallablePool = import("../resolve.js").CallablePool;
type TestTarget = import("../resolve.js").TestTarget;

const db = prisma as unknown as {
  apiKey: { findUnique: ReturnType<typeof vi.fn> };
};

const SEGMENTED = { realtime: { adapter: "segmented" } };
const VLLM = { realtime: { adapter: "vllm" } };

type RouteOverrides = {
  member?: string;
  target?: string;
  instance?: string;
  node?: string | null;
  profile?: unknown;
  ready?: boolean;
  health?: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "HALF_OPEN" | "UNHEALTHY";
  active?: boolean;
  owner?: string;
  shareId?: string | null;
  weight?: number;
  nextRetryAt?: Date | null;
  trialStartedAt?: Date | null;
};

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 60_000);

function testRoute({
  target = "et-1",
  instance = "inst-1",
  node = "node-1",
  profile = SEGMENTED,
  ready = true,
  health: targetHealth = "HEALTHY",
  owner = "owner",
  nextRetryAt = null,
  trialStartedAt = null,
}: RouteOverrides = {}): TestRoute {
  return {
    target: {
      id: target,
      health: targetHealth,
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      lastFailureAt: null,
      nextRetryAt,
      halfOpenTrialStartedAt: trialStartedAt,
      lastRoutedAt: null,
    },
    instance: {
      id: instance,
      handle: `i-${instance
        .replace(/[^a-z0-9]/g, "")
        .padEnd(12, "a")
        .slice(0, 12)}`,
      runtimeId: "rt-1",
      versionId: "v-1",
      launchHash: "h",
      nodeId: node,
      nodeOnline: node !== null,
      ready,
      engine: "VLLM",
      hardConcurrencyLimit: null,
      physicalMaxContext: null,
      kvBudgetTokens: null,
      engineCountContext: null,
      countStrategy: "CONSERVATIVE_ESTIMATE",
      imageTokenAllowance: null,
      cacheGeneration: "",
      requestCompat: {},
      runtimeIdentityKey: "h",
      runtimeModel: "whisper-large",
      runtimeRevision: "v-1",
      tokenizer: null,
      tokenizerVersion: null,
      template: null,
      templateVersion: null,
      cacheNamespace: instance,
    },
    model: {
      id: "rm-1",
      userId: owner,
      upstreamModelId: "whisper-large",
      capabilities: ["AUDIO_INPUT"],
      type: "TRANSCRIPTION",
      transcriptionProfile: profile as TestRoute["model"]["transcriptionProfile"],
      embeddingContract: null,
    },
  };
}

function poolRoute(overrides: RouteOverrides = {}): PoolRoute {
  return {
    ...testRoute(overrides),
    member: {
      id: overrides.member ?? "m1",
      poolId: "pool-1",
      shareId: overrides.shareId ?? null,
      weight: overrides.weight ?? 1,
      active: overrides.active ?? true,
    },
    pool: {} as unknown as PoolRoute["pool"],
  };
}

const POOL = { id: "pool-1", ownerUserId: "owner", shareId: "share-1" };
const poolTarget = {
  target: "POOL",
  id: "pool-1",
  modelId: "owner/asr",
  ownerUserId: "owner",
  shareId: "share-1",
} as unknown as CallablePool;
const testTarget = {
  target: "TEST",
  id: "rm-1",
  modelId: "runtime:rt-1:whisper-large",
  ownerUserId: "owner",
} as unknown as TestTarget;

beforeEach(() => {
  callable.targets = { pools: [], tests: [] };
  callable.userCalls = [];
  callable.keyCalls = [];
  health.recordTargetRelayFailure.mockClear();
  health.markTargetRelaySuccess.mockClear();
  health.markTargetHalfOpenTrial.mockClear();
  health.releaseTargetHalfOpenTrial.mockClear();
  health.returnTargetTrial.mockClear();
});

describe("live capability (from the served model's transcription profile)", () => {
  it("reads the realtime profile and refuses models without one", () => {
    expect(liveCapabilities(testRoute().model)).toMatchObject({
      audio: { transcriptions: { realtime: { supported: true, adapter: "segmented" } } },
    });
    expect(liveCapabilities(testRoute({ profile: null }).model)).toBeNull();
    expect(liveCapabilities(testRoute({ profile: { streaming: true } }).model)).toBeNull();
    expect(liveCapabilities(testRoute({ profile: { realtime: { adapter: "x" } } }).model)).toBe(
      null,
    );
  });
});

describe("pool candidates", () => {
  it("returns ready, healthy, online, active routes with their route identity", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute({ shareId: "share-c", owner: "contributor" })],
    });
    expect(candidates).toEqual([
      {
        nodeId: "node-1",
        handle: expect.stringMatching(/^i-/),
        upstreamModel: "whisper-large",
        capabilities: expect.objectContaining({ version: 2 }),
        memberId: "m1",
        route: {
          kind: "pool",
          poolId: "pool-1",
          poolMemberId: "m1",
          runtimeModelId: "rm-1",
          executionTargetId: "et-1",
          instanceId: "inst-1",
          ownerUserId: "owner",
          engineOwnerUserId: "contributor",
          shareId: "share-1",
          contributedShareId: "share-c",
        },
      },
    ]);
  });

  it("drops offline, unready, trial-in-flight, cooling, unhealthy, inactive and non-live routes", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [
        poolRoute({ member: "offline", node: "node-2" }),
        poolRoute({ member: "unready", ready: false }),
        poolRoute({ member: "half", health: "HALF_OPEN", trialStartedAt: new Date() }),
        poolRoute({ member: "cooling", health: "DEGRADED", nextRetryAt: FUTURE }),
        poolRoute({ member: "sick", health: "UNHEALTHY" }),
        poolRoute({ member: "inactive", active: false }),
        poolRoute({ member: "file-only", profile: { streaming: true } }),
        poolRoute({ member: "ok", target: "et-ok" }),
      ],
    });
    expect(candidates.map((candidate) => candidate.memberId)).toEqual(["ok"]);
  });

  it("offers a degraded target whose window opened as the session's trial, ahead of the rest", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [
        poolRoute({ member: "fresh", target: "et-fresh", health: "UNKNOWN" }),
        poolRoute({ member: "proven", target: "et-proven" }),
        poolRoute({ member: "due", target: "et-due", health: "DEGRADED", nextRetryAt: PAST }),
      ],
    });
    expect(candidates.map((candidate) => [candidate.memberId, candidate.trial])).toEqual([
      ["due", { degradedFallback: true }],
      ["proven", undefined],
      ["fresh", undefined],
    ]);
  });

  it("offers one trial per session even when several windows are open", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [
        poolRoute({ member: "a", target: "et-a", health: "UNHEALTHY", nextRetryAt: PAST }),
        poolRoute({ member: "b", target: "et-b", health: "DEGRADED", nextRetryAt: PAST }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.trial).toBeDefined();
  });

  it("tries targets that served before ahead of unjudged ones", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [
        poolRoute({ member: "fresh", target: "et-fresh", health: "UNKNOWN" }),
        poolRoute({ member: "proven", target: "et-proven" }),
      ],
    });
    expect(candidates.map((candidate) => candidate.memberId)).toEqual(["proven", "fresh"]);
  });

  it("drops degraded targets still in their cooldown", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [
        poolRoute({ member: "degraded", health: "DEGRADED", nextRetryAt: FUTURE }),
      ],
    });
    expect(candidates).toEqual([]);
  });

  it("takes a fresh target nothing has judged yet, as HTTP routing does", async () => {
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute({ member: "fresh", health: "UNKNOWN" })],
    });
    expect(candidates.map((candidate) => candidate.memberId)).toEqual(["fresh"]);
  });

  it("drops vLLM routes when a language or prompt is set", async () => {
    const routes = async () => [poolRoute({ member: "vllm", profile: VLLM })];
    expect(
      await poolCandidates({ pool: POOL, config: {}, onlineNodeIds: ["node-1"], routes }),
    ).toHaveLength(1);
    expect(
      await poolCandidates({
        pool: POOL,
        config: { language: "en" },
        onlineNodeIds: ["node-1"],
        routes,
      }),
    ).toEqual([]);
  });
});

describe("test candidates and model resolution", () => {
  it("offers a direct test's target whose window opened as a trial, and skips one in flight", async () => {
    const due = await testCandidates({
      target: testTarget,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [testRoute({ health: "UNHEALTHY", nextRetryAt: PAST })],
    });
    expect(due.map((candidate) => candidate.trial)).toEqual([{ degradedFallback: false }]);
    const inFlight = await testCandidates({
      target: testTarget,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [testRoute({ health: "HALF_OPEN", trialStartedAt: new Date() })],
    });
    expect(inFlight).toEqual([]);
  });

  it("routes the caller's own served model as a TEST target", async () => {
    const [candidate] = await testCandidates({
      target: testTarget,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [testRoute()],
    });
    expect(candidate?.route).toEqual({
      kind: "test",
      poolId: null,
      poolMemberId: null,
      runtimeModelId: "rm-1",
      executionTargetId: "et-1",
      instanceId: "inst-1",
      ownerUserId: "owner",
      engineOwnerUserId: "owner",
      shareId: null,
      contributedShareId: null,
    });
  });

  it("maps unknown models to model_not_found and :external to external_variant_unsupported", async () => {
    callable.targets = { pools: [poolTarget], tests: [testTarget] };
    const key = {
      kind: "token" as const,
      token: {
        id: "k",
        userId: "u",
        scope: "ALL_POOLS" as const,
        lookupPrefix: "wsmp_key_x",
        expiresAt: null,
        lastUsedAt: null,
      },
    };
    expect(await resolveRealtimeModel(key, "nobody/none")).toEqual({ error: "model_not_found" });
    expect(await resolveRealtimeModel(key, "owner/asr:external")).toEqual({
      error: "external_variant_unsupported",
    });
    expect(await resolveRealtimeModel(key, "owner/asr")).toEqual({
      kind: "pool",
      target: poolTarget,
    });
    // An API key calls pools only.
    expect(await resolveRealtimeModel(key, "runtime:rt-1:whisper-large")).toEqual({
      error: "model_not_found",
    });
    expect(
      await resolveRealtimeModel({ kind: "dashboard", userId: "u" }, "runtime:rt-1:whisper-large"),
    ).toEqual({ kind: "test", target: testTarget });
    expect(callable.keyCalls).toEqual(["k", "k", "k", "k"]);
    expect(callable.userCalls).toEqual(["u"]);
  });

  it("reports a configuration refusal without touching target health", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = createRealtimeRouter({
      access: { kind: "dashboard", userId: "u" },
      onlineNodeIds: () => [],
    });
    const candidate = {
      nodeId: "node-1",
      handle: "i-aaaaaaaaaaaa",
      upstreamModel: "m",
      capabilities: null,
      memberId: "m1",
    };
    router.memberMisconfigured?.(candidate, "unsupported_capability");
    expect(health.recordTargetRelayFailure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("records an open failure on the route's execution target", async () => {
    const router = createRealtimeRouter({
      access: { kind: "dashboard", userId: "u" },
      onlineNodeIds: () => ["node-1"],
    });
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute()],
    });
    if (!candidate) throw new Error("no candidate");
    router.memberOpenFailed(candidate, "timeout");
    router.memberOpenFailed({ ...candidate, route: undefined }, "timeout");
    expect(health.recordTargetRelayFailure).toHaveBeenCalledTimes(1);
    expect(health.recordTargetRelayFailure).toHaveBeenCalledWith({
      executionTargetId: "et-1",
      failure: "timeout",
      trialStartedAt: null,
    });
  });

  it("claims, settles and gives back trials through the shared target health writes", async () => {
    const router = createRealtimeRouter({
      access: { kind: "dashboard", userId: "u" },
      onlineNodeIds: () => ["node-1"],
    });
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute({ health: "DEGRADED", nextRetryAt: PAST })],
    });
    if (!candidate?.trial) throw new Error("no trial candidate");
    const startedAt = await router.claimTrial?.(candidate);
    expect(startedAt).toBeInstanceOf(Date);
    expect(health.markTargetHalfOpenTrial).toHaveBeenCalledWith({
      executionTargetId: "et-1",
      now: startedAt,
      allowDegradedFallback: true,
    });
    health.markTargetHalfOpenTrial.mockResolvedValueOnce(0);
    expect(await router.claimTrial?.(candidate)).toBeNull();
    if (!startedAt) throw new Error("no claim");
    router.memberOpened?.(candidate, startedAt);
    expect(health.markTargetRelaySuccess).toHaveBeenCalledWith("et-1", {
      trialStartedAt: startedAt,
    });
    router.memberOpenFailed(candidate, "timeout", startedAt);
    expect(health.recordTargetRelayFailure).toHaveBeenCalledWith({
      executionTargetId: "et-1",
      failure: "timeout",
      trialStartedAt: startedAt,
    });
    router.releaseTrial?.(candidate, startedAt, "unused");
    expect(health.releaseTargetHalfOpenTrial).toHaveBeenCalledWith({
      executionTargetId: "et-1",
      trialStartedAt: startedAt,
    });
    router.releaseTrial?.(candidate, startedAt, "inconclusive");
    expect(health.returnTargetTrial).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: "et-1", trialStartedAt: startedAt }),
    );
  });

  it("marks the target healthy when its engine opens a session, never as a trial", async () => {
    const router = createRealtimeRouter({
      access: { kind: "dashboard", userId: "u" },
      onlineNodeIds: () => ["node-1"],
    });
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute({ health: "UNKNOWN" })],
    });
    if (!candidate) throw new Error("no candidate");
    router.memberOpened?.(candidate);
    router.memberOpened?.({ ...candidate, route: undefined });
    expect(health.markTargetRelaySuccess).toHaveBeenCalledTimes(1);
    expect(health.markTargetRelaySuccess).toHaveBeenCalledWith("et-1", { trialStartedAt: null });
  });

  it("the router reports no_live_member when nothing is eligible", async () => {
    callable.targets = { pools: [], tests: [] };
    const router = createRealtimeRouter({
      access: { kind: "dashboard", userId: "u" },
      onlineNodeIds: () => [],
    });
    expect(
      await router.candidates({ model: "x/y", config: {}, signal: new AbortController().signal }),
    ).toEqual({ ok: false, code: "model_not_found" });
  });
});

describe("access rechecks", () => {
  const key = {
    id: "t",
    userId: "u",
    scope: "ALL_POOLS",
    lookupPrefix: "wsmp_key_t",
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
  };
  const routes = (pool: PoolRoute[] = [poolRoute()]) => ({
    pool: async () => pool,
    test: async () => [],
  });

  async function opened() {
    callable.targets = { pools: [poolTarget], tests: [] };
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      onlineNodeIds: ["node-1"],
      routes: async () => [poolRoute()],
    });
    if (!candidate) throw new Error("no candidate");
    return {
      credential: { kind: "token" as const, tokenId: "t" },
      userId: "u",
      model: "owner/asr",
      resolved: { kind: "pool" as const, target: poolTarget },
      candidate,
      config: {},
      routes: routes(),
    };
  }

  it("passes while everything still holds", async () => {
    const input = await opened();
    db.apiKey.findUnique.mockResolvedValue(key);
    expect(await recheckRealtimeAccess({ ...input, permission: async () => null })).toEqual({
      ok: true,
    });
  });

  it.each([
    ["revoked", { revokedAt: new Date(0) }],
    ["expired", { expiresAt: new Date(0) }],
    ["banned owner", { User: { banned: true, banExpires: null, deletionRequestedAt: null } }],
  ])("denies a %s credential", async (_label, change) => {
    const input = await opened();
    db.apiKey.findUnique.mockResolvedValue({ ...key, ...change });
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "credential" });
  });

  it.each([
    ["requester", "credential"],
    ["access", "model"],
    ["member", "member"],
  ] as const)("denies when the shared send check says %s", async (denied, reason) => {
    const input = await opened();
    db.apiKey.findUnique.mockResolvedValue(key);
    const permission = vi.fn(async () => denied);
    expect(await recheckRealtimeAccess({ ...input, permission })).toEqual({ ok: false, reason });
    expect(permission).toHaveBeenCalledWith({ tokenId: "t", userId: "u" }, input.candidate);
  });

  it("propagates a failed send check (the registry skips that sweep)", async () => {
    const input = await opened();
    db.apiKey.findUnique.mockResolvedValue(key);
    await expect(
      recheckRealtimeAccess({
        ...input,
        permission: async () => {
          throw new Error("lock timeout");
        },
      }),
    ).rejects.toThrow();
  });

  it("denies a model no longer callable, another share, and a route that no longer serves", async () => {
    const input = await opened();
    db.apiKey.findUnique.mockResolvedValue(key);
    callable.targets = { pools: [], tests: [] };
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "model" });
    callable.targets = { pools: [{ ...poolTarget, shareId: "share-2" }], tests: [] };
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "model" });
    callable.targets = { pools: [poolTarget], tests: [] };
    const permission = async () => null;
    for (const changed of [
      [],
      [poolRoute({ active: false })],
      [poolRoute({ instance: "inst-2" })],
      [poolRoute({ profile: null })],
      [poolRoute({ shareId: "share-x" })],
    ]) {
      expect(
        await recheckRealtimeAccess({ ...input, routes: routes(changed), permission }),
      ).toEqual({ ok: false, reason: "member" });
    }
    // A degraded member keeps its session: health is not rechecked.
    expect(
      await recheckRealtimeAccess({
        ...input,
        routes: routes([poolRoute({ health: "UNHEALTHY" })]),
        permission,
      }),
    ).toEqual({ ok: true });
  });

  it("rechecks a Chat Test session by its dashboard session, with the user's targets and no key", async () => {
    const input = await opened();
    db.apiKey.findUnique.mockReset();
    callable.userCalls = [];
    const dashboardSession = vi.fn(async () => "ok" as const);
    const permission = vi.fn(async () => null);
    expect(
      await recheckRealtimeAccess({
        ...input,
        credential: { kind: "dashboard", sessionId: "sess-1" },
        dashboardSession,
        permission,
      }),
    ).toEqual({ ok: true });
    expect(dashboardSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", userId: "u" }),
    );
    expect(callable.userCalls).toEqual(["u"]);
    expect(permission).toHaveBeenCalledWith({ tokenId: null, userId: "u" }, input.candidate);
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it.each(["ended", "blocked", "two_factor_required"] as const)(
    "ends a Chat Test session whose dashboard session is %s",
    async (verdict) => {
      const input = await opened();
      const permission = vi.fn(async () => null);
      expect(
        await recheckRealtimeAccess({
          ...input,
          credential: { kind: "dashboard", sessionId: "sess-1" },
          dashboardSession: async () => verdict,
          permission,
        }),
      ).toEqual({ ok: false, reason: "credential" });
      expect(permission).not.toHaveBeenCalled();
    },
  );
});
