// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeSpec } from "@ws-model-proxy/api/lib/runtime-spec";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      update: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            state.update(input);
            return { version: { version: 2 }, adoptedLive: [], needsRestart: [] };
          },
        }),
      },
    },
  },
}));

import { MetricsReaderCard } from "./metrics-reader-card";

const SPEC: RuntimeSpec = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "m" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 8 }],
    labels: [],
    commands: [{ start: "serve", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
  metricsReader: { kind: "builtin" },
};

function mount(readOnly = false) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MetricsReaderCard runtimeId="rt-1" spec={SPEC} readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.update.mockClear();
});

// Form-heavy renders: slow under a full parallel run.
describe("metrics reader form", { timeout: 20_000 }, () => {
  it("fills the form from a preset and saves it into the definition", async () => {
    mount();
    const kind = screen.getByLabelText("dashboard:runtime.reader.kind") as HTMLSelectElement;
    expect(kind.value).toBe("builtin");
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.preset"), {
      target: { value: "sglang" },
    });
    expect(kind.value).toBe("route");
    expect(
      (screen.getByLabelText("dashboard:runtime.reader.route") as HTMLInputElement).value,
    ).toBe("/metrics");
    const series = document.getElementById("reader-map-0-series") as HTMLInputElement;
    expect(series.value).toBe("sglang:num_running_reqs");
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.interval"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.reader.save" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toEqual({
      runtimeId: "rt-1",
      note: "dashboard:runtime.reader.note",
      spec: {
        ...SPEC,
        metricsReader: {
          kind: "route",
          route: "/metrics",
          format: "prometheus",
          intervalSecs: 5,
          map: {
            running: { series: "sglang:num_running_reqs", aggregate: "sum" },
            waiting: { series: "sglang:num_queue_reqs", aggregate: "sum" },
            kvUsage: { series: "sglang:token_usage", aggregate: "max" },
          },
        },
      },
    });
  });

  it("refuses a signal read twice and a bad route, at their inputs", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.preset"), {
      target: { value: "vllm" },
    });
    fireEvent.change(document.getElementById("reader-map-1-signal") as HTMLSelectElement, {
      target: { value: "running" },
    });
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.route"), {
      target: { value: "metrics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.reader.save" }));
    expect(await screen.findByText("dashboard:runtime.reader.duplicate")).toBeTruthy();
    expect(screen.getByText(/A route must start with a single \//)).toBeTruthy();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("removes the reader with None", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.kind"), {
      target: { value: "none" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.reader.save" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    const { metricsReader: _reader, ...rest } = SPEC;
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({ spec: rest });
    expect(state.update.mock.calls[0]?.[0].spec.metricsReader).toBeUndefined();
  });

  it("shows a node-origin reader without a way to save it", () => {
    mount(true);
    expect(screen.queryByRole("button", { name: "dashboard:runtime.reader.save" })).toBeNull();
    expect(screen.getByText("dashboard:runtime.reader.readOnly")).toBeTruthy();
  });
});
