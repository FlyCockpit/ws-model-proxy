// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: null as unknown,
  pending: false,
  error: false,
  inputs: [] as unknown[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      poolCacheStats: {
        queryOptions: ({ input }: { input: unknown }) => {
          state.inputs.push(input);
          return {
            queryKey: ["poolCacheStats", input],
            queryFn: async () => {
              if (state.error) throw new Error("boom");
              if (state.pending) return new Promise<unknown>(() => {});
              return state.data;
            },
            retry: false,
          };
        },
      },
    },
  },
}));

const { PoolCacheStats } = await import("./pool-cache-stats");

function stats(overrides: Record<string, unknown> = {}) {
  return {
    requests: 20,
    cacheReadTokens: 40,
    cacheKnownRequests: 16,
    cacheKnownInputTokens: 80,
    continuationRequests: 8,
    continuationInputTokens: 40,
    continuationCacheReadTokens: 30,
    hitRate: 0.5,
    continuationHitRate: 0.75,
    coverage: 0.8,
    window: {
      start: "2026-09-24T11:00:00.000Z",
      end: "2026-09-24T12:00:00.000Z",
      bucketMinutes: 1,
      source: "minute",
    },
    series: [
      {
        start: "2026-09-24T11:00:00.000Z",
        requests: 10,
        hitRate: 0.4,
        continuationHitRate: 0.7,
        coverage: 0.8,
      },
      {
        start: "2026-09-24T11:30:00.000Z",
        requests: 10,
        hitRate: 0.6,
        continuationHitRate: 0.8,
        coverage: 0.8,
      },
    ],
    stability: {
      median: 0.5,
      p10: 0.4,
      stddev: 0.1,
      bucketsBelowHalf: 1,
      firstHalfHitRate: 0.4,
      secondHalfHitRate: 0.6,
      change: 0.2,
    },
    notes: [],
    ...overrides,
  };
}

function renderChart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PoolCacheStats poolId="pool-1" />
    </QueryClientProvider>,
  );
}

describe("PoolCacheStats", () => {
  beforeEach(() => {
    state.data = stats();
    state.pending = false;
    state.error = false;
    state.inputs = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("shows a layout-matching skeleton while loading", async () => {
    state.pending = true;
    state.data = null;
    renderChart();
    expect(await screen.findByTestId("pool-cache-stats-skeleton")).toBeTruthy();
  });

  it("renders the line chart when cache usage is present", async () => {
    renderChart();
    expect(await screen.findByTestId("pool-cache-stats-chart")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.cacheStats.chartLabel")).toBeTruthy();
    expect(state.inputs[0]).toMatchObject({ poolId: "pool-1", lastMinutes: 1440 });
  });

  it("shows the empty state when the window has no traffic", async () => {
    state.data = stats({
      requests: 0,
      hitRate: null,
      continuationHitRate: null,
      coverage: null,
      series: [],
      notes: ["engine_reports_no_cache_fields"],
    });
    renderChart();
    expect(await screen.findByTestId("pool-cache-stats-empty")).toBeTruthy();
    expect(screen.queryByTestId("pool-cache-stats-chart")).toBeNull();
  });

  it("shows the no-cache state when traffic did not report cache fields", async () => {
    state.data = stats({
      requests: 12,
      hitRate: null,
      continuationHitRate: null,
      coverage: null,
      notes: ["engine_reports_no_cache_fields"],
    });
    renderChart();
    expect(await screen.findByTestId("pool-cache-stats-no-cache")).toBeTruthy();
    expect(screen.queryByTestId("pool-cache-stats-chart")).toBeNull();
  });

  it("surfaces a low-coverage warning", async () => {
    state.data = stats({
      coverage: 0.1,
      notes: ["low_coverage"],
    });
    renderChart();
    expect(await screen.findByTestId("pool-cache-stats-low-coverage")).toBeTruthy();
    expect(screen.getByTestId("pool-cache-stats-chart")).toBeTruthy();
  });
});
