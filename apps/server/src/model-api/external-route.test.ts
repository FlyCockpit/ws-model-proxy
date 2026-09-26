import type {
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true },
}));

const {
  evaluateExternalEgress,
  externalDenialError,
  externalRouteErrorResponse,
  isIssuedExternalConsent,
  resolveRequestedModelName,
  splitModelVariant,
  withResponseHeaders,
} = await import("./external-route.js");

const pool: VisibleModelPoolTarget = {
  target: "MODEL_POOL",
  id: "pool-id",
  modelId: "owner/pool.v2",
  name: "Pool",
  description: null,
  ownerUserId: "owner-id",
  ownerUserSlug: "owner",
  accessGrantId: null,
  poolSlug: "pool.v2",
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  fallbackEnabled: true,
  fallbackForGrantees: false,
  externalMemberCount: 1,
  effectiveProviderEgress: true,
  providerAccountLabels: [],
  allowLossyDeveloperRoleCollapse: false,
  recommendedSurfaceOverride: null,
};

const direct: VisibleDirectModelTarget = {
  target: "DIRECT_MODEL",
  id: "direct-id",
  modelId: "owner/cli/endpoint/qwen3%3A8b",
  upstreamModelId: "qwen3:8b",
  ownerUserId: "owner-id",
  ownerUserSlug: "owner",
  endpointId: "endpoint-id",
  endpointSlug: "endpoint",
  cliDeviceSlug: "cli",
  maxAttachmentBytes: null,
};

const targets = { directModels: [direct], modelPools: [pool] };

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

  it("resolves plain and :external names of visible pools and exact direct ids", () => {
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
      kind: "direct",
      target: { id: "direct-id" },
    });
  });

  it.each([
    ["an unknown variant", "owner/pool.v2:fallback"],
    ["an uppercase variant", "owner/pool.v2:External"],
    ["a stacked variant", "owner/pool.v2:external:external"],
    ["an empty variant", "owner/pool.v2:"],
    ["a suffix on a direct id", `${direct.modelId}:external`],
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
    // A sloppy raw colon in a direct id is not a pool variant.
    expect(resolveRequestedModelName(targets, "owner/cli/endpoint/qwen3:8b")).toEqual({
      kind: "not_found",
    });
  });
});

describe("egress gate", () => {
  const owner = { userId: "owner-id", source: "API_TOKEN" as const, modelApiTokenId: "token" };
  const grantee = { userId: "grantee-id", source: "API_TOKEN" as const, modelApiTokenId: "token" };

  type Case = {
    switchOn: boolean;
    requested: boolean;
    tokenPermits: boolean;
    fallbackEnabled: boolean;
    requesterIsOwner: boolean;
    fallbackForGrantees: boolean;
  };
  const cases: Case[] = [];
  for (const switchOn of [true, false])
    for (const requested of [true, false])
      for (const tokenPermits of [true, false])
        for (const fallbackEnabled of [true, false])
          for (const requesterIsOwner of [true, false])
            for (const fallbackForGrantees of [true, false])
              cases.push({
                switchOn,
                requested,
                tokenPermits,
                fallbackEnabled,
                requesterIsOwner,
                fallbackForGrantees,
              });

  it.each(cases)(
    "grants only when every condition holds: %o",
    ({
      switchOn,
      requested,
      tokenPermits,
      fallbackEnabled,
      requesterIsOwner,
      fallbackForGrantees,
    }) => {
      const decision = evaluateExternalEgress({
        requested,
        requester: requesterIsOwner ? owner : grantee,
        tokenPermitsPool: tokenPermits,
        pool: { ...pool, fallbackEnabled, fallbackForGrantees },
        deploymentSwitchEnabled: switchOn,
      });
      const expected =
        switchOn &&
        requested &&
        tokenPermits &&
        fallbackEnabled &&
        (requesterIsOwner || fallbackForGrantees);
      expect(decision.granted).toBe(expected);
      if (decision.granted) {
        expect(isIssuedExternalConsent(decision.consent)).toBe(true);
        expect(decision.consent).toMatchObject({
          poolId: "pool-id",
          ownerUserId: "owner-id",
          requesterIsOwner,
        });
      }
    },
  );

  it("reports denials in gate order so the caller sees the right error", () => {
    const deny = (overrides: Partial<Parameters<typeof evaluateExternalEgress>[0]>) => {
      const decision = evaluateExternalEgress({
        requested: true,
        requester: grantee,
        tokenPermitsPool: false,
        pool: { ...pool, fallbackEnabled: false },
        deploymentSwitchEnabled: false,
        ...overrides,
      });
      return decision.granted ? "GRANTED" : decision.denial;
    };
    expect(deny({ requested: false })).toBe("NOT_REQUESTED");
    expect(deny({})).toBe("DEPLOYMENT_DISABLED");
    expect(deny({ deploymentSwitchEnabled: true })).toBe("TOKEN_NOT_PERMITTED");
    expect(deny({ deploymentSwitchEnabled: true, tokenPermitsPool: true })).toBe(
      "POOL_FALLBACK_DISABLED",
    );
    expect(
      deny({
        deploymentSwitchEnabled: true,
        tokenPermitsPool: true,
        pool: { ...pool, fallbackEnabled: true },
      }),
    ).toBe("GRANTEE_NOT_COVERED");
  });

  it("treats a signed-in Chat Test user as consenting and MCP as unsupported", () => {
    const chatTest = evaluateExternalEgress({
      requested: true,
      requester: { userId: "owner-id", source: "CHAT_TEST", modelApiTokenId: null },
      tokenPermitsPool: false,
      pool,
    });
    expect(chatTest.granted).toBe(true);
    for (const source of ["MCP", "TRANSFORMER"] as const) {
      const decision = evaluateExternalEgress({
        requested: true,
        requester: { userId: "owner-id", source, modelApiTokenId: null },
        tokenPermitsPool: true,
        pool,
      });
      expect(decision).toEqual({ granted: false, denial: "SOURCE_UNSUPPORTED" });
    }
    // An API token requester without a token id never consents.
    expect(
      evaluateExternalEgress({
        requested: true,
        requester: { userId: "owner-id", source: "API_TOKEN", modelApiTokenId: null },
        tokenPermitsPool: true,
        pool,
      }),
    ).toEqual({ granted: false, denial: "TOKEN_NOT_PERMITTED" });
  });

  it("never treats a structurally identical object as an issued consent", () => {
    const decision = evaluateExternalEgress({
      requested: true,
      requester: owner,
      tokenPermitsPool: true,
      pool,
    });
    if (!decision.granted) throw new Error("expected consent");
    expect(isIssuedExternalConsent({ ...decision.consent })).toBe(false);
    expect(isIssuedExternalConsent(null)).toBe(false);
  });

  it("maps stopping denials to errors that name the plain pool name", () => {
    expect(externalDenialError("DEPLOYMENT_DISABLED", pool)).toMatchObject({
      code: "external_providers_disabled",
      message: expect.stringContaining('"owner/pool.v2"'),
    });
    expect(externalDenialError("TOKEN_NOT_PERMITTED", pool)).toMatchObject({
      code: "external_not_permitted",
    });
    expect(externalDenialError("SOURCE_UNSUPPORTED", pool)).toMatchObject({
      code: "external_not_supported_for_mcp",
    });
    // Owner-side denials serve locally with `x-wsmp-fallback: unavailable`.
    expect(externalDenialError("POOL_FALLBACK_DISABLED", pool)).toBeNull();
    expect(externalDenialError("GRANTEE_NOT_COVERED", pool)).toBeNull();
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

  it("adds route headers and exposes them to browsers without touching the body", async () => {
    const response = withResponseHeaders(
      new Response("body", {
        status: 201,
        headers: { "access-control-expose-headers": "x-wsmp-transform" },
      }),
      { "x-wsmp-route": "pool-external", "x-wsmp-served-model": "gpt-upstream" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-wsmp-route")).toBe("pool-external");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-wsmp-transform, x-wsmp-route, x-wsmp-served-model",
    );
    await expect(response.text()).resolves.toBe("body");
  });
});
