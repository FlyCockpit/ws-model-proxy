// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  providerEgressEnabled: false,
  providerOperationsMounts: 0,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
  const mutation = () => ({
    mutationOptions: () => ({ mutationFn: async () => undefined }),
  });
  return {
    orpc: {
      appConfig: query("appConfig", () => ({
        capacityEnabled: false,
        providerEgressEnabled: state.providerEgressEnabled,
      })),
      capacityManagement: {
        key: () => ["capacityManagement"],
        list: query("capacities", () => []),
        remove: mutation(),
      },
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listModelPools: query("pools", () => []),
        listCliDevices: query("devices", () => []),
        deleteModelPool: mutation(),
        grantPoolAccessByEmail: mutation(),
        removePoolMember: mutation(),
        reorderProviderPoolMember: mutation(),
        revokePoolAccessByEmail: mutation(),
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
