// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildNodeCardSnapshot,
  type NodeCardSnapshot,
  nodeUsableBudgetsInputSchema,
} from "@ws-model-proxy/api/lib/node-inventory";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as Array<{ name: string; input: unknown }>,
  budgetError: null as unknown,
  labelError: null as unknown,
  language: "en-US",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
    i18n: { language: state.language },
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
            if (state.labelError) throw state.labelError;
            return { cliDeviceId: "cli-1", labels: (input as { labels: string[] }).labels };
          },
          ...options,
        }),
      },
      setCliDeviceUsableBudgets: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (input: unknown) => {
            state.payloads.push({ name: "setCliDeviceUsableBudgets", input });
            if (state.budgetError) throw state.budgetError;
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
  state.budgetError = null;
  state.labelError = null;
  state.language = "en-US";
});

describe("CliDeviceNodeCard", () => {
  it.each(["__proto__", "constructor", "toString", "GPU-aaa", "index:0"])(
    "submits numeric GPU budget for accepted key %s and restores its default",
    async (key) => {
      const user = userEvent.setup();
      renderCard(
        buildNodeCardSnapshot({
          nodeInfo: {
            nodeKind: "discrete",
            memoryTotalMiB: 32768,
            gpus: [
              {
                index: 0,
                name: "test-gpu",
                ...(key === "index:0" ? {} : { uuid: key }),
                vramTotalMiB: 8192,
              },
            ],
          },
          nodeMetrics: null,
          labels: [],
          usableVramGb: Object.fromEntries([[key, 6.25]]),
        }),
      );
      await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
      const vram = await screen.findByLabelText(/dashboard:clis.node.usableVramForGpu/);
      expect((vram as HTMLInputElement).value).toBe("6.25");
      await user.clear(vram);
      await user.type(vram, "7.5");
      await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
      await waitFor(() => expect(state.payloads).toHaveLength(1));
      const payload = JSON.parse(JSON.stringify(state.payloads[0]?.input));
      expect(payload.usableVramGb).toEqual(Object.fromEntries([[key, 7.5]]));
      expect(Object.hasOwn(payload.usableVramGb, key)).toBe(true);
      expect(payload.usableVramGb[key]).toBe(7.5);
      expect(
        nodeUsableBudgetsInputSchema.parse({ usableVramGb: payload.usableVramGb }).usableVramGb?.[
          key
        ],
      ).toBe(7.5);
      await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
      const reopened = await screen.findByLabelText(/dashboard:clis.node.usableVramForGpu/);
      await user.clear(reopened);
      await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
      await waitFor(() => expect(state.payloads).toHaveLength(2));
      expect(state.payloads[1]?.input).toMatchObject({ usableVramGb: null });
    },
  );
  it("keeps an uncommitted label draft after a failed save", async () => {
    state.labelError = new Error("rejected");
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editLabelsFor/ }));
    const input = await screen.findByLabelText("dashboard:clis.node.labels");
    await user.type(input, "new-label");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveLabels" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((input as HTMLInputElement).value).toBe("new-label");
  });

  it("uses the exact hardware bound and connects validation errors to the input", async () => {
    const user = userEvent.setup();
    renderCard(node({ memoryTotalGb: 23.988 }));
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const input = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(input);
    await user.type(input, "24");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText(/budgetExceedsTotal.*23\.988/)).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("23.988");
  });

  it("does not silently turn an API-written positive micro-budget into zero", async () => {
    const user = userEvent.setup();
    renderCard(node({ usableMemoryGb: 1e-25, usableMemoryGbDefault: false }));
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const input = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    expect(Number((input as HTMLInputElement).value)).toBe(1e-25);
    expect((input as HTMLInputElement).value).not.toContain("e");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    await waitFor(() => expect(state.payloads[0]?.input).toMatchObject({ usableMemoryGb: 1e-25 }));
  });
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

  it("does not flag a leading decimal point while typing, and accepts .5", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(memory);
    await user.type(memory, ".");
    expect(screen.queryByText("dashboard:clis.node.invalidBudget")).toBeNull();
    await user.type(memory, "5");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    await waitFor(() => expect(state.payloads).toHaveLength(1));
    expect(state.payloads[0]?.input).toMatchObject({ usableMemoryGb: 0.5 });
  });

  it("rejects grouping-shaped budget input and amounts above the snapshot total", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(memory);
    await user.type(memory, "1,500");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText("dashboard:clis.node.invalidBudget")).toBeTruthy();
    expect(state.payloads).toEqual([]);

    await user.clear(memory);
    await user.type(memory, "200");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText(/dashboard:clis.node.budgetExceedsTotal/)).toBeTruthy();
    expect(state.payloads).toEqual([]);
  });

  it("maps a hardware-exceeded server field onto the form without the English message", async () => {
    state.budgetError = {
      code: "BAD_REQUEST",
      message: "Usable memory cannot exceed the physical total.",
      data: { fields: ["usableMemoryGb"] },
    };
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(memory);
    await user.type(memory, "10");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText(/dashboard:clis.node.budgetExceedsTotal/)).toBeTruthy();
    await waitFor(() => expect(state.payloads).toHaveLength(1));
    expect(screen.queryByText(/cannot exceed the physical total/i)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("formats a tiny stored budget without scientific notation", async () => {
    const user = userEvent.setup();
    renderCard(
      node({
        usableMemoryGb: 1e-7,
        usableMemoryGbDefault: false,
      }),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    expect((memory as HTMLInputElement).value).toBe("0.0000001");
    expect((memory as HTMLInputElement).value).not.toMatch(/e/i);
  });

  it("rejects a comma decimal budget in en-US", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(memory);
    await user.type(memory, "1,5");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText("dashboard:clis.node.invalidBudget")).toBeTruthy();
    expect(state.payloads).toEqual([]);
  });

  it("renders the es-MX budget form with a dot decimal: 1.5 is saved and 1,5 is rejected", async () => {
    state.language = "es-MX";
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    expect(memory.getAttribute("inputmode")).toBe("decimal");
    await user.clear(memory);
    await user.type(memory, "1,5");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText("dashboard:clis.node.invalidBudget")).toBeTruthy();
    expect(state.payloads).toEqual([]);

    await user.clear(memory);
    await user.type(memory, "1.5");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    await waitFor(() => expect(state.payloads).toHaveLength(1));
    expect(state.payloads[0]?.input).toMatchObject({ usableMemoryGb: 1.5 });
  });

  it("maps a keyed per-GPU server field onto only that GPU's input", async () => {
    state.budgetError = {
      code: "BAD_REQUEST",
      message: "Usable VRAM cannot exceed the physical total.",
      data: { fields: ["usableVramGb.GPU-B"] },
    };
    const gpu = (index: number, name: string, uuid: string, vramTotalGb: number) => ({
      index,
      name,
      uuid,
      driverVersion: "580.1",
      vramTotalGb,
      usableVramGb: null,
      usableVramGbDefault: true,
      vramUsedGb: 1,
      temperatureC: 40,
      utilizationPercent: 0,
    });
    const user = userEvent.setup();
    renderCard(
      node({
        kind: "discrete",
        unifiedMemory: false,
        memoryTotalGb: 64,
        usableMemoryGb: null,
        gpus: [gpu(0, "card-a", "GPU-A", 24), gpu(1, "card-b", "GPU-B", 48)],
      }),
    );
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const first = await screen.findByLabelText(/usableVramForGpu.*card-a/);
    const second = screen.getByLabelText(/usableVramForGpu.*card-b/);
    await user.type(second, "10");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    await waitFor(() => expect(state.payloads).toHaveLength(1));
    await waitFor(() => expect(second.getAttribute("aria-invalid")).toBe("true"));
    expect(
      document.getElementById(second.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/budgetExceedsTotal.*"48"/);
    expect(first.getAttribute("aria-invalid")).toBe("false");
    expect(first.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(/cannot exceed the physical total/i)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("uses the unknown-total copy when the server rejects a budget whose total is unknown", async () => {
    state.budgetError = {
      code: "BAD_REQUEST",
      message: "Usable memory cannot exceed the physical total.",
      data: { fields: ["usableMemoryGb"] },
    };
    const user = userEvent.setup();
    renderCard(node({ memoryTotalGb: null }));
    await user.click(screen.getByRole("button", { name: /dashboard:clis.node.editBudgetsFor/ }));
    const memory = await screen.findByLabelText("dashboard:clis.node.usableMemory");
    await user.clear(memory);
    await user.type(memory, "10");
    await user.click(screen.getByRole("button", { name: "dashboard:clis.node.saveBudgets" }));
    expect(await screen.findByText("dashboard:clis.node.budgetExceedsUnknownTotal")).toBeTruthy();
    expect(screen.queryByText(/budgetExceedsTotal/)).toBeNull();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(memory.getAttribute("aria-invalid")).toBe("true");
  });
});
