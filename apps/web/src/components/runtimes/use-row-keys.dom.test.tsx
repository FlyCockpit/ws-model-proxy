// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeSpec } from "@ws-model-proxy/api/lib/runtime-spec";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
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

import { useAppForm } from "@/hooks/use-app-form";
import { editorValues, readSpecEditor, type SpecReading } from "@/lib/runtime-spec-draft";

import { MetricsReaderCard } from "./metrics-reader-card";
import { RuntimeSpecFields } from "./runtime-spec-fields";
import { removeRowKey, rowKeyAt } from "./use-row-keys";

afterEach(() => {
  cleanup();
  state.update.mockClear();
});

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return element;
}

describe("row keys", () => {
  it("keeps every other row's key when a row is removed, and never reuses one", () => {
    let keys = { kept: [] as string[], next: 0 };
    const all = (length: number) => Array.from({ length }, (_, at) => rowKeyAt(keys, "r", at));
    expect(all(3)).toEqual(["r0", "r1", "r2"]);
    keys = removeRowKey(keys, "r", 3, 1);
    expect(all(2)).toEqual(["r0", "r2"]);
    // A row added at the end gets a fresh key.
    expect(all(3)).toEqual(["r0", "r2", "r3"]);
    keys = removeRowKey(keys, "r", 3, 0);
    expect(all(3)).toEqual(["r2", "r3", "r4"]);
  });
});

const SERVING_SPEC = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }],
  launch: {
    management: "service",
    groupSize: 1,
    resources: [{ kind: "unified", memoryGb: 100 }],
    labels: ["ds-head"],
    reservations: [
      { labels: ["w-a"], resources: { kind: "unified", memoryGb: 1 } },
      { labels: ["w-b"], resources: { kind: "unified", memoryGb: 2 } },
      { labels: ["w-c"], resources: { kind: "unified", memoryGb: 3 } },
    ],
    commands: [{ start: "up", stop: "down", status: "check" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

function SpecHost({ onRead }: { onRead: (reading: SpecReading) => void }) {
  const form = useAppForm({ defaultValues: { spec: editorValues(SERVING_SPEC, "STARTABLE") } });
  return (
    <>
      <RuntimeSpecFields form={form} fields="spec" kind="STARTABLE" idPrefix="t" />
      <button
        type="button"
        onClick={() =>
          onRead(
            readSpecEditor(form.getFieldValue("spec"), "STARTABLE", {
              notJson: "not json",
              wrongKind: "wrong kind",
            }),
          )
        }
      >
        read
      </button>
    </>
  );
}

describe("RuntimeSpecFields row removal", { timeout: 20_000 }, () => {
  it("removing a middle model keeps the rows below on their own elements and focus", () => {
    const onRead = vi.fn<(reading: SpecReading) => void>();
    render(<SpecHost onRead={onRead} />);
    const third = input("t-model-2");
    expect(third.value).toBe("model-c");
    third.focus();
    fireEvent.click(
      screen.getAllByRole("button", { name: "dashboard:runtime.specForm.removeModel" })[1],
    );
    expect(input("t-model-0").value).toBe("model-a");
    // The third row's own input is now the second row: same element, still focused.
    expect(input("t-model-1")).toBe(third);
    expect(third.value).toBe("model-c");
    expect(document.activeElement).toBe(third);
    expect(document.getElementById("t-model-2")).toBeNull();
    fireEvent.change(third, { target: { value: "model-c2" } });
    fireEvent.click(screen.getByRole("button", { name: "read" }));
    const reading = onRead.mock.calls[0]?.[0];
    expect(reading?.ok).toBe(true);
    if (!reading?.ok) return;
    // Nothing but the rows' own fields reaches the definition.
    expect(reading.spec.models).toEqual([{ id: "model-a" }, { id: "model-c2" }]);
  });

  it("removing a middle reservation keeps the others' values", () => {
    const onRead = vi.fn<(reading: SpecReading) => void>();
    render(<SpecHost onRead={onRead} />);
    const third = input("t-reservation-2-labels");
    third.focus();
    fireEvent.click(
      screen.getAllByRole("button", { name: "dashboard:runtime.specForm.removeReservation" })[1],
    );
    expect(input("t-reservation-1-labels")).toBe(third);
    expect(document.activeElement).toBe(third);
    fireEvent.click(screen.getByRole("button", { name: "read" }));
    const reading = onRead.mock.calls[0]?.[0];
    if (!reading?.ok) throw new Error("spec did not read");
    expect(reading.spec.launch?.reservations).toEqual([
      { labels: ["w-a"], resources: { kind: "unified", memoryGb: 1 } },
      { labels: ["w-c"], resources: { kind: "unified", memoryGb: 3 } },
    ]);
  });
});

const READER_SPEC: RuntimeSpec = {
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

describe("metrics reader row removal", { timeout: 20_000 }, () => {
  it("removing a middle signal keeps the rows below and saves only their fields", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MetricsReaderCard runtimeId="rt-1" spec={READER_SPEC} readOnly={false} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("dashboard:runtime.reader.preset"), {
      target: { value: "sglang" },
    });
    const third = input("reader-map-2-series");
    expect(third.value).toBe("sglang:token_usage");
    third.focus();
    fireEvent.click(
      screen.getAllByRole("button", { name: "dashboard:runtime.reader.removeSignal" })[1],
    );
    expect(input("reader-map-1-series")).toBe(third);
    expect(third.value).toBe("sglang:token_usage");
    expect(document.activeElement).toBe(third);
    expect(input("reader-map-0-series").value).toBe("sglang:num_running_reqs");
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.reader.save" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0].spec.metricsReader).toEqual({
      kind: "route",
      route: "/metrics",
      format: "prometheus",
      map: {
        running: { series: "sglang:num_running_reqs", aggregate: "sum" },
        kvUsage: { series: "sglang:token_usage", aggregate: "max" },
      },
    });
  });
});
