// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NodeCardSnapshot } from "@ws-model-proxy/api/lib/node-inventory";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as Array<{ name: string; input: unknown }>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      key: () => ["forwarderManagement"],
      setCliDeviceLabels: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (input: unknown) => {
            state.payloads.push({ name: "setCliDeviceLabels", input });
            return { cliDeviceId: "cli-1", labels: (input as { labels: string[] }).labels };
          },
          ...options,
        }),
      },
      setCliDeviceUsableBudgets: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (input: unknown) => {
            state.payloads.push({ name: "setCliDeviceUsableBudgets", input });
            return { cliDeviceId: "cli-1" };
          },
          ...options,
        }),
      },
    },
  },
}));

import { CliDeviceNodeCard } from "./cli-device-node-card";

function node(overrides: Partial<NodeCardSnapshot> = {}): NodeCardSnapshot {
  return {
    kind: "unified",
    unifiedMemory: true,
    memoryTotalGb: 128,
    memoryAvailableGb: 90,
    cpuPercent: 12,
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB10",
        uuid: "GPU-1",
        driverVersion: "580.1",
        vramTotalGb: 128,
        usableVramGb: 127.5,
        usableVramGbDefault: true,
        vramUsedGb: 8,
        temperatureC: 52,
        utilizationPercent: 10,
      },
    ],
    labels: [],
    suggestedLabels: ["dgx-spark", "unified-memory"],
    usableMemoryGb: 126,
    usableRamGb: null,
    usableMemoryGbDefault: true,
    usableRamGbDefault: true,
    warnings: [{ code: "thermal", severity: "warning" }],
    ...overrides,
  };
}

function renderCard(snapshot: NodeCardSnapshot = node()) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <CliDeviceNodeCard cliDeviceId="cli-1" deviceName="desk-01" node={snapshot} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.payloads.length = 0;
});

describe("CliDeviceNodeCard", () => {
  it("shows kind, live memory, suggested labels, budgets, and warnings", () => {
    renderCard();
    expect(screen.getByTestId("cli-device-node-card")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.node.kinds.unified")).toBeTruthy();
    expect(screen.getByText(/dashboard:clis.node.memoryLive/)).toBeTruthy();
    expect(screen.getByText(/dashboard:clis.node.suggestedList/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /dashboard:clis.node.editLabelsFor/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ })).toBeTruthy();
    expect(screen.getByText("dashboard:clis.node.warning.thermal")).toBeTruthy();
    expect(screen.getByText(/dashboard:clis.node.warningsHint/)).toBeTruthy();
  });

  it("shows an abandoned file recovery warning", () => {
    renderCard(
      node({
        warnings: [{ code: "abandoned_recovery", severity: "warning" }],
      }),
    );
    expect(screen.getByText("dashboard:clis.node.warning.abandoned_recovery")).toBeTruthy();
  });

  it("accepts suggested labels on the first node.info", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.acceptSuggested" }));
    expect(state.payloads).toEqual([
      {
        name: "setCliDeviceLabels",
        input: { cliDeviceId: "cli-1", labels: ["dgx-spark", "unified-memory"] },
      },
    ]);
  });
});
