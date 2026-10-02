// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";
import esDashboard from "../locales/es-MX/dashboard.json";

const state = vi.hoisted(() => ({
  calls: 0,
  data: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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

import { CliDeviceEngineAdapters } from "./cli-device-engine-adapters";

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
      <CliDeviceEngineAdapters cliDeviceId="cli-1" />
    </QueryClientProvider>,
  );
}

describe("CliDeviceEngineAdapters", () => {
  it("loads only when opened and shows route/command state without command text", async () => {
    state.data = {
      nodeMetrics: {
        engineAdapters: [
          { endpointSlug: "gpu", input: "route", state: "active" },
          {
            endpointSlug: "other",
            input: "command",
            state: "failing",
            error: "out_of_range",
            command: "curl http://127.0.0.1/secret",
            output: "raw adapter stdout",
          },
        ],
      },
    };
    mount();
    expect(state.calls).toBe(0);
    fireEvent.click(screen.getByText("dashboard:clis.engineAdapters.title"));
    await waitFor(() => expect(screen.getByText("gpu")).toBeTruthy());
    expect(state.calls).toBe(1);
    expect(screen.getByText("dashboard:clis.engineAdapters.inputs.route")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.inputs.command")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.states.active")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.states.failing")).toBeTruthy();
    expect(screen.queryByText("dashboard:clis.engineAdapters.states.pending_approval")).toBeNull();
    expect(screen.getByText("dashboard:clis.engineAdapters.errors.out_of_range")).toBeTruthy();
    expect(screen.queryByText("curl http://127.0.0.1/secret")).toBeNull();
    expect(screen.queryByText("raw adapter stdout")).toBeNull();
    expect(screen.getByText("dashboard:clis.engineAdapters.hint")).toBeTruthy();
    for (const bundle of [enDashboard, esDashboard]) {
      expect(bundle.clis.engineAdapters.title.length).toBeGreaterThan(0);
      expect(bundle.clis.engineAdapters.hint).toContain("wsmp endpoints adapter");
      expect(bundle.clis.engineAdapters.errors.out_of_range.length).toBeGreaterThan(0);
      expect(bundle.clis.engineAdapters.errors.unmapped.length).toBeGreaterThan(0);
      expect(bundle.clis.engineAdapters.states.pending_approval.length).toBeGreaterThan(0);
      expect(bundle.clis.engineAdapters.states.refused.length).toBeGreaterThan(0);
      expect(bundle.clis.engineAdapters.pendingHint).toContain("wsmp endpoints adapter approve");
      expect(bundle.clis.engineAdapters.refusedHint).toContain("allowRemoteEngineAdapters");
    }
  });

  it("shows pending_approval and refused without command text", async () => {
    state.data = {
      nodeMetrics: {
        engineAdapters: [
          { endpointSlug: "gpu", input: "command", state: "pending_approval" },
          { endpointSlug: "other", input: "route", state: "refused" },
        ],
      },
    };
    mount();
    fireEvent.click(screen.getByText("dashboard:clis.engineAdapters.title"));
    await waitFor(() => expect(screen.getByText("gpu")).toBeTruthy());
    expect(screen.getByText("dashboard:clis.engineAdapters.states.pending_approval")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.states.refused")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.pendingHint")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.engineAdapters.refusedHint")).toBeTruthy();
  });

  it("shows an empty state", async () => {
    state.data = { nodeMetrics: { engineAdapters: [] } };
    mount();
    fireEvent.click(screen.getByText("dashboard:clis.engineAdapters.title"));
    await waitFor(() =>
      expect(screen.getByText("dashboard:clis.engineAdapters.empty")).toBeTruthy(),
    );
  });
});
