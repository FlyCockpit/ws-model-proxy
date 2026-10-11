// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** New runtime: a preset, then "already running" (always-on) or "startable". */

const state = vi.hoisted(() => ({
  create: vi.fn(async (_input: unknown) => ({
    runtime: { id: "rt-new" },
    warnings: [],
  })),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    useNavigate: () => state.navigate,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/components/page-stub", () => ({ PageHeading: () => null }));

const HEALTH = { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 };

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      presets: {
        list: {
          queryOptions: () => ({
            queryKey: ["runtimes", "presets"],
            queryFn: async () => ({
              presets: [
                // The real built-in presets that are not stubbed below.
                ...(
                  await import("@ws-model-proxy/api/lib/runtime-presets")
                ).RUNTIME_PRESET_LIST.filter(
                  (preset) => preset.id !== "vllm" && preset.id !== "systemd_unit",
                ),
                {
                  id: "vllm",
                  kind: "STARTABLE",
                  fill: [],
                  spec: {
                    api: "openai",
                    engine: "vllm",
                    modelType: "llm",
                    models: [{ id: "Qwen/Qwen3-8B" }],
                    launch: {
                      management: "process",
                      groupSize: 1,
                      resources: [{ kind: "discrete", gpuCount: 1, vramGb: 24 }],
                      labels: [],
                      commands: [{ start: "vllm serve x --host 127.0.0.1", stop: "true" }],
                      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 900_000 },
                      health: HEALTH,
                    },
                  },
                },
                {
                  id: "systemd_unit",
                  kind: "STARTABLE",
                  fill: [],
                  spec: {
                    launch: {
                      management: "service",
                      groupSize: 1,
                      resources: [{ kind: "none" }],
                      labels: [],
                      commands: [{ start: "a", stop: "b", status: "c" }],
                      health: HEALTH,
                    },
                  },
                },
              ],
            }),
          }),
        },
      },
      create: { mutationOptions: () => ({ mutationFn: state.create }) },
    },
    nodes: {
      list: {
        queryOptions: () => ({
          queryKey: ["nodes"],
          queryFn: async () => ({ nodes: [{ id: "node-1", slug: "gpu-box", name: "GPU box" }] }),
        }),
      },
    },
  },
}));

import { Route } from "./new";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

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

function radio(kind: "ALWAYS_ON" | "STARTABLE") {
  return screen.getByRole("radio", {
    name: new RegExp(`dashboard:runtime\\.kindChoice\\.${kind}\\.title`),
  }) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  state.create.mockClear();
});

// Form-heavy renders: slow under a full parallel run.
describe("new runtime", { timeout: 20_000 }, () => {
  it("adds a server you already run as always-on: a node and an address, no launch", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    expect(radio("STARTABLE").checked).toBe(true);
    expect(screen.queryByLabelText("dashboard:runtime.form.node")).toBeNull();
    expect(document.getElementById("runtime-spec-command-0-start")).not.toBeNull();

    fireEvent.click(radio("ALWAYS_ON"));
    expect(radio("ALWAYS_ON").checked).toBe(true);
    // The launch gives way to the address the server listens on.
    expect(document.getElementById("runtime-spec-command-0-start")).toBeNull();
    const baseUrl = document.getElementById("runtime-spec-base-url") as HTMLInputElement;
    expect(baseUrl.value).toBe("http://127.0.0.1:8000/v1");

    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "My vLLM" },
    });
    const node = (await screen.findByLabelText("dashboard:runtime.form.node")) as HTMLSelectElement;
    await waitFor(() => expect(node.options.length).toBe(2));
    fireEvent.change(node, { target: { value: "node-1" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));

    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toEqual({
      slug: "my-vllm",
      name: "My vLLM",
      kind: "ALWAYS_ON",
      preset: "vllm",
      nodeId: "node-1",
      spec: {
        api: "openai",
        engine: "vllm",
        modelType: "llm",
        models: [{ id: "Qwen/Qwen3-8B" }],
        address: { baseUrl: "http://127.0.0.1:8000/v1" },
      },
    });
  });

  it("needs a node for an always-on runtime", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    fireEvent.click(radio("ALWAYS_ON"));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    expect(await screen.findByText("dashboard:runtime.form.nodeRequired")).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("offers every built-in preset", async () => {
    mount();
    const { RUNTIME_PRESET_LIST } = await import("@ws-model-proxy/api/lib/runtime-presets");
    for (const { id } of RUNTIME_PRESET_LIST)
      expect(
        await screen.findByRole("button", { name: new RegExp(`presets\\.${id}\\.title`) }),
      ).toBeTruthy();
  });

  it("creates speech-to-text from its preset with the transcription profile kept", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /presets\.vllm_transcription\.title/ }),
    );
    expect(radio("STARTABLE").checked).toBe(true);
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Whisper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    const { RUNTIME_PRESET_LIST } = await import("@ws-model-proxy/api/lib/runtime-presets");
    const preset = RUNTIME_PRESET_LIST.find((entry) => entry.id === "vllm_transcription");
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      kind: "STARTABLE",
      preset: "vllm_transcription",
      spec: { modelType: "transcription", models: preset?.spec.models },
    });
  });

  it("keeps a Docker Compose project startable only", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.docker_compose\.title/ }));
    expect(radio("ALWAYS_ON").disabled).toBe(true);
    expect(radio("STARTABLE").checked).toBe(true);
  });

  it("keeps a service startable only", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.systemd_unit\.title/ }));
    expect(radio("ALWAYS_ON").disabled).toBe(true);
    expect(radio("STARTABLE").checked).toBe(true);
    expect(screen.getByText("dashboard:runtime.kindChoice.serviceStartable")).toBeTruthy();
  });
});
