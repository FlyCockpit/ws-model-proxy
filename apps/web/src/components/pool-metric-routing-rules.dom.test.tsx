// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";
import esDashboard from "../locales/es-MX/dashboard.json";

const state = vi.hoisted(() => ({
  view: null as Record<string, unknown> | null,
  mutationCalls: [] as unknown[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "count" in options ? `${key}:${String(options.count)}` : key,
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      key: () => ["forwarderManagement"],
      getPoolRoutingRules: {
        queryOptions: () => ({
          queryKey: ["routingRules"],
          queryFn: async () => state.view,
          initialData: state.view,
        }),
      },
      setPoolMemberEngineLoad: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (variables: unknown) => {
            state.mutationCalls.push(variables);
            return variables;
          },
          ...options,
        }),
      },
      setPoolRoutingRules: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (variables: unknown) => {
            state.mutationCalls.push(variables);
            return variables;
          },
          ...options,
        }),
      },
    },
  },
}));

import { PoolMetricRoutingRules, parseLabelText } from "./pool-metric-routing-rules";

function mount(children: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
}

function engineLoad(overrides: Record<string, unknown> = {}) {
  return {
    mode: "auto",
    kvFullThreshold: null,
    effectiveKvFullThreshold: 0.95,
    engineKind: "VLLM",
    engineSlots: null,
    hasSignal: true,
    state: "clear",
    full: false,
    snapshotState: null,
    kvBudget: {
      reportedTokens: 100_000,
      effectiveTokens: 100_000,
      cutFraction: 0,
      floorFraction: 0.5,
      lastObservedAt: null,
      expiresAt: null,
      active: false,
    },
    live: null,
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    poolId: "pool-1",
    poolSlug: "coder",
    rules: [
      {
        metric: "node.gpu.temperature_c",
        labels: { gpu: "0" },
        aggregate: "max",
        op: ">",
        threshold: 85,
        effect: "full",
      },
    ],
    members: [
      {
        poolMemberId: "m1",
        upstreamModelId: "qwen-a",
        endpointSlug: "gpu",
        cliDeviceId: "d1",
        verdict: "full",
        state: "active",
        ruleStates: ["triggered"],
        evaluatedAt: null,
        expiresAt: null,
        endpointSeries: [{ name: "endpoint.running", labels: {}, value: 2, stale: false }],
        engineLoad: engineLoad({
          state: "full_waiting",
          full: true,
          live: {
            running: 3,
            waiting: 2,
            kvUsage: 0.91,
            slotsBusy: null,
            deferred: null,
            waitingStreak: 2,
            ageSeconds: 1,
            stale: false,
            prefixCacheHits: 30,
            prefixCacheQueries: 60,
          },
        }),
      },
      {
        poolMemberId: "m2",
        upstreamModelId: "qwen-b",
        endpointSlug: "gpu",
        cliDeviceId: "d1",
        verdict: null,
        state: "stale",
        ruleStates: ["stale"],
        evaluatedAt: null,
        expiresAt: null,
        endpointSeries: [],
        engineLoad: engineLoad({ state: "stale" }),
      },
    ],
    devices: [
      {
        cliDeviceId: "d1",
        label: "desk",
        live: true,
        series: [
          {
            name: "node.gpu.temperature_c",
            labels: { gpu: "0" },
            value: 91,
            origin: "builtin",
            ageSeconds: 3,
            stale: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  state.view = null;
  state.mutationCalls = [];
});

describe("PoolMetricRoutingRules", () => {
  it("shows the rules, member badges and the device's metrics", () => {
    state.view = view();
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    expect(screen.getByDisplayValue("node.gpu.temperature_c")).toBeTruthy();
    expect(screen.getByDisplayValue("gpu=0")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.metricRules.badges.full")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.metricRules.badges.stale")).toBeTruthy();
    expect(screen.getByText('node.gpu.temperature_c{gpu="0"}')).toBeTruthy();
    // Every rule input is a 44px target.
    for (const input of screen.getAllByRole("textbox"))
      expect(input.className).toContain("min-h-11");
  });

  it("adds a rule and saves the whole list with parsed labels and numbers", async () => {
    state.view = view();
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    fireEvent.click(screen.getByRole("button", { name: /metricRules.add/ }));
    const metricInputs = screen.getAllByLabelText("dashboard:pools.metricRules.metric");
    fireEvent.change(metricInputs[1]!, { target: { value: "endpoint.waiting" } });
    const thresholds = screen.getAllByLabelText("dashboard:pools.metricRules.threshold");
    fireEvent.change(thresholds[1]!, { target: { value: "2.5" } });
    const effects = screen.getAllByLabelText("dashboard:pools.metricRules.effect");
    fireEvent.change(effects[1]!, { target: { value: "avoid" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.metricRules.save" }));
    await waitFor(() => expect(state.mutationCalls).toHaveLength(1));
    expect(state.mutationCalls[0]).toEqual({
      poolId: "pool-1",
      rules: [
        {
          metric: "node.gpu.temperature_c",
          labels: { gpu: "0" },
          aggregate: "max",
          op: ">",
          threshold: 85,
          effect: "full",
        },
        { metric: "endpoint.waiting", aggregate: "max", op: ">", threshold: 2.5, effect: "avoid" },
      ],
    });
  });

  it("refuses malformed labels and thresholds without saving", async () => {
    state.view = view();
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    fireEvent.change(screen.getByDisplayValue("gpu=0"), { target: { value: "gpu 0" } });
    fireEvent.change(screen.getByDisplayValue("85"), { target: { value: "hot" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.metricRules.save" }));
    await waitFor(() =>
      expect(screen.getByText("dashboard:pools.metricRules.labelsInvalid")).toBeTruthy(),
    );
    expect(screen.getByText("dashboard:pools.metricRules.thresholdInvalid")).toBeTruthy();
    expect(state.mutationCalls).toEqual([]);
  });

  it("removes a rule and saves an empty list", async () => {
    state.view = view();
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.metricRules.remove" }));
    expect(screen.getByText("dashboard:pools.metricRules.empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pools.metricRules.save" }));
    await waitFor(() => expect(state.mutationCalls).toEqual([{ poolId: "pool-1", rules: [] }]));
  });
});

describe("PoolEngineLoad (S-D)", () => {
  it.each([true, false])("shows the eviction warning only when active=%s", (active) => {
    const base = view();
    state.view = {
      ...base,
      members: base.members.map((member) => ({
        ...member,
        engineLoad: engineLoad({
          kvBudget: {
            reportedTokens: 100_000,
            effectiveTokens: 50_000,
            cutFraction: 0.5,
            floorFraction: 0.5,
            lastObservedAt: null,
            expiresAt: null,
            active,
          },
        }),
      })),
    };
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    expect(screen.queryAllByText("dashboard:pools.engineLoad.kvBudgetLowered")).toHaveLength(
      active ? 2 : 0,
    );
    expect(screen.queryAllByText("dashboard:pools.engineLoad.kvBudgetEvictions")).toHaveLength(
      active ? 2 : 0,
    );
    for (const bundle of [enDashboard, esDashboard]) {
      expect(bundle.pools.engineLoad.kvBudgetLowered.length).toBeGreaterThan(0);
      expect(bundle.pools.engineLoad.kvBudgetEvictions).toContain("{{effective}}");
      expect(bundle.pools.engineLoad.kvBudgetEvictions).toContain("{{reported}}");
    }
  });

  it("shows live load, the FULL and stale badges, and the override toggle", async () => {
    state.view = view();
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    expect(screen.getByText("dashboard:pools.engineLoad.states.full_waiting")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.engineLoad.badges.stale")).toBeTruthy();
    const line = screen.getByText(/engineLoad\.running:3/);
    expect(line.textContent).toContain("engineLoad.waiting:2");
    expect(line.textContent).toContain("engineLoad.kv");
    const toggles = screen.getAllByRole("switch");
    expect(toggles).toHaveLength(2);
    // The first member uses engine load (auto): turning it off saves mode off.
    fireEvent.click(toggles[0]!);
    await waitFor(() => expect(state.mutationCalls).toEqual([{ poolMemberId: "m1", mode: "off" }]));
  });

  it("shows observe-only for unenforced custom FULL and the enforce toggle", async () => {
    const base = view();
    state.view = {
      ...base,
      members: [
        {
          ...base.members[0]!,
          engineLoad: engineLoad({
            loadSource: "custom",
            customMode: "observe",
            full: true,
            enforced: false,
            state: "full_kv",
            live: {
              running: 1,
              kvUsage: 1,
              kvOccupancy: 1,
              slotsBusy: null,
              deferred: null,
              waitingStreak: 0,
              ageSeconds: 1,
              stale: false,
              prefixCacheHits: 0,
              prefixCacheQueries: 0,
            },
          }),
        },
      ],
    };
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    expect(screen.getByText("dashboard:pools.engineLoad.observeOnly")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.engineLoad.badges.custom")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.engineLoad.enforceCustom")).toBeTruthy();
    expect(screen.queryByText("dashboard:pools.engineLoad.states.full_kv")).toBeNull();
    const toggles = screen.getAllByRole("switch");
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[1]!);
    await waitFor(() =>
      expect(state.mutationCalls).toEqual([
        { poolMemberId: "m1", mode: "auto", customMode: "enforce" },
      ]),
    );
    for (const bundle of [enDashboard, esDashboard]) {
      expect(bundle.pools.engineLoad.observeOnly.length).toBeGreaterThan(0);
      expect(bundle.pools.engineLoad.enforceCustom.length).toBeGreaterThan(0);
      expect(bundle.pools.engineLoad.badges.custom.length).toBeGreaterThan(0);
    }
  });

  it("labels an off override and an engine without a signal", () => {
    const base = view();
    const members = base.members.map((member, index) => ({
      ...member,
      engineLoad: engineLoad(
        index === 0 ? { mode: "off" } : { hasSignal: false, engineKind: "OLLAMA", state: "none" },
      ),
    }));
    state.view = { ...base, members };
    mount(<PoolMetricRoutingRules poolId="pool-1" />);
    expect(screen.getByText("dashboard:pools.engineLoad.badges.off")).toBeTruthy();
    expect(screen.getByText("dashboard:pools.engineLoad.badges.noSignal")).toBeTruthy();
    expect(screen.queryByText(/states\.full_/)).toBeNull();
  });
});

describe("parseLabelText", () => {
  it("parses key=value lists and rejects anything else", () => {
    expect(parseLabelText("")).toEqual({});
    expect(parseLabelText(" gpu = 0 , fan=1 ")).toEqual({ gpu: "0", fan: "1" });
    expect(parseLabelText("gpu")).toBeNull();
    expect(parseLabelText("gpu=0=1")).toBeNull();
    expect(parseLabelText('gpu="0"')).toBeNull();
    // `__proto__` would be dropped, widening the rule: refuse it like the server.
    expect(parseLabelText("__proto__=x")).toBeNull();
    expect(parseLabelText("gpu=0, __proto__=x")).toBeNull();
    expect(parseLabelText("_proto__=x")).toEqual({ _proto__: "x" });
  });
});
