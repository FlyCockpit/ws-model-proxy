// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  providerEgressEnabled: false,
  providerOperationsMounts: 0,
  capacityEnabled: false as boolean | undefined,
  rejectMutation: null as string | null,
  mutationCalls: [] as string[],
  devices: [] as Array<Record<string, unknown>>,
  pools: [] as Array<Record<string, unknown>>,
}));

const toastState = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: toastState,
}));

vi.mock("@/components/guarded-pool-setup-wizard", () => ({
  GuardedPoolSetupWizard: () => null,
}));

vi.mock("@/components/provider-operations-section", () => ({
  ProviderOperationsSection: () => {
    state.providerOperationsMounts += 1;
    return <div>provider-operations</div>;
  },
}));

vi.mock("@/utils/orpc", () => {
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options?: { onSuccess?: () => void }) => ({
      mutationFn: async () => {
        state.mutationCalls.push(name);
        if (state.rejectMutation === name) throw new Error(`${name} failed`);
        return name === "addPoolMember"
          ? { id: "new-member", executionTargetId: "target-id" }
          : undefined;
      },
      ...options,
    }),
  });
  return {
    orpc: {
      appConfig: query("appConfig", () => ({
        capacityEnabled: state.capacityEnabled,
        providerEgressEnabled: state.providerEgressEnabled,
      })),
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listModelPools: query("pools", () => state.pools),
        listCliDevices: query("devices", () => state.devices),
        deleteModelPool: mutation("deleteModelPool"),
        grantPoolAccessByEmail: mutation("grantPoolAccessByEmail"),
        removePoolMember: mutation("removePoolMember"),
        reorderProviderPoolMember: mutation("reorderProviderPoolMember"),
        revokePoolAccessByEmail: mutation("revokePoolAccessByEmail"),
        updatePoolMember: mutation("updatePoolMember"),
        addPoolMember: mutation("addPoolMember"),
        cacheAffinityStats: query("affinity", () => ({ activeRecords: 0, targets: [] })),
        clearCacheAffinity: mutation("clearCacheAffinity"),
        testPoolMemberThroughResolver: mutation("testPoolMemberThroughResolver"),
        createModelPool: mutation("createModelPool"),
        updateModelPool: mutation("updateModelPool"),
      },
      capacityManagement: {
        key: () => ["capacityManagement"],
        list: query("capacities", () => []),
        remove: mutation("removeCapacity"),
        updatePoolPolicy: mutation("updatePoolPolicy"),
        updateMemberPolicy: mutation("updateMemberPolicy"),
        updateDirectPolicy: mutation("updateDirectPolicy"),
        create: mutation("createCapacity"),
        update: mutation("updateCapacity"),
      },
    },
  };
});

import { PoolsSection } from "./forwarder-dashboard-sections";

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PoolsSection />
    </QueryClientProvider>,
  );
}

describe("PoolsSection provider egress capability", () => {
  it("does not mount provider operations while server egress is disabled", () => {
    state.providerEgressEnabled = false;
    state.providerOperationsMounts = 0;

    mount();

    expect(screen.queryByText("provider-operations")).toBeNull();
    expect(state.providerOperationsMounts).toBe(0);
  });

  it("mounts provider operations when server egress is enabled", () => {
    state.providerEgressEnabled = true;
    state.providerOperationsMounts = 0;

    mount();

    expect(screen.getByText("provider-operations")).toBeTruthy();
    expect(state.providerOperationsMounts).toBe(1);
  });
});

afterEach(() => {
  cleanup();
  state.capacityEnabled = false;
  state.rejectMutation = null;
  state.mutationCalls = [];
  state.devices = [];
  state.pools = [];
  toastState.success.mockReset();
  toastState.error.mockReset();
});

const memberPool = {
  id: "pool-id",
  slug: "test-pool",
  name: "Pool",
  description: null,
  canonicalModelId: "owner/pool/pool",
  grants: [],
  members: [
    {
      id: "member-id",
      discoveredModelId: "model-id",
      executionTargetId: "target-id",
      model: { canonicalModelId: "owner/cli/model", surfaces: {} },
      providerModel: null,
      weight: 1,
      routingStatus: "ACTIVE",
      tier: "PRIMARY",
      healthStatus: "HEALTHY",
      lastFailureClass: null,
      consecutiveRetryableFailures: 0,
      publicOrder: null,
      capacityPriority: null,
      capacityConcurrencyMode: "INHERIT",
      capacityConcurrencyLimit: null,
      capacityReservedSlots: null,
      capacityBorrowPolicy: null,
      capacityWaitBudgetMode: "INHERIT",
      capacityWaitBudgetMs: null,
      capacityContextCeilingMode: "INHERIT",
      capacityContextCeiling: null,
      capacityContextMargin: null,
      inferenceCapacityId: null,
    },
  ],
  compatibility: {
    suggestedConnectionType: null,
    recommendedSurface: null,
    warnings: [],
    surfaces: {},
  },
  transformer: { model: null },
  affinity: {
    enabled: false,
    ttlSeconds: 3600,
    maxRecords: 10_000,
    prefixWeight: 100,
    conversationWeight: 150,
    loadPenaltyWeight: 100,
  },
};

describe("PoolsSection member capacity gate", () => {
  async function submitMemberEdit(capacityEnabled: boolean) {
    state.capacityEnabled = capacityEnabled;
    state.mutationCalls = [];
    state.pools = [memberPool];
    mount();

    const memberRow = screen.getByText("owner/cli/model").closest("tr");
    if (!memberRow) throw new Error("member row not found");
    fireEvent.click(within(memberRow).getByRole("button", { name: "common:actions.edit" }));
    if (!capacityEnabled)
      expect(screen.getByText("dashboard:pools.capacity.disabledReason")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toContain("updatePoolMember"));
  }

  it("saves a member without capacity mutations when capacity is disabled", async () => {
    await submitMemberEdit(false);

    expect(state.mutationCalls).toEqual(["updatePoolMember"]);
  });

  it("keeps capacity controls disabled with a loading message while deployment settings are unknown", () => {
    state.capacityEnabled = undefined;
    state.pools = [memberPool];
    mount();

    const memberRow = screen.getByText("owner/cli/model").closest("tr");
    if (!memberRow) throw new Error("member row not found");
    fireEvent.click(within(memberRow).getByRole("button", { name: "common:actions.edit" }));

    expect(screen.getByText("dashboard:pools.capacity.settingsLoading")).toBeTruthy();
    expect(screen.queryByText("dashboard:pools.capacity.disabledReason")).toBeNull();
  });

  it("saves both member and capacity policy when capacity is enabled", async () => {
    await submitMemberEdit(true);

    expect(state.mutationCalls).toEqual(
      expect.arrayContaining(["updatePoolMember", "updateMemberPolicy", "updateDirectPolicy"]),
    );
  });

  it("keeps the member editor open without success feedback when a capacity leg fails", async () => {
    state.capacityEnabled = true;
    state.rejectMutation = "updateMemberPolicy";
    state.pools = [memberPool];
    mount();

    const memberRow = screen.getByText("owner/cli/model").closest("tr");
    if (!memberRow) throw new Error("member row not found");
    fireEvent.click(within(memberRow).getByRole("button", { name: "common:actions.edit" }));
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toContain("updateMemberPolicy"));

    expect(toastState.success).not.toHaveBeenCalled();
    expect(screen.getByText("dashboard:pools.editMemberTitle")).toBeTruthy();
  });

  it("keeps the pool editor open without success feedback when its capacity leg fails", async () => {
    state.capacityEnabled = true;
    state.rejectMutation = "updatePoolPolicy";
    state.pools = [memberPool];
    mount();

    const poolCard = screen.getByRole("region", { name: "Pool" });
    fireEvent.click(within(poolCard).getByRole("button", { name: "dashboard:pools.editPool" }));
    const title = await screen.findByText("dashboard:pools.editTitle");
    const sheet = title.closest<HTMLElement>('[role="dialog"]');
    if (!sheet) throw new Error("pool editor sheet not found");
    fireEvent.click(within(sheet).getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toContain("updatePoolPolicy"));

    expect(toastState.success).not.toHaveBeenCalled();
    expect(screen.getByText("dashboard:pools.editTitle")).toBeTruthy();
  });

  it("does not report success when member creation cannot attach its capacity policy", async () => {
    state.capacityEnabled = true;
    state.rejectMutation = "updateDirectPolicy";
    state.devices = [
      {
        slug: "cli",
        endpoints: [
          {
            slug: "endpoint",
            label: "Endpoint",
            published: true,
            capabilityMetadata: null,
            models: [
              {
                id: "model-id",
                canonicalModelId: "owner/cli/model",
              },
            ],
          },
        ],
      },
    ];
    state.pools = [memberPool];
    mount();

    const poolCard = screen.getByRole("region", { name: "Pool" });
    fireEvent.click(within(poolCard).getByRole("button", { name: "dashboard:pools.addMember" }));
    const title = await screen.findByText("dashboard:pools.addMemberTitle");
    const dialog = title.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("member dialog not found");
    fireEvent.click(within(dialog).getByRole("button", { name: "common:actions.save" }));

    await waitFor(() => expect(state.mutationCalls).toContain("updateDirectPolicy"));

    expect(toastState.success).not.toHaveBeenCalled();
  });
});
