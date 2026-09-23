// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  pricing: [] as Array<Record<string, unknown>>,
  accountPayload: undefined as Record<string, unknown> | undefined,
  budgetPayload: undefined as Record<string, unknown> | undefined,
  updateModelResult: undefined as Record<string, unknown> | undefined,
  updateModelPayloads: [] as Array<Record<string, unknown>>,
  allowPrivateNetworks: true,
}));

vi.mock("@/hooks/use-deployment-audience", () => ({
  useDeploymentAudience: () => ({ isAdmin: false }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Forward interpolation options so toast assertions can verify exactly
    // which variables (slugs, not count) reach the translated message.
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
        if (name === "updateModel") {
          state.updateModelPayloads.push(input);
          return state.updateModelResult ?? {};
        }
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
      appConfig: query("appConfig", () => ({
        deploymentFeatures: {
          WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: state.allowPrivateNetworks,
        },
      })),
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

import { toast } from "@ws-model-proxy/ui/components/sileo";
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
  state.updateModelResult = undefined;
  state.updateModelPayloads = [];
  state.allowPrivateNetworks = true;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

describe("ProviderOperationsSection mounted forms", () => {
  it("says private and loopback URLs are rejected before submit when that flag is off", () => {
    state.allowPrivateNetworks = false;
    mount();
    expect(screen.getByText("dashboard:deploymentFeatures.privateNetworkUser")).toBeTruthy();
    expect(screen.getByLabelText("dashboard:providers.fields.baseUrl")).toBeTruthy();
  });

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
    const form = await screen.findByRole("form", { name: "dashboard:providers.budgets" });
    const budgetLabels = [
      "dashboard:providers.fields.concurrencyAttempt",
      "dashboard:providers.fields.tokensAttempt",
      "dashboard:providers.fields.tokensDay",
      "dashboard:providers.fields.tokensMonth",
      "dashboard:providers.fields.tokensLifetime",
      "dashboard:providers.fields.spendDay",
      "dashboard:providers.fields.spendMonth",
    ];
    const budgetCards = budgetLabels.map((label) =>
      within(form).getByRole("group", { name: label }),
    );
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

  it("surfaces the capability-impact advisory after saving a native inventory edit, and stays silent on clean saves", async () => {
    const user = userEvent.setup();
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
        nativeCapabilities: null,
      },
    ];
    state.updateModelResult = {
      impactedPools: [{ id: "pool-1", slug: "overflow", surface: "OPENAI_RESPONSES" }],
    };
    mount();
    await user.click(screen.getByText("dashboard:providers.actions.editModel"));
    // The create-model form exposes the same field label; the edit form is the
    // last one in document order (rendered inside the model row details).
    const inventory = screen
      .getAllByLabelText("dashboard:providers.fields.capabilityInventory")
      .at(-1)!;
    fireEvent.change(inventory, {
      target: {
        value: JSON.stringify({
          version: 3,
          protocol: "openai-compatible",
          surfaces: {
            openaiChatCompletions: {
              source: "dashboard",
              confidence: "exact",
              supported: true,
              streaming: true,
            },
          },
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "dashboard:providers.actions.saveModel" }));

    // The save succeeded (success toast) and the warning interpolates slugs
    // only; the reworded key has no count.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("dashboard:providers.modelSaved"),
    );
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        `dashboard:providers.modelCapabilityImpact|${JSON.stringify({ slugs: "overflow" })}`,
      ),
    );

    // Clean save: no advisory toast.
    vi.mocked(toast.warning).mockClear();
    state.updateModelResult = { impactedPools: [] };
    await user.click(screen.getByRole("button", { name: "dashboard:providers.actions.saveModel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("omits nativeCapabilities from the payload when the inventory is unchanged and stays silent without the advisory key", async () => {
    const user = userEvent.setup();
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
        nativeCapabilities: null,
      },
    ];
    // The edit form is the last inventory textarea in document order; it is
    // left untouched, so the loaded inventory is sent as "not edited".
    state.updateModelResult = {};
    mount();
    await user.click(screen.getByText("dashboard:providers.actions.editModel"));
    await user.click(screen.getByRole("button", { name: "dashboard:providers.actions.saveModel" }));

    await waitFor(() => expect(state.updateModelPayloads.length).toBe(1));
    expect(state.updateModelPayloads[0]).not.toHaveProperty("nativeCapabilities");
    // No impactedPools key in the response: no warning, no crash; the save
    // itself is still confirmed.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("dashboard:providers.modelSaved"),
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
