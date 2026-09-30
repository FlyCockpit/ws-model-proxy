// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: 0,
  data: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "name" in options ? `${key}:${String(options.name)}` : key,
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      getCliDeviceMetrics: {
        queryOptions: () => ({
          queryKey: ["deviceMetrics"],
          queryFn: async () => {
            state.calls += 1;
            return state.data;
          },
        }),
      },
    },
  },
}));

import { CliDeviceMetricSources } from "./cli-device-metric-sources";

afterEach(() => {
  cleanup();
  state.calls = 0;
  state.data = null;
});

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CliDeviceMetricSources cliDeviceId="cli-1" />
    </QueryClientProvider>,
  );
}

describe("CliDeviceMetricSources", () => {
  it("loads only when opened and shows local and remote sources with their state", async () => {
    state.data = {
      nodeMetrics: {
        sources: [
          { name: "fans", origin: "local", state: "active", intervalSecs: 10 },
          { name: "power", origin: "remote", state: "pending_approval", intervalSecs: 30 },
          { name: "disk", origin: "local", state: "failing", error: "timeout" },
        ],
      },
      remoteMetricSources: [
        { name: "power", command: "x", intervalSecs: 30, timeoutSecs: 5, format: "number" },
        { name: "later", command: "y", intervalSecs: 30, timeoutSecs: 5, format: "number" },
      ],
      remoteMetricSourcesAllowed: true,
      series: [
        { name: "fan_rpm", labels: { fan: "1" }, value: 1200, origin: "custom", stale: false },
        { name: "node.cpu.usage_percent", labels: {}, value: 3, origin: "builtin", stale: false },
      ],
    };
    mount();
    expect(state.calls).toBe(0);
    fireEvent.click(screen.getByText("dashboard:clis.metricSources.title"));
    await waitFor(() => expect(screen.getByText("fans")).toBeTruthy());
    expect(state.calls).toBe(1);
    expect(screen.getByText("dashboard:clis.metricSources.states.pending_approval")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.metricSources.pendingHint:power")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.metricSources.errors.timeout")).toBeTruthy();
    // A server definition the CLI has not reported yet.
    expect(screen.getByText("later")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.metricSources.notReported")).toBeTruthy();
    // A local source's latest values reach the dashboard; built-ins are not repeated here.
    expect(screen.getByText('fan_rpm{fan="1"}')).toBeTruthy();
    expect(screen.queryByText("node.cpu.usage_percent")).toBeNull();
  });

  it("shows an empty state", async () => {
    state.data = { nodeMetrics: null, remoteMetricSources: [], remoteMetricSourcesAllowed: false };
    mount();
    fireEvent.click(screen.getByText("dashboard:clis.metricSources.title"));
    await waitFor(() =>
      expect(screen.getByText("dashboard:clis.metricSources.empty")).toBeTruthy(),
    );
  });
});
