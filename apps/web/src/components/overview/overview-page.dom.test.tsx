// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metrics: null as unknown,
  health: null as unknown,
  metricsInputs: [] as unknown[],
  metricsError: false,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      params,
      to,
    }: {
      children: ReactNode;
      className?: string;
      params?: Record<string, string>;
      to: string;
    }) => {
      let href = to;
      for (const [key, value] of Object.entries(params ?? {}))
        href = href.replace(`$${key}`, value);
      return (
        <a className={className} href={href}>
          {children}
        </a>
      );
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    overview: {
      metrics: {
        queryOptions: ({ input }: { input: unknown }) => {
          state.metricsInputs.push(input);
          return {
            queryKey: ["overview", "metrics", input],
            queryFn: async () => {
              if (state.metricsError) throw new Error("boom");
              return state.metrics;
            },
            retry: false,
          };
        },
      },
      health: {
        queryOptions: () => ({
          queryKey: ["overview", "health"],
          queryFn: async () => state.health,
          retry: false,
        }),
      },
    },
  },
}));

const { OverviewPage } = await import("./overview-page");
const { resetOverviewRangeForTests, OVERVIEW_RANGE_STORAGE_KEY } = await import(
  "@/hooks/use-overview-range"
);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stats(overrides: Record<string, unknown> = {}) {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    cancels: 0,
    retries: 0,
    errorRate: null,
    usageKnownRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    cacheReportedRequests: 0,
    avgLatencyMs: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    p50TtftMs: null,
    p95TtftMs: null,
    ...overrides,
  };
}

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    range: "24h",
    bucketMs: 900_000,
    start: "2026-09-23T10:30:00.000Z",
    end: "2026-09-24T10:30:00.000Z",
    previousStart: "2026-09-22T10:30:00.000Z",
    generatedAt: "2026-09-24T10:17:30.000Z",
    includeTestTraffic: false,
    totals: { current: stats(), previous: stats() },
    pools: [],
    direct: [],
    sharedPools: [],
    setup: { hasPools: false, hasDirectTargets: false },
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: "2026-09-24T10:17:30.000Z",
    clis: { total: 0, online: 0, offline: [] },
    endpoints: { total: 0, healthy: 0, unhealthy: [] },
    poolMembers: { total: 0, degradedCount: 0, circuitOpenCount: 0, degraded: [], circuitOpen: [] },
    modelApiTokens: 0,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OverviewPage lang="en-US" />
    </QueryClientProvider>,
  );
}

describe("OverviewPage", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    state.metricsInputs = [];
    state.metricsError = false;
    resetOverviewRangeForTests();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the h1, a layout-matching skeleton, then the setup checklist for a new user", async () => {
    state.metrics = metrics();
    state.health = health();
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "overview.title" })).toBeTruthy();
    expect(screen.getByTestId("overview-skeleton")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "overview.setup.title" })).toBeTruthy();
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(within(steps[0]!).getByRole("link").getAttribute("href")).toBe("/en-US/dashboard/clis");
    expect(within(steps[2]!).getByRole("link").getAttribute("href")).toBe(
      "/en-US/dashboard/pools/new",
    );
    // Default range and no charts without pools.
    expect(state.metricsInputs[0]).toEqual({ range: "24h" });
    expect(screen.queryByRole("heading", { name: "overview.pools.title" })).toBeNull();
    // Empty KPIs render as "no value"/"not reported", never 0%.
    expect(screen.getByText("overview.notReported")).toBeTruthy();
  });

  it("renders pool cards, member rows, and 'not reported' cache for non-reporting members", async () => {
    state.health = health({
      clis: { total: 1, online: 1, offline: [] },
      endpoints: { total: 1, healthy: 1, unhealthy: [] },
      poolMembers: {
        total: 2,
        degradedCount: 1,
        circuitOpenCount: 0,
        degraded: [
          { id: "member-b", poolId: "pool-1", poolName: "Coding", healthStatus: "DEGRADED" },
        ],
        circuitOpen: [],
      },
      modelApiTokens: 1,
    });
    state.metrics = metrics({
      setup: { hasPools: true, hasDirectTargets: true },
      totals: {
        current: stats({ requests: 40, errors: 1, errorRate: 0.025, cacheHitRate: 0.5 }),
        previous: stats({ requests: 20, errorRate: 0 }),
      },
      pools: [
        {
          poolId: "pool-1",
          name: "Coding",
          slug: "coding",
          current: stats({ requests: 40, errors: 1, cacheHitRate: 0.5 }),
          previous: stats({ requests: 20 }),
          seriesKeys: ["member-a", "member-b"],
          series: [
            { bucketStart: "2026-09-24T10:00:00.000Z", values: { "member-a": 1, "member-b": 0.5 } },
            { bucketStart: "2026-09-24T10:15:00.000Z", values: { "member-a": 2, "member-b": 1 } },
          ],
          members: [
            {
              poolMemberId: "member-a",
              seriesKey: "member-a",
              kind: "LOCAL",
              model: "qwen-a",
              location: "vLLM · gpu-box",
              tier: "PRIMARY",
              healthStatus: "HEALTHY",
              routingStatus: "ACTIVE",
              present: true,
              share: 0.75,
              stats: stats({ requests: 30, cacheHitRate: 0.5, p95LatencyMs: 420, errorRate: 0 }),
            },
            {
              poolMemberId: "member-b",
              seriesKey: "member-b",
              kind: "LOCAL",
              model: "qwen-b",
              location: "Ollama · laptop",
              tier: "PRIMARY",
              healthStatus: "DEGRADED",
              routingStatus: "ACTIVE",
              present: true,
              share: 0.25,
              stats: stats({ requests: 10, usageKnownRequests: 10, cacheHitRate: null }),
            },
          ],
        },
      ],
    });
    renderPage();
    const poolHeading = await screen.findByRole("heading", { level: 3, name: "Coding" });
    const card = poolHeading.closest("section")!;
    expect(within(card).getByText("qwen-a")).toBeTruthy();
    const memberB = within(card).getByText("qwen-b").closest("tr")!;
    expect(within(memberB).getByText("overview.notReported")).toBeTruthy();
    expect(within(memberB).getByText("overview.pools.health.DEGRADED")).toBeTruthy();
    expect(within(card).getByText('overview.pools.chartLabel:{"name":"Coding"}')).toBeTruthy();
    expect(within(card).getByRole("link").getAttribute("href")).toBe(
      "/en-US/dashboard/pools/pool-1",
    );
    // Setup checklist hidden once CLIs and pools exist; health links to the fix.
    expect(screen.queryByRole("heading", { name: "overview.setup.title" })).toBeNull();
    expect(
      screen
        .getByText('overview.health.reviewMember:{"pool":"Coding"}')
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/en-US/dashboard/pools/pool-1");
    // Requests doubled vs previous period.
    expect(screen.getByText('overview.kpi.deltaUp:{"value":"100%"}')).toBeTruthy();
    // Rate deltas use the localized percentage-point unit, never a literal "pp".
    const pointsDelta = screen.getByText(
      (text) =>
        text.startsWith("overview.kpi.deltaUp:") && text.includes("overview.kpi.deltaPoints"),
    );
    expect(pointsDelta.textContent).toContain('\\"value\\":\\"2.5\\"');
    expect(document.body.textContent).not.toMatch(/\d pp\b/);
    // No shared-pool usage: the section is not rendered.
    expect(screen.queryByRole("heading", { name: "overview.shared.title" })).toBeNull();
  });

  it("shows the viewer's own usage of shared pools without owner member details", async () => {
    state.health = health({ clis: { total: 1, online: 1, offline: [] } });
    state.metrics = metrics({
      setup: { hasPools: true, hasDirectTargets: false },
      sharedPools: [
        {
          poolId: "shared-pool",
          available: true,
          name: "Team GPUs",
          slug: "team-gpus",
          ownerSlug: "alice",
          current: stats({ requests: 7, errors: 1, errorRate: 1 / 7, p95LatencyMs: 800 }),
          previous: stats(),
        },
        {
          poolId: "revoked-pool",
          available: false,
          name: null,
          slug: null,
          ownerSlug: null,
          current: stats({ requests: 2 }),
          previous: stats(),
        },
      ],
    });
    renderPage();
    const heading = await screen.findByRole("heading", { level: 2, name: "overview.shared.title" });
    const section = heading.closest("section")!;
    const shared = within(section).getByText("Team GPUs").closest("tr")!;
    expect(within(shared).getByText('overview.shared.owner:{"owner":"alice"}')).toBeTruthy();
    expect(within(shared).getByText("7")).toBeTruthy();
    expect(within(section).getByText("overview.shared.unavailable")).toBeTruthy();
    // Shared usage alone is traffic for the viewer: no empty-range message.
    expect(screen.queryByText("overview.empty.title")).toBeNull();
  });

  it("persists the chosen range per viewer and refetches with it", async () => {
    state.metrics = metrics();
    state.health = health({ clis: { total: 1, online: 1, offline: [] } });
    renderPage();
    await screen.findByRole("heading", { name: "overview.setup.title" });
    await userEvent.click(screen.getByRole("button", { name: "overview.ranges.7d" }));
    expect(window.localStorage.getItem(OVERVIEW_RANGE_STORAGE_KEY)).toBe("7d");
    expect(state.metricsInputs).toContainEqual({ range: "7d" });
  });

  it("shows a retryable error state when metrics fail to load", async () => {
    state.metricsError = true;
    state.health = health();
    renderPage();
    expect(await screen.findByText("overview.loadFailed")).toBeTruthy();
  });
});
