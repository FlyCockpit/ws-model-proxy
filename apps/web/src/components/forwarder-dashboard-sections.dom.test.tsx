// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutationCalls: [] as string[],
  mutationPayloads: [] as Array<{ name: string; input: unknown }>,
  nextReject: null as { name: string; error: unknown } | null,
  cliDevices: [] as Array<Record<string, unknown>>,
  capabilityImpact: [] as Array<{ id: string; slug: string; surface: string }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Forward interpolation options so toast assertions can verify exactly
    // which variables (slugs, not count) reach the translated message.
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listCliDevices: {
          queryOptions: () => ({
            queryKey: ["cliDevices"],
            queryFn: async () => state.cliDevices,
            initialData: state.cliDevices,
          }),
        },
        createModelPool: mutation("createModelPool"),
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
  publicEgressEnabled: false,
  publicEgressAcknowledged: false,
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
  affinity: {
    enabled: false,
    ttlSeconds: 3600,
    maxRecords: 10_000,
    prefixWeight: 100,
    conversationWeight: 150,
    confirmedCacheWeight: 150,
    loadPenaltyWeight: 100,
  },
};

function mount(
  _protocolAdaptationAvailable = true,
  options: {
    mode?: "create" | "edit";
    capacityAvailability?: "enabled" | "disabled";
    pool?: typeof editablePool;
    sections?: Array<"identity" | "routing" | "capacity" | "media">;
  } = {},
) {
  const mode = options.mode ?? "create";
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PoolForm
        mode={mode}
        pool={mode === "edit" ? (options.pool ?? editablePool) : undefined}
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
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
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
      mode: "edit",
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
      mode: "edit",
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
      mode: "edit",
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
    mount(true, { mode: "edit", sections: ["routing"] });

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
      mode: "edit",
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
    mount(true, { mode: "edit", sections: ["routing"] });

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
    mount(true, { mode: "edit", sections: ["routing"] });

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
      mode: "edit",
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
      mode: "edit",
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
      mode: "edit",
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

    fireEvent.change(screen.getByLabelText("dashboard:pools.slug"), {
      target: { value: "primary" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.name"), {
      target: { value: "Primary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["createModelPool"]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves a capacity-enabled edit through updateModelPool with all capacity fields", async () => {
    mount(true, { mode: "edit", capacityAvailability: "enabled" });

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
    mount(true, { mode: "edit", sections: ["routing"] });

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
    mount(true, { mode: "edit", sections: ["routing"] });

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
  it("initializes the affinity toggle checked in create mode and submits true", async () => {
    mount();

    const toggle = screen.getByLabelText("dashboard:pools.affinity.enabled");
    expect((toggle as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText("dashboard:pools.slug"), {
      target: { value: "primary" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.name"), {
      target: { value: "Primary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["createModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ affinityEnabled: true });
  });

  it("submits an explicit opt-out when the create-mode toggle is unchecked", async () => {
    mount();

    fireEvent.click(screen.getByLabelText("dashboard:pools.affinity.enabled"));
    fireEvent.change(screen.getByLabelText("dashboard:pools.slug"), {
      target: { value: "primary" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:pools.name"), {
      target: { value: "Primary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["createModelPool"]));
    expect(state.mutationPayloads[0]?.input).toMatchObject({ affinityEnabled: false });
  });

  it("loads the stored affinity value in edit mode", () => {
    // editablePool stores affinity disabled; the edit form must keep it off
    // instead of falling back to the create-mode ON default.
    mount(true, { mode: "edit" });

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
  it("updates the member policy and attachment when capacity is enabled", async () => {
    mountMemberEditor("enabled");

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() =>
      expect(state.mutationCalls).toEqual([
        "updatePoolMember",
        "updateMemberPolicy",
        "updateDirectPolicy",
      ]),
    );
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
        <CliEndpointsModelsSection />
      </QueryClientProvider>,
    );
  }

  it("fires the save success toast and the impact warning with slugs (no count) after a capability edit", async () => {
    state.cliDevices = [cliDeviceWithModel];
    state.capabilityImpact = [{ id: "pool-1", slug: "alpha", surface: "OPENAI_RESPONSES" }];
    mountModelsSection();

    fireEvent.click(screen.getByLabelText("dashboard:models.vision"));

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

  it("keeps the plain success toast on clean responses", async () => {
    state.cliDevices = [cliDeviceWithModel];
    state.capabilityImpact = [];
    mountModelsSection();

    fireEvent.click(screen.getByLabelText("dashboard:models.vision"));

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
        <CliEndpointsModelsSection />
      </QueryClientProvider>,
    );
  }

  async function confirmDelete(token: string) {
    fireEvent.change(await screen.findByPlaceholderText(token), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "actions.delete" }));
  }

  it.each([
    ["removeCliDeviceMetadata", 0, "desk", "retained_history", "retainedHistory.cliDevice"],
    ["removeEndpointMetadata", 1, "desk/local", "delete_pending", "deletePending"],
    [
      "removeDiscoveredModelMetadata",
      -1,
      "owner/desk/local/example",
      "retained_history",
      "retainedHistory.discoveredModel",
    ],
  ])(
    "%s: a structured CONFLICT shows its specific copy, not the generic one",
    async (name, buttonIndex, token, reason, key) => {
      state.cliDevices = [cliDeviceWithModel];
      state.nextReject = {
        name,
        error: { status: 409, code: "CONFLICT", message: "raw", data: { reason } },
      };
      mountWithAppToasts();

      if (buttonIndex < 0) {
        fireEvent.click(screen.getByRole("button", { name: "dashboard:metadata.deleteModel" }));
      } else {
        fireEvent.click(
          screen.getAllByRole("button", { name: "dashboard:metadata.delete" })[buttonIndex],
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
        <CliEndpointsModelsSection />
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
  publicEgressEnabled: boolean;
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

describe("GrantPoolDialog provider egress acknowledgement", () => {
  it("shows the checkbox for public overflow with no provider members and submits the acknowledgement", async () => {
    mountGrantDialog({
      id: "pool-overflow",
      publicEgressEnabled: true,
      effectiveProviderEgress: true,
      members: [{ tier: "PRIMARY", providerModel: null }],
    });

    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.grantEgressAcknowledge")).toBeTruthy();
    grantEmail("friend@example.com");
    expect(
      (screen.getByRole("button", { name: "dashboard:pools.grant" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["grantPoolAccessByEmail"]));
    expect(state.mutationPayloads[0]?.input).toEqual({
      poolId: "pool-overflow",
      email: "friend@example.com",
      publicEgressAcknowledged: true,
    });
  });

  it("shows the checkbox for a primary provider member when overflow is off", () => {
    mountGrantDialog({
      id: "pool-primary",
      publicEgressEnabled: false,
      effectiveProviderEgress: true,
      members: [{ tier: "PRIMARY", providerModel: { id: "provider-model" } }],
    });

    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("hides the checkbox for an overflow-only provider member when overflow is off", async () => {
    mountGrantDialog({
      id: "pool-overflow-member",
      publicEgressEnabled: false,
      effectiveProviderEgress: false,
      members: [{ tier: "PUBLIC_OVERFLOW", providerModel: { id: "overflow-model" } }],
    });

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("dashboard:pools.grantEgressAcknowledge")).toBeNull();
    grantEmail("friend@example.com");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["grantPoolAccessByEmail"]));
    expect(state.mutationPayloads[0]?.input).toEqual({
      poolId: "pool-overflow-member",
      email: "friend@example.com",
      publicEgressAcknowledged: false,
    });
  });

  it.each([
    grantPoolAccessServerMessages.userNotFound,
    grantPoolAccessServerMessages.cannotGrantToSelf,
    grantPoolAccessServerMessages.egressAcknowledgementRequired,
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
      publicEgressEnabled: false,
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
      publicEgressEnabled: false,
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
