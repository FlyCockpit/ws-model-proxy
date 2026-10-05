// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutationCalls: [] as string[],
  mutationPayloads: [] as Array<{ name: string; input: unknown }>,
  nextReject: null as { name: string; error: unknown } | null,
  cliDevices: [] as Array<Record<string, unknown>>,
  capabilityImpact: [] as Array<{ id: string; slug: string; surface: string }>,
  activityInputs: [] as Array<{ cliDeviceId: string } | undefined>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Forward interpolation options so toast assertions can verify exactly
    // which variables (slugs, not count) reach the translated message.
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Covered by cli-device-metric-sources.dom.test.tsx.
vi.mock("@/components/cli-device-metric-sources", () => ({
  CliDeviceMetricSources: () => null,
}));
vi.mock("@/components/cli-device-engine-adapters", () => ({
  CliDeviceEngineAdapters: () => null,
}));
vi.mock("@/components/cli-device-node-card", () => ({
  CliDeviceNodeCard: () => null,
}));

vi.mock("@/utils/orpc", () => {
  const query = (key: string, data: unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data, initialData: data }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      mutationFn: async (input: unknown) => {
        state.mutationCalls.push(name);
        state.mutationPayloads.push({ name, input });
        if (state.nextReject?.name === name) {
          const error = state.nextReject.error;
          state.nextReject = null;
          throw error;
        }
        if (name === "addPoolMember") return { id: "member-1", executionTargetId: "target-1" };
        if (name === "updateDiscoveredModelCapabilities")
          return { impactedPools: state.capabilityImpact };
        if (name === "setDiscoveredModelCapabilityProfile")
          return { impactedPools: state.capabilityImpact };
        if (name === "renameCliDevice") {
          const renamed = (input as { name: string | null }).name;
          return { cliDeviceId: "cli-1", name: renamed, displayName: renamed ?? "desk-01.local" };
        }
        if (name === "removeDiscoveredModelMetadata")
          return { deleted: true, impactedPools: state.capabilityImpact };
        return { id: "pool-1" };
      },
      ...options,
    }),
  });
  return {
    orpc: {
      appConfig: query("appConfig", { capacityEnabled: false }),
      // The Agent activity section reads only once a device's section is opened.
      cliAgentActivity: {
        list: {
          infiniteOptions: (options: {
            initialPageParam: string | undefined;
            getNextPageParam: (page: { nextCursor: string | null }) => string | undefined;
            input?: (cursor: string | undefined) => { cliDeviceId: string };
          }) => ({
            queryKey: ["cliAgentActivity"],
            queryFn: async (context?: { pageParam?: string }) => {
              state.activityInputs.push(options.input?.(context?.pageParam));
              return { events: [], nextCursor: null };
            },
            initialPageParam: options.initialPageParam,
            getNextPageParam: options.getNextPageParam,
          }),
        },
      },
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listCliDevices: {
          queryOptions: () => ({
            queryKey: ["cliDevices"],
            queryFn: async () => state.cliDevices,
            initialData: state.cliDevices,
          }),
        },
        updateModelPool: mutation("updateModelPool"),
        addPoolMember: mutation("addPoolMember"),
        updatePoolMember: mutation("updatePoolMember"),
        removeCliDeviceMetadata: mutation("removeCliDeviceMetadata"),
        removeEndpointMetadata: mutation("removeEndpointMetadata"),
        removeDiscoveredModelMetadata: mutation("removeDiscoveredModelMetadata"),
        updateDiscoveredModelCapabilities: mutation("updateDiscoveredModelCapabilities"),
        setDiscoveredModelCapabilityProfile: mutation("setDiscoveredModelCapabilityProfile"),
        updateDiscoveredModelAttachmentLimit: mutation("updateDiscoveredModelAttachmentLimit"),
        setCliDeviceFeatureGrants: mutation("setCliDeviceFeatureGrants"),
        renameCliDevice: mutation("renameCliDevice"),
        cacheAffinityStats: query("affinity", { activeRecords: 0, targets: [] }),
        clearCacheAffinity: mutation("clearCacheAffinity"),
        grantPoolAccessByEmail: mutation("grantPoolAccessByEmail"),
      },
      adminObservability: { key: () => ["adminObservability"] },
      capacityManagement: {
        key: () => ["capacityManagement"],
        list: query("capacities", []),
        updateMemberPolicy: mutation("updateMemberPolicy"),
        updateDirectPolicy: mutation("updateDirectPolicy"),
      },
    },
  };
});

import { grantPoolAccessServerMessages } from "@ws-model-proxy/api/lib/effective-provider-egress";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppMutationCache } from "@/utils/mutation-error-toast";
import {
  CliEndpointsModelsSection,
  GrantPoolDialog,
  PoolForm,
  PoolMemberForm,
} from "./forwarder-dashboard-sections";

const cliDeviceWithModel = {
  id: "cli-1",
  slug: "desk",
  name: null,
  reportedHostname: "desk-01.local",
  displayName: "desk-01.local",
  status: "ONLINE",
  isStale: false,
  inventoryConfirmed: true,
  inventoryAcknowledgedAt: new Date("2026-01-01"),
  inventorySeq: 1,
  endpoints: [
    {
      id: "endpoint-1",
      slug: "local",
      label: "Local",
      status: "ONLINE",
      kind: "OPENAI",
      published: true,
      lastSeenAt: new Date("2026-01-01"),
      capabilityMetadata: null,
      failureReasonCode: null,
      models: [
        {
          id: "model-1",
          canonicalModelId: "owner/desk/local/example",
          upstreamModelId: "example",
          lastSeenAt: new Date("2026-01-01"),
          published: true,
          suggestedConnectionType: null,
          capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
          capabilityOverrideMetadata: null,
          capabilityOverrides: [],
          effectiveCapabilities: { coarse: [] },
          maxAttachmentBytes: null,
        },
      ],
    },
  ],
};

const editablePool = {
  id: "pool-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  slug: "primary",
  name: "Primary",
  description: null,
  canonicalModelId: "owner/pool/primary",
  grants: [],
  members: [],
  compatibility: {
    recommendedSurface: null,
    suggestedConnectionType: null,
    warnings: [],
    surfaces: {
      ANTHROPIC_MESSAGES: {
        native: 0,
        adapted: 0,
        unavailable: 0,
        streaming: false,
        limitations: [],
        primary: { native: 0, adapted: 0, unavailable: 0 },
        publicOverflow: { native: 0, adapted: 0, unavailable: 0 },
      },
      OPENAI_CHAT_COMPLETIONS: {
        native: 0,
        adapted: 0,
        unavailable: 0,
        streaming: false,
        limitations: [],
        primary: { native: 0, adapted: 0, unavailable: 0 },
        publicOverflow: { native: 0, adapted: 0, unavailable: 0 },
      },
      OPENAI_RESPONSES: {
        native: 0,
        adapted: 0,
        unavailable: 0,
        streaming: false,
        limitations: [],
        primary: { native: 0, adapted: 0, unavailable: 0 },
        publicOverflow: { native: 0, adapted: 0, unavailable: 0 },
      },
    },
  },
  transformer: {
    discoveredModelId: null,
    images: true,
    audio: false,
    video: false,
    cacheMode: "OFF" as const,
    systemPrompt: null,
    includePrimaryTools: false,
    maxTools: 32,
    maxToolChars: 8000,
    timeoutMs: null,
    maxAssets: null,
    model: null,
  },
  maxAttachmentBytes: null,
  optimisticBasicTranscription: false,
  protocolAdaptationEnabled: false,
  allowLossyDeveloperRoleCollapse: false,
  fallbackEnabled: false,
  fallbackForGrantees: false,
  externalAfterWaitMs: 2_000,
  paidWarmProtectionEnabled: false,
  embeddingContract: null,
  effectiveProviderEgress: false,
  recommendedSurfaceOverride: null as
    | "ANTHROPIC_MESSAGES"
    | "OPENAI_CHAT_COMPLETIONS"
    | "OPENAI_RESPONSES"
    | null,
  capacityPriority: 16,
  capacityConcurrencyLimit: 1,
  capacityReservedSlots: 0,
  capacityWaitBudgetMs: 30_000,
  capacityContextCeiling: 32_768,
  capacityContextMargin: 1_024,
  capacityBorrowPolicy: "WHEN_IDLE" as const,
  cacheHolderWaitMs: null as number | null,
  protection: {
    enabled: true,
    evictionFeedbackEnabled: true,
    windowSeconds: 300,
    minTokens: 8192,
    share: "EQUAL_SHARE" as "EQUAL_SHARE" | "FIRST_COME" | "FIXED_PERCENT",
    fixedPercent: null as number | null,
    ownerPercent: null as number | null,
  },
  affinity: {
    enabled: false,
    ttlSeconds: 3600,
    maxRecords: 10_000,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 150,
    loadPenaltyWeight: 100,
    residencyWeight: 100,
  },
};

function mount(
  _protocolAdaptationAvailable = true,
  options: {
    capacityAvailability?: "enabled" | "disabled";
    pool?: typeof editablePool;
    sections?: Array<"identity" | "routing" | "capacity" | "media">;
  } = {},
) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PoolForm
        pool={options.pool ?? editablePool}
        directModels={[]}
        capacities={[]}
        capacityAvailability={options.capacityAvailability ?? "enabled"}
        sections={options.sections}
        onSuccess={() => undefined}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.mutationCalls = [];
  state.mutationPayloads = [];
  state.nextReject = null;
  state.cliDevices = [];
  state.capabilityImpact = [];
  state.activityInputs = [];
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

describe("PoolForm capacity limits", () => {
  it("applies a preset and saves a No limit switch as null", async () => {
    mount(true, { sections: ["capacity"] });

    fireEvent.click(screen.getByRole("button", { name: "8" }));
    const noLimit = screen.getAllByRole("switch", { name: "dashboard:pools.capacity.noLimit" });
    expect(noLimit).toHaveLength(3);
    fireEvent.click(noLimit[1] as HTMLElement);
    expect(screen.getByText("dashboard:pools.capacity.noLimitHint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      capacityConcurrencyLimit: 8,
      capacityWaitBudgetMs: null,
      capacityContextCeiling: 32_768,
    });
  });
});

describe("PoolForm protocol adaptation controls", () => {
  it("maps the protocol radio options to the two stored booleans", () => {
    mount();

    const lossless = screen.getByLabelText("dashboard:pools.protocolOptions.lossless.label");
    const lossy = screen.getByLabelText("dashboard:pools.protocolOptions.lossy.label");
    expect((lossless as HTMLInputElement).checked).toBe(false);

    fireEvent.click(lossless);
    expect((lossless as HTMLInputElement).checked).toBe(true);
    fireEvent.click(lossy);

    expect((lossy as HTMLInputElement).checked).toBe(true);
  });

  it("shows an invalid stored lossy pair as lossless translation", () => {
    mount(true, {
      pool: {
        ...editablePool,
        allowLossyDeveloperRoleCollapse: true,
        protocolAdaptationEnabled: false,
      },
    });

    expect(
      (screen.getByLabelText("dashboard:pools.protocolOptions.lossless.label") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("does not migrate an invalid protocol pair when saving a non-routing section", async () => {
    mount(true, {
      pool: {
        ...editablePool,
        allowLossyDeveloperRoleCollapse: true,
        protocolAdaptationEnabled: false,
      },
      sections: ["identity"],
    });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("allowLossyDeveloperRoleCollapse");
  });

  it("repairs an untouched invalid routing pair without enabling adaptation", async () => {
    mount(true, {
      pool: {
        ...editablePool,
        allowLossyDeveloperRoleCollapse: true,
        protocolAdaptationEnabled: false,
      },
      sections: ["routing"],
    });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    // The repair still rides on the always-sent lossy bit; the unchanged
    // adaptation flag and override stay omitted (dirty-field sends).
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      allowLossyDeveloperRoleCollapse: false,
    });
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
  });

  it("omits unchanged selectability-gated routing fields on edit (W5)", async () => {
    mount(true, { sections: ["routing"] });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
    // Unrelated routing fields keep their always-send semantics.
    expect(state.mutationPayloads[0]?.input).toHaveProperty("allowLossyDeveloperRoleCollapse");
    expect(state.mutationPayloads[0]?.input).toHaveProperty("affinityEnabled");
  });

  it("sends the override when the user clears a stored surface", async () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, recommendedSurfaceOverride: "OPENAI_RESPONSES" },
    });

    fireEvent.change(screen.getByLabelText("dashboard:pools.recommendedSurfaceOverride"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      recommendedSurfaceOverride: null,
    });
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
  });

  it("sends the override when the user sets a surface on an automatic pool", async () => {
    mount(true, { sections: ["routing"] });

    fireEvent.change(screen.getByLabelText("dashboard:pools.recommendedSurfaceOverride"), {
      target: { value: "OPENAI_RESPONSES" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      recommendedSurfaceOverride: "OPENAI_RESPONSES",
    });
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
  });

  it("sends adaptation when changed and the override when unchanged separately", async () => {
    mount(true, { sections: ["routing"] });

    fireEvent.click(screen.getByLabelText("dashboard:pools.protocolOptions.lossless.label"));
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      protocolAdaptationEnabled: true,
    });
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
  });

  it("omits the stored override on routing save when the control is untouched", async () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, recommendedSurfaceOverride: "OPENAI_RESPONSES" },
    });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
  });

  it("omits a stored enabled adaptation on routing save when the control is untouched", async () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, protocolAdaptationEnabled: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("protocolAdaptationEnabled");
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
  });

  it("sends protocolAdaptationEnabled false when the user disables a stored adaptation", async () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, protocolAdaptationEnabled: true },
    });

    fireEvent.click(screen.getByLabelText("dashboard:pools.protocolOptions.native.label"));
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      protocolAdaptationEnabled: false,
    });
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("recommendedSurfaceOverride");
  });

  it("saves exactly one pool mutation without a sheet", async () => {
    mount();

    fireEvent.change(screen.getByLabelText("dashboard:pools.name"), {
      target: { value: "Primary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves a capacity-enabled edit through updateModelPool with all capacity fields", async () => {
    mount(true, { capacityAvailability: "enabled" });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads).toEqual([
      {
        name: "updateModelPool",
        input: expect.objectContaining({
          capacityPriority: 16,
          capacityConcurrencyLimit: 1,
          capacityReservedSlots: 0,
          capacityWaitBudgetMs: 30_000,
          capacityContextCeiling: 32_768,
          capacityContextMargin: 1_024,
          capacityBorrowPolicy: "WHEN_IDLE",
        }),
      },
    ]);
  });

  it("maps a SURFACE_NOT_SUPPORTED update rejection onto the recommended-API field", async () => {
    state.nextReject = {
      name: "updateModelPool",
      error: Object.assign(new Error("surface mismatch"), {
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      }),
    };
    mount(true, { sections: ["routing"] });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(
      screen.getByText("dashboard:pools.wizard.createErrors.SURFACE_NOT_SUPPORTED"),
    ).toBeTruthy();

    // Changing the recommended-API choice clears the inline rejection.
    fireEvent.change(screen.getByLabelText("dashboard:pools.recommendedSurfaceOverride"), {
      target: { value: "OPENAI_RESPONSES" },
    });
    expect(
      screen.queryByText("dashboard:pools.wizard.createErrors.SURFACE_NOT_SUPPORTED"),
    ).toBeNull();

    // Changing the protocol adaptation choice clears it too.
    state.nextReject = {
      name: "updateModelPool",
      error: Object.assign(new Error("surface mismatch"), {
        code: "BAD_REQUEST",
        data: { reason: "SURFACE_NOT_SUPPORTED" },
      }),
    };
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() =>
      expect(
        screen.getByText("dashboard:pools.wizard.createErrors.SURFACE_NOT_SUPPORTED"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("dashboard:pools.protocolOptions.lossless.label"));
    expect(
      screen.queryByText("dashboard:pools.wizard.createErrors.SURFACE_NOT_SUPPORTED"),
    ).toBeNull();
  });

  it("lets non-surface update rejections propagate untouched", async () => {
    const other = Object.assign(new Error("unrelated"), {
      code: "BAD_REQUEST",
      data: { reason: "PROVIDER_NOT_READY" },
    });
    state.nextReject = { name: "updateModelPool", error: other };
    mount(true, { sections: ["routing"] });

    const save = screen.getByRole("button", { name: "common:actions.save" });
    fireEvent.click(save);

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    // The rejection is not mapped to the recommended-API field: the promise
    // chain propagates it (unhandled in this harness) and no inline copy is
    // rendered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByText("dashboard:pools.wizard.createErrors.SURFACE_NOT_SUPPORTED"),
    ).toBeNull();
  });
});

describe("PoolForm affinity defaults", () => {
  it("renders and submits the new-conversation residency weight", async () => {
    mount(true, { sections: ["routing"] });
    const field = screen.getByLabelText(
      "dashboard:pools.affinity.fields.affinityResidencyWeight",
    ) as HTMLInputElement;
    expect(field.value).toBe("100");
    fireEvent.change(field, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ affinityResidencyWeight: 250 });
  });

  it("saves the cache-holder wait as automatic (null) or a fixed value (0 = off)", async () => {
    mount(true, { sections: ["routing"] });
    const mode = screen.getByLabelText(
      "dashboard:pools.affinity.fields.cacheHolderWaitMs",
    ) as HTMLSelectElement;
    expect(mode.value).toBe("AUTO");
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ cacheHolderWaitMs: null });

    fireEvent.change(mode, { target: { value: "FIXED" } });
    fireEvent.change(screen.getByLabelText("dashboard:pools.affinity.cacheHolderWait.valueLabel"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toHaveLength(2));
    expect(state.mutationPayloads[1]?.input).toMatchObject({ cacheHolderWaitMs: 0 });
  });

  it("saves warm-session protection settings (share mode, fixed percent, owner share)", async () => {
    mount(true, { sections: ["routing"] });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      protectionEnabled: true,
      evictionFeedbackEnabled: true,
      protectionWindowSeconds: 300,
      protectMinTokens: 8192,
      protectionShare: "EQUAL_SHARE",
      protectionFixedPercent: null,
      ownerProtectionPercent: null,
    });

    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.share"), {
      target: { value: "FIXED_PERCENT" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.fixedPercent"), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.ownerShare"), {
      target: { value: "UNPROTECTED" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.windowSeconds"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByLabelText("dashboard:pools.protection.enabled"));
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toHaveLength(2));
    expect(state.mutationPayloads[1]?.input).toMatchObject({
      protectionEnabled: false,
      protectionWindowSeconds: 120,
      protectionShare: "FIXED_PERCENT",
      protectionFixedPercent: 25,
      ownerProtectionPercent: 0,
    });
  });

  it("does not validate hidden percent fields (a stale invalid value never blocks save)", async () => {
    mount(true, { sections: ["routing"] });
    const share = screen.getByLabelText("dashboard:pools.protection.share");
    fireEvent.change(share, { target: { value: "FIXED_PERCENT" } });
    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.fixedPercent"), {
      target: { value: "0" },
    });
    // Back to a mode without the field: the invalid hidden value is not sent or checked.
    fireEvent.change(share, { target: { value: "EQUAL_SHARE" } });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      protectionShare: "EQUAL_SHARE",
      protectionFixedPercent: null,
    });
  });

  it("does not validate a hidden owner percent (PERCENT back to INHERIT still saves)", async () => {
    mount(true, { sections: ["routing"] });
    const owner = screen.getByLabelText("dashboard:pools.protection.ownerShare");
    fireEvent.change(owner, { target: { value: "PERCENT" } });
    fireEvent.change(screen.getByLabelText("dashboard:pools.protection.percentLabel"), {
      target: { value: "0" },
    });
    fireEvent.change(owner, { target: { value: "INHERIT" } });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ ownerProtectionPercent: null });
  });

  it("loads a stored owner protection percent", () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, protection: { ...editablePool.protection, ownerPercent: 40 } },
    });
    expect(
      (screen.getByLabelText("dashboard:pools.protection.ownerShare") as HTMLSelectElement).value,
    ).toBe("PERCENT");
    expect(
      (screen.getByLabelText("dashboard:pools.protection.percentLabel") as HTMLInputElement).value,
    ).toBe("40");
  });

  it("loads a stored fixed cache-holder wait", () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, cacheHolderWaitMs: 1_500 },
    });
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.affinity.fields.cacheHolderWaitMs",
        ) as HTMLSelectElement
      ).value,
    ).toBe("FIXED");
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.affinity.cacheHolderWait.valueLabel",
        ) as HTMLInputElement
      ).value,
    ).toBe("1500");
  });

  it("keeps a stored cache-holder wait of 0 (off) as a fixed value on save", async () => {
    mount(true, {
      sections: ["routing"],
      pool: { ...editablePool, cacheHolderWaitMs: 0 },
    });
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.affinity.fields.cacheHolderWaitMs",
        ) as HTMLSelectElement
      ).value,
    ).toBe("FIXED");
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.affinity.cacheHolderWait.valueLabel",
        ) as HTMLInputElement
      ).value,
    ).toBe("0");
    // Saving another routing field must not silently turn "off" into automatic.
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ cacheHolderWaitMs: 0 });
  });

  it("loads the stored affinity value in edit mode", () => {
    // editablePool stores affinity disabled; the edit form must keep it off
    // instead of falling back to the create-mode ON default.
    mount();

    expect(
      (screen.getByLabelText("dashboard:pools.affinity.enabled") as HTMLInputElement).checked,
    ).toBe(false);
  });
});

const localMember = {
  id: "member-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  discoveredModelId: "model-1",
  executionTargetId: "target-1",
  model: {
    id: "model-1",
    upstreamModelId: "upstream-model-1",
    canonicalModelId: "owner/cli/model",
    endpointId: "endpoint-1",
    endpointSlug: "endpoint",
    cliDeviceSlug: "cli",
    declaredContextWindow: null,
    surfaces: {
      ANTHROPIC_MESSAGES: { mode: "unavailable" as const, streaming: false, limitations: [] },
      OPENAI_CHAT_COMPLETIONS: {
        mode: "unavailable" as const,
        streaming: false,
        limitations: [],
      },
      OPENAI_RESPONSES: { mode: "unavailable" as const, streaming: false, limitations: [] },
    },
  },
  providerModel: null,
  weight: 1,
  routingStatus: "ACTIVE" as const,
  tier: "PRIMARY" as const,
  healthStatus: "HEALTHY" as const,
  lastFailureClass: null,
  lastFailureAt: null,
  nextRetryAt: null,
  halfOpenTrialStartedAt: null,
  consecutiveRetryableFailures: 0,
  publicOrder: null,
  capacityPriority: null,
  capacityConcurrencyMode: "INHERIT" as const,
  capacityConcurrencyLimit: null,
  capacityReservedSlots: null,
  capacityBorrowPolicy: null,
  capacityWaitBudgetMode: "INHERIT" as const,
  capacityWaitBudgetMs: null,
  capacityContextCeilingMode: "INHERIT" as const,
  capacityContextCeiling: null,
  capacityContextMargin: null,
  inferenceCapacityId: null,
};

function mountMemberEditor(capacityAvailability: "enabled" | "disabled") {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PoolMemberForm
        mode="edit"
        member={localMember}
        directModels={[]}
        capacities={[]}
        capacityAvailability={capacityAvailability}
        onSuccess={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("PoolMemberForm capacity save gate", () => {
  it("updates the member policy without an untouched attachment when capacity is enabled", async () => {
    mountMemberEditor("enabled");

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() =>
      expect(state.mutationCalls).toEqual(["updatePoolMember", "updateMemberPolicy"]),
    );
  });

  it.each([
    { mode: "create", current: "auto", choice: undefined, expected: undefined },
    { mode: "create", current: null, choice: undefined, expected: undefined },
    { mode: "create", current: "auto", choice: "", expected: null },
    { mode: "create", current: "auto", choice: "other", expected: "other" },
    { mode: "edit", current: "auto", choice: undefined, expected: undefined },
    { mode: "edit", current: "auto", choice: "auto", expected: undefined },
    { mode: "edit", current: "auto", choice: "", expected: null },
    { mode: "edit", current: null, choice: "other", expected: "other" },
  ] as const)(
    "capacity selection follows actual owner changes: %#",
    async ({ mode, current, choice, expected }) => {
      const directModels = [
        {
          id: "model-1",
          canonicalModelId: "first",
          executionTarget: { inferenceCapacityId: current },
        },
        {
          id: "model-2",
          canonicalModelId: "second",
          executionTarget: { inferenceCapacityId: "other" },
        },
      ] as unknown as Parameters<typeof PoolMemberForm>[0]["directModels"];
      const capacities = [
        { id: "auto", label: "Automatic", hardConcurrencyLimit: 1 },
        { id: "other", label: "Other", hardConcurrencyLimit: 1 },
      ] as Parameters<typeof PoolMemberForm>[0]["capacities"];
      render(
        <QueryClientProvider client={new QueryClient()}>
          <PoolMemberForm
            mode={mode}
            poolId="pool"
            member={{ ...localMember, inferenceCapacityId: current }}
            directModels={directModels}
            capacities={capacities}
            capacityAvailability="enabled"
            onSuccess={() => undefined}
          />
        </QueryClientProvider>,
      );
      const select = screen.getByLabelText(
        "dashboard:pools.capacity.attachment",
      ) as HTMLSelectElement;
      expect(select.value).toBe(current ?? "");
      if (choice !== undefined) fireEvent.change(select, { target: { value: choice } });
      fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const attachment = state.mutationPayloads.filter(
        (call) => call.name === "updateDirectPolicy",
      );
      expect(attachment).toEqual(
        expected === undefined
          ? []
          : [
              {
                name: "updateDirectPolicy",
                input: { executionTargetId: "target-1", inferenceCapacityId: expected },
              },
            ],
      );
    },
  );

  it("resets the capacity choice to each selected create target's current capacity", async () => {
    const directModels = [
      {
        id: "model-1",
        canonicalModelId: "first",
        executionTarget: { inferenceCapacityId: "auto" },
      },
      {
        id: "model-2",
        canonicalModelId: "second",
        executionTarget: { inferenceCapacityId: "other" },
      },
    ] as unknown as Parameters<typeof PoolMemberForm>[0]["directModels"];
    const capacities = [
      { id: "auto", label: "Automatic", hardConcurrencyLimit: 1 },
      { id: "other", label: "Other", hardConcurrencyLimit: 1 },
    ] as Parameters<typeof PoolMemberForm>[0]["capacities"];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PoolMemberForm
          mode="create"
          poolId="pool"
          directModels={directModels}
          capacities={capacities}
          capacityAvailability="enabled"
          onSuccess={() => undefined}
        />
      </QueryClientProvider>,
    );
    const select = screen.getByLabelText(
      "dashboard:pools.capacity.attachment",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("dashboard:pools.directModel"), {
      target: { value: "model-2" },
    });
    expect(select.value).toBe("other");
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(state.mutationCalls).toEqual(["addPoolMember", "updateMemberPolicy"]);
  });

  it("does not run capacity mutations when capacity is disabled", async () => {
    mountMemberEditor("disabled");

    expect(screen.getByText("dashboard:pools.capacity.disabledReason")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updatePoolMember"]));
  });
});

describe("CliEndpointsModelsSection capability-impact advisory", () => {
  function mountModelsSection() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CliEndpointsModelsSection lang="en-US" />
      </QueryClientProvider>,
    );
  }

  it("fires the save success toast and the impact warning with slugs (no count) after a capability edit", async () => {
    state.cliDevices = [cliDeviceWithModel];
    state.capabilityImpact = [{ id: "pool-1", slug: "alpha", surface: "OPENAI_RESPONSES" }];
    mountModelsSection();

    // Capability toggles live in the model's Configure sheet.
    fireEvent.click(screen.getByRole("button", { name: /^dashboard:models\.configureLabel/ }));
    fireEvent.click(await screen.findByLabelText("dashboard:models.vision"));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateDiscoveredModelCapabilities"]));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("dashboard:models.capabilitySaved"),
    );
    // The warning interpolates slugs only; the reworded key has no count.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        `dashboard:models.capabilityImpact|${JSON.stringify({ slugs: "alpha" })}`,
      ),
    );
  });

  it("builds the next capability save on refetched data, not the snapshot taken at open", async () => {
    state.cliDevices = [cliDeviceWithModel];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CliEndpointsModelsSection lang="en-US" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^dashboard:models\.configureLabel/ }));
    const vision = (await screen.findByLabelText("dashboard:models.vision")) as HTMLInputElement;
    expect(vision.checked).toBe(false);

    // A refetch after an earlier save now reports vision on.
    const [device] = state.cliDevices as [typeof cliDeviceWithModel];
    const [endpoint] = device.endpoints;
    const [model] = endpoint!.models;
    act(() =>
      client.setQueryData(
        ["cliDevices"],
        [
          {
            ...device,
            endpoints: [
              {
                ...endpoint,
                models: [
                  {
                    ...model,
                    capabilityOverrideMode: "OVERRIDE",
                    capabilityOverrides: ["VISION_INPUT"],
                  },
                ],
              },
            ],
          },
        ],
      ),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("dashboard:models.vision") as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByLabelText("dashboard:models.audio"));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateDiscoveredModelCapabilities"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ vision: true, audio: true });
  });

  it("shows a refused credential identity on that device only", () => {
    state.cliDevices = [
      { ...cliDeviceWithModel, identityRefusedAt: new Date("2026-09-28T10:00:00.000Z") },
      { ...cliDeviceWithModel, id: "cli-2", slug: "laptop", identityRefusedAt: null },
    ];
    mountModelsSection();

    expect(screen.getAllByText("dashboard:clis.identityRefused")).toHaveLength(1);
    expect(screen.getByText(/^dashboard:clis\.identityRefusedDetail\|/)).toBeTruthy();
  });

  it("flags a device whose CLI must be upgraded for the relay protocol", () => {
    state.cliDevices = [
      {
        ...cliDeviceWithModel,
        upgradeRequired: {
          protocolVersion: "2.6",
          cliVersion: "0.4.0",
          rejectedAt: new Date("2026-09-28T10:00:00.000Z"),
          reason: "cli_too_old",
        },
      },
      { ...cliDeviceWithModel, id: "cli-2", slug: "laptop", upgradeRequired: null },
    ];
    mountModelsSection();

    const badges = screen.getAllByText(/^dashboard:clis\.upgradeRequired\|/);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe(
      `dashboard:clis.upgradeRequired|${JSON.stringify({ protocol: "2.6" })}`,
    );
    expect(screen.getByText(/^dashboard:clis\.upgradeRequiredDetail\|/).textContent).toContain(
      '"version":"0.4.0"',
    );
  });

  it("says the server must be upgraded when the refused CLI is newer", () => {
    state.cliDevices = [
      {
        ...cliDeviceWithModel,
        upgradeRequired: {
          protocolVersion: "2.8",
          cliVersion: "0.9.0",
          rejectedAt: new Date("2026-09-28T10:00:00.000Z"),
          reason: "cli_too_new",
        },
      },
    ];
    mountModelsSection();

    expect(screen.queryByText(/^dashboard:clis\.upgradeRequired/)).toBeNull();
    expect(screen.getByText(/^dashboard:clis\.serverUpgradeRequired\|/).textContent).toBe(
      `dashboard:clis.serverUpgradeRequired|${JSON.stringify({ protocol: "2.8" })}`,
    );
    expect(
      screen.getByText(/^dashboard:clis\.serverUpgradeRequiredDetail\|/).textContent,
    ).toContain('"version":"0.9.0"');
  });

  it("keeps the plain success toast on clean responses", async () => {
    state.cliDevices = [cliDeviceWithModel];
    state.capabilityImpact = [];
    mountModelsSection();

    // Capability toggles live in the model's Configure sheet.
    fireEvent.click(screen.getByRole("button", { name: /^dashboard:models\.configureLabel/ }));
    fireEvent.click(await screen.findByLabelText("dashboard:models.vision"));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateDiscoveredModelCapabilities"]));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("dashboard:models.capabilitySaved"),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("CliEndpointsModelsSection delete conflicts", () => {
  function mountWithAppToasts() {
    return render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            mutationCache: createAppMutationCache((key) => key),
          })
        }
      >
        <CliEndpointsModelsSection lang="en-US" />
      </QueryClientProvider>,
    );
  }

  async function confirmDelete(token: string) {
    fireEvent.change(await screen.findByPlaceholderText(token), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "actions.delete" }));
  }

  it.each([
    ["removeCliDeviceMetadata", "cli", "desk", "retained_history", "retainedHistory.cliDevice"],
    ["removeEndpointMetadata", "endpoint", "desk/local", "delete_pending", "deletePending"],
    [
      "removeDiscoveredModelMetadata",
      "model",
      "owner/desk/local/example",
      "retained_history",
      "retainedHistory.discoveredModel",
    ],
  ] as const)(
    "%s: a structured CONFLICT shows its specific copy, not the generic one",
    async (name, target, token, reason, key) => {
      state.cliDevices = [cliDeviceWithModel];
      state.nextReject = {
        name,
        error: { status: 409, code: "CONFLICT", message: "raw", data: { reason } },
      };
      mountWithAppToasts();

      if (target === "cli") {
        // Removing a CLI signs it out, so it sits in the device's overflow menu.
        fireEvent.click(screen.getByRole("button", { name: /^dashboard:clis\.moreActions/ }));
        fireEvent.click(
          await screen.findByRole("menuitem", { name: "dashboard:clis.removeAndSignOut" }),
        );
      } else if (target === "endpoint") {
        fireEvent.click(screen.getByRole("button", { name: "dashboard:endpoints.forget" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: /^dashboard:models\.configureLabel/ }));
        fireEvent.click(
          await screen.findByRole("button", { name: "dashboard:metadata.deleteModel" }),
        );
      }
      await confirmDelete(token);

      await waitFor(() => expect(state.mutationCalls).toEqual([name]));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(`errors:deletionConflict.${key}`),
      );
      expect(toast.error).not.toHaveBeenCalledWith("That conflicts with an existing record.");
    },
  );
});

describe("CliEndpointsModelsSection device names", () => {
  function mountDevices() {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CliEndpointsModelsSection lang="en-US" />
      </QueryClientProvider>,
    );
  }

  it("shows the display name with the slug as secondary text", () => {
    state.cliDevices = [cliDeviceWithModel];
    mountDevices();

    expect(screen.getByRole("heading", { name: "desk-01.local" })).toBeTruthy();
    expect(screen.getByText("desk")).toBeTruthy();
    // SectionHeader is the page h1 now that the shared dashboard header is gone.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("renders one agent activity section per device", async () => {
    state.cliDevices = [
      cliDeviceWithModel,
      {
        ...cliDeviceWithModel,
        id: "cli-2",
        slug: "tower",
        name: "Work laptop",
        displayName: "Work laptop",
        endpoints: [],
      },
    ];
    mountDevices();

    // Each device has its own Activity tab (AC 7); nothing is fetched until it is opened.
    const tabs = screen.getAllByRole("tab", { name: "dashboard:clis.tabs.activity" });
    expect(tabs).toHaveLength(2);
    expect(state.activityInputs).toHaveLength(0);

    // Opening a device's tab queries that device by its id, not its slug:
    // the audit list is keyed by cliDeviceId, so a slug would silently show
    // another (nonexistent) device's empty log.
    fireEvent.click(tabs[1]!);
    await waitFor(() => expect(state.activityInputs.length).toBeGreaterThan(0));
    expect(state.activityInputs.every((input) => input?.cliDeviceId === "cli-2")).toBe(true);
    expect(screen.getAllByText("clis.activity.title")).toHaveLength(1);
  });

  it("finds a device by display name, hostname, or slug", () => {
    state.cliDevices = [
      cliDeviceWithModel,
      {
        ...cliDeviceWithModel,
        id: "cli-2",
        slug: "tower",
        name: "Work laptop",
        reportedHostname: "tower.lan",
        displayName: "Work laptop",
        endpoints: [],
      },
    ];
    mountDevices();
    const search = screen.getByLabelText("dashboard:clis.searchLabel");

    for (const query of ["work lap", "tower.lan", "tower"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByRole("heading", { name: "Work laptop" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "desk-01.local" })).toBeNull();
    }
  });

  it("anchors each device card with cli-<deviceId> matching the token form's link", () => {
    state.cliDevices = [
      cliDeviceWithModel,
      {
        ...cliDeviceWithModel,
        id: "cli-2",
        slug: "tower",
        name: "Work laptop",
        reportedHostname: "tower.lan",
        displayName: "Work laptop",
        endpoints: [],
      },
    ];
    mountDevices();

    // The token form links to `#cli-<id>` (cli-command-devices.tsx), so each
    // card must carry a matching id for the browser to scroll to it.
    for (const id of ["cli-1", "cli-2"]) {
      const anchor = document.getElementById(`cli-${id}`);
      expect(anchor).toBeTruthy();
      expect(anchor?.id).toBe(`cli-${id}`);
    }
  });

  it("renames a device with a trimmed name", async () => {
    state.cliDevices = [cliDeviceWithModel];
    mountDevices();

    fireEvent.click(screen.getByRole("button", { name: /dashboard:clis\.rename\.actionLabel/ }));
    fireEvent.change(screen.getByLabelText("dashboard:clis.rename.field"), {
      target: { value: "  Work laptop  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:clis.rename.save" }));

    await waitFor(() =>
      expect(state.mutationPayloads).toEqual([
        { name: "renameCliDevice", input: { cliDeviceId: "cli-1", name: "Work laptop" } },
      ]),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("dashboard:clis.rename.saved"));
  });

  it("rejects invisible formatting characters without saving", async () => {
    state.cliDevices = [cliDeviceWithModel];
    mountDevices();

    fireEvent.click(screen.getByRole("button", { name: /dashboard:clis\.rename\.actionLabel/ }));
    fireEvent.change(screen.getByLabelText("dashboard:clis.rename.field"), {
      target: { value: "Work\u202Elaptop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:clis.rename.save" }));

    expect(await screen.findByText("dashboard:clis.rename.invalidCharacters")).toBeTruthy();
    expect(state.mutationPayloads).toEqual([]);
  });

  it("hints the name the device falls back to when cleared", () => {
    state.cliDevices = [
      { ...cliDeviceWithModel, name: "Old", reportedHostname: null, displayName: "Old" },
    ];
    mountDevices();

    fireEvent.click(screen.getByRole("button", { name: /dashboard:clis\.rename\.actionLabel/ }));
    expect(
      screen.getByText('dashboard:clis.rename.hint|{"fallback":"desk"}', { exact: true }),
    ).toBeTruthy();
  });

  it("clears the name when saved blank", async () => {
    state.cliDevices = [{ ...cliDeviceWithModel, name: "Old", displayName: "Old" }];
    mountDevices();

    fireEvent.click(screen.getByRole("button", { name: /dashboard:clis\.rename\.actionLabel/ }));
    fireEvent.change(screen.getByLabelText("dashboard:clis.rename.field"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:clis.rename.save" }));

    await waitFor(() =>
      expect(state.mutationPayloads).toEqual([
        { name: "renameCliDevice", input: { cliDeviceId: "cli-1", name: null } },
      ]),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("dashboard:clis.rename.cleared"),
    );
  });
});

function mountGrantDialog(pool: {
  id: string;
  effectiveProviderEgress: boolean;
  fallbackEnabled: boolean;
  members: Array<{ tier: string; providerModel: { id: string } | null }>;
}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <GrantPoolDialog pool={pool} onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}

function grantEmail(value: string) {
  fireEvent.change(screen.getByLabelText("dashboard:pools.email"), { target: { value } });
}

describe("GrantPoolDialog", () => {
  it.each([
    ["a pool with external fallback", true],
    ["a local-only pool", false],
  ])("grants %s without any egress acknowledgement", async (_label, external) => {
    mountGrantDialog({
      id: "pool-grant",
      fallbackEnabled: external,
      effectiveProviderEgress: external,
      members: external ? [{ tier: "PUBLIC_OVERFLOW", providerModel: { id: "external" } }] : [],
    });

    // Grantees' data leaves only when they ask for `owner/pool:external`
    // themselves and the owner pays for grantees; the grant has no checkbox.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("dashboard:pools.grantEgressAcknowledge")).toBeNull();
    grantEmail("friend@example.com");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["grantPoolAccessByEmail"]));
    expect(state.mutationPayloads[0]?.input).toEqual({
      poolId: "pool-grant",
      email: "friend@example.com",
    });
  });

  it.each([
    grantPoolAccessServerMessages.userNotFound,
    grantPoolAccessServerMessages.cannotGrantToSelf,
  ])("shows the server grant message %s instead of raw oRPC JSON", async (message) => {
    state.nextReject = {
      name: "grantPoolAccessByEmail",
      error: {
        code: "BAD_REQUEST",
        status: 400,
        message,
        defined: false,
        data: { secret: "nope" },
      },
    };
    mountGrantDialog({
      id: "pool-local",
      fallbackEnabled: false,
      effectiveProviderEgress: false,
      members: [],
    });
    grantEmail("friend@example.com");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
    expect(screen.queryByText(/secret|defined|BAD_REQUEST/)).toBeNull();
  });

  it("does not render a non-allowlisted oRPC payload", async () => {
    state.nextReject = {
      name: "grantPoolAccessByEmail",
      error: {
        message: JSON.stringify({
          code: "INTERNAL_SERVER_ERROR",
          data: { secret: "postgres://db.invalid/leaked_app_db" },
        }),
      },
    };
    mountGrantDialog({
      id: "pool-local",
      fallbackEnabled: false,
      effectiveProviderEgress: false,
      members: [],
    });
    grantEmail("friend@example.com");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "common:somethingWentWrong",
    );
    expect(screen.queryByText(/postgres:\/\/|leaked_app_db/)).toBeNull();
  });
});
