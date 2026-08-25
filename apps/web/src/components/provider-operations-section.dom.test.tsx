// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  pricing: [] as Array<Record<string, unknown>>,
  accountPayload: undefined as Record<string, unknown> | undefined,
  budgetPayload: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/orpc", () => {
  const query = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data(), initialData: data() }),
  });
  const mutation = (name: string) => ({
    mutationOptions: (options: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        if (name === "createAccount") {
          state.accountPayload = input;
          return { id: "created-account" };
        }
        if (name === "createBudgetPolicy") state.budgetPayload = input;
        return {};
      },
    }),
  });
  const providerQueries = {
    listAccounts: query("accounts", () => state.accounts),
    listModels: query("models", () => state.models),
    listCredentials: query("credentials", () => []),
    listAuditEvents: query("audits", () => []),
    listUsageReportPage: query("usage", () => ({ items: [], nextCursor: null })),
    getUsageTotals: query("usageTotals", () => ({ totals: [] })),
    listBudgetActivity: query("budgetActivity", () => ({ caveats: [] })),
    listProviderAttemptEvents: query("attemptEvents", () => []),
    listProviderAttempts: query("attempts", () => ({ items: [], nextCursor: null })),
    listPricingVersions: query("pricing", () => state.pricing),
    listBudgetPolicies: query("policies", () => []),
  };
  const names = [
    "activatePricingVersion",
    "createAccount",
    "createBudgetPolicy",
    "createCredential",
    "createModel",
    "createPricingVersion",
    "deactivateBudgetPolicy",
    "deleteAccount",
    "deleteModel",
    "deletePricingVersion",
    "repairExpiredAttempts",
    "replaceBudgetPolicy",
    "replaceCredential",
    "retirePricingVersion",
    "revokeCredential",
    "setAccountEnabled",
    "testCredential",
    "updateAccount",
    "updateModel",
    "updatePricingVersion",
  ];
  const providerMutations = Object.fromEntries(names.map((name) => [name, mutation(name)]));
  return {
    orpc: {
      providerManagement: {
        key: () => ["providerManagement"],
        ...providerQueries,
        ...providerMutations,
      },
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listModelPools: query("pools", () => []),
        addProviderPoolMember: mutation("addProviderPoolMember"),
        removePoolMember: mutation("removePoolMember"),
        reorderProviderPoolMember: mutation("reorderProviderPoolMember"),
        updateModelPool: mutation("updateModelPool"),
      },
      modelApiTokens: { list: query("modelApiTokens", () => []) },
    },
  };
});

import { ProviderOperationsSection } from "./provider-operations-section";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderOperationsSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.accounts = [];
  state.models = [];
  state.pricing = [];
  state.accountPayload = undefined;
  state.budgetPayload = undefined;
});

describe("ProviderOperationsSection mounted forms", () => {
  it("reactively reports and focuses account errors, then submits the actual mutation payload", async () => {
    const user = userEvent.setup();
    mount();
    const add = screen.getByRole("button", { name: /providers\.actions\.addAccount/ });
    await user.click(add);
    const label = screen.getByLabelText("dashboard:providers.fields.label");
    await waitFor(() => expect(document.activeElement).toBe(label));
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("providers.validation.required");

    await user.type(label, "Primary OpenAI");
    const baseUrl = screen.getByLabelText("dashboard:providers.fields.baseUrl");
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://api.example.com/v1");
    await user.click(add);
    await waitFor(() => expect(state.accountPayload).toBeDefined());
    expect(state.accountPayload).toEqual({
      label: "Primary OpenAI",
      providerType: "openai",
      baseUrl: "https://api.example.com/v1",
      authType: "BEARER",
      safeConfiguration: null,
    });
  });

  it("exercises all seven budget modes, reactive validation, focus, and successful mutation", async () => {
    state.accounts = [
      {
        id: "account-a",
        label: "Primary",
        providerType: "openai",
        baseUrl: "https://api.example.com/v1",
        authType: "BEARER",
        enabled: true,
        healthStatus: "HEALTHY",
        healthCheckedAt: null,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    state.models = [
      {
        id: "model-a",
        upstreamModelId: "gpt-example",
        displayName: "Example",
        pricingVersion: "v1",
        healthStatus: "HEALTHY",
        enabled: true,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        contextWindow: 128000,
        maxOutputTokens: 4096,
        concurrencyLimit: 4,
      },
    ];
    state.pricing = [
      {
        id: "pricing-a",
        version: "v1",
        currency: "USD",
        status: "ACTIVE",
        accountingVersion: "provider-billable-v1",
      },
    ];
    const user = userEvent.setup();
    mount();
    const budgetHeading = await screen.findByText("dashboard:providers.budgets");
    const form = budgetHeading.closest("form");
    if (!form) throw new Error("budget form missing");
    const budgetLabels = [
      "dashboard:providers.fields.concurrencyAttempt",
      "dashboard:providers.fields.tokensAttempt",
      "dashboard:providers.fields.tokensDay",
      "dashboard:providers.fields.tokensMonth",
      "dashboard:providers.fields.tokensLifetime",
      "dashboard:providers.fields.spendDay",
      "dashboard:providers.fields.spendMonth",
    ];
    const budgetCards = budgetLabels.map((label) => {
      const card = within(form).getByText(label).parentElement;
      if (!card) throw new Error(`budget card missing: ${label}`);
      return card;
    });
    for (const card of budgetCards)
      await user.selectOptions(within(card).getByRole("combobox"), "UNLIMITED");
    expect(within(form).getAllByText("providers.unlimitedRuleWarning")).toHaveLength(7);

    const dayCard = budgetCards[2]!;
    await user.selectOptions(within(dayCard).getByRole("combobox"), "LIMITED");
    const dayValue = within(dayCard).getByRole("spinbutton", {
      name: "providers.fields.limitValue",
    });
    await user.clear(dayValue);
    const activate = within(form).getByRole("button", {
      name: "dashboard:providers.actions.activateBudget",
    });
    await user.click(activate);
    await waitFor(() => expect(document.activeElement).toBe(dayValue));
    expect(dayValue.getAttribute("aria-invalid")).toBe("true");

    await user.type(dayValue, "2500");
    await user.click(activate);
    await waitFor(() => expect(state.budgetPayload).toBeDefined());
    expect(state.budgetPayload).toMatchObject({
      scopeType: "PROVIDER_ACCOUNT",
      providerAccountId: "account-a",
      active: true,
      rules: [
        { metric: "CONCURRENCY", mode: "UNLIMITED", limitValue: null },
        { metric: "TOKENS", period: "PER_ATTEMPT", mode: "UNLIMITED", limitValue: null },
        { metric: "TOKENS", period: "UTC_DAY", mode: "LIMITED", limitValue: "2500" },
        { metric: "TOKENS", period: "UTC_MONTH", mode: "UNLIMITED", limitValue: null },
        { metric: "TOKENS", period: "LIFETIME", mode: "UNLIMITED", limitValue: null },
        { metric: "SPEND", period: "UTC_DAY", mode: "UNLIMITED", limitValue: null },
        { metric: "SPEND", period: "UTC_MONTH", mode: "UNLIMITED", limitValue: null },
      ],
    });
  });
});
