// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SPEC = {
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  models: [{ id: "Qwen/Qwen3-8B" }],
  launch: {
    management: "process",
    groupSize: 1,
    resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
    labels: [],
    commands: [{ start: "vllm serve x --host 127.0.0.1 --port {{port}}", stop: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 },
    health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
  },
};

const state = vi.hoisted(() => ({
  origin: "SERVER" as "NODE" | "SERVER",
  update: vi.fn(async (_input: unknown) => ({
    version: { version: 3 },
    adoptedLive: [],
    needsRestart: [],
    warnings: [],
  })),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ runtimeId: "rt-1" }),
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function detail(id: string, version: number, spec: unknown, note: string | null) {
  return {
    id,
    version,
    runtimeId: "rt-1",
    createdAt: "2026-10-07T10:00:00.000Z",
    editor: { actor: version === 2 ? "AGENT" : "USER" },
    note,
    launchHash: "a".repeat(64),
    launchChanged: true,
    contentHash: "b".repeat(64),
    spec,
    limits: { concurrencyLimit: { effective: 8, source: version === 2 ? "override" : "engine" } },
    advanced: {},
    compat: {},
  };
}

vi.mock("@/utils/orpc", async () => {
  const { skipToken: skip } = await import("@tanstack/react-query");
  const v1 = detail("v-1", 1, SPEC, null);
  const v2 = detail("v-2", 2, { ...SPEC, models: [{ id: "Qwen/Qwen3-32B" }] }, "Bigger model");
  return {
    orpc: {
      runtimes: {
        key: () => ["runtimes"],
        get: {
          queryOptions: () => ({
            queryKey: ["runtimes", "get", state.origin],
            queryFn: async () => ({
              id: "rt-1",
              kind: "STARTABLE",
              origin: state.origin,
              currentVersion: { id: "v-2" },
              current: { spec: v2.spec },
            }),
          }),
        },
        versions: {
          list: {
            infiniteOptions: () => ({
              queryKey: ["runtimes", "versions"],
              queryFn: async () => ({ items: [v2, v1], nextCursor: null }),
              initialPageParam: undefined,
              getNextPageParam: () => undefined,
            }),
          },
          get: {
            queryOptions: ({ input }: { input: { versionId: string } | symbol }) =>
              typeof input === "symbol"
                ? { queryKey: ["runtimes", "version", "none"], queryFn: skip }
                : {
                    queryKey: ["runtimes", "version", input.versionId],
                    queryFn: async () => (input.versionId === "v-2" ? v2 : v1),
                  },
          },
        },
        update: { mutationOptions: () => ({ mutationFn: state.update }) },
      },
      pools: { key: () => ["pools"] },
      models: { key: () => ["models"] },
    },
  };
});

import { Route } from "./definition";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

// Load the lazy page once, outside any test: a cold import under a parallel
// run can outlast a test's timeout, and a render that lands after that
// test's cleanup would leak into the next test.
beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element as T;
}

afterEach(() => {
  cleanup();
  state.update.mockClear();
});

// Form-heavy renders: slow under a full parallel run.
describe("runtime definition page", { timeout: 20_000 }, () => {
  it("shows a node-origin definition read-only, with no way to save it", async () => {
    state.origin = "NODE";
    mount();
    const spec = (await screen.findByLabelText(
      "dashboard:runtime.form.spec",
    )) as HTMLTextAreaElement;
    expect(spec.readOnly).toBe(true);
    expect(spec.value).toContain('"api": "openai"');
    expect(screen.getByText("dashboard:runtime.nodeOrigin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "dashboard:runtime.saveVersion" })).toBeNull();
    expect(screen.queryByLabelText("dashboard:runtime.form.note")).toBeNull();
    // Nothing to submit: the definition is not inside a form.
    expect(spec.closest("form")).toBeNull();
    expect(spec.getAttribute("aria-describedby")).toBe("definition-node-origin");
    state.origin = "SERVER";
  });

  it("edits the definition in the form and in JSON, and saves the same spec either way", async () => {
    mount();
    const modelId = await waitFor(() => byId<HTMLInputElement>("definition-model-0"));
    expect(modelId.value).toBe("Qwen/Qwen3-32B");
    expect(byId<HTMLTextAreaElement>("definition-command-0-start").value).toContain("vllm serve");
    // Unchanged: saving would apply live.
    expect(screen.getByText("dashboard:runtime.specForm.hintLive")).toBeTruthy();

    fireEvent.change(modelId, { target: { value: "Qwen/Qwen3-14B" } });
    fireEvent.change(byId("definition-command-0-timeout-start"), { target: { value: "1200" } });
    expect(screen.getByText("dashboard:runtime.specForm.hintRestart.STARTABLE")).toBeTruthy();

    // Form → JSON carries the edits.
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.jsonTab" }));
    const json = byId<HTMLTextAreaElement>("definition-json");
    const fromForm = JSON.parse(json.value);
    expect(fromForm.models).toEqual([{ id: "Qwen/Qwen3-14B" }]);
    expect(fromForm.launch.commands[0].timeoutsSec).toEqual({ start: 1200 });

    // JSON → form carries the JSON edits.
    fromForm.launch.commands[0].stop = "pkill vllm";
    fireEvent.change(json, { target: { value: JSON.stringify(fromForm, null, 2) } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.formTab" }));
    const stop = await waitFor(() => byId<HTMLTextAreaElement>("definition-command-0-stop"));
    expect(stop.value).toBe("pkill vllm");
    expect(byId<HTMLInputElement>("definition-command-0-timeout-start").value).toBe("1200");

    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.saveVersion" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0]).toMatchObject({
      runtimeId: "rt-1",
      spec: fromForm,
      restartRunning: false,
    });
  });

  it("keeps invalid JSON on the JSON tab and shows the schema issue at its input", async () => {
    mount();
    await waitFor(() => byId("definition-model-0"));
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.jsonTab" }));
    fireEvent.change(byId("definition-json"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.formTab" }));
    expect(screen.getByText("dashboard:runtime.specForm.fixJsonFirst")).toBeTruthy();
    expect(byId("definition-json")).toBeTruthy();

    fireEvent.change(byId("definition-json"), { target: { value: JSON.stringify(SPEC) } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.formTab" }));
    const start = await waitFor(() => byId<HTMLTextAreaElement>("definition-command-0-start"));
    fireEvent.change(start, { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.saveVersion" }));
    await waitFor(() => expect(screen.getByText("Command must not be blank.")).toBeTruthy());
    expect(state.update).not.toHaveBeenCalled();
  });

  it("marks agent-written versions and diffs a version against the one before", async () => {
    mount();
    const v2 = (await screen.findByText("v2")).closest("li");
    if (!v2) throw new Error("no v2 row");
    expect(within(v2).getByText("dashboard:runtime.history.agentWritten")).toBeTruthy();
    expect(within(v2).getByText("Bigger model")).toBeTruthy();
    expect(within(v2).getByText("dashboard:runtime.needsRestartBadge")).toBeTruthy();
    fireEvent.click(
      within(v2).getByRole("button", { name: "dashboard:runtime.history.showChanges" }),
    );
    const diff = await within(v2).findByRole("group", {
      name: "dashboard:runtime.history.diffLabel",
    });
    const removed = [...diff.querySelectorAll('[data-diff="remove"]')].map(
      (row) => row.textContent,
    );
    const added = [...diff.querySelectorAll('[data-diff="add"]')].map((row) => row.textContent);
    expect(removed.some((text) => text?.includes('"id": "Qwen/Qwen3-8B"'))).toBe(true);
    expect(added.some((text) => text?.includes('"id": "Qwen/Qwen3-32B"'))).toBe(true);
    // The limit override v2 set shows up too.
    expect(added.some((text) => text?.includes('"concurrencyLimit": 8'))).toBe(true);
  });
});
