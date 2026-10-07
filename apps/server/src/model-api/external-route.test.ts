import { describe, expect, it, vi } from "vitest";
import type { CallablePool, TestTarget } from "./resolve.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true },
}));

// Tests flip the mocked deployment switch; production reads only `env`.
const { env: testEnv } = (await import("@ws-model-proxy/env/server")) as unknown as {
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: boolean };
};
function withSwitch<T>(on: boolean, run: () => T): T {
  const previous = testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED;
  testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = on;
  try {
    return run();
  } finally {
    testEnv.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = previous;
  }
}

const {
  evaluateExternalEgress,
  externalDenialError,
  externalRouteErrorResponse,
  isIssuedExternalConsent,
  resolveRequestedModelName,
  splitModelVariant,
  withResponseHeaders,
} = await import("./external-route.js");

const pool: CallablePool = {
  target: "POOL",
  id: "pool-id",
  modelId: "owner/pool.v2",
  name: "Pool",
  description: null,
  modelType: "LLM",
  ownerUserId: "owner-id",
  ownerUserSlug: "owner",
  poolSlug: "pool.v2",
  shareId: null,
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
  fallbackMode: "OWNER",
  externalMemberCount: 1,
  externalEquivalentModel: null,
  embeddingContract: null,
  paidWarmProtection: false,
  ownKeyProviderModelId: null,
};

const direct: TestTarget = {
  target: "TEST",
  id: "runtime-model-id",
  modelId: "runtime:rt_1:qwen3:8b",
  runtimeId: "rt_1",
  upstreamModelId: "qwen3:8b",
  ownerUserId: "owner-id",
  ownerUserSlug: "owner",
  maxAttachmentBytes: null,
};

const targets = { tests: [direct], pools: [pool] };

describe("model name grammar", () => {
  it("splits at the first colon only", () => {
    expect(splitModelVariant("owner/pool")).toEqual({ base: "owner/pool", variant: null });
    expect(splitModelVariant("owner/pool:external")).toEqual({
      base: "owner/pool",
      variant: "external",
    });
    expect(splitModelVariant("owner/pool:external:external")).toEqual({
      base: "owner/pool",
      variant: "external:external",
    });
  });

  it("resolves plain and :external names of visible pools and exact TEST names", () => {
    expect(resolveRequestedModelName(targets, "owner/pool.v2")).toMatchObject({
      kind: "pool",
      externalRequested: false,
    });
    expect(resolveRequestedModelName(targets, "owner/pool.v2:external")).toMatchObject({
      kind: "pool",
      target: { id: "pool-id" },
      externalRequested: true,
    });
    expect(resolveRequestedModelName(targets, direct.modelId)).toMatchObject({
      kind: "test",
      target: { id: "runtime-model-id" },
    });
  });

  it("resolves the caller's aliases, never over a callable ID, only to callable pools", () => {
    const withAliases = {
      ...targets,
      aliases: [
        { name: "gpt-4o", poolId: "pool-id" },
        { name: "qwen3:8b", poolId: "pool-id" },
        { name: "owner/pool.v2", poolId: "other-pool" },
        { name: "ghost", poolId: "invisible-pool" },
      ],
    };
    expect(resolveRequestedModelName(withAliases, "gpt-4o")).toMatchObject({
      kind: "pool",
      target: { id: "pool-id" },
      externalRequested: false,
    });
    expect(resolveRequestedModelName(withAliases, "gpt-4o:external")).toMatchObject({
      kind: "pool",
      externalRequested: true,
    });
    expect(resolveRequestedModelName(withAliases, "qwen3:8b")).toMatchObject({ kind: "pool" });
    expect(resolveRequestedModelName(withAliases, "qwen3:8b:external")).toMatchObject({
      kind: "pool",
      externalRequested: true,
    });
    // The callable ID wins over an alias of the same name.
    expect(resolveRequestedModelName(withAliases, "owner/pool.v2")).toMatchObject({
      target: { id: "pool-id" },
    });
    expect(resolveRequestedModelName(withAliases, "ghost")).toEqual({ kind: "not_found" });
    // Also in the :external form, the callable ID wins.
    expect(resolveRequestedModelName(withAliases, "owner/pool.v2:external")).toMatchObject({
      target: { id: "pool-id" },
      externalRequested: true,
    });
  });

  it.each([
    ["an unknown variant", "owner/pool.v2:fallback"],
    ["an uppercase variant", "owner/pool.v2:External"],
    ["a stacked variant", "owner/pool.v2:external:external"],
    ["an empty variant", "owner/pool.v2:"],
  ])("rejects %s with a helpful model_not_found", (_label, model) => {
    const resolution = resolveRequestedModelName(targets, model);
    expect(resolution).toMatchObject({ kind: "error", error: { code: "model_not_found" } });
    if (resolution.kind !== "error") throw new Error("expected an error resolution");
    expect(resolution.error.message.length).toBeGreaterThan(20);
  });

  it("never reveals whether an invisible pool exists", () => {
    expect(resolveRequestedModelName(targets, "stranger/secret:external")).toEqual({
      kind: "not_found",
    });
    expect(resolveRequestedModelName(targets, "stranger/secret:bogus")).toEqual({
      kind: "not_found",
    });
    // A TEST name takes no variant, and an unknown runtime is not found.
    expect(resolveRequestedModelName(targets, `${direct.modelId}:external`)).toEqual({
      kind: "not_found",
    });
    expect(resolveRequestedModelName(targets, "runtime:rt_2:qwen3:8b")).toEqual({
      kind: "not_found",
    });
  });
});

describe("egress gate", () => {
  const owner = { userId: "owner-id", source: "API_KEY" as const, apiKeyId: "key" };
  const grantee = { userId: "grantee-id", source: "API_KEY" as const, apiKeyId: "key" };

  type Case = {
    switchOn: boolean;
    requested: boolean;
    fallbackMode: CallablePool["fallbackMode"];
    requesterIsOwner: boolean;
  };
  const cases: Case[] = [];
  for (const switchOn of [true, false])
    for (const requested of [true, false])
      for (const fallbackMode of ["OFF", "OWNER", "OWNER_AND_SHARES"] as const)
        for (const requesterIsOwner of [true, false])
          cases.push({ switchOn, requested, fallbackMode, requesterIsOwner });

  it.each(cases)(
    "grants only when every condition holds: %o",
    ({ switchOn, requested, fallbackMode, requesterIsOwner }) => {
      const decision = withSwitch(switchOn, () =>
        evaluateExternalEgress({
          requested,
          requester: requesterIsOwner ? owner : grantee,
          pool: { ...pool, fallbackMode, shareId: requesterIsOwner ? null : "share" },
        }),
      );
      const expected =
        switchOn &&
        requested &&
        fallbackMode !== "OFF" &&
        (requesterIsOwner || fallbackMode === "OWNER_AND_SHARES");
      expect(decision.granted).toBe(expected);
      if (decision.granted) {
        expect(isIssuedExternalConsent(decision.consent)).toBe(true);
        expect(decision.consent).toMatchObject({
          poolId: "pool-id",
          ownerUserId: "owner-id",
          requesterIsOwner,
          apiKeyId: "key",
          shareId: requesterIsOwner ? null : "share",
        });
      }
    },
  );

  it("reports denials in gate order so the caller sees the right error", () => {
    const deny = (
      switchOn: boolean,
      overrides: Partial<Parameters<typeof evaluateExternalEgress>[0]> = {},
    ) => {
      const decision = withSwitch(switchOn, () =>
        evaluateExternalEgress({
          requested: true,
          requester: grantee,
          pool: { ...pool, shareId: "share", fallbackMode: "OFF" },
          ...overrides,
        }),
      );
      return decision.granted ? "GRANTED" : decision.denial;
    };
    expect(deny(false, { requested: false })).toBe("NOT_REQUESTED");
    expect(deny(false)).toBe("DEPLOYMENT_DISABLED");
    expect(deny(true, { requester: { ...grantee, source: "AGENT_TEST", apiKeyId: null } })).toBe(
      "SOURCE_UNSUPPORTED",
    );
    expect(deny(true)).toBe("POOL_FALLBACK_DISABLED");
    expect(deny(true, { pool: { ...pool, shareId: "share", fallbackMode: "OWNER" } })).toBe(
      "SHARE_NOT_COVERED",
    );
  });

  it("treats a signed-in Test page user as consenting and agent tests and sidecars as unsupported", () => {
    const test = evaluateExternalEgress({
      requested: true,
      requester: { userId: "owner-id", source: "TEST", apiKeyId: null },
      pool,
    });
    expect(test.granted).toBe(true);
    for (const source of ["AGENT_TEST", "SIDECAR"] as const) {
      const decision = evaluateExternalEgress({
        requested: true,
        requester: { userId: "owner-id", source, apiKeyId: null },
        pool,
      });
      expect(decision).toEqual({ granted: false, denial: "SOURCE_UNSUPPORTED" });
    }
  });

  it("never treats a structurally identical object as an issued consent", () => {
    const decision = evaluateExternalEgress({ requested: true, requester: owner, pool });
    if (!decision.granted) throw new Error("expected consent");
    expect(isIssuedExternalConsent({ ...decision.consent })).toBe(false);
    expect(isIssuedExternalConsent(null)).toBe(false);
  });

  it("maps stopping denials to errors that name the plain pool name", () => {
    expect(externalDenialError("DEPLOYMENT_DISABLED", pool)).toMatchObject({
      code: "external_providers_disabled",
      message: expect.stringContaining('"owner/pool.v2"'),
    });
    expect(externalDenialError("SOURCE_UNSUPPORTED", pool)).toMatchObject({
      code: "external_not_supported_for_mcp",
    });
    // Owner-side denials serve locally with `x-wsmp-fallback: unavailable`.
    expect(externalDenialError("POOL_FALLBACK_DISABLED", pool)).toBeNull();
    expect(externalDenialError("SHARE_NOT_COVERED", pool)).toBeNull();
  });
});

describe("client-facing errors and headers", () => {
  it("renders the switch-off error in the OpenAI and Anthropic shapes", async () => {
    const error = { code: "external_providers_disabled" as const, message: "disabled" };
    const openAi = externalRouteErrorResponse("chat.completions", error);
    expect(openAi.status).toBe(403);
    await expect(openAi.json()).resolves.toEqual({
      error: {
        message: "disabled",
        type: "permission_error",
        param: null,
        code: "external_providers_disabled",
      },
    });
    const anthropic = externalRouteErrorResponse("messages", error);
    expect(anthropic.status).toBe(403);
    await expect(anthropic.json()).resolves.toEqual({
      type: "error",
      error: { type: "permission_error", message: "disabled" },
    });
  });

  it("D9: renders the data-policy refusal as a 503 in both surface shapes", async () => {
    const error = { code: "provider_data_policy_unavailable" as const, message: "no endpoint" };
    const openAi = externalRouteErrorResponse("chat.completions", error);
    expect(openAi.status).toBe(503);
    await expect(openAi.json()).resolves.toMatchObject({
      error: { code: "provider_data_policy_unavailable", message: "no endpoint" },
    });
    const anthropic = externalRouteErrorResponse("messages", error);
    expect(anthropic.status).toBe(503);
    await expect(anthropic.json()).resolves.toEqual({
      type: "error",
      error: { type: "api_error", message: "no endpoint" },
    });
  });

  it("adds route headers and exposes them to browsers without touching the body", async () => {
    const response = withResponseHeaders(
      new Response("body", {
        status: 201,
        headers: { "access-control-expose-headers": "x-wsmp-transform" },
      }),
      { "x-wsmp-route": "pool-fallback", "x-wsmp-served-model": "gpt-upstream" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-wsmp-route")).toBe("pool-fallback");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-wsmp-transform, x-wsmp-route, x-wsmp-served-model",
    );
    await expect(response.text()).resolves.toBe("body");
  });
});

describe("own-key initial E0", () => {
  const input = () => ({
    requested: true,
    requester: { userId: "grantee", source: "API_KEY" as const, apiKeyId: "key" },
    pool: {
      ...pool,
      shareId: "exact-share",
      externalEquivalentModel: "vendor/model",
      ownKeyProviderModelId: "own-model",
      fallbackMode: "OFF" as CallablePool["fallbackMode"],
    },
  });
  it("permits a share holder's own key independently of the owner-paid fallback mode", () => {
    expect(evaluateExternalEgress(input())).toMatchObject({
      granted: true,
      consent: { ownKeyProviderModelId: "own-model", shareId: "exact-share" },
    });
  });
  it.each(["suffix", "switch", "share", "equivalent", "preference", "owner", "agent"])(
    "refuses when %s is absent",
    (condition) => {
      const request = input();
      if (condition === "suffix") request.requested = false;
      if (condition === "share") Object.assign(request.pool, { shareId: null });
      if (condition === "equivalent")
        Object.assign(request.pool, { externalEquivalentModel: null });
      if (condition === "preference") Object.assign(request.pool, { ownKeyProviderModelId: null });
      if (condition === "owner") request.requester.userId = pool.ownerUserId;
      if (condition === "agent") Object.assign(request.requester, { source: "AGENT_TEST" });
      const result = withSwitch(condition !== "switch", () => evaluateExternalEgress(request));
      expect(result.granted).toBe(false);
    },
  );
});
