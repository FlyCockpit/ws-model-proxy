// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The chart's first render after the queries settle can take longer than the
// 1 s default on a loaded runner; every wait is still for a real condition.
configure({ asyncUtilTimeout: 10_000 });

/** Activity metrics explorer: scope, metric, range/step, tests, compare versions, URL state. */

type Input = Record<string, unknown>;
type Answer = {
  start: string;
  series: Array<{
    group?: { key: string; label?: string };
    at: number[];
    values: Record<string, Array<number | null>>;
  }>;
  totals: Record<string, number>;
  truncated?: true;
  histogramVersion: "v1";
};

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  inputs: [] as Input[],
  answer: (_input: Input): Answer | Error => new Error("unset"),
  pools: {
    pools: [] as Array<Record<string, unknown>>,
    sharedWithMe: [] as Array<Record<string, unknown>>,
  },
  runtimesFail: false,
}));

function setSearch(next: Record<string, unknown>) {
  state.search = next;
  for (const listener of state.listeners) listener();
}

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
      useSearch: () => useSyncExternalStore(subscribe, () => state.search),
      useNavigate:
        () =>
        ({ search }: { search: (prev: Record<string, unknown>) => Record<string, unknown> }) => {
          setSearch(search(state.search));
          return Promise.resolve();
        },
    }),
    Link: ({
      children,
      className,
      to,
    }: {
      children: ReactNode;
      className?: string;
      to: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", async () => {
  const { skipToken: skip } = await import("@tanstack/react-query");
  const { metricsQueryInputSchema } = await import("@ws-model-proxy/api/contracts/metrics");
  const list = (key: string, data: () => unknown) => ({
    queryOptions: () => ({ queryKey: [key], queryFn: async () => data() }),
  });
  const withInput = (key: string, data: (input: Input) => unknown) => ({
    queryOptions: ({ input }: { input: Input | typeof skip }) =>
      typeof input === "symbol"
        ? { queryKey: [key, null], queryFn: skip }
        : { queryKey: [key, input], queryFn: async () => data(input) },
  });
  return {
    orpc: {
      activity: {
        metrics: {
          query: withInput("metrics", (input) => {
            // Every input the page builds must pass the contract.
            metricsQueryInputSchema.parse(input);
            state.inputs.push(input);
            const answer = state.answer(input);
            if (answer instanceof Error) throw answer;
            return answer;
          }),
        },
      },
      pools: { list: list("pools", () => state.pools) },
      runtimes: {
        list: list("runtimes", () => {
          if (state.runtimesFail) throw new Error("runtimes down");
          return {
            runtimes: [
              { id: "rt1", slug: "qwen", service: false },
              { id: "svc", slug: "redis", service: true },
            ],
          };
        }),
        versions: {
          list: withInput("versions", () => ({
            items: [
              { id: "v2", version: 2 },
              { id: "v1", version: 1 },
            ],
            nextCursor: null,
          })),
        },
        get: withInput("runtime", () => ({
          instanceList: [{ id: "in1", handle: "qwen-a", versionNumber: 2 }],
        })),
      },
      nodes: { list: list("nodes", () => ({ nodes: [{ id: "n1", slug: "desk" }] })) },
    },
  };
});

import { Route } from "./index";

const START = "2026-10-08T00:00:00.000Z";

function answer(input: Input): Answer {
  const metrics = input.metrics as string[];
  if (input.groupBy === "version")
    return {
      start: START,
      series: [
        { group: { key: "v2", label: "qwen v2" }, at: [0], values: { requests: [7] } },
        { group: { key: "v1", label: "qwen v1" }, at: [1], values: { requests: [3] } },
      ],
      totals: { requests: 10 },
      histogramVersion: "v1",
    };
  return {
    start: START,
    series: [
      {
        at: [0, 2],
        values: Object.fromEntries(metrics.map((metric) => [metric, [5, 1234]])),
      },
    ],
    totals: { requests: 1239, errors: 2, latency_p95: 420, tests: 3 },
    histogramVersion: "v1",
  };
}

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

// Route components are code-split: load the chunk once, outside any test's
// own budget.
beforeAll(async () => {
  await Component.preload?.();
}, 60_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.search = {};
  state.inputs = [];
  state.answer = answer;
  state.runtimesFail = false;
  state.pools = {
    pools: [{ id: "p1", slug: "chat", callableIds: ["alex/chat"] }],
    sharedWithMe: [],
  };
  // Recharts measures its container.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
});

describe("Activity metrics explorer", { timeout: 30_000 }, () => {
  it("queries the first pool over 24 hours without tests and shows the totals", async () => {
    await mount();
    expect(await screen.findByText("1,239")).toBeTruthy();
    const input = state.inputs[0];
    expect(input).toMatchObject({
      scope: { pool: "p1" },
      range: "24h",
      step: "5m",
      includeTests: false,
    });
    expect((input?.metrics as string[] | undefined)?.[0]).toBe("requests");
    // Ungrouped, the chart reuses the totals answer: one request.
    expect(state.inputs).toHaveLength(1);
    expect(screen.getByText("activity:metrics.testsLeftOut:3")).toBeTruthy();
    expect(screen.getByRole("img", { name: "activity:metrics.chartLabel:1" })).toBeTruthy();
    expect(
      screen.getAllByText("activity:metrics.requestLog")[0]?.closest("a")?.getAttribute("href"),
    ).toBe("/$lang/activity/requests");
  });

  it("shows the values as a table and keeps the view in the URL", async () => {
    await mount();
    await screen.findByText("1,239");
    fireEvent.click(screen.getByRole("button", { name: "activity:metrics.viewValue.table" }));
    expect(state.search.view).toBe("table");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // Header plus every bucket (counters fill missing buckets with 0).
    expect(rows.length).toBeGreaterThan(3);
    expect(within(table).getByText("1,234")).toBeTruthy();
  });

  it("includes tests when the toggle is on", async () => {
    await mount();
    await screen.findByText("1,239");
    fireEvent.click(screen.getByRole("switch", { name: "activity:metrics.includeTests" }));
    expect(state.search.tests).toBe(true);
    await waitFor(() =>
      expect(state.inputs.some((input) => input.includeTests === true)).toBe(true),
    );
  });

  it("compares a runtime's versions, one series per version", async () => {
    setSearch({ scope: "runtime", view: "table" });
    await mount();
    const compare = await screen.findByRole("switch", { name: "activity:metrics.compareVersions" });
    fireEvent.click(compare);
    expect(state.search.groupBy).toBe("version");
    expect(await screen.findByRole("columnheader", { name: "qwen v2" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "qwen v1" })).toBeTruthy();
    expect(state.inputs.find((input) => input.groupBy === "version")).toMatchObject({
      scope: { runtime: "rt1" },
      metrics: ["requests"],
    });
    // Services have no metrics.
    expect(screen.queryByRole("option", { name: "redis" })).toBeNull();
  });

  it("changes metric, range and step through the URL", async () => {
    await mount();
    await screen.findByText("1,239");
    fireEvent.change(screen.getByLabelText("activity:metrics.metric"), {
      target: { value: "kv_usage_max" },
    });
    expect(state.search.metric).toBe("kv_usage_max");
    // Engine load is kept about a week: no 30-day range.
    expect(screen.queryByRole("button", { name: "activity:metrics.rangeValue.30d" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "activity:metrics.rangeValue.7d" }));
    await waitFor(() => expect(state.inputs.at(-1)).toMatchObject({ range: "7d", step: "1h" }));
    expect(state.inputs.at(-1)?.metrics).toContain("kv_usage_max");
    // No tests toggle for engine load.
    expect(screen.queryByRole("switch", { name: "activity:metrics.includeTests" })).toBeNull();
  });

  it("picks a runtime version and a node", async () => {
    setSearch({ scope: "version" });
    await mount();
    await waitFor(() => expect(state.inputs.at(-1)).toMatchObject({ scope: { version: "v2" } }));
    expect(screen.getByRole("option", { name: "qwen v1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "activity:metrics.scopeValue.node" }));
    await waitFor(() => expect(state.inputs.at(-1)).toMatchObject({ scope: { node: "n1" } }));
  });

  it("says when there is no data and links to the request log", async () => {
    state.answer = () => ({
      start: START,
      series: [],
      totals: { requests: 0 },
      histogramVersion: "v1",
    });
    await mount();
    expect(await screen.findByText("activity:metrics.empty")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /activity:metrics.requestLog/ })).toHaveLength(2);
  });

  it("says when a scope has nothing to pick", async () => {
    state.pools = { pools: [], sharedWithMe: [] };
    await mount();
    expect(await screen.findAllByText("activity:metrics.noTargets.pool")).not.toHaveLength(0);
    expect(state.inputs).toHaveLength(0);
  });

  it("offers request metrics only for a pool shared with you", async () => {
    state.pools = {
      pools: [],
      sharedWithMe: [{ poolId: "sp1", callableIds: ["sam/chat"] }],
    };
    setSearch({ metric: "cpu_pct" });
    await mount();
    await waitFor(() => expect(state.inputs.at(-1)).toMatchObject({ scope: { pool: "sp1" } }));
    expect((state.inputs.at(-1)?.metrics as string[] | undefined)?.[0]).toBe("requests");
    expect(
      screen.queryByRole("option", { name: "activity:metrics.metricValue.cpu_pct" }),
    ).toBeNull();
    expect(screen.getByText("activity:metrics.sharedPool")).toBeTruthy();
  });

  it("waits for the pool list before querying a linked shared pool", async () => {
    state.pools = {
      pools: [{ id: "p1", slug: "chat", callableIds: ["alex/chat"] }],
      sharedWithMe: [{ poolId: "sp1", callableIds: ["sam/chat"] }],
    };
    setSearch({ id: "sp1", metric: "kv_usage_max", groupBy: "model" });
    await mount();
    await waitFor(() => expect(state.inputs.length).toBeGreaterThan(0));
    // Never a load metric or a model split for a pool shared with you.
    for (const input of state.inputs) {
      expect(input.scope).toEqual({ pool: "sp1" });
      expect(input.groupBy).toBeUndefined();
      expect((input.metrics as string[]).every((metric) => !metric.startsWith("kv_"))).toBe(true);
    }
  });

  it("falls back to the first pool when a linked one is gone", async () => {
    setSearch({ id: "gone" });
    await mount();
    await waitFor(() => expect(state.inputs.length).toBeGreaterThan(0));
    expect(state.inputs.every((input) => (input.scope as Input).pool === "p1")).toBe(true);
  });

  it("offers a retry when the runtime list fails in a version scope", async () => {
    state.runtimesFail = true;
    setSearch({ scope: "version" });
    await mount();
    expect(await screen.findAllByText("activity:metrics.targetsFailed")).not.toHaveLength(0);
    expect(state.inputs).toHaveLength(0);
  });

  it("offers a retry when the query fails", async () => {
    state.answer = () => new Error("down");
    await mount();
    expect(await screen.findByText("activity:metrics.loadFailed")).toBeTruthy();
  });
});
