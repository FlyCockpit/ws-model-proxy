// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capacityEnabled: true,
  providerEgressEnabled: false,
  tab: "overview" as "overview" | "fallback" | "routing" | "capacity" | "media" | "access",
  detailTab: null as
    | null
    | ((props: {
        tab: "overview" | "fallback" | "routing" | "capacity" | "media" | "access";
      }) => ReactNode),
  pools: [] as Array<Record<string, unknown>>,
  capacities: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/use-deployment-audience", () => ({
  useDeploymentAudience: () => ({ isAdmin: false }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    Outlet: () => {
      const DetailTab = state.detailTab;
      return DetailTab ? <DetailTab tab={state.tab} /> : null;
    },
    Link: ({
      children,
      to,
      params,
    }: {
      children: ReactNode;
      to: string;
      params?: { lang?: string; poolId?: string };
    }) => (
      <a
        href={to
          .replace("$lang", params?.lang ?? "en-US")
          .replace("$poolId", params?.poolId ?? "new")}
      >
        {children}
      </a>
    ),
  };
});

vi.mock("@/components/forwarder-dashboard-sections", () => ({
  allDirectModels: () => [],
  CapacitySetupForm: () => <div>capacity-form</div>,
  CopyableModelId: ({ modelId }: { modelId: string }) => <span>{modelId}</span>,
  GrantPoolDialog: ({ pool }: { pool: unknown }) => (pool ? <div>grant-pool-dialog</div> : null),
  PoolMemberForm: () => <div>pool-member-form</div>,
  PoolForm: () => <div>pool-form</div>,
  resolveCapacityAvailability: () => "enabled" as const,
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
      deploymentFlags: query("deploymentFlags", () => ({
        providerEgressEnabled: state.providerEgressEnabled,
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

import {
  InferenceCapacityPage,
  PoolDetailPage,
  PoolDetailTab,
  PoolsListPage,
} from "./pool-route-pages";

state.detailTab = PoolDetailTab;

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
  state.providerEgressEnabled = false;
  state.tab = "overview";
  state.pools = [];
  state.capacities = [];
});

describe("dedicated pool pages", () => {
  it("shows private and external-provider badges on the pool list and detail", () => {
    state.pools = [
      {
        id: "pool-private",
        slug: "local",
        name: "Local",
        description: null,
        canonicalModelId: "owner/pool/local",
        effectiveProviderEgress: false,
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
      {
        id: "pool-external",
        slug: "shared",
        name: "Shared",
        description: null,
        canonicalModelId: "owner/pool/shared",
        effectiveProviderEgress: true,
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
    ];

    mount(<PoolsListPage lang="en-US" />);

    expect(screen.getByText("dashboard:pools.privacyBadge.private")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.privacyBadge.external")).toBeTruthy();

    cleanup();
    mount(<PoolDetailPage poolId="pool-external" />);
    expect(screen.getByText("dashboard:pools.privacyBadge.external")).toBeTruthy();
  });

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

  it("renders all detail tab URLs and the fallback empty checklist", () => {
    state.capacityEnabled = true;
    state.providerEgressEnabled = true;
    state.tab = "fallback";
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

    expect(
      within(screen.getByRole("navigation", { name: "dashboard:pools.detailNavAriaLabel" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/en-US/dashboard/pools/pool-1",
      "/en-US/dashboard/pools/pool-1/fallback",
      "/en-US/dashboard/pools/pool-1/routing",
      "/en-US/dashboard/pools/pool-1/capacity",
      "/en-US/dashboard/pools/pool-1/media",
      "/en-US/dashboard/pools/pool-1/access",
    ]);
    expect(screen.getByText("dashboard:pools.fallbackEmpty")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackSteps.account")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackSteps.model")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackSteps.ceiling")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackSteps.acknowledge")).toBeTruthy();
  });

  it("renders the disabled deployment copy in the fallback tab when provider egress is off", () => {
    state.providerEgressEnabled = false;
    state.tab = "fallback";
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

    expect(screen.getByText("dashboard:pools.fallbackDisabledDeployment")).toBeTruthy();
  });

  it("shows stored member policy values and does not mark an override as inherited", () => {
    state.tab = "overview";
    state.pools = [
      {
        id: "pool-1",
        slug: "primary",
        name: "Primary",
        description: null,
        canonicalModelId: "owner/pool/primary",
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
        capacityPriority: 16,
        capacityConcurrencyLimit: 4,
        capacityReservedSlots: 1,
        capacityWaitBudgetMs: 30000,
        capacityContextCeiling: 32768,
        capacityContextMargin: 1024,
        capacityBorrowPolicy: "WHEN_IDLE",
        members: [
          {
            id: "member-1",
            discoveredModelId: "model-1",
            model: { canonicalModelId: "owner/cli/model" },
            tier: "PRIMARY",
            weight: 1,
            routingStatus: "ACTIVE",
            capacityPriority: 9,
            capacityConcurrencyMode: "LIMITED",
            capacityConcurrencyLimit: 2,
            capacityReservedSlots: 1,
            capacityBorrowPolicy: "NEVER",
            capacityWaitBudgetMode: "LIMITED",
            capacityWaitBudgetMs: 15000,
            capacityContextCeilingMode: "LIMITED",
            capacityContextCeiling: 16000,
            capacityContextMargin: 512,
          },
        ],
      },
    ];

    mount(<PoolDetailPage poolId="pool-1" />);

    const policy = screen.getByText(/dashboard:pools.capacity.modes.override/);
    expect(policy.textContent).toContain("9");
    expect(policy.textContent).toContain("16000");
    expect(policy.textContent).not.toContain("dashboard:pools.inherited");
  });

  it("loads capacity records instead of a deployment-disabled reason", async () => {
    mount(<InferenceCapacityPage />);

    await waitFor(() => expect(screen.getByText("dashboard:pools.capacity.empty")).toBeTruthy());
    expect(screen.queryByText("dashboard:pools.capacity.disabledReason")).toBeNull();
  });
});
