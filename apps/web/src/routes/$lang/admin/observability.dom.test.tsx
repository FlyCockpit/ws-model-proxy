// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObservabilitySearch } from "@/lib/observability-search";

const routeState = vi.hoisted(() => ({
  search: {
    tab: "clis",
    page: 1,
    owner: "",
    cliStatus: "all",
    endpointStatus: "all",
    capability: "all",
    poolHealth: "all",
    relayStatus: "all",
    errorClass: "",
    createdAfter: "",
    createdBefore: "",
  },
}));

const calls = vi.hoisted(() => ({
  clis: [] as Array<Record<string, unknown>>,
  endpoints: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  pools: [] as Array<Record<string, unknown>>,
  relays: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useSearch: () => routeState.search,
      useNavigate: () => vi.fn(),
    }),
    stripSearchParams: () => undefined,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/segmented-control", () => ({
  SegmentedControl: () => null,
}));

vi.mock("@ws-model-proxy/ui/components/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

vi.mock("@/utils/orpc", () => {
  const queryOptions =
    (name: keyof typeof calls) => (options: { input: Record<string, unknown> }) => ({
      queryKey: [name, options.input],
      queryFn: async () => {
        calls[name].push(options.input);
        return {
          items: [],
          total: 0,
          pageCount: 1,
          summary: {
            durationMs: { average: null },
            tokens: { total: 0 },
            statusCounts: [],
          },
        };
      },
    });

  return {
    orpc: {
      adminObservability: {
        listCliDevices: { queryOptions: queryOptions("clis") },
        listEndpoints: { queryOptions: queryOptions("endpoints") },
        listModels: { queryOptions: queryOptions("models") },
        listPools: { queryOptions: queryOptions("pools") },
        listRelayMetadataSummaries: { queryOptions: queryOptions("relays") },
      },
    },
  };
});

import { Route } from "./observability";

const defaultSearch: ObservabilitySearch = {
  tab: "clis",
  page: 1,
  owner: "",
  cliStatus: "all",
  endpointStatus: "all",
  capability: "all",
  poolHealth: "all",
  relayStatus: "all",
  errorClass: "",
  createdAfter: "",
  createdBefore: "",
};

async function mount(search: ObservabilitySearch) {
  routeState.search = search;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 1000 * 60 * 5 } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  const view = render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  const rerender = (nextSearch: ObservabilitySearch) => {
    routeState.search = nextSearch;
    view.rerender(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
  };
  return { rerender };
}

function totalCalls() {
  return Object.values(calls).reduce((total, procedureCalls) => total + procedureCalls.length, 0);
}

afterEach(() => {
  cleanup();
  for (const procedureCalls of Object.values(calls)) procedureCalls.length = 0;
  routeState.search = { ...defaultSearch };
});

describe("admin observability query activation", () => {
  it("fetches only the default or deep-linked active tab", async () => {
    await mount({ ...defaultSearch });
    await waitFor(() => expect(calls.clis).toHaveLength(1));
    expect(totalCalls()).toBe(1);

    cleanup();
    for (const procedureCalls of Object.values(calls)) procedureCalls.length = 0;

    await mount({ ...defaultSearch, tab: "relays" });
    await waitFor(() => expect(calls.relays).toHaveLength(1));
    expect(totalCalls()).toBe(1);
  });

  it("fetches a newly active tab without fetching hidden tabs on that render", async () => {
    const view = await mount({ ...defaultSearch });
    await waitFor(() => expect(calls.clis).toHaveLength(1));

    view.rerender({ ...defaultSearch, tab: "models" });
    await waitFor(() => expect(calls.models).toHaveLength(1));

    expect(calls.clis).toHaveLength(1);
    expect(calls.endpoints).toHaveLength(0);
    expect(calls.pools).toHaveLength(0);
    expect(calls.relays).toHaveLength(0);
  });

  it("defers hidden filters until activation and reuses a fresh tab/input cache", async () => {
    const view = await mount({ ...defaultSearch });
    await waitFor(() => expect(calls.clis).toHaveLength(1));

    view.rerender({ ...defaultSearch, endpointStatus: "OFFLINE" });
    await Promise.resolve();
    expect(calls.endpoints).toHaveLength(0);
    expect(calls.clis).toHaveLength(1);

    view.rerender({ ...defaultSearch, tab: "endpoints", endpointStatus: "OFFLINE" });
    await waitFor(() => expect(calls.endpoints).toHaveLength(1));
    expect(calls.endpoints[0]).toMatchObject({ status: "OFFLINE" });

    view.rerender({ ...defaultSearch });
    await Promise.resolve();
    expect(calls.clis).toHaveLength(1);
  });

  it("fetches when an active tab filter or page changes", async () => {
    const view = await mount({ ...defaultSearch, tab: "pools" });
    await waitFor(() => expect(calls.pools).toHaveLength(1));

    view.rerender({ ...defaultSearch, tab: "pools", poolHealth: "DEGRADED" });
    await waitFor(() => expect(calls.pools).toHaveLength(2));

    view.rerender({
      ...defaultSearch,
      tab: "pools",
      poolHealth: "DEGRADED",
      page: 2,
    });
    await waitFor(() => expect(calls.pools).toHaveLength(3));
    expect(calls.pools[2]).toMatchObject({ memberHealth: "DEGRADED", page: 2 });
  });
});
