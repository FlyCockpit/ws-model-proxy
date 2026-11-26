// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
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
    Link: ({ children, className }: { children: ReactNode; className?: string }) => (
      <a href="/en-US/runtimes" className={className}>
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

vi.mock("@ws-model-proxy/ui/lib/toast", () => ({
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

import { pickSelectOption } from "@/lib/pick-select-option";

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
    // The node picker lists node names, never raw ids.
    await waitFor(() =>
      expect(screen.getByLabelText("dashboard:runtime.form.node").textContent).toContain(
        "dashboard:runtime.form.pickNode",
      ),
    );
    await pickSelectOption(screen.getByLabelText("dashboard:runtime.form.node"), "GPU box");
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

function input(id: string) {
  const element = document.getElementById(`runtime-spec-${id}`);
  if (!element) throw new Error(`no input runtime-spec-${id}`);
  return element as HTMLInputElement;
}

describe("new runtime: the quick path first", { timeout: 20_000 }, () => {
  it("shows only the preset's essentials; everything else is in collapsed sections", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    for (const id of ["model-0", "command-0-start", "resource-0-kind", "resource-0-gpus"])
      expect(input(id).closest("details")).toBeNull();
    expect(document.getElementById("runtime-name")?.closest("details")).toBeNull();
    for (const id of [
      "api",
      "engine",
      "management",
      "group-size",
      "command-0-stop",
      "readiness-path",
    ])
      expect(input(id).closest("details")?.open).toBe(false);
    expect(document.getElementById("runtime-slug")?.closest("details")?.open).toBe(false);
    expect(radio("STARTABLE").closest("details")?.open).toBe(false);
    for (const details of document.querySelectorAll("details"))
      expect(details.querySelector("summary")?.textContent?.trim()).not.toBe("");
  });

  it("puts a service's stop and status commands up front", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.systemd_unit\.title/ }));
    for (const id of ["command-0-start", "command-0-stop", "command-0-status"])
      expect(input(id).closest("details")).toBeNull();
    // A service has no model or size to decide.
    expect(document.getElementById("runtime-spec-model-0")).toBeNull();
    expect(input("resource-0-kind").closest("details")?.open).toBe(false);
  });

  it("names the preset's fields in words and focuses each on click", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.sglang\.title/ }));
    expect(document.body.textContent).not.toMatch(/models\[0\]|launch\./);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.modelId" }));
    expect(document.activeElement).toBe(input("model-0"));
    fireEvent.click(
      screen.getByRole("button", { name: "dashboard:runtime.specForm.fillCommand.start" }),
    );
    expect(document.activeElement).toBe(input("command-0-start"));
    fireEvent.click(
      screen.getByRole("button", { name: "dashboard:runtime.specForm.sections.size" }),
    );
    expect(document.activeElement).toBe(input("resource-0-kind"));
  });

  it("opens the section of the first invalid field and focuses it after a failed create", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Qwen" },
    });
    const groupSize = input("group-size");
    const section = groupSize.closest("details");
    expect(section?.open).toBe(false);
    fireEvent.change(groupSize, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(document.activeElement).toBe(groupSize));
    expect(section?.open).toBe(true);
    expect(groupSize.getAttribute("aria-invalid")).toBe("true");
    const errorId = groupSize.getAttribute("aria-describedby")?.split(" ").at(-1) ?? "";
    expect(document.getElementById(errorId)?.textContent).not.toBe("");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("shows readiness and health durations in seconds and saves milliseconds", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    const timeout = input("readiness-timeout");
    expect(timeout.value).toBe("900");
    expect(input("health-intervalMs").value).toBe("15");
    fireEvent.change(timeout, { target: { value: "1." } });
    // The trailing point stays while typing.
    expect(timeout.value).toBe("1.");
    fireEvent.change(timeout, { target: { value: "1.5" } });
    expect(timeout.value).toBe("1.5");
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Qwen" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      spec: {
        launch: {
          readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 1500 },
          health: HEALTH,
        },
      },
    });
  });

  it("edits the embeddings preset's contract in the form", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm_embeddings\.title/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "dashboard:runtime.specForm.fillEmbedding" }),
    );
    const revision = input("model-0-embedding-revision");
    expect(document.activeElement).toBe(revision);
    expect(revision.value).toBe("main");
    fireEvent.change(revision, { target: { value: "abc123" } });
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Embed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    const { RUNTIME_PRESET_LIST } = await import("@ws-model-proxy/api/lib/runtime-presets");
    const preset = RUNTIME_PRESET_LIST.find((entry) => entry.id === "vllm_embeddings");
    const [model] = preset?.spec.models ?? [];
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      spec: {
        models: [
          { ...model, embeddingContract: { ...model?.embeddingContract, revision: "abc123" } },
        ],
      },
    });
  });
  it("keeps the start command on the model the person typed", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.sglang\.title/ }));
    const model = input("model-0");
    const start = input("command-0-start");
    expect(model.value).toBe("Qwen/Qwen3-8B");
    expect(start.value).toContain("Qwen/Qwen3-8B");
    fireEvent.change(model, { target: { value: "Qwen/Qwen3-32B" } });
    expect(start.value).toContain("Qwen/Qwen3-32B");
    expect(start.value).not.toContain("Qwen/Qwen3-8B");
    // Cleared, then typed anew: still followed.
    fireEvent.change(model, { target: { value: "" } });
    fireEvent.change(model, { target: { value: "org/other-model" } });
    expect(start.value).toContain("org/other-model");
    expect(start.value).not.toContain("Qwen3");
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({
      spec: {
        models: [{ id: "org/other-model" }],
        launch: { commands: [{ start: expect.stringContaining("--model-path org/other-model") }] },
      },
    });
  });
  it("focuses the readiness box, opening its section, when a model server has none", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Qwen" },
    });
    const box = screen.getByRole("checkbox", {
      name: "dashboard:runtime.specForm.readinessEnabled",
    });
    const section = box.closest("details") as HTMLDetailsElement;
    section.open = true;
    fireEvent.click(box);
    section.open = false;
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(section.open).toBe(true);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(state.create).not.toHaveBeenCalled();
  });
  it("shows the command list's own error when a per-node split no longer fits the group", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Qwen" },
    });
    fireEvent.change(input("group-size"), { target: { value: "2" } });
    // Size first, then commands (the test's t() drops the "what" option).
    const [, splitCommands] = await screen.findAllByRole("button", {
      name: "dashboard:runtime.specForm.perRankOf",
    });
    fireEvent.click(splitCommands as HTMLElement);
    fireEvent.change(input("group-size"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() =>
      expect(document.getElementById("runtime-spec-commands-error")).toBeTruthy(),
    );
    const error = document.getElementById("runtime-spec-commands-error");
    expect(error?.textContent).not.toBe("");
    // Nothing else is marked invalid, so focus lands on the list's error itself.
    expect(document.activeElement).toBe(error);
    expect(state.create).not.toHaveBeenCalled();
  });
  it("renames one model in the commands without capturing another model's mentions", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.sglang\.title/ }));
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.specForm.addModel" }));
    fireEvent.change(input("model-1"), { target: { value: "extra" } });
    const start = input("command-0-start");
    fireEvent.change(start, { target: { value: "serve --served-model-name Qwen/Qwen3-8B extra" } });
    const first = input("model-0");
    // Typed one key at a time: "extra" in between equals the second model's ID.
    for (const value of ["e", "ex", "extra", "extra2"])
      fireEvent.change(first, { target: { value } });
    expect(start.value).toBe("serve --served-model-name extra2 extra");
    // A command edited by hand is never overwritten by a later rename.
    fireEvent.blur(first);
    fireEvent.change(start, { target: { value: "serve my-own-thing" } });
    fireEvent.change(first, { target: { value: "other" } });
    expect(start.value).toBe("serve my-own-thing");
  });
  it("leaves an embedding contract edited by hand alone when the model ID is filled in later", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm_embeddings\.title/ }));
    const id = input("model-0");
    fireEvent.change(id, { target: { value: "" } });
    fireEvent.blur(id);
    const contractModel = input("model-0-embedding-model");
    fireEvent.change(contractModel, { target: { value: "my-own/embedder" } });
    fireEvent.change(id, { target: { value: "BAAI/bge-m3" } });
    expect(contractModel.value).toBe("my-own/embedder");
  });
  it("opens the note's section and focuses it when the note is too long", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /presets\.vllm\.title/ }));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.form.name"), {
      target: { value: "Qwen" },
    });
    const note = document.getElementById("runtime-note") as HTMLInputElement;
    expect(note.maxLength).toBe(500);
    const section = note.closest("details") as HTMLDetailsElement;
    fireEvent.change(note, { target: { value: "x".repeat(501) } });
    section.open = false;
    fireEvent.click(screen.getByRole("button", { name: "dashboard:runtime.create" }));
    await waitFor(() => expect(document.activeElement).toBe(note));
    expect(section.open).toBe(true);
    expect(document.getElementById("runtime-note-error")?.textContent).toBe(
      "dashboard:runtime.form.noteTooLong",
    );
    expect(state.create).not.toHaveBeenCalled();
  });
});
