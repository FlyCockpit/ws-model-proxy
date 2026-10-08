// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  catalogQueries: [] as unknown[],
}));

const { ACCOUNT, VERSIONS } = vi.hoisted(() => {
  const ACCOUNT = {
    id: "acc-1",
    providerType: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authType: "BEARER",
    enabled: true,
    allowDataCollection: false,
    health: "HEALTHY",
    healthCheckedAt: null,
    credential: null,
    spend: { monthlyLimit: null, currency: "USD", spentThisMonth: "0", reservedNow: "0" },
    createdAt: "2026-10-01T00:00:00.000Z",
    models: [
      {
        id: "pm-1",
        providerAccountId: "acc-1",
        upstreamModelId: "qwen/qwen3-32b",
        displayName: null,
        type: "LLM",
        enabled: true,
        health: "HEALTHY",
        contextWindow: 32_768,
        maxOutputTokens: null,
        price: { input: "0.1", output: "0.3", currency: "USD" },
      },
    ],
  };
  const VERSIONS = [
    {
      id: "pv-2",
      providerModelId: "pm-1",
      version: "v2",
      status: "DRAFT",
      currency: "USD",
      confidence: "CALCULATED",
      pricing: { input: "0.2", output: "0.4" },
      effectiveAt: "2026-10-05T00:00:00.000Z",
      activatedAt: null,
      retiredAt: null,
    },
    {
      id: "pv-1",
      providerModelId: "pm-1",
      version: "v1",
      status: "ACTIVE",
      currency: "USD",
      confidence: "CALCULATED",
      pricing: { input: "0.1", output: "0.3", cacheRead: "0.01" },
      effectiveAt: "2026-10-01T00:00:00.000Z",
      activatedAt: "2026-10-01T00:00:00.000Z",
      retiredAt: null,
    },
  ];
  return { ACCOUNT, VERSIONS };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", accountId: "acc-1" }),
    }),
    useNavigate: () => async () => undefined,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && !("defaultValue" in options) ? `${key}(${JSON.stringify(options)})` : key,
  }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: () => null,
}));
vi.mock("@/components/time-ago", () => ({
  TimeAgo: ({ value }: { value: string }) => <time>{value}</time>,
}));
vi.mock("@/components/segmented-control", () => ({
  SegmentedControl: ({
    items,
    onChange,
  }: {
    items: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} type="button" onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => {
  const mutation = (name: string, result: unknown = {}) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: unknown) => {
        state.calls.push({ name, input });
        return result;
      },
    }),
  });
  const query = (key: string, data: (input: unknown) => unknown) => ({
    queryOptions: (options?: { input?: unknown }) => ({
      queryKey: ["providers", key, options?.input ?? null],
      queryFn: async () => data(options?.input),
    }),
  });
  const page = (key: string, items: unknown[]) => ({
    infiniteOptions: (options: { input: (cursor: undefined) => unknown }) => ({
      queryKey: ["providers", key, options.input(undefined)],
      queryFn: async () => ({ items, nextCursor: null }),
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
    }),
  });
  return {
    orpc: {
      pools: { key: () => ["pools"] },
      providers: {
        key: () => ["providers"],
        accounts: {
          get: query("account", () => ACCOUNT),
          update: mutation("accounts.update"),
          setEnabled: mutation("accounts.setEnabled"),
          setDataCollection: mutation("accounts.setDataCollection"),
          delete: mutation("accounts.delete"),
        },
        credentials: {
          replace: mutation("credentials.replace"),
          revoke: mutation("credentials.revoke"),
          test: mutation("credentials.test"),
        },
        spendCaps: { set: mutation("spendCaps.set"), clear: mutation("spendCaps.clear") },
        models: {
          create: mutation("models.create"),
          update: mutation("models.update"),
          delete: mutation("models.delete"),
        },
        pricing: {
          list: query("pricing", () => ({ versions: VERSIONS })),
          create: mutation("pricing.create"),
          activate: mutation("pricing.activate"),
          retire: mutation("pricing.retire"),
          delete: mutation("pricing.delete"),
        },
        catalog: {
          search: query("catalog", (input) => {
            state.catalogQueries.push(input);
            return {
              models: [
                {
                  id: "meta-llama/llama-3.3-70b",
                  name: "Llama 3.3 70B",
                  type: "LLM",
                  contextWindow: 131_072,
                },
              ],
            };
          }),
        },
        attempts: {
          list: page("attempts", [
            {
              id: "at-1",
              requestId: "rq-1",
              createdAt: "2026-10-07T10:00:00.000Z",
              state: "FAILED",
              providerModelId: "pm-1",
              httpStatusCode: 429,
              errorClass: "rate_limited",
            },
          ]),
        },
        usage: {
          list: page("usage", [
            {
              id: "us-1",
              createdAt: "2026-10-07T10:00:00.000Z",
              providerModelId: "pm-1",
              poolId: null,
              inputTokens: 1200,
              outputTokens: 300,
              cost: "0.00021",
              currency: "USD",
              confidence: "REPORTED",
            },
          ]),
        },
      },
    },
  };
});

import { Route } from "./$accountId";

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText(
    "dashboard:providers.activity.attemptState.FAILED",
    {},
    { timeout: 5_000 },
  );
}

const callsOf = (name: string) => state.calls.filter((call) => call.name === name);

afterEach(() => {
  cleanup();
  state.calls = [];
  state.catalogQueries = [];
});

describe("provider page", { timeout: 30_000 }, () => {
  it("shows this account's attempts and usage", async () => {
    await mount();
    expect(
      screen.getByText(/dashboard:providers\.activity\.http\(\{"status":429\}\)/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.activity.usage" }));
    expect(
      await screen.findByText(/dashboard:providers\.activity\.confidence\.REPORTED/),
    ).toBeTruthy();
    expect(screen.getAllByText("qwen/qwen3-32b").length).toBeGreaterThan(1);
  });

  it("renames the account through accounts.update with only what changed", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("dashboard:providers.form.label"), {
      target: { value: "Work OpenRouter" },
    });
    fireEvent.click(
      within(
        screen.getByLabelText("dashboard:providers.form.label").closest("form") as HTMLElement,
      ).getByRole("button", { name: "common:actions.save" }),
    );
    await waitFor(() => expect(callsOf("accounts.update")).toHaveLength(1));
    expect(callsOf("accounts.update")[0]?.input).toEqual({
      accountId: "acc-1",
      label: "Work OpenRouter",
    });
  });

  it("deletes a model after a confirm", async () => {
    await mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: 'dashboard:providers.deleteModel({"model":"qwen/qwen3-32b"})',
      }),
    );
    expect(callsOf("models.delete")).toEqual([]);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button"));
    await waitFor(() =>
      expect(callsOf("models.delete")).toEqual([
        { name: "models.delete", input: { modelId: "pm-1" } },
      ]),
    );
  });

  it("edits prices: add a draft, activate it, retire the active one", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.toggle" }));
    await screen.findByText("v2");
    fireEvent.change(screen.getByLabelText("dashboard:providers.pricing.rate.input"), {
      target: { value: "0.25" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:providers.pricing.rate.output"), {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.addDraft" }));
    await waitFor(() => expect(callsOf("pricing.create")).toHaveLength(1));
    expect(callsOf("pricing.create")[0]?.input).toEqual({
      modelId: "pm-1",
      currency: "USD",
      pricing: { input: "0.25", output: "0.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.activate" }));
    await waitFor(() =>
      expect(callsOf("pricing.activate")[0]?.input).toEqual({ versionId: "pv-2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.retire" }));
    expect(callsOf("pricing.retire")).toEqual([]);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button"));
    await waitFor(() => expect(callsOf("pricing.retire")[0]?.input).toEqual({ versionId: "pv-1" }));
  });

  it("refuses a draft without input and output prices", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.toggle" }));
    await screen.findByText("v2");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.pricing.addDraft" }));
    expect(
      (await screen.findAllByText("dashboard:providers.pricing.rateInvalid")).length,
    ).toBeGreaterThan(0);
    expect(callsOf("pricing.create")).toEqual([]);
  });

  it("adds a model picked from the catalog search", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("dashboard:providers.catalog.label"), {
      target: { value: "llama" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:providers.catalog.search" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: 'dashboard:providers.catalog.useModel({"model":"meta-llama/llama-3.3-70b"})',
      }),
    );
    expect(state.catalogQueries).toEqual([{ query: "llama" }]);
    expect((screen.getByLabelText("dashboard:providers.modelId") as HTMLInputElement).value).toBe(
      "meta-llama/llama-3.3-70b",
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.add" }));
    await waitFor(() => expect(callsOf("models.create")).toHaveLength(1));
    expect(callsOf("models.create")[0]?.input).toEqual({
      accountId: "acc-1",
      upstreamModelId: "meta-llama/llama-3.3-70b",
      type: "LLM",
      contextWindow: 131_072,
    });
  });
});
