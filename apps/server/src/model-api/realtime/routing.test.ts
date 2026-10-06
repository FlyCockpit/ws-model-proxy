import { beforeEach, describe, expect, it, vi } from "vitest";

// The server env validates on import; nothing these tests reach reads it, so
// the strict (empty-env) unit run gets an empty one.
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const visible = vi.hoisted(() => ({
  targets: { directModels: [] as unknown[], modelPools: [] as unknown[] },
}));
const userTargets = vi.hoisted(() => ({
  calls: [] as string[],
}));
vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  listVisibleModelTargetsForUser: vi.fn(async (userId: string) => {
    userTargets.calls.push(userId);
    return visible.targets;
  }),
  listVisibleModelTargetsWithExternalPermissionForToken: vi.fn(async () => ({
    targets: visible.targets,
    externalPoolIds: new Set<string>(),
  })),
}));

const health = vi.hoisted(() => ({ recordPoolMemberRelayFailure: vi.fn(async () => ({})) }));
vi.mock("@ws-model-proxy/api/lib/model-pool-routing", async () => {
  const actual = await vi.importActual<typeof import("@ws-model-proxy/api/lib/model-pool-routing")>(
    "@ws-model-proxy/api/lib/model-pool-routing",
  );
  return { ...actual, recordPoolMemberRelayFailure: health.recordPoolMemberRelayFailure };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  createRealtimeRouter,
  directCandidates,
  endpointIsRecipeManaged,
  poolCandidates,
  recheckRealtimeAccess,
  resolveRealtimeModel,
} = await import("./routing.js");

const db = prisma as unknown as {
  poolMember: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  discoveredModel: { findUnique: ReturnType<typeof vi.fn> };
  modelApiToken: { findUnique: ReturnType<typeof vi.fn> };
};

const LIVE = {
  version: 2,
  protocol: "openai-compatible",
  audio: {
    transcriptions: { supported: true, realtime: { supported: true, adapter: "segmented" } },
  },
};
const VLLM = {
  version: 2,
  protocol: "openai-compatible",
  audio: { transcriptions: { supported: true, realtime: { supported: true, adapter: "vllm" } } },
};

type ModelOverrides = {
  id?: string;
  cli?: string;
  slug?: string;
  capabilities?: unknown;
  override?: unknown;
  instance?: unknown;
  owner?: string;
};

function model({
  id = "dm-1",
  cli = "cli-1",
  slug = "inst-aaaaaaaaaaaaaaaa",
  capabilities = LIVE,
  override,
  instance,
  owner = "owner",
}: ModelOverrides = {}) {
  return {
    id,
    userId: owner,
    published: true,
    upstreamModelId: "whisper-large",
    capabilityOverrideMode: override ? "OVERRIDE" : "INHERIT",
    capabilityOverrideMetadata: override ?? null,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
    Endpoint: {
      id: `ep-${id}`,
      userId: owner,
      slug,
      published: true,
      cliDeviceId: cli,
      status: "ONLINE",
      capabilityMetadata: capabilities,
      CliDevice: { status: "CONNECTED" },
      DeploymentInstance:
        instance === undefined
          ? {
              userId: owner,
              endpointSlug: slug,
              desiredState: "RUNNING",
              observedState: "RUNNING",
              Nodes: [{ cliDeviceId: cli }],
            }
          : instance,
    },
    ExecutionTarget: { id: `et-${id}`, inferenceCapacityId: `cap-${id}` },
  };
}

function member(id: string, dm: ReturnType<typeof model>, overrides: Record<string, unknown> = {}) {
  return {
    id,
    poolId: "pool-1",
    weight: 1,
    healthStatus: "HEALTHY",
    routingStatus: "ACTIVE",
    instanceGate: "OPEN",
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
    inferenceContributionId: null,
    InferenceContribution: null,
    ModelPool: { userId: "owner" },
    ExecutionTarget: { id: dm.ExecutionTarget.id, inferenceCapacityId: "cap", DiscoveredModel: dm },
    ...overrides,
  };
}

const POOL = { id: "pool-1", ownerUserId: "owner", accessGrantId: null };

beforeEach(() => {
  vi.clearAllMocks();
  visible.targets = { directModels: [], modelPools: [] };
});

describe("recipe-managed ownership (from the database, never the slug)", () => {
  it.each([
    ["no deployment instance", null],
    [
      "another user's instance",
      {
        userId: "x",
        endpointSlug: "inst-aaaaaaaaaaaaaaaa",
        desiredState: "RUNNING",
        observedState: "RUNNING",
        Nodes: [{ cliDeviceId: "cli-1" }],
      },
    ],
    [
      "a different slug",
      {
        userId: "owner",
        endpointSlug: "inst-bbbbbbbbbbbbbbbb",
        desiredState: "RUNNING",
        observedState: "RUNNING",
        Nodes: [{ cliDeviceId: "cli-1" }],
      },
    ],
    [
      "not running",
      {
        userId: "owner",
        endpointSlug: "inst-aaaaaaaaaaaaaaaa",
        desiredState: "RUNNING",
        observedState: "UNHEALTHY",
        Nodes: [{ cliDeviceId: "cli-1" }],
      },
    ],
    [
      "stopping",
      {
        userId: "owner",
        endpointSlug: "inst-aaaaaaaaaaaaaaaa",
        desiredState: "STOPPED",
        observedState: "RUNNING",
        Nodes: [{ cliDeviceId: "cli-1" }],
      },
    ],
    [
      "no claimed rank-0 node on this CLI",
      {
        userId: "owner",
        endpointSlug: "inst-aaaaaaaaaaaaaaaa",
        desiredState: "RUNNING",
        observedState: "RUNNING",
        Nodes: [{ cliDeviceId: "cli-2" }],
      },
    ],
  ])("refuses %s", (_label, instance) => {
    expect(endpointIsRecipeManaged(model({ instance }).Endpoint as never)).toBe(false);
  });

  it("accepts the owned, running instance", () => {
    expect(endpointIsRecipeManaged(model().Endpoint as never)).toBe(true);
  });

  it("an inst- slug without ownership rows is not a candidate", async () => {
    db.poolMember.findMany.mockResolvedValue([member("m1", model({ instance: null }))]);
    expect(await poolCandidates({ pool: POOL, config: {}, activeCliDeviceIds: ["cli-1"] })).toEqual(
      [],
    );
  });
});

describe("pool candidates", () => {
  it("returns live, managed, healthy, connected members with their route identity", async () => {
    db.poolMember.findMany.mockResolvedValue([member("m1", model())]);
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      activeCliDeviceIds: ["cli-1"],
    });
    expect(candidate).toMatchObject({
      cliDeviceId: "cli-1",
      endpointSlug: "inst-aaaaaaaaaaaaaaaa",
      upstreamModel: "whisper-large",
      deploymentManaged: true,
      memberId: "m1",
      route: {
        kind: "pool",
        poolId: "pool-1",
        poolMemberId: "m1",
        executionTargetId: "et-dm-1",
        capacityId: "cap",
        ownerUserId: "owner",
      },
    });
    expect(db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ poolId: "pool-1", tier: "PRIMARY", instanceGate: "OPEN" }),
      }),
    );
  });

  it("excludes members without live capability, translations-only, overridden off, or adapter mismatch", async () => {
    const translationsOnly = {
      version: 2,
      protocol: "openai-compatible",
      audio: {
        translations: { supported: true, realtime: { supported: true, adapter: "segmented" } },
      },
    };
    db.poolMember.findMany.mockResolvedValue([
      member(
        "none",
        model({ id: "a", capabilities: { version: 2, protocol: "openai-compatible" } }),
      ),
      member("trans", model({ id: "b", capabilities: translationsOnly })),
      member("off", model({ id: "c", override: { version: 2, protocol: "openai-compatible" } })),
      member("mismatch", model({ id: "d", override: VLLM })),
    ]);
    expect(await poolCandidates({ pool: POOL, config: {}, activeCliDeviceIds: ["cli-1"] })).toEqual(
      [],
    );
  });

  it("drops vLLM members when a language or prompt is set", async () => {
    db.poolMember.findMany.mockResolvedValue([member("v", model({ capabilities: VLLM }))]);
    expect(
      await poolCandidates({
        pool: POOL,
        config: { language: "en" },
        activeCliDeviceIds: ["cli-1"],
      }),
    ).toEqual([]);
    expect(
      await poolCandidates({ pool: POOL, config: {}, activeCliDeviceIds: ["cli-1"] }),
    ).toHaveLength(1);
  });

  it("drops disconnected, half-open, disabled and invalid-contribution members", async () => {
    db.poolMember.findMany.mockResolvedValue([
      member("offline", model({ id: "a", cli: "cli-gone" })),
      member("half", model({ id: "b" }), { healthStatus: "UNHEALTHY", nextRetryAt: new Date(0) }),
      member("disabled", model({ id: "c" }), { routingStatus: "DISABLED" }),
      member("contrib", model({ id: "d" }), {
        inferenceContributionId: "ic",
        InferenceContribution: {
          state: "REVOKED",
          poolId: "pool-1",
          discoveredModelId: "d",
          contributorUserId: "owner",
        },
      }),
      member("foreign", model({ id: "e", owner: "someone" })),
      member("ok", model({ id: "f" })),
    ]);
    const candidates = await poolCandidates({
      pool: POOL,
      config: {},
      activeCliDeviceIds: ["cli-1"],
    });
    expect(candidates.map((candidate) => candidate.memberId)).toEqual(["ok"]);
  });
});

describe("direct candidates and model resolution", () => {
  it("routes a managed direct model and refuses an unmanaged one", async () => {
    db.discoveredModel.findUnique.mockResolvedValueOnce(model());
    expect(
      await directCandidates({ target: { id: "dm-1" }, config: {}, activeCliDeviceIds: ["cli-1"] }),
    ).toMatchObject([{ route: { kind: "direct", poolMemberId: null, ownerUserId: "owner" } }]);
    db.discoveredModel.findUnique.mockResolvedValueOnce(model({ instance: null }));
    expect(
      await directCandidates({ target: { id: "dm-1" }, config: {}, activeCliDeviceIds: ["cli-1"] }),
    ).toEqual([]);
  });

  it("maps unknown models to model_not_found and :external to external_variant_unsupported", async () => {
    visible.targets = {
      directModels: [],
      modelPools: [
        {
          target: "MODEL_POOL",
          id: "pool-1",
          modelId: "owner/asr",
          ownerUserId: "owner",
          accessGrantId: null,
        },
      ],
    };
    const token = { id: "t", userId: "u", scopeMode: "ALL_VISIBLE" as const, allowExternal: true };
    expect(await resolveRealtimeModel({ kind: "token", token }, "nope")).toEqual({
      error: "model_not_found",
    });
    expect(await resolveRealtimeModel({ kind: "token", token }, "owner/asr:external")).toEqual({
      error: "external_variant_unsupported",
    });
    expect(await resolveRealtimeModel({ kind: "token", token }, "owner/asr")).toMatchObject({
      kind: "pool",
    });
  });

  it("reports a configuration refusal without touching member health", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = createRealtimeRouter({
      access: {
        kind: "token",
        token: { id: "t", userId: "u", scopeMode: "ALL_VISIBLE", allowExternal: false },
      },
      activeCliDeviceIds: () => [],
    });
    router.memberMisconfigured?.(
      {
        cliDeviceId: "cli-1",
        endpointSlug: "inst-aaaaaaaaaaaaaaaa",
        upstreamModel: "m",
        capabilities: null,
        deploymentManaged: true,
        memberId: "m1",
      },
      "unsupported_capability",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(health.recordPoolMemberRelayFailure).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the router reports no_live_member and records health only for pool members", async () => {
    visible.targets = {
      directModels: [],
      modelPools: [
        {
          target: "MODEL_POOL",
          id: "pool-1",
          modelId: "owner/asr",
          ownerUserId: "owner",
          accessGrantId: null,
        },
      ],
    };
    db.poolMember.findMany.mockResolvedValue([]);
    const resolved = vi.fn();
    const router = createRealtimeRouter({
      access: {
        kind: "token",
        token: { id: "t", userId: "u", scopeMode: "ALL_VISIBLE", allowExternal: false },
      },
      activeCliDeviceIds: () => ["cli-1"],
      onResolved: resolved,
    });
    const signal = new AbortController().signal;
    expect(await router.candidates({ model: "owner/asr", config: {}, signal })).toEqual({
      ok: false,
      code: "no_live_member",
    });
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ kind: "pool" }), "owner/asr");
    db.poolMember.findMany.mockResolvedValue([member("m1", model())]);
    const routed = await router.candidates({ model: "owner/asr", config: {}, signal });
    if (!routed.ok) throw new Error("no route");
    const [candidate] = routed.candidates;
    if (!candidate) throw new Error("no candidate");
    router.memberOpenFailed(candidate, "upstream_5xx");
    expect(health.recordPoolMemberRelayFailure).toHaveBeenCalledWith({
      poolMemberId: "m1",
      failure: "upstream_5xx",
      trialStartedAt: null,
    });
    router.memberOpenFailed({ ...candidate, route: undefined }, "timeout");
    expect(health.recordPoolMemberRelayFailure).toHaveBeenCalledTimes(1);
  });
});

describe("access rechecks", () => {
  const token = {
    id: "t",
    userId: "u",
    scopeMode: "ALL_VISIBLE",
    allowExternal: false,
    revokedAt: null,
    expiresAt: null,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
  };
  const poolTarget = {
    target: "MODEL_POOL",
    id: "pool-1",
    modelId: "owner/asr",
    ownerUserId: "owner",
    accessGrantId: null,
  };

  async function opened() {
    visible.targets = { directModels: [], modelPools: [poolTarget] };
    db.poolMember.findMany.mockResolvedValue([member("m1", model())]);
    const [candidate] = await poolCandidates({
      pool: POOL,
      config: {},
      activeCliDeviceIds: ["cli-1"],
    });
    if (!candidate) throw new Error("no candidate");
    return {
      credential: { kind: "token" as const, tokenId: "t" },
      userId: "u",
      model: "owner/asr",
      resolved: { kind: "pool" as const, target: poolTarget as never },
      candidate,
      config: {},
    };
  }

  it("passes while everything still holds", async () => {
    const input = await opened();
    db.modelApiToken.findUnique.mockResolvedValue(token);
    db.poolMember.findFirst.mockResolvedValue(member("m1", model()));
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
    db.modelApiToken.findUnique.mockResolvedValue({ ...token, ...change });
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "credential" });
  });

  it.each([
    ["requester", "credential"],
    ["access", "model"],
    ["member", "member"],
  ] as const)("denies when the shared send check says %s", async (denied, reason) => {
    const input = await opened();
    db.modelApiToken.findUnique.mockResolvedValue(token);
    db.poolMember.findFirst.mockResolvedValue(member("m1", model()));
    const permission = vi.fn(async () => denied);
    expect(await recheckRealtimeAccess({ ...input, permission })).toEqual({ ok: false, reason });
    expect(permission).toHaveBeenCalledWith({ tokenId: "t", userId: "u" }, input.candidate);
  });

  it("propagates a failed send check (the registry skips that sweep)", async () => {
    const input = await opened();
    db.modelApiToken.findUnique.mockResolvedValue(token);
    db.poolMember.findFirst.mockResolvedValue(member("m1", model()));
    await expect(
      recheckRealtimeAccess({
        ...input,
        permission: async () => {
          throw new Error("lock timeout");
        },
      }),
    ).rejects.toThrow();
  });

  it("denies a model no longer visible and a member no longer managed", async () => {
    const input = await opened();
    db.modelApiToken.findUnique.mockResolvedValue(token);
    visible.targets = { directModels: [], modelPools: [] };
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "model" });
    visible.targets = { directModels: [], modelPools: [poolTarget] };
    db.poolMember.findFirst.mockResolvedValue(member("m1", model({ instance: null })));
    expect(await recheckRealtimeAccess({ ...input, permission: async () => null })).toEqual({
      ok: false,
      reason: "member",
    });
    db.poolMember.findFirst.mockResolvedValue(null);
    expect(await recheckRealtimeAccess(input)).toEqual({ ok: false, reason: "member" });
  });

  it("rechecks a Chat Test session by its dashboard session, with the user's models and no token", async () => {
    const input = await opened();
    const dashboard = {
      ...input,
      credential: { kind: "dashboard" as const, sessionId: "sess-1" },
      userId: "u",
    };
    db.modelApiToken.findUnique.mockReset();
    db.poolMember.findFirst.mockResolvedValue(member("m1", model()));
    userTargets.calls = [];
    const dashboardSession = vi.fn(async () => "ok" as const);
    const permission = vi.fn(async () => null);
    expect(await recheckRealtimeAccess({ ...dashboard, dashboardSession, permission })).toEqual({
      ok: true,
    });
    expect(dashboardSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", userId: "u" }),
    );
    expect(userTargets.calls).toEqual(["u"]);
    expect(permission).toHaveBeenCalledWith({ tokenId: null, userId: "u" }, input.candidate);
    expect(db.modelApiToken.findUnique).not.toHaveBeenCalled();
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

  it("resolves a Chat Test model among every model the user can see", async () => {
    visible.targets = { directModels: [], modelPools: [poolTarget] };
    userTargets.calls = [];
    expect(
      await resolveRealtimeModel({ kind: "dashboard", userId: "u" }, "owner/asr"),
    ).toMatchObject({ kind: "pool" });
    expect(
      await resolveRealtimeModel({ kind: "dashboard", userId: "u" }, "owner/asr:external"),
    ).toEqual({ error: "external_variant_unsupported" });
    expect(userTargets.calls).toEqual(["u", "u"]);
  });
});
