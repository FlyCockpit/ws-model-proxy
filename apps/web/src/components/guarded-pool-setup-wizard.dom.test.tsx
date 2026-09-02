// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capacityPromise: Promise.resolve([] as Array<Record<string, unknown>>),
  capacityCalls: 0,
  candidateCalls: 0,
  submitted: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { current?: number; name?: string }) =>
      values?.current ? `${key}:${values.current}` : values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: {
      queryOptions: () => ({
        queryKey: ["appConfig"],
        queryFn: async () => ({ capacityEnabled: true }),
        initialData: { capacityEnabled: true },
      }),
    },
    forwarderManagement: {
      key: () => ["forwarderManagement"],
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
              },
            ];
          },
        }),
      },
      createGuardedModelPool: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: async (input: Record<string, unknown>) => {
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
vi.mock("@ws-model-proxy/ui/components/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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

function mount(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <GuardedPoolSetupWizard open={open} onOpenChange={() => undefined} directModels={models} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  cleanup();
  state.capacityCalls = 0;
  state.candidateCalls = 0;
  state.capacityPromise = Promise.resolve([]);
  state.submitted = undefined;
});

describe("GuardedPoolSetupWizard mounted workflow", () => {
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
        <GuardedPoolSetupWizard open onOpenChange={() => undefined} directModels={models} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(state.candidateCalls).toBe(1);
      expect(state.capacityCalls).toBe(1);
    });
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
      ).toBe("3072"),
    );

    await user.click(screen.getByText("dashboard:pools.wizard.advanced.title"));
    await user.click(screen.getByText("dashboard:pools.wizard.fields.protocolAdaptationEnabled"));
    const memberEditor = screen.getByRole("group", { name: "owner/cli/chat" });
    await user.click(within(memberEditor).getByText("owner/cli/chat"));
    await user.click(within(memberEditor).getByText("pools.wizard.fields.enableMemberOverride"));
    const override = within(memberEditor).getByRole("spinbutton", {
      name: /pools\.wizard\.fields\.memberConcurrencyOverride pools\.wizard\.fields\.limitValue/,
    });
    await user.clear(override);
    await user.type(override, "2");

    await user.click(screen.getByRole("button", { name: /dashboard:pools\.wizard\.next/ }));
    expect(
      (
        screen.getByLabelText(
          "dashboard:pools.wizard.fields.recommendedSurface",
        ) as HTMLSelectElement
      ).value,
    ).toBe("OPENAI_RESPONSES");
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
      recommendedSurface: "OPENAI_RESPONSES",
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
        memberOverrides: [{ discoveredModelId: "chat", concurrency: { limitValue: 2 } }],
      },
    });
  });
});
