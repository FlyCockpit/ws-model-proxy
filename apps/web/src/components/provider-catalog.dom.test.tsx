// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type SearchInput = { query: string; poolId?: string; filters: object; cursor?: number };
type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  searchCalls: [] as SearchInput[],
  respond: (_input: SearchInput): unknown => ({ status: "ok", items: [], nextCursor: null }),
  imports: [] as Array<Record<string, unknown>>,
  importResult: {} as Record<string, unknown>,
  equivalent: { externalEquivalentModel: null as string | null, providerEgressEnabled: true },
  sets: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/utils/orpc", () => {
  const mutation = (sink: "imports" | "sets", result: () => unknown) => ({
    mutationOptions: (options: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state[sink].push(input);
        return result();
      },
    }),
  });
  return {
    orpc: {
      providerManagement: { key: () => ["providerManagement"] },
      providerCatalog: {
        key: () => ["providerCatalog"],
        search: {
          infiniteOptions: (options: {
            input: (cursor: number | undefined) => SearchInput;
            initialPageParam: number | undefined;
            getNextPageParam: (page: unknown) => number | undefined;
          }) => ({
            queryKey: ["providerCatalog", "search", options.input(undefined)],
            queryFn: async ({ pageParam }: { pageParam: number | undefined }) => {
              const input = options.input(pageParam);
              state.searchCalls.push(input);
              return state.respond(input);
            },
            initialPageParam: options.initialPageParam,
            getNextPageParam: options.getNextPageParam,
          }),
        },
        importModel: mutation("imports", () => state.importResult),
        getPoolExternalEquivalent: {
          queryOptions: () => ({
            queryKey: ["providerCatalog", "equivalent"],
            queryFn: async () => state.equivalent,
          }),
        },
        setPoolExternalEquivalent: mutation("sets", () => ({
          externalEquivalentModel: state.sets.at(-1)?.modelId ?? null,
          compatibility: null,
        })),
      },
    },
  };
});

const { ProviderCatalogPicker } = await import("./provider-catalog-picker");
const { ProviderCatalogImport } = await import("./provider-catalog-import");
const { PoolExternalEquivalentSection } = await import("./pool-external-equivalent");
const { ProviderPresetButtons, PROVIDER_PRESETS } = await import("./provider-presets");

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    name: `Name ${id}`,
    contextLength: 131_072,
    maxCompletionTokens: 8_192,
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      cacheRead: null,
      cacheWrite: null,
      variable: false,
    },
    supportsTools: true,
    supportsReasoning: false,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    expirationDate: null,
    moderated: false,
    free: false,
    compatibility: { verdict: "ok", block: [], warn: [] },
    ...overrides,
  };
}

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  state.searchCalls = [];
  state.imports = [];
  state.sets = [];
  state.respond = () => ({ status: "ok", items: [], nextCursor: null });
  state.equivalent = { externalEquivalentModel: null, providerEgressEnabled: true };
});

describe("ProviderCatalogPicker", () => {
  it("shows a layout skeleton while the first page loads", async () => {
    let release: (value: unknown) => void = () => undefined;
    state.respond = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { container } = wrap(<ProviderCatalogPicker onSelect={vi.fn()} />);
    expect(container.querySelector("[data-slot='skeleton']")).not.toBeNull();
    release({ status: "ok", items: [row("a/b")], nextCursor: null });
    await screen.findByText("Name a/b");
    expect(container.querySelector("[data-slot='skeleton']")).toBeNull();
  });

  it("renders context, price, tools badges and verdict warnings, in a bounded vertical list", async () => {
    state.respond = () => ({
      status: "ok",
      items: [
        row("vendor/warned", {
          compatibility: { verdict: "warn", block: [], warn: ["NO_REASONING", "FREE_MODEL"] },
          free: true,
        }),
      ],
      nextCursor: null,
    });
    const { container } = wrap(<ProviderCatalogPicker onSelect={vi.fn()} />);
    await screen.findByText("Name vendor/warned");
    expect(
      screen.getByText('dashboard:providerCatalog.picker.context|{"value":"131.1K"}'),
    ).toBeTruthy();
    expect(
      screen.getByText('dashboard:providerCatalog.picker.price|{"input":"3","output":"15"}'),
    ).toBeTruthy();
    expect(screen.getByText("dashboard:providerCatalog.picker.tools")).toBeTruthy();
    expect(screen.getByText("dashboard:providerCatalog.picker.vision")).toBeTruthy();
    expect(screen.getByText("dashboard:providerCatalog.reasons.NO_REASONING")).toBeTruthy();
    expect(screen.getByText("dashboard:providerCatalog.reasons.FREE_MODEL")).toBeTruthy();
    const list = container.querySelector("[data-slot='command-list']");
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("overflow-x-hidden");
    expect(list?.className).toContain("overscroll-contain");
    const item = container.querySelector("[data-slot='command-item']");
    expect(item?.className).toContain("min-h-11");
  });

  it("debounces the query and sends the pool id and tool filter", async () => {
    wrap(<ProviderCatalogPicker poolId="pool-1" onSelect={vi.fn()} />);
    await waitFor(() => expect(state.searchCalls).toHaveLength(1));
    expect(state.searchCalls[0]).toMatchObject({ query: "", poolId: "pool-1", filters: {} });
    const input = screen.getByLabelText("dashboard:providerCatalog.picker.label");
    fireEvent.change(input, { target: { value: "q" } });
    fireEvent.change(input, { target: { value: "qw" } });
    fireEvent.change(input, { target: { value: "qwen" } });
    await waitFor(() => expect(state.searchCalls.at(-1)?.query).toBe("qwen"));
    // Intermediate keystrokes never reached the server.
    expect(state.searchCalls.map((call) => call.query)).toEqual(["", "qwen"]);
    fireEvent.click(screen.getByLabelText("dashboard:providerCatalog.picker.toolsOnly"));
    await waitFor(() =>
      expect(state.searchCalls.at(-1)).toMatchObject({ query: "qwen", filters: { tools: true } }),
    );
  });

  it("selects a model but never a blocked one", async () => {
    const onSelect = vi.fn();
    state.respond = () => ({
      status: "ok",
      items: [
        row("vendor/ok"),
        row("vendor/image-only", {
          compatibility: { verdict: "block", block: ["NO_TEXT_OUTPUT"], warn: [] },
        }),
      ],
      nextCursor: null,
    });
    wrap(<ProviderCatalogPicker onSelect={onSelect} />);
    fireEvent.click(await screen.findByText("Name vendor/image-only"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Name vendor/ok"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "vendor/ok" }));
  });

  it("loads the next page with the server cursor", async () => {
    state.respond = (input) =>
      input.cursor === undefined
        ? { status: "ok", items: [row("a/one")], nextCursor: 1 }
        : { status: "ok", items: [row("a/two")], nextCursor: null };
    wrap(<ProviderCatalogPicker onSelect={vi.fn()} />);
    await screen.findByText("Name a/one");
    fireEvent.click(screen.getByText("dashboard:providerCatalog.picker.loadMore"));
    await screen.findByText("Name a/two");
    expect(state.searchCalls.at(-1)?.cursor).toBe(1);
    expect(screen.queryByText("dashboard:providerCatalog.picker.loadMore")).toBeNull();
  });

  it("explains a disabled deployment and an unavailable catalog", async () => {
    state.respond = () => ({ status: "disabled", items: [], nextCursor: null });
    wrap(<ProviderCatalogPicker onSelect={vi.fn()} />);
    await screen.findByText("dashboard:providerCatalog.picker.disabled");
    cleanup();
    state.respond = () => ({ status: "unavailable", items: [], nextCursor: null });
    wrap(<ProviderCatalogPicker onSelect={vi.fn()} />);
    await screen.findByText("dashboard:providerCatalog.picker.unavailable");
  });
});

describe("ProviderCatalogImport", () => {
  it("imports the picked model into the given account and reports pricing and context notes", async () => {
    state.respond = () => ({ status: "ok", items: [row("vendor/pick")], nextCursor: null });
    state.importResult = {
      created: true,
      restored: false,
      pricing: "unknown",
      contextWindowDrift: { current: 8_000, catalog: 131_072 },
      model: {},
      compatibility: { verdict: "ok", block: [], warn: [] },
    };
    wrap(<ProviderCatalogImport providerAccountId="acct-1" />);
    const action = screen.getByRole("button", { name: "dashboard:providerCatalog.import.action" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByText("Name vendor/pick"));
    fireEvent.click(action);
    await waitFor(() =>
      expect(state.imports).toEqual([{ providerAccountId: "acct-1", modelId: "vendor/pick" }]),
    );
    await screen.findByText("dashboard:providerCatalog.import.pricingUnknown");
    expect(
      screen.getByText(
        'dashboard:providerCatalog.import.contextDrift|{"catalog":131072,"current":8000}',
      ),
    ).toBeTruthy();
  });
});

describe("PoolExternalEquivalentSection", () => {
  it("saves a picked catalog model for the pool", async () => {
    state.respond = () => ({ status: "ok", items: [row("qwen/qwen3-coder")], nextCursor: null });
    wrap(<PoolExternalEquivalentSection poolId="pool-1" />);
    await screen.findByText("dashboard:providerCatalog.equivalent.none");
    fireEvent.click(await screen.findByText("Name qwen/qwen3-coder"));
    fireEvent.click(screen.getByText("dashboard:providerCatalog.equivalent.save"));
    await waitFor(() =>
      expect(state.sets).toEqual([{ poolId: "pool-1", modelId: "qwen/qwen3-coder" }]),
    );
    expect(state.searchCalls[0]?.poolId).toBe("pool-1");
  });

  it("shows the current value and still allows clearing when the switch is off", async () => {
    state.equivalent = {
      externalEquivalentModel: "qwen/qwen3-coder",
      providerEgressEnabled: false,
    };
    wrap(<PoolExternalEquivalentSection poolId="pool-1" />);
    await screen.findByText(
      'dashboard:providerCatalog.equivalent.current|{"model":"qwen/qwen3-coder"}',
    );
    expect(screen.getByText("dashboard:providerCatalog.equivalent.disabled")).toBeTruthy();
    expect(screen.queryByLabelText("dashboard:providerCatalog.picker.label")).toBeNull();
    expect(state.searchCalls).toEqual([]);
    fireEvent.click(screen.getByText("dashboard:providerCatalog.equivalent.clear"));
    await waitFor(() => expect(state.sets).toEqual([{ poolId: "pool-1", modelId: null }]));
  });
});

describe("ProviderPresetButtons", () => {
  it("applies the OpenRouter preset with its API-root base URL and bearer auth", () => {
    const onApply = vi.fn();
    render(<ProviderPresetButtons onApply={onApply} />);
    fireEvent.click(screen.getByText("dashboard:providerCatalog.presets.openrouter"));
    expect(onApply).toHaveBeenCalledWith({
      key: "openrouter",
      providerType: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      authType: "BEARER",
    });
    expect(PROVIDER_PRESETS.map((preset) => preset.key)).toEqual([
      "openrouter",
      "openai",
      "anthropic",
      "custom",
    ]);
  });
});
