// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capacityEnabled: true,
  pools: [] as Array<Record<string, unknown>>,
  capacities: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    Link: ({
      children,
      params,
    }: {
      children: ReactNode;
      params?: { lang?: string; poolId?: string };
    }) => <a href={`/${params?.lang}/dashboard/pools/${params?.poolId ?? "new"}`}>{children}</a>,
  };
});

vi.mock("@/components/forwarder-dashboard-sections", () => ({
  allDirectModels: () => [],
  CapacitySetupForm: () => <div>capacity-form</div>,
  CopyableModelId: ({ modelId }: { modelId: string }) => <span>{modelId}</span>,
  GrantPoolDialog: ({ pool }: { pool: unknown }) => (pool ? <div>grant-pool-dialog</div> : null),
  PoolMemberForm: () => <div>pool-member-form</div>,
  PoolForm: () => <div>pool-form</div>,
  resolveCapacityAvailability: (enabled: boolean) => (enabled ? "enabled" : "disabled"),
}));

vi.mock("@/components/provider-operations-section", () => ({
  ProviderOperationsSection: () => <div>provider-operations</div>,
}));

vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/utils/orpc", () => {
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const deferredQuery = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data() }),
  });
  const mutation = () => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      mutationFn: async () => undefined,
      ...options,
    }),
  });
  return {
    orpc: {
      appConfig: query("appConfig", () => ({
        capacityEnabled: state.capacityEnabled,
        providerEgressEnabled: false,
        protocolAdaptationAvailable: true,
      })),
      forwarderManagement: {
        listModelPools: query("pools", () => state.pools),
        listCliDevices: query("devices", () => []),
        deleteModelPool: mutation(),
        addPoolMember: mutation(),
        updatePoolMember: mutation(),
        removePoolMember: mutation(),
        grantPoolAccessByEmail: mutation(),
        revokePoolAccessByEmail: mutation(),
      },
      capacityManagement: {
        key: () => ["capacityManagement"],
        list: deferredQuery("capacities", () => state.capacities),
        remove: mutation(),
      },
    },
  };
});

import { InferenceCapacityPage, PoolDetailPage, PoolsListPage } from "./pool-route-pages";

function mount(children: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.capacityEnabled = true;
  state.pools = [];
  state.capacities = [];
});

describe("dedicated pool pages", () => {
  it("links the list edit action to the pool detail route instead of opening a sheet", () => {
    state.pools = [
      {
        id: "pool-1",
        slug: "primary",
        name: "Primary",
        description: null,
        canonicalModelId: "owner/pool/primary",
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
    ];

    mount(<PoolsListPage lang="en-US" />);

    const edit = screen.getByRole("link", { name: "common:actions.edit" });
    expect(edit.getAttribute("href")).toBe("/en-US/dashboard/pools/pool-1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a not-found state for a pool outside the owned list", () => {
    mount(<PoolDetailPage poolId="missing" />);

    expect(screen.getByRole("status").textContent).toContain("dashboard:pools.notFound");
  });

  it("exposes member, grant, and delete-pool controls on the detail page", () => {
    state.pools = [
      {
        id: "pool-1",
        slug: "primary",
        name: "Primary",
        description: null,
        canonicalModelId: "owner/pool/primary",
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
    ];

    mount(<PoolDetailPage poolId="pool-1" />);

    expect(screen.getByRole("button", { name: "dashboard:pools.addMember" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "dashboard:pools.grant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "common:actions.delete" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.addMember" }));
    expect(screen.getByText("pool-member-form")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.grant" }));
    expect(screen.getByText("grant-pool-dialog")).toBeTruthy();
  });

  it("renders the disabled capacity reason instead of a skipped-query skeleton", async () => {
    state.capacityEnabled = false;
    mount(<InferenceCapacityPage />);

    await waitFor(() =>
      expect(screen.getByText("dashboard:pools.capacity.disabledReason")).toBeTruthy(),
    );
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
  });
});
