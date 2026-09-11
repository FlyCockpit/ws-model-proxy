// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutationCalls: [] as string[],
  mutationPayloads: [] as Array<{ name: string; input: unknown }>,
  protocolAdaptationAvailable: true,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
        return name === "addPoolMember"
          ? { id: "member-1", executionTargetId: "target-1" }
          : { id: "pool-1" };
      },
      ...options,
    }),
  });
  return {
    orpc: {
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        createModelPool: mutation("createModelPool"),
        updateModelPool: mutation("updateModelPool"),
        addPoolMember: mutation("addPoolMember"),
        updatePoolMember: mutation("updatePoolMember"),
        cacheAffinityStats: query("affinity", { activeRecords: 0, targets: [] }),
        clearCacheAffinity: mutation("clearCacheAffinity"),
      },
      capacityManagement: {
        key: () => ["capacityManagement"],
        updateMemberPolicy: mutation("updateMemberPolicy"),
        updateDirectPolicy: mutation("updateDirectPolicy"),
      },
    },
  };
});

import { PoolForm, PoolMemberForm } from "./forwarder-dashboard-sections";

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
      OPENAI_COMPLETIONS: {
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
    cacheMode: "OFF",
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
  protocolAdaptationAvailable: true,
  allowLossyDeveloperRoleCollapse: false,
  publicEgressEnabled: false,
  publicEgressAcknowledged: false,
  recommendedSurfaceOverride: null,
  capacityPriority: 16,
  capacityConcurrencyLimit: 1,
  capacityReservedSlots: 0,
  capacityWaitBudgetMs: 30_000,
  capacityContextCeiling: 32_768,
  capacityContextMargin: 1_024,
  capacityBorrowPolicy: "WHEN_IDLE",
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
  protocolAdaptationAvailable = true,
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
        capacityAvailability={options.capacityAvailability ?? "disabled"}
        protocolAdaptationAvailable={protocolAdaptationAvailable}
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
    expect(state.mutationPayloads[0]?.input).toMatchObject({
      protocolAdaptationEnabled: false,
      allowLossyDeveloperRoleCollapse: false,
    });
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

  it("omits capacity fields for a capacity-disabled edit", async () => {
    mount(true, { mode: "edit", capacityAvailability: "disabled" });

    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toEqual(["updateModelPool"]));
    expect(state.mutationPayloads[0]?.input).not.toHaveProperty("capacityPriority");
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
      OPENAI_COMPLETIONS: { mode: "unavailable" as const, streaming: false, limitations: [] },
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
