// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  providerEgressEnabled: true,
  flagsStatus: "ready" as "ready" | "pending" | "error",
  credentials: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  accounts: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  pricing: [] as Array<Record<string, unknown>>,
  accountPayload: undefined as Record<string, unknown> | undefined,
  budgetPayload: undefined as Record<string, unknown> | undefined,
  updateModelResult: undefined as Record<string, unknown> | undefined,
  updateModelPayloads: [] as Array<Record<string, unknown>>,
  allowPrivateNetworks: true,
  testResult: undefined as Record<string, unknown> | undefined,
  pools: [] as Array<Record<string, unknown>>,
  mutationFailures: {} as Record<string, unknown>,
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
  const mutation = (name: string) => ({
    mutationOptions: (options: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state.calls.push(name);
        if (name in state.mutationFailures) throw state.mutationFailures[name];
        if (name === "createAccount") {
          state.accountPayload = input;
          return { id: "created-account" };
        }
        if (name === "createBudgetPolicy") state.budgetPayload = input;
        if (name === "testCredential") return state.testResult ?? {};
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
    listCredentials: query("credentials", () => state.credentials),
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
      deploymentFlags: query("deploymentFlags", () => ({
        privateNetworksAllowed: state.allowPrivateNetworks,
        providerEgressEnabled: state.providerEgressEnabled,
      })),
      providerManagement: {
        key: () => ["providerManagement"],
        ...providerQueries,
        ...providerMutations,
      },
      forwarderManagement: {
        key: () => ["forwarderManagement"],
        listModelPools: query("pools", () => state.pools),
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
import { createAppMutationCache } from "@/utils/mutation-error-toast";
import { ProviderOperationsSection } from "./provider-operations-section";

function mount({ appToasts = false }: { appToasts?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    // The app's global mutation toast, with keys shown as `t(key)`.
    ...(appToasts ? { mutationCache: createAppMutationCache((key) => `t(${key})`) } : {}),
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderOperationsSection />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.accounts = [];
  state.credentials = [];
  state.calls = [];
  state.providerEgressEnabled = true;
  state.flagsStatus = "ready";
  state.models = [];
  state.pricing = [];
  state.accountPayload = undefined;
  state.budgetPayload = undefined;
  state.updateModelResult = undefined;
  state.updateModelPayloads = [];
  state.allowPrivateNetworks = true;
  state.credentials = [];
  state.testResult = undefined;
  state.pools = [];
  state.mutationFailures = {};
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
});

describe("ProviderOperationsSection mounted forms", () => {
  it.each([
    [{ ok: true, outcome: "SUCCESS", reason: null }, "success", "testPassed"],
    [{ ok: false, outcome: "FAILURE", reason: "INVALID_CREDENTIAL" }, "error", "testRejected"],
    [{ ok: false, outcome: "FAILURE", reason: "UNEXPECTED_STATUS" }, "error", "testFailed"],
    // A compatible gateway cannot confirm a key: a warning, never "passed".
    [{ ok: false, outcome: "INCONCLUSIVE", reason: "UNVERIFIED" }, "warning", "testUnverified"],
    // 403: the key may only lack permission to list models, not a rejection.
    [
      { ok: false, outcome: "INCONCLUSIVE", reason: "INSUFFICIENT_PERMISSION" },
      "warning",
      "testForbidden",
    ],
    [
      { ok: false, outcome: "INCONCLUSIVE", reason: "UNEXPECTED_STATUS" },
      "warning",
      "testUnverified",
    ],
  ] as const)("reports credential test %j as a %s toast", async (result, kind, key) => {
    state.accounts = [
      {
        id: "account-a",
        label: "Gateway",
        providerType: "openai-compatible",
        baseUrl: "https://gateway.example",
        authType: "BEARER",
        enabled: false,
        healthStatus: "HEALTHY",
        healthCheckedAt: null,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    state.credentials = [{ id: "credential-a", status: "ACTIVE" }];
    state.testResult = { ...result, statusCode: 200 };
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /dashboard:providers\.actions\.test/u }),
    );
    await waitFor(() =>
      expect(vi.mocked(toast[kind])).toHaveBeenCalledWith(`dashboard:providers.feedback.${key}`),
    );
    for (const other of ["success", "error", "warning"] as const) {
      if (other !== kind) expect(vi.mocked(toast[other])).not.toHaveBeenCalled();
    }
  });

  // Request paths carry `/v1`; a `/v1` default produced `/v1/v1/...` upstream.
  it("defaults the new account to the unversioned OpenAI API root", () => {
    mount();
    const baseUrl = screen.getByLabelText("dashboard:providers.fields.baseUrl");
    expect((baseUrl as HTMLInputElement).value).toBe("https://api.openai.com");
  });

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

describe("provider pool member removal", () => {
  function withAttachedMember() {
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
      },
    ];
    state.pools = [
      {
        id: "pool-a",
        name: "Team pool",
        grants: [],
        members: [
          {
            id: "member-a",
            tier: "PRIMARY",
            publicOrder: null,
            routingStatus: "ACTIVE",
            providerModel: {
              displayName: "Example",
              upstreamModelId: "gpt-example",
              ProviderAccount: { id: "account-a" },
            },
          },
        ],
      },
    ];
  }

  const conflict = (reason: string) => ({
    status: 409,
    code: "CONFLICT",
    message: "raw server message",
    data: { reason },
  });

  it.each([
    ["retained_history", "t(errors:deletionConflict.retainedHistory.poolMember)"],
    ["delete_pending", "t(errors:deletionConflict.deletePending)"],
    ["delete_contended", "t(errors:deletionConflict.deleteContended)"],
  ])("toasts the localized %s copy once when detaching is refused", async (reason, copy) => {
    withAttachedMember();
    state.mutationFailures = { removePoolMember: conflict(reason) };
    mount({ appToasts: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard:providers.actions.detachProvider" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(state.calls).toContain("removePoolMember");
  });

  it("falls back to the providers failure copy without a deletion reason", async () => {
    withAttachedMember();
    state.mutationFailures = { removePoolMember: { status: 500, code: "INTERNAL_SERVER_ERROR" } };
    mount({ appToasts: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "dashboard:providers.actions.detachProvider" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("t(dashboard:providers.feedback.failed)"),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("provider management with external providers disabled", () => {
  it("keeps the empty page reachable without creation", () => {
    state.providerEgressEnabled = false;
    mount();
    expect(screen.getByText("dashboard:providers.disabledDeployment")).toBeTruthy();
    expect(screen.getByText("dashboard:providers.empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /actions.addAccount/ })).toBeNull();
  });

  it("keeps keys viewable and revocable and accounts deletable, with tests disabled", async () => {
    state.providerEgressEnabled = false;
    state.accounts = [
      {
        id: "account-a",
        label: "Stored provider",
        providerType: "openai",
        baseUrl: "https://provider.example/v1",
        authType: "BEARER",
        enabled: true,
        updatedAt: new Date(0),
      },
    ];
    state.credentials = [{ id: "credential-a", status: "ACTIVE", displaySuffix: "1234" }];
    mount();
    expect(screen.getByText(/dashboard:providers.activeSuffix/).textContent).toContain("1234");
    expect(screen.queryByRole("button", { name: /actions.replaceCredential/ })).toBeNull();
    const test = screen.getByRole("button", { name: /actions.test/ });
    expect(test.hasAttribute("disabled")).toBe(true);
    fireEvent.click(test);
    expect(state.calls).not.toContain("testCredential");
    fireEvent.click(screen.getByRole("button", { name: /actions.revokeCredential/ }));
    await waitFor(() => expect(state.calls).toContain("revokeCredential"));
    const remove = screen.getByRole("button", { name: /actions.deleteAccount/ });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(state.calls).toContain("deleteAccount"));
  });
});

it("shows a matching skeleton while flags load after accounts have loaded", () => {
  state.flagsStatus = "pending";
  mount();
  expect(
    screen.getByRole("region", { name: "dashboard:providers.title" }).getAttribute("aria-busy"),
  ).toBe("true");
  expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(1);
  expect(screen.queryByText("dashboard:providers.disabledDeployment")).toBeNull();
  expect(screen.queryByLabelText("dashboard:providers.fields.baseUrl")).toBeNull();
});

it("shows a flags error after a failed refetch and recovers through retry", async () => {
  state.flagsStatus = "error";
  mount();
  expect(await screen.findByText("dashboard:deploymentFeatures.loadFailed")).toBeTruthy();
  expect(screen.queryByText("dashboard:providers.disabledDeployment")).toBeNull();
  expect(screen.queryByLabelText("dashboard:providers.fields.baseUrl")).toBeNull();
  state.flagsStatus = "ready";
  fireEvent.click(screen.getByRole("button", { name: "actions.tryAgain" }));
  expect(await screen.findByLabelText("dashboard:providers.fields.baseUrl")).toBeTruthy();
});
