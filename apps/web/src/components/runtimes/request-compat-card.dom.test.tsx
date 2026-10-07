// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join("|")}` : key,
    i18n: { language: "en-US" },
  }),
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

import { RequestCompatCard } from "./request-compat-card";

type Runtime = ComponentProps<typeof RequestCompatCard>["runtime"];
const K = "dashboard:runtime.compat";

function mount(compat: Runtime["current"]["compat"] = {}) {
  const runtime = {
    id: "rt-1",
    currentVersion: { id: "v-1" },
    current: { compat },
  } as unknown as Runtime;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RequestCompatCard runtime={runtime} />
    </QueryClientProvider>,
  );
}

function addRule(op: string, path: string) {
  fireEvent.change(screen.getByLabelText(`${K}.rules.op`), { target: { value: op } });
  fireEvent.change(screen.getByLabelText(`${K}.rules.path`), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: `${K}.rules.addButton` }));
}

afterEach(() => {
  cleanup();
  state.update.mockReset();
});

describe("RequestCompatCard", () => {
  it("saves the whole edited setting as one update", async () => {
    mount();
    const save = screen.getByRole("button", { name: `${K}.save` }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Automatic: nothing to reset.
    expect(screen.queryByRole("button", { name: `${K}.reset` })).toBeNull();

    fireEvent.click(screen.getByLabelText(new RegExp(`${K}.policy.options.strict`)));
    addRule("drop", "messages[].cache_control");
    await screen.findByText(`${K}.describe.drop:messages[].cache_control`);
    fireEvent.change(screen.getByLabelText("anthropic-beta"), { target: { value: "strip" } });

    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update).toHaveBeenCalledWith({
      runtimeId: "rt-1",
      compat: {
        unknownFieldPolicy: "strict",
        rewriteRules: [{ op: "drop", path: "messages[].cache_control" }],
        headers: { "anthropic-beta": "strip" },
      },
    });
  });

  it("refuses dropping a semantic field until it is allowed to drop", async () => {
    mount();
    addRule("drop", "temperature");
    await screen.findByText(`${K}.errors.semantic`);
    expect(screen.queryByText(`${K}.describe.drop:temperature`)).toBeNull();

    fireEvent.change(screen.getByLabelText(`${K}.allowDrop.path`), {
      target: { value: "temperature" },
    });
    fireEvent.click(screen.getByRole("button", { name: `${K}.allowDrop.add` }));
    await screen.findByRole("button", { name: `${K}.allowDrop.remove:temperature` });

    fireEvent.click(screen.getByRole("button", { name: `${K}.rules.addButton` }));
    await screen.findByText(`${K}.describe.drop:temperature`);
  });

  it("marks a rule the setting no longer allows instead of saving", async () => {
    mount({
      allowDropSemanticFields: ["temperature"],
      rewriteRules: [{ op: "drop", path: "temperature" }],
    });
    fireEvent.click(screen.getByRole("button", { name: `${K}.allowDrop.remove:temperature` }));
    fireEvent.click(screen.getByRole("button", { name: `${K}.save` }));
    await screen.findByText(`${K}.errors.semantic`);
    expect(screen.getByRole("alert").textContent).toBe(`${K}.errors.fixBelow`);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("rejects a credential-like path with a localized reason", async () => {
    mount();
    addRule("drop", "api_key");
    await screen.findByText(`${K}.errors.pathForbidden`);
  });
});
