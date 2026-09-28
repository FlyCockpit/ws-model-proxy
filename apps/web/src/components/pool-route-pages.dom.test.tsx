// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capacityEnabled: true,
  providerEgressEnabled: false,
  flagsStatus: "ready" as "ready" | "pending" | "error",
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
  fallbackAudits: [] as Array<Record<string, unknown>>,
  auditQueryInputs: [] as unknown[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
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
    queryOptions: () => ({
      queryKey: [key],
      queryFn: async () => {
        if (key === "deploymentFlags" && state.flagsStatus === "pending")
          return new Promise<unknown>(() => {});
        if (key === "deploymentFlags" && state.flagsStatus === "error")
          throw new Error("flags failed");
        return data();
      },
      initialData:
        key === "deploymentFlags" && state.flagsStatus === "pending" ? undefined : data(),
    }),
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
      deploymentFlags: {
        ...query("deploymentFlags", () => ({
          providerEgressEnabled: state.providerEgressEnabled,
        })),
        key: () => ["deploymentFlags"],
      },
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
        updatePoolGrant: mutation("updatePoolGrant"),
        revokePoolAccessByEmail: mutation(),
      },
      providerManagement: {
        listAuditEvents: {
          key: () => ["providerManagement", "listAuditEvents"],
          queryOptions: (options?: { input?: unknown }) => {
            state.auditQueryInputs.push(options?.input);
            return query("poolFallbackAudits", () => state.fallbackAudits).queryOptions();
          },
        },
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
import i18next from "i18next";
import enErrors from "@/locales/en-US/errors.json";

// `friendly()` reads the default i18next instance, which the app's i18n
// module initializes; this test does not load that module.
beforeAll(async () => {
  await i18next.init({ lng: "en-US", resources: { "en-US": { errors: enErrors } } });
});

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
  state.flagsStatus = "ready";
  state.providerEgressEnabled = false;
  state.tab = "overview";
  state.pools = [];
  state.capacities = [];
  state.nextReject = null;
  state.mutationCalls = [];
  state.fallbackAudits = [];
  state.auditQueryInputs = [];
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

    expect(screen.getByText("dashboard:pools.fallbackBadge.local")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "dashboard:pools.fallbackBadge.label" }),
    ).toBeTruthy();

    cleanup();
    mount(<PoolDetailPage poolId="pool-external" />);
    expect(
      screen.getByRole("button", { name: "dashboard:pools.fallbackBadge.label" }),
    ).toBeTruthy();
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
    expect(screen.getByText("dashboard:pools.fallbackSteps.enable")).toBeTruthy();
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

  it("shows the pool's fallback change history with its source (C1b-3)", () => {
    state.tab = "fallback";
    state.pools = [
      {
        id: "pool-1",
        slug: "primary",
        name: "Primary",
        description: null,
        canonicalModelId: "owner/pool/primary",
        fallbackEnabled: true,
        fallbackForGrantees: true,
        externalAfterWaitMs: 2000,
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
    ];
    state.fallbackAudits = [
      {
        id: "audit-1",
        createdAt: new Date("2026-09-28T12:00:00Z"),
        action: "POOL_FALLBACK_UPDATED",
        subjectId: "pool-1",
        providerAccountId: null,
        metadata: {
          source: "mcp",
          changes: { fallbackForGrantees: { before: false, after: true } },
        },
      },
    ];
    mount(<PoolDetailPage poolId="pool-1" />);
    expect(screen.getByText("dashboard:pools.fallbackHistory.title")).toBeTruthy();
    expect(screen.getByText(/dashboard:pools\.fallbackHistory\.sourceMcp/)).toBeTruthy();
    expect(screen.getAllByText("dashboard:pools.fallbackHistory.change")).toHaveLength(1);
    // Scoped to this pool: never the owner's whole audit trail.
    expect(state.auditQueryInputs).toContainEqual({ poolId: "pool-1", limit: 20 });
    expect(
      state.auditQueryInputs.every((input) => (input as { poolId?: string }).poolId === "pool-1"),
    ).toBe(true);
  });

  describe("grant routing (warm-session protection and queue priority)", () => {
    const grantPool = (grant: Record<string, unknown> = {}) => ({
      id: "pool-1",
      slug: "primary",
      name: "Primary",
      description: null,
      canonicalModelId: "owner/pool/primary",
      members: [],
      grants: [
        {
          id: "grant-1",
          createdAt: new Date(0),
          granteeUserId: "grantee-1",
          granteeEmail: "grantee@example.test",
          granteeName: "Grantee",
          protectionOverridePercent: null,
          queuePriority: null,
          ...grant,
        },
      ],
      compatibility: { recommendedSurface: null },
      transformer: { model: null },
    });

    it("saves an unprotected override and a queue priority for one grantee", async () => {
      state.tab = "access";
      state.pools = [grantPool()];
      mount(<PoolDetailPage poolId="pool-1" />);

      fireEvent.click(
        await screen.findByRole("button", { name: "dashboard:pools.grantRouting.editFor" }),
      );
      fireEvent.change(screen.getByLabelText("dashboard:pools.grantRouting.protection"), {
        target: { value: "UNPROTECTED" },
      });
      fireEvent.change(screen.getByLabelText("dashboard:pools.grantRouting.queuePriority"), {
        target: { value: "SET" },
      });
      fireEvent.change(screen.getByLabelText("dashboard:pools.grantRouting.priorityValue"), {
        target: { value: "24" },
      });
      fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

      await waitFor(() =>
        expect(state.mutationCalls).toContainEqual({
          name: "updatePoolGrant",
          variables: {
            poolId: "pool-1",
            grantId: "grant-1",
            protectionOverridePercent: 0,
            queuePriority: 24,
          },
        }),
      );
    });

    it("loads stored values and saves 'pool default' as null", async () => {
      state.tab = "access";
      state.pools = [grantPool({ protectionOverridePercent: 30, queuePriority: 5 })];
      mount(<PoolDetailPage poolId="pool-1" />);

      fireEvent.click(
        await screen.findByRole("button", { name: "dashboard:pools.grantRouting.editFor" }),
      );
      expect(
        (screen.getByLabelText("dashboard:pools.protection.percentLabel") as HTMLInputElement)
          .value,
      ).toBe("30");
      fireEvent.change(screen.getByLabelText("dashboard:pools.grantRouting.protection"), {
        target: { value: "INHERIT" },
      });
      fireEvent.change(screen.getByLabelText("dashboard:pools.grantRouting.queuePriority"), {
        target: { value: "INHERIT" },
      });
      fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));

      await waitFor(() =>
        expect(state.mutationCalls).toContainEqual({
          name: "updatePoolGrant",
          variables: {
            poolId: "pool-1",
            grantId: "grant-1",
            protectionOverridePercent: null,
            queuePriority: null,
          },
        }),
      );
    });
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

    it.each(["pending", "error"] as const)(
      "does not describe %s flags as disabled",
      async (status) => {
        state.flagsStatus = status;
        state.tab = "fallback";
        state.pools = [fallbackPool()];
        mount(<PoolDetailPage poolId="pool-1" />);
        if (status === "pending") expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
        else
          expect(await screen.findByText("dashboard:deploymentFeatures.loadFailed")).toBeTruthy();
        expect(screen.queryByText("dashboard:pools.fallbackDisabledDeployment")).toBeNull();
        expect(
          screen.queryByRole("checkbox", { name: "dashboard:pools.fallbackSettings.enabled" }),
        ).toBeNull();
      },
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

    it("refreshes the fallback change history after a save (C2a-2)", async () => {
      const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      state.providerEgressEnabled = true;
      state.tab = "fallback";
      state.pools = [fallbackPool()];
      mount(<PoolDetailPage poolId="pool-1" />);
      fireEvent.click(
        screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.forGrantees" }),
      );
      submit();
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: ["providerManagement", "listAuditEvents"],
        }),
      );
      invalidate.mockRestore();
    });

    it("enables fallback in one save without a grantee confirmation", async () => {
      state.providerEgressEnabled = true;
      state.tab = "fallback";
      state.pools = [fallbackPool()];
      mount(<PoolDetailPage poolId="pool-1" />);
      fireEvent.click(
        screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.enabled" }),
      );
      submit();
      await waitFor(() => expect(updateCalls()).toHaveLength(1));
      expect(updateCalls()[0]?.variables).toEqual({ id: "pool-1", fallbackEnabled: true });
      expect(toast.error).not.toHaveBeenCalled();
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

  it("says fallback is unavailable when the server refuses enabling it after the switch turned off", async () => {
    // The form loaded with the switch on; it turned off before the save.
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
    state.nextReject = {
      name: "updateModelPool",
      error: {
        code: "NOT_FOUND",
        status: 404,
        message: "Provider egress is not enabled for this deployment.",
        data: { reason: "PROVIDER_EGRESS_DISABLED" },
      },
    };
    mount(<PoolDetailPage poolId="pool-1" />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.enabled" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.fallbackSettings.save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "dashboard:pools.fallbackSettings.enableBlockedDeployment",
      ),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(state.mutationCalls).toEqual([
      { name: "updateModelPool", variables: { id: "pool-1", fallbackEnabled: true } },
    ]);
  });

  it("keeps the generic save error for a NOT_FOUND without the switch reason", async () => {
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
    state.nextReject = {
      name: "updateModelPool",
      error: { code: "NOT_FOUND", status: 404, message: "Model pool not found." },
    };
    mount(<PoolDetailPage poolId="pool-1" />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "dashboard:pools.fallbackSettings.enabled" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.fallbackSettings.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalledWith(
      "dashboard:pools.fallbackSettings.enableBlockedDeployment",
    );
  });

  it("allows fallback withdrawal and wait-time edits when provider egress is off", async () => {
    state.providerEgressEnabled = false;
    state.tab = "fallback";
    state.pools = [
      {
        id: "pool-1",
        slug: "primary",
        name: "Primary",
        description: null,
        canonicalModelId: "owner/pool/primary",
        fallbackEnabled: true,
        fallbackForGrantees: true,
        externalAfterWaitMs: 2000,
        members: [],
        grants: [],
        compatibility: { recommendedSurface: null },
        transformer: { model: null },
      },
    ];

    mount(<PoolDetailPage poolId="pool-1" />);

    expect(screen.getByText("dashboard:pools.fallbackDisabledDeployment")).toBeTruthy();

    const enableFallback = screen.getByRole("checkbox", {
      name: "dashboard:pools.fallbackSettings.enabled",
    });
    const forGrantees = screen.getByRole("checkbox", {
      name: "dashboard:pools.fallbackSettings.forGrantees",
    });
    expect(enableFallback.getAttribute("aria-disabled")).not.toBe("true");
    expect(forGrantees.getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(enableFallback);
    fireEvent.click(forGrantees);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.fallbackSettings.save" }));
    await waitFor(() =>
      expect(state.mutationCalls.filter((call) => call.name === "updateModelPool")).toHaveLength(1),
    );
    expect(state.mutationCalls[0]?.variables).toEqual({
      id: "pool-1",
      fallbackEnabled: false,
      fallbackForGrantees: false,
    });

    state.mutationCalls = [];
    state.pools = [
      {
        ...(state.pools[0] as Record<string, unknown>),
        fallbackEnabled: false,
        fallbackForGrantees: false,
      },
    ];
    cleanup();
    mount(<PoolDetailPage poolId="pool-1" />);
    fireEvent.change(
      screen.getByLabelText("dashboard:pools.fallbackSettings.externalAfterWaitMs"),
      { target: { value: "4500" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.fallbackSettings.save" }));
    await waitFor(() =>
      expect(state.mutationCalls.filter((call) => call.name === "updateModelPool")).toHaveLength(1),
    );
    expect(state.mutationCalls[0]?.variables).toEqual({
      id: "pool-1",
      externalAfterWaitMs: 4500,
    });
  });

  it("blocks turning fallback on when provider egress is off", async () => {
    state.providerEgressEnabled = false;
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

    for (const name of [
      "dashboard:pools.fallbackSettings.enabled",
      "dashboard:pools.fallbackSettings.forGrantees",
    ]) {
      const control = screen.getByRole("checkbox", { name });
      expect(
        control.getAttribute("aria-disabled") === "true" || control.hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.click(control);
    }
    expect(state.mutationCalls).toEqual([]);
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

const NO_ENGINE_FACTS = {
  engineKind: null,
  engineSlots: null,
  kvBudgetTokens: null,
  maxModelLen: null,
  engineFactsSource: null,
  engineFactsAt: null,
  enginePreset: { preset: "generic", fullWhen: "active_at_user_cap", protectionUnit: "slots" },
};

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

  it("shows detected engine facts, the preset and their source", async () => {
    state.capacities = [
      {
        id: "capacity-1",
        label: "GPU box",
        runtimeModel: "example",
        hardConcurrencyLimit: 4,
        engineKind: "LLAMA_CPP",
        engineSlots: 4,
        kvBudgetTokens: null,
        maxModelLen: 32768,
        engineFactsSource: "PROBE",
        engineFactsAt: new Date("2026-09-28T10:00:00.000Z"),
        enginePreset: { preset: "llama.cpp", fullWhen: "active_at_slots", protectionUnit: "slots" },
        _count: { CapacityLeases: 0 },
      },
      {
        id: "capacity-2",
        label: "Manual",
        runtimeModel: "example",
        hardConcurrencyLimit: 1,
        ...NO_ENGINE_FACTS,
        _count: { CapacityLeases: 0 },
      },
    ];
    mountWithAppToasts(<InferenceCapacityPage />);

    expect(await screen.findByText(/dashboard:pools\.capacity\.engineFacts\.engine/)).toBeTruthy();
    expect(screen.getByText(/dashboard:pools\.capacity\.engineFacts\.slots/)).toBeTruthy();
    expect(screen.getByText(/dashboard:pools\.capacity\.engineFacts\.sources\.PROBE/)).toBeTruthy();
    // Only the capacity with facts shows them.
    expect(screen.getAllByText(/dashboard:pools\.capacity\.engineFacts\.preset/)).toHaveLength(1);
  });

  it("shows facts for a capacity whose only stored fact is maxModelLen", async () => {
    state.capacities = [
      {
        id: "capacity-1",
        label: "GPU box",
        runtimeModel: "example",
        hardConcurrencyLimit: 2,
        ...NO_ENGINE_FACTS,
        maxModelLen: 131072,
        engineFactsSource: "PROBE",
        engineFactsAt: new Date("2026-09-28T10:00:00.000Z"),
        _count: { CapacityLeases: 0 },
      },
    ];
    mountWithAppToasts(<InferenceCapacityPage />);

    expect(
      await screen.findByText(/dashboard:pools\.capacity\.engineFacts\.maxModelLen/),
    ).toBeTruthy();
    expect(screen.getByText(/dashboard:pools\.capacity\.engineFacts\.preset/)).toBeTruthy();
  });

  it("shows the capacity retained-history copy on a capacity delete", async () => {
    state.capacities = [
      {
        id: "capacity-1",
        label: "GPU box",
        runtimeModel: "example",
        hardConcurrencyLimit: 2,
        ...NO_ENGINE_FACTS,
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
        ...NO_ENGINE_FACTS,
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

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enErrors.friendly.conflict));
  });
});
