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
  nextReject: null as { name: string; error: unknown } | null,
  mutationCalls: [] as Array<{ name: string; variables: unknown }>,
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
  ConfirmDeleteDialog: ({
    children,
    open,
    title,
    onConfirm,
  }: {
    children?: ReactNode;
    open: boolean;
    title: string;
    onConfirm: (value: string) => void;
  }) => (
    <>
      {children}
      {open ? (
        <button type="button" onClick={() => onConfirm("")}>
          {`confirm ${title}`}
        </button>
      ) : null}
    </>
  ),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/utils/orpc", () => {
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const deferredQuery = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data() }),
  });
  const mutation = (name = "") => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      mutationFn: async (variables: unknown) => {
        state.mutationCalls.push({ name, variables });
        if (state.nextReject && state.nextReject.name === name) {
          const error = state.nextReject.error;
          state.nextReject = null;
          throw error;
        }
        return undefined;
      },
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
        key: () => ["forwarderManagement"],
        deleteModelPool: mutation("deleteModelPool"),
        updateModelPool: mutation("updateModelPool"),
        addPoolMember: mutation(),
        updatePoolMember: mutation(),
        removePoolMember: mutation("removePoolMember"),
        grantPoolAccessByEmail: mutation(),
        revokePoolAccessByEmail: mutation(),
      },
      capacityManagement: {
        key: () => ["capacityManagement"],
        list: deferredQuery("capacities", () => state.capacities),
        remove: mutation("capacityRemove"),
      },
    },
  };
});

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppMutationCache } from "@/utils/mutation-error-toast";
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
  state.nextReject = null;
  state.mutationCalls = [];
  vi.mocked(toast.error).mockClear();
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
        fallbackEnabled: false,
        fallbackForGrantees: false,
        externalAfterWaitMs: 2000,
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
    // Owner fallback settings: the plain name stays local; grantees are not
    // covered unless the owner opts in.
    expect(screen.getByText("dashboard:pools.fallbackSettings.enabled")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.fallbackSettings.forGrantees")).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.fallbackSettings.externalAfterWaitMs",
        ) as HTMLInputElement
      ).value,
    ).toBe("2000");
  });

  describe("fallback settings form", () => {
    const fallbackPool = () => ({
      id: "pool-1",
      slug: "primary",
      name: "Primary",
      description: null,
      canonicalModelId: "owner/pool/primary",
      fallbackEnabled: false,
      fallbackForGrantees: false,
      externalAfterWaitMs: 2000,
      members: [],
      grants: [],
      compatibility: { recommendedSurface: null },
      transformer: { model: null },
    });
    const updateCalls = () => state.mutationCalls.filter((call) => call.name === "updateModelPool");
    const submit = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "dashboard:pools.fallbackSettings.save" }),
      );

    it("sends only the changed fields", async () => {
      state.providerEgressEnabled = true;
      state.tab = "fallback";
      state.pools = [fallbackPool()];
      mount(<PoolDetailPage poolId="pool-1" />);

      // Nothing changed: no request at all.
      submit();
      await waitFor(() => expect(screen.getByRole("button", { name: /fallbackSettings.save/ })));
      expect(updateCalls()).toEqual([]);

      fireEvent.click(
        screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.forGrantees" }),
      );
      submit();
      await waitFor(() => expect(updateCalls()).toHaveLength(1));
      // The stored external wait is not re-sent, so it can never fail this save.
      expect(updateCalls()[0]?.variables).toEqual({ id: "pool-1", fallbackForGrantees: true });
    });

    it("asks for grantee privacy confirmation and retries with it", async () => {
      state.providerEgressEnabled = true;
      state.tab = "fallback";
      state.pools = [fallbackPool()];
      state.nextReject = {
        name: "updateModelPool",
        error: {
          code: "BAD_REQUEST",
          data: {
            reason: "GRANTEE_PRIVACY_CONFIRMATION_REQUIRED",
            poolName: "Primary",
            grantees: [{ email: "grantee@example.test", name: "Grantee" }],
          },
        },
      };
      mount(<PoolDetailPage poolId="pool-1" />);

      fireEvent.click(
        screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.enabled" }),
      );
      submit();
      await waitFor(() => expect(screen.getByText("grantee@example.test")).toBeTruthy());
      expect(toast.error).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "dashboard:pools.granteePrivacyConfirmAction" }),
      );
      await waitFor(() => expect(updateCalls()).toHaveLength(2));
      expect(updateCalls()[1]?.variables).toEqual({
        id: "pool-1",
        fallbackEnabled: true,
        confirmGranteePrivacyChange: true,
      });
    });

    it("surfaces other save errors instead of swallowing them", async () => {
      state.providerEgressEnabled = true;
      state.tab = "fallback";
      state.pools = [fallbackPool()];
      state.nextReject = {
        name: "updateModelPool",
        error: { code: "BAD_REQUEST", message: "boom" },
      };
      mount(<PoolDetailPage poolId="pool-1" />);

      fireEvent.change(
        screen.getByLabelText("dashboard:pools.fallbackSettings.externalAfterWaitMs"),
        { target: { value: "500" } },
      );
      submit();
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(updateCalls()[0]?.variables).toEqual({ id: "pool-1", externalAfterWaitMs: 500 });
    });
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

describe("delete conflicts on pool pages", () => {
  function mountWithAppToasts(children: ReactNode) {
    return render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            mutationCache: createAppMutationCache((key) => key),
          })
        }
      >
        {children}
      </QueryClientProvider>,
    );
  }

  function conflict(reason: string) {
    return { status: 409, code: "CONFLICT", message: "raw", data: { reason } };
  }

  const pool = {
    id: "pool-1",
    slug: "primary",
    name: "Primary",
    description: null,
    canonicalModelId: "owner/pool/primary",
    members: [
      {
        id: "member-1",
        discoveredModelId: "model-1",
        model: { canonicalModelId: "owner/desk/local/example" },
        routingStatus: "ACTIVE",
        tier: "PRIMARY",
        weight: 1,
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
      },
    ],
    grants: [],
    compatibility: { recommendedSurface: null },
    transformer: { model: null },
  };

  it("shows the in-flight copy when a pool delete is still draining", async () => {
    state.pools = [pool];
    state.nextReject = { name: "deleteModelPool", error: conflict("delete_pending") };
    mountWithAppToasts(<PoolDetailPage poolId="pool-1" />);

    fireEvent.click(screen.getByRole("button", { name: "common:actions.delete" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm dashboard:pools.deleteTitle" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("errors:deletionConflict.deletePending"),
    );
  });

  it("suggests disabling a pool member that has retained history", async () => {
    state.pools = [pool];
    state.nextReject = { name: "removePoolMember", error: conflict("retained_history") };
    mountWithAppToasts(<PoolDetailPage poolId="pool-1" />);

    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.removeMember" }));
    fireEvent.click(
      screen.getByRole("button", { name: "confirm dashboard:pools.removeMemberTitle" }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "errors:deletionConflict.retainedHistory.poolMember",
      ),
    );
  });

  it("shows the capacity retained-history copy on a capacity delete", async () => {
    state.capacities = [
      {
        id: "capacity-1",
        label: "GPU box",
        runtimeModel: "example",
        hardConcurrencyLimit: 2,
        _count: { CapacityLeases: 0 },
      },
    ];
    state.nextReject = { name: "capacityRemove", error: conflict("retained_history") };
    mountWithAppToasts(<InferenceCapacityPage />);

    fireEvent.click(await screen.findByRole("button", { name: "common:actions.delete" }));
    fireEvent.click(
      screen.getByRole("button", { name: "confirm dashboard:pools.capacity.deleteTitle" }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("errors:deletionConflict.retainedHistory.capacity"),
    );
  });

  it("keeps the generic copy for a capacity CONFLICT without a reason", async () => {
    state.capacities = [
      {
        id: "capacity-1",
        label: "GPU box",
        runtimeModel: "example",
        hardConcurrencyLimit: 2,
        _count: { CapacityLeases: 0 },
      },
    ];
    state.nextReject = {
      name: "capacityRemove",
      error: { status: 409, code: "CONFLICT", message: "raw" },
    };
    mountWithAppToasts(<InferenceCapacityPage />);

    fireEvent.click(await screen.findByRole("button", { name: "common:actions.delete" }));
    fireEvent.click(
      screen.getByRole("button", { name: "confirm dashboard:pools.capacity.deleteTitle" }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("That conflicts with an existing record."),
    );
  });
});
