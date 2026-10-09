// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A runtime's served model: "Add to a pool shared with me" offers only pools shared with can
 * contribute that can take this model now.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  pools: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.pool === "string" ? `${key}:${opts.pool}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    access: {
      contributing: {
        key: () => ["access", "contributing"],
        pools: {
          queryOptions: () => ({
            queryKey: ["access", "contributing", "pools"],
            queryFn: async () => ({ pools: state.pools, servedModels: [] }),
          }),
        },
      },
    },
    pools: {
      key: () => ["pools"],
      members: {
        addContributed: {
          mutationOptions: (options?: Record<string, unknown>) => ({
            ...options,
            mutationFn: async (input: unknown) => {
              state.calls.push({ name: "pools.members.addContributed", input });
              return {};
            },
          }),
        },
      },
    },
    runtimes: { key: () => ["runtimes"] },
  },
}));

import { AddToSharedPool } from "./contribute";

function pool(poolId: string, overrides: Record<string, unknown> = {}) {
  return {
    shareId: `share-${poolId}`,
    poolId,
    callableId: `alice/${poolId}`,
    ownerEmail: "alice@example.test",
    modelType: "LLM",
    ownHardwareOnly: false,
    yourMembers: [],
    ...overrides,
  };
}

function mount(model = { id: "rm-1", type: "LLM", retired: false }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AddToSharedPool model={model} />
    </QueryClientProvider>,
  );
  const loaded = () =>
    waitFor(() => expect(client.getQueryData(["access", "contributing", "pools"])).toBeDefined());
  return { ...view, loaded };
}

afterEach(() => {
  cleanup();
  state.calls = [];
  state.pools = [];
});

describe("AddToSharedPool", () => {
  it("offers only pools of the model's type that can take it, then adds it", async () => {
    state.pools = [
      pool("chat"),
      pool("embed", { modelType: "EMBEDDINGS" }),
      pool("mine-only", { ownHardwareOnly: true }),
      pool("has-it", {
        yourMembers: [{ memberId: "m1", runtimeModelId: "rm-1", upstreamModelId: "qwen" }],
      }),
    ];
    mount();
    const select = await screen.findByLabelText("access:contributions.addToShared");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "chat"]);
    const add = screen.getByRole("button", { name: "access:contributions.add" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(select, { target: { value: "chat" } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(state.calls).toEqual([
        {
          name: "pools.members.addContributed",
          input: { poolId: "chat", runtimeModelId: "rm-1" },
        },
      ]),
    );
  });

  it("renders nothing without a pool shared with you that could take the model", async () => {
    state.pools = [pool("embed", { modelType: "EMBEDDINGS" })];
    const { container, loaded } = mount();
    await loaded();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a retired model", async () => {
    state.pools = [pool("chat")];
    const { container, loaded } = mount({ id: "rm-1", type: "LLM", retired: true });
    await loaded();
    expect(container.innerHTML).toBe("");
  });
});
