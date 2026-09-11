// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  appConfig: { capacityEnabled: true } as Record<string, unknown>,
  // When false, the page's appConfig observer starts cold (no initialData).
  appConfigInitialData: true,
  // The promise settled by each appConfig fetch; tests can swap in a pending
  // or rejecting promise to pin pending/error gate behavior.
  appConfigPromise: Promise.resolve({ capacityEnabled: true } as Record<string, unknown>),
  capacityPromise: Promise.resolve([] as Array<Record<string, unknown>>),
  capacityCalls: 0,
  candidateCalls: 0,
  createRejection: undefined as unknown,
  devices: [] as Array<Record<string, unknown>>,
  submitted: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number; name?: string }) =>
      values?.current ? `${key}:${values.current}` : values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useParams: () => ({ lang: "en-US" }),
    useNavigate: () => () => undefined,
  };
});
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: {
      queryOptions: () => ({
        queryKey: ["appConfig"],
        // state.appConfigPromise only gates settle timing (pending/rejected);
        // the resolved value is always the current state.appConfig snapshot.
        queryFn: async () => {
          await state.appConfigPromise;
          return state.appConfig;
        },
        ...(state.appConfigInitialData ? { initialData: state.appConfig } : {}),
      }),
    },
    forwarderManagement: {
      key: () => ["forwarderManagement"],
      listCliDevices: {
        queryOptions: () => ({
          queryKey: ["devices"],
          queryFn: async () => state.devices,
        }),
      },
      listGuardedOverflowCandidates: {
        queryOptions: () => ({
          queryKey: ["providers"],
          queryFn: async () => {
            state.candidateCalls += 1;
            return [
              {
                id: "provider-a",
                upstreamModelId: "public-model",
                displayName: "Public provider",
                providerAccount: { label: "OpenAI" },
                pricing: { currency: "USD" },
                // Chat-native provider so provider-first PRIMARY selections
                // have a real best-ranked native surface to auto-set.
                nativeCapabilities: {
                  version: 3,
                  protocol: "openai-compatible",
                  surfaces: {
                    openaiChatCompletions: {
                      source: "provider",
                      confidence: "exact",
                      supported: true,
                      streaming: true,
                    },
                  },
                },
              },
            ];
          },
        }),
      },
      createGuardedModelPool: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: async (input: Record<string, unknown>) => {
            if (state.createRejection !== undefined) throw state.createRejection;
            state.submitted = input;
            return {};
          },
        }),
      },
    },
    capacityManagement: {
      list: {
        queryOptions: () => ({
          queryKey: ["capacities"],
          queryFn: () => {
            state.capacityCalls += 1;
            return state.capacityPromise;
          },
        }),
      },
    },
  },
}));
vi.mock("@ws-model-proxy/ui/components/dialog", async () => {
  const { createContext, useContext } = await import("react");
  const DialogRootContext = createContext(false);
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <DialogRootContext.Provider value>{children}</DialogRootContext.Provider> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
    DialogDescription: ({ children }: { children: ReactNode }) => {
      if (!useContext(DialogRootContext)) throw new Error("Dialog.Root context is required");
      return <p>{children}</p>;
    },
    DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
    DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    DialogTitle: ({ children }: { children: ReactNode }) => {
      if (!useContext(DialogRootContext)) throw new Error("Dialog.Root context is required");
      return <h1>{children}</h1>;
    },
  };
});
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { NewPoolPage } from "./guarded-pool-new-page";
import { GuardedPoolSetupWizard } from "./guarded-pool-setup-wizard";

const surface = (name: "openaiChatCompletions" | "openaiResponses") => ({
  version: 3 as const,
  protocol: "openai-compatible" as const,
  surfaces: {
    [name]: {
      source: "declared" as const,
      confidence: "exact" as const,
      supported: true,
      streaming: true,
    },
  },
});
const models = [
  {
    id: "chat",
    canonicalModelId: "owner/cli/chat",
    effectiveCapabilities: { metadata: surface("openaiChatCompletions") },
    executionTarget: { inferenceCapacityId: "chat-capacity" },
  },
  {
    id: "responses",
    canonicalModelId: "owner/cli/responses",
    effectiveCapabilities: { metadata: surface("openaiResponses") },
    executionTarget: { inferenceCapacityId: "responses-capacity" },
  },
];

// Device fixture exposing one published direct model so /pools/new can reach
// the provider step; mirrors the shape of listCliDevices output.
const devicesWithModels = [
  {
    id: "device",
    slug: "cli",
    endpoints: [
      {
        slug: "endpoint",
        label: "Endpoint",
        published: true,
        capabilityMetadata: null,
        models: [models[1]],
      },
    ],
  },
];

function mountPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <NewPoolPage />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function mount(
  open = true,
  protocolAdaptationAvailable = true,
  initialStep: 0 | 1 | 2 | 3 = 0,
  options: { providerEgressEnabled?: boolean; initialProviderModelIds?: string[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <GuardedPoolSetupWizard
        open={open}
        onOpenChange={() => undefined}
        directModels={models}
        capacityEnabled
        protocolAdaptationAvailable={protocolAdaptationAvailable}
        providerEgressEnabled={options.providerEgressEnabled ?? true}
        initialStep={initialStep}
        initialProviderModelIds={options.initialProviderModelIds ?? []}
      />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  cleanup();
  state.appConfig = { capacityEnabled: true };
  state.appConfigInitialData = true;
  state.appConfigPromise = Promise.resolve(state.appConfig);
  state.capacityCalls = 0;
  state.candidateCalls = 0;
  state.capacityPromise = Promise.resolve([]);
  state.createRejection = undefined;
  state.devices = [];
  state.submitted = undefined;
});

describe("GuardedPoolSetupWizard mounted workflow", () => {
  it("renders page mode without Dialog.Root-dependent primitives", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GuardedPoolSetupWizard
          open
          page
          onOpenChange={() => undefined}
          directModels={models}
          capacityEnabled
          protocolAdaptationAvailable
          providerEgressEnabled
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("dashboard:pools.wizard.title")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps affinity available when protocol adaptation is disabled by deployment", () => {
    mount(true, false, 1);

    const adaptation = screen.getByRole("radio", {
      name: "dashboard:pools.protocolOptions.lossless.label",
    });
    const lossy = screen.getByRole("radio", {
      name: "dashboard:pools.protocolOptions.lossy.label",
    });
    const affinity = screen.getByRole("checkbox", {
      name: "dashboard:pools.wizard.fields.affinityEnabled",
    });
    expect((adaptation as HTMLInputElement).disabled).toBe(true);
    expect((lossy as HTMLInputElement).disabled).toBe(true);
    expect(affinity.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText("dashboard:pools.protocolAdaptationDisabledReason")).toBeTruthy();
  });

  it("selects lossless instruction merge from the protocol radio", async () => {
    const user = userEvent.setup();
    mount(true, true, 1);

    const lossy = screen.getByRole("radio", {
      name: "dashboard:pools.protocolOptions.lossy.label",
    });
    await user.click(lossy);
    expect((lossy as HTMLInputElement).checked).toBe(true);
  });

  it("does not fetch candidates or capacities while closed", async () => {
    mount(false);

    await Promise.resolve();

    expect(state.candidateCalls).toBe(0);
    expect(state.capacityCalls).toBe(0);
  });

  it("fetches candidates and capacities when opened after mounting", async () => {
    const view = mount(false);

    expect(state.candidateCalls).toBe(0);
    expect(state.capacityCalls).toBe(0);

    view.rerender(
      <QueryClientProvider client={view.client}>
        <GuardedPoolSetupWizard
          open
          onOpenChange={() => undefined}
          directModels={models}
          capacityEnabled
          protocolAdaptationAvailable
          providerEgressEnabled
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(state.candidateCalls).toBe(1);
      expect(state.capacityCalls).toBe(1);
    });
  });

  it("disables provider selection and shows the deployment notice when egress is disabled", async () => {
    const user = userEvent.setup();
    mount(true, true, 2, { providerEgressEnabled: false });

    const checkbox = await screen.findByLabelText(
      "dashboard:pools.wizard.selectProvider:Public provider",
    );
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("dashboard:pools.wizard.providerEgressDisabled")).toBeTruthy();
    expect(screen.queryByText("dashboard:pools.wizard.egressWarning")).toBeNull();

    await user.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("ignores initial provider selections when egress is disabled", async () => {
    mount(true, true, 2, {
      providerEgressEnabled: false,
      initialProviderModelIds: ["provider-a"],
    });

    const checkbox = await screen.findByLabelText(
      "dashboard:pools.wizard.selectProvider:Public provider",
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("dashboard:pools.wizard.egressWarning")).toBeNull();
  });

  it("submits an empty providerModels payload when egress is disabled from the start", async () => {
    const user = userEvent.setup();
    mount(true, true, 0, { providerEgressEnabled: false });

    await driveToReviewStep(user);
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    await waitFor(() => expect(state.submitted).toBeDefined());
    // Gate-blocked flow must reach the server with no provider attachments;
    // tier/order defaults stay inert because no provider rows are emitted.
    expect(state.submitted?.providerModels).toEqual([]);
  });

  it("blocks advancing from the provider step when the gate flips off with a live selection", async () => {
    const user = userEvent.setup();
    // Dialog-mode callers have no page-level remount key, so a mid-session
    // gate flip must be caught by step validation (belt-and-braces alongside
    // the server-side PROVIDER_EGRESS_DISABLED rejection).
    const view = mount(true, true, 2);

    const provider = await screen.findByLabelText(
      "dashboard:pools.wizard.selectProvider:Public provider",
    );
    await user.click(provider);
    expect(provider.getAttribute("aria-checked")).toBe("true");

    view.rerender(
      <QueryClientProvider client={view.client}>
        <GuardedPoolSetupWizard
          open
          onOpenChange={() => undefined}
          directModels={models}
          capacityEnabled
          protocolAdaptationAvailable
          providerEgressEnabled={false}
          initialStep={2}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));

    expect(screen.getByText("dashboard:pools.wizard.errors.providerEgressBlocked")).toBeTruthy();
    // Advance was blocked: still on the provider step, not the review step.
    expect(screen.getByText("dashboard:pools.wizard.providerOrderExact")).toBeTruthy();
    expect(screen.queryByText("dashboard:pools.wizard.atomicRollback")).toBeNull();
  });

  it("remounts with no provider selection when the settled egress gate flips off", async () => {
    const user = userEvent.setup();
    state.appConfig = { capacityEnabled: true, providerEgressEnabled: true };
    state.devices = [
      {
        id: "device",
        slug: "cli",
        endpoints: [
          {
            slug: "endpoint",
            label: "Endpoint",
            published: true,
            capabilityMetadata: null,
            models: [models[1]],
          },
        ],
      },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const routeElement = (
      <QueryClientProvider client={client}>
        <NewPoolPage />
      </QueryClientProvider>
    );
    const view = render(routeElement);

    // Drive to the provider step and preselect the provider while gate=true.
    await user.type(await screen.findByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));

    const provider = await screen.findByLabelText(
      "dashboard:pools.wizard.selectProvider:Public provider",
    );
    await user.click(provider);
    expect(provider.getAttribute("aria-checked")).toBe("true");

    // Simulate the settled appConfig snapshot flipping the gate to disabled.
    client.setQueryData(["appConfig"], {
      capacityEnabled: true,
      providerEgressEnabled: false,
    });
    view.rerender(routeElement);

    // The remount reset the form: the slug input is empty again (fresh state).
    await waitFor(() =>
      expect((screen.getByLabelText("dashboard:pools.slug") as HTMLInputElement).value).toBe(""),
    );

    // Re-drive to the provider step: the remounted wizard starts over.
    await user.type(screen.getByLabelText("dashboard:pools.slug"), "guarded-pool-2");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));

    const after = await screen.findByLabelText(
      "dashboard:pools.wizard.selectProvider:Public provider",
    );
    expect(after.getAttribute("aria-checked")).toBe("false");
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("dashboard:pools.wizard.providerEgressDisabled")).toBeTruthy();
  });

  it("fails the egress gate closed while the cold appConfig fetch is pending", async () => {
    const user = userEvent.setup();
    state.devices = devicesWithModels;
    // Cold observer: no initialData and a fetch that never settles, so the
    // page stays isPending with undefined data for the whole test.
    state.appConfigInitialData = false;
    state.appConfigPromise = new Promise(() => {});
    mountPage();

    const provider = await drivePageToProviderStep(user);
    expect(provider.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("dashboard:pools.wizard.providerEgressDisabled")).toBeTruthy();
    await user.click(provider);
    expect(provider.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("dashboard:pools.wizard.egressWarning")).toBeNull();
  });

  it("fails the egress gate closed after a failed appConfig refetch retains a stale-true snapshot", async () => {
    let rejectAppConfig!: (reason: unknown) => void;
    const user = userEvent.setup();
    state.devices = devicesWithModels;
    state.appConfig = { capacityEnabled: true, providerEgressEnabled: true };
    state.appConfigInitialData = true;
    state.appConfigPromise = new Promise((_, reject) => {
      rejectAppConfig = reject;
    });
    mountPage();

    const provider = await drivePageToProviderStep(user);
    // During the in-flight refetch RTT the warm snapshot still serves the gate.
    expect(provider.getAttribute("aria-disabled")).toBeNull();
    await user.click(provider);
    expect(provider.getAttribute("aria-checked")).toBe("true");

    // The refetchOnMount fetch fails; React Query sets status "error" while
    // retaining the stale providerEgressEnabled:true data.
    rejectAppConfig(new Error("appConfig unavailable"));

    // Gate flips to closed and the settled key change remounts the wizard,
    // clearing the live provider selection and all entered form state.
    await waitFor(() =>
      expect((screen.getByLabelText("dashboard:pools.slug") as HTMLInputElement).value).toBe(""),
    );

    const after = await drivePageToProviderStep(user);
    expect(after.getAttribute("aria-checked")).toBe("false");
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("dashboard:pools.wizard.providerEgressDisabled")).toBeTruthy();
  });

  it("registers the page's appConfig observer with refetchOnMount always", () => {
    const { client } = mountPage();

    const query = client.getQueryCache().find({ queryKey: ["appConfig"] });
    expect(query).toBeDefined();
    if (!query) throw new Error("appConfig query not registered");
    expect(query.observers.length).toBeGreaterThan(0);
    // Structural pin: the page must opt its own observer out of the shared
    // warm-cache defaults so the gate tracks a fresh snapshot per visit.
    expect(query.observers[0]?.options.refetchOnMount).toBe("always");
  });

  it("navigates, applies delayed capacities, opts into adaptation, configures overrides and budgets, and submits", async () => {
    let resolveCapacities!: (value: Array<Record<string, unknown>>) => void;
    state.capacityPromise = new Promise((resolve) => {
      resolveCapacities = resolve;
    });
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/chat"),
    );
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));

    expect(screen.getByText("dashboard:pools.wizard.capacityDistinctHint")).toBeTruthy();
    resolveCapacities([
      { id: "chat-capacity", physicalMaxContext: 8192, countStrategy: "TOKENIZER" },
      { id: "responses-capacity", physicalMaxContext: 4096, countStrategy: "TOKENIZER" },
    ]);
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "dashboard:pools.wizard.fields.memberContextCeiling",
          ) as HTMLInputElement
        ).value,
      ).toBe(""),
    );

    await user.click(screen.getByText("dashboard:pools.wizard.advanced.title"));
    await user.click(screen.getByText("dashboard:pools.protocolOptions.lossless.label"));
    const memberEditor = screen.getByRole("group", { name: "owner/cli/chat" });
    await user.click(within(memberEditor).getByText("owner/cli/chat"));
    await user.click(within(memberEditor).getByText("pools.wizard.fields.enableMemberOverride"));
    const override = within(memberEditor).getByRole("spinbutton", {
      name: /pools\.wizard\.fields\.memberConcurrencyOverride pools\.wizard\.fields\.limitValue/,
    });
    await user.clear(override);
    await user.type(override, "2");

    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    // Auto-set-once: the first selected member (chat) pinned
    // OPENAI_CHAT_COMPLETIONS; adding the responses member and enabling
    // adaptation must not recompute it away while it stays selectable.
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.wizard.fields.recommendedSurface",
        ) as HTMLSelectElement
      ).value,
    ).toBe("OPENAI_CHAT_COMPLETIONS");
    await user.click(
      await screen.findByLabelText("dashboard:pools.wizard.selectProvider:Public provider"),
    );
    expect(screen.getByText("dashboard:pools.wizard.egressWarning")).toBeTruthy();
    await user.click(screen.getByText("dashboard:pools.wizard.advanced.budgetTitle"));

    const budgetLabels = [
      "dashboard:pools.wizard.fields.budgetConcurrency",
      "dashboard:pools.wizard.fields.tokenAttempt",
      "dashboard:pools.wizard.fields.tokenDay",
      "dashboard:pools.wizard.fields.tokenMonth",
      "dashboard:pools.wizard.fields.tokenLifetime",
      "dashboard:pools.wizard.fields.spendDay",
      "dashboard:pools.wizard.fields.spendMonth",
    ];
    const budgetCards = budgetLabels.map((label) => screen.getByRole("group", { name: label }));
    for (const card of budgetCards)
      await user.selectOptions(within(card).getByRole("combobox"), "UNLIMITED");
    expect(screen.getAllByText("pools.wizard.advanced.unlimitedWarning")).toHaveLength(7);
    const concurrencyCard = budgetCards[0]!;
    await user.selectOptions(within(concurrencyCard).getByRole("combobox"), "LIMITED");
    const concurrency = within(concurrencyCard).getByRole("spinbutton", {
      name: "pools.wizard.fields.limitValue",
    });
    await user.clear(concurrency);
    await user.type(concurrency, "3");

    await user.click(screen.getByText("dashboard:pools.wizard.fields.publicEgressAcknowledged"));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(screen.getByText("dashboard:pools.wizard.atomicRollback")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    expect(screen.getByText("dashboard:pools.wizard.providerOrder")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    await waitFor(() => expect(state.submitted).toBeDefined());
    expect(state.submitted).toMatchObject({
      slug: "guarded-pool",
      recommendedSurface: "OPENAI_CHAT_COMPLETIONS",
      memberContextCeiling: null,
      publicEgressAcknowledged: true,
      providerModels: [
        {
          providerModelId: "provider-a",
          budgetRules: {
            concurrency: { mode: "LIMITED", limitValue: 3 },
            tokensPerAttempt: { mode: "UNLIMITED", limitValue: null },
            tokensPerDay: { mode: "UNLIMITED", limitValue: null },
            tokensPerMonth: { mode: "UNLIMITED", limitValue: null },
            tokensLifetime: { mode: "UNLIMITED", limitValue: null },
            spendPerDay: { mode: "UNLIMITED", limitValue: null },
            spendPerMonth: { mode: "UNLIMITED", limitValue: null },
          },
        },
      ],
      advanced: {
        protocolAdaptationEnabled: true,
        contextMargin: 0,
        memberOverrides: [
          {
            discoveredModelId: "chat",
            concurrency: { limitValue: 2 },
            contextCeiling: { mode: "INHERIT", limitValue: null },
            contextMargin: 0,
          },
        ],
      },
    });
  });

  async function drivePageToProviderStep(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    return await screen.findByLabelText("dashboard:pools.wizard.selectProvider:Public provider");
  }

  async function driveToReviewStep(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(screen.getByText("dashboard:pools.wizard.atomicRollback")).toBeTruthy();
  }

  it("defaults the recommended API to the first member, keeps selectable manual choices, and auto-repairs unselectable ones", async () => {
    const user = userEvent.setup();
    mount();
    const surfaceSelect = () =>
      screen.getByLabelText(
        "dashboard:pools.wizard.fields.recommendedSurface",
      ) as HTMLSelectElement;

    await user.type(await screen.findByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/chat"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    // Enable adaptation BEFORE the manual choice so the OPENAI_RESPONSES
    // override is genuinely selectable for the chat-only member at selection
    // time — the persistence assertion below then rides the selectable-keep
    // path, not the stranded-keep path.
    await user.click(
      screen.getByRole("radio", { name: "dashboard:pools.protocolOptions.lossless.label" }),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    // First selected member (chat-native) pinned its best native API.
    expect(surfaceSelect().value).toBe("OPENAI_CHAT_COMPLETIONS");

    // The manual override is selectable (chat serves it via adaptation).
    await user.selectOptions(surfaceSelect(), "OPENAI_RESPONSES");
    expect(surfaceSelect().value).toBe("OPENAI_RESPONSES");

    // Adding a member that keeps the manual choice selectable must persist it
    // (not recompute it to a ranked default).
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(surfaceSelect().value).toBe("OPENAI_RESPONSES");

    // Disabling adaptation and dropping the responses member strands the
    // manual choice for the chat-only member: auto-repair falls back to the
    // best-ranked selectable surface.
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(
      screen.getByRole("radio", { name: "dashboard:pools.protocolOptions.native.label" }),
    );
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(surfaceSelect().value).toBe("OPENAI_CHAT_COMPLETIONS");
  });

  it("auto-sets the recommended API from a provider-first PRIMARY selection and never overwrites it with a later local", async () => {
    const user = userEvent.setup();
    mount();
    const surfaceSelect = () =>
      screen.getByLabelText(
        "dashboard:pools.wizard.fields.recommendedSurface",
      ) as HTMLSelectElement;

    await user.type(await screen.findByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    // Provider-first: step 0 permits zero locals (the empty-member schema
    // issue targets providerModelIds, a step-2 field), so leave them all off.
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    // Adaptation keeps the OPENAI_RESPONSES default selectable for the
    // chat-native provider, so only the first-PRIMARY-member branch (not
    // repair) can explain the auto-set below. Under the old locals-only
    // policy the provider selection never triggered an auto-set and the
    // field silently kept OPENAI_RESPONSES — this test fails there.
    await user.click(
      screen.getByRole("radio", { name: "dashboard:pools.protocolOptions.lossless.label" }),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(surfaceSelect().value).toBe("OPENAI_RESPONSES");

    // Tier flip with no providers selected: the primary set stays empty.
    await user.selectOptions(
      screen.getByLabelText("dashboard:pools.wizard.fields.providerTier"),
      "PRIMARY",
    );
    expect(surfaceSelect().value).toBe("OPENAI_RESPONSES");

    // (a) The first PRIMARY member (the chat-native provider) auto-sets its
    // best-ranked native surface exactly once.
    await user.click(
      await screen.findByLabelText("dashboard:pools.wizard.selectProvider:Public provider"),
    );
    expect(surfaceSelect().value).toBe("OPENAI_CHAT_COMPLETIONS");

    // (b) Back-nav: adding the first local later must NOT overwrite the
    // provider-era surface even though the locals-only set transitions
    // empty → non-empty. Under the old locals-only trigger the first branch
    // re-ranked to the responses local's native OPENAI_RESPONSES — this
    // assertion fails there.
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    await user.click(
      screen.getByLabelText("dashboard:pools.wizard.selectLocalModel:owner/cli/responses"),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(surfaceSelect().value).toBe("OPENAI_CHAT_COMPLETIONS");
  });

  it("does not auto-set on PUBLIC_OVERFLOW provider selection but does on the tier flip to PRIMARY", async () => {
    const user = userEvent.setup();
    mount();
    const surfaceSelect = () =>
      screen.getByLabelText(
        "dashboard:pools.wizard.fields.recommendedSurface",
      ) as HTMLSelectElement;

    await user.type(await screen.findByLabelText("dashboard:pools.slug"), "guarded-pool");
    await user.type(screen.getByLabelText("dashboard:pools.name"), "Guarded pool");
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    await user.click(
      screen.getByRole("radio", { name: "dashboard:pools.protocolOptions.lossless.label" }),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));

    // (c) A PUBLIC_OVERFLOW-tier provider is not a primary member: selecting
    // it must not trigger the member-driven auto-set.
    await user.click(
      await screen.findByLabelText("dashboard:pools.wizard.selectProvider:Public provider"),
    );
    expect(surfaceSelect().value).toBe("OPENAI_RESPONSES");

    // (d) Flipping the tier to PRIMARY makes the provider the first primary
    // member (combined primary set empty → non-empty) and auto-sets its
    // native surface. Under the old policy the tier change never fired the
    // first branch and the still-selectable default was kept — this
    // assertion fails there.
    await user.selectOptions(
      screen.getByLabelText("dashboard:pools.wizard.fields.providerTier"),
      "PRIMARY",
    );
    expect(surfaceSelect().value).toBe("OPENAI_CHAT_COMPLETIONS");
  });

  it("renders the specific create failure reason inline on the review step", async () => {
    const user = userEvent.setup();
    mount();
    await driveToReviewStep(user);

    state.createRejection = Object.assign(new Error("conflict"), {
      data: { reason: "SLUG_TAKEN" },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("dashboard:pools.wizard.createErrors.SLUG_TAKEN")).toBeTruthy();
    expect(within(alert).getByText("dashboard:pools.wizard.atomicFailure")).toBeTruthy();
    expect(screen.queryByText("conflict")).toBeNull();
  });

  it("falls back to the generic rollback copy for an unknown failure reason", async () => {
    const user = userEvent.setup();
    mount();
    await driveToReviewStep(user);

    state.createRejection = Object.assign(new Error("boom"), {
      data: { reason: "NOT_A_REAL_REASON" },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByText("dashboard:pools.wizard.atomicFailure")).toHaveLength(1);
    expect(screen.queryByText(/createErrors/)).toBeNull();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("falls back to the generic rollback copy when the error carries no data", async () => {
    const user = userEvent.setup();
    mount();
    await driveToReviewStep(user);

    state.createRejection = new Error("boom");
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByText("dashboard:pools.wizard.atomicFailure")).toHaveLength(1);
    expect(screen.queryByText(/createErrors/)).toBeNull();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("clears the inline failure when a new submit starts", async () => {
    const user = userEvent.setup();
    mount();
    await driveToReviewStep(user);

    state.createRejection = Object.assign(new Error("conflict"), {
      data: { reason: "SLUG_TAKEN" },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));
    await screen.findByRole("alert");

    state.createRejection = undefined;
    state.submitted = undefined;
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(state.submitted).toBeDefined();
  });

  it("clears the inline failure when navigating back and re-entering the review step", async () => {
    const user = userEvent.setup();
    mount();
    await driveToReviewStep(user);

    state.createRejection = Object.assign(new Error("conflict"), {
      data: { reason: "SLUG_TAKEN" },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));
    await screen.findByRole("alert");

    // Back leaves the review step; the stale failure must be cleared...
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.back" }));
    expect(screen.getByText("dashboard:pools.wizard.providerOrder")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("dashboard:pools.wizard.createErrors.SLUG_TAKEN")).toBeNull();

    // ...and must not resurface when re-entering the review step via Next,
    // before any new submit could occur there.
    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(screen.getByText("dashboard:pools.wizard.atomicRollback")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("dashboard:pools.wizard.createErrors.SLUG_TAKEN")).toBeNull();
    expect(screen.queryByText("conflict")).toBeNull();

    // A new failing submit shows the failure again on the review step.
    state.createRejection = Object.assign(new Error("conflict"), {
      data: { reason: "SLUG_TAKEN" },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:pools.wizard.create" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("dashboard:pools.wizard.createErrors.SLUG_TAKEN")).toBeTruthy();
  });
});
