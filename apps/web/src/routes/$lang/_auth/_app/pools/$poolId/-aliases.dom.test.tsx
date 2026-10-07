// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ set: vi.fn(), remove: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", poolId: "pool-1" }),
    }),
  };
});

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

const alias = (overrides: Record<string, unknown>) => ({
  id: "a-1",
  name: "gpt-4o",
  poolId: "pool-1",
  callableId: "me/pool",
  apiKeyId: null,
  apiKeyName: null,
  usable: true,
  ...overrides,
});

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      aliases: {
        key: () => ["pools", "aliases"],
        list: {
          queryOptions: () => ({
            queryKey: ["pools", "aliases", "list"],
            queryFn: async () => ({
              aliases: [
                alias({}),
                alias({
                  id: "a-2",
                  name: "claude-sonnet-4-5",
                  apiKeyId: "k-1",
                  apiKeyName: "laptop",
                  usable: false,
                  callableId: null,
                }),
                alias({ id: "a-3", name: "elsewhere", poolId: "pool-2" }),
              ],
            }),
          }),
        },
        set: {
          mutationOptions: () => ({
            mutationFn: async (input: unknown) => {
              state.set(input);
              return {};
            },
          }),
        },
        delete: {
          mutationOptions: () => ({
            mutationFn: async (input: unknown) => {
              state.remove(input);
              return { ok: true };
            },
          }),
        },
      },
    },
    access: {
      apiKeys: {
        list: {
          queryOptions: () => ({
            queryKey: ["access", "apiKeys"],
            queryFn: async () => ({
              baseUrl: "https://proxy.test/v1",
              keys: [
                {
                  id: "k-1",
                  name: "laptop",
                  scope: "ALL_POOLS",
                  poolIds: [],
                  revokedAt: null,
                  expiresAt: null,
                },
                {
                  id: "k-2",
                  name: "other-pool-only",
                  scope: "SELECTED_POOLS",
                  poolIds: ["pool-2"],
                  revokedAt: null,
                  expiresAt: null,
                },
              ],
            }),
          }),
        },
      },
    },
  },
}));

import { Route } from "./aliases";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};
const K = "dashboard:pool.aliases";

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("gpt-4o");
}

afterEach(() => {
  cleanup();
  state.set.mockReset();
  state.remove.mockReset();
});

describe("pool aliases tab", () => {
  it("lists only this pool's aliases with their key scope and usability", async () => {
    await mount();
    expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(screen.getByText(`${K}.onlyKey:laptop`)).toBeTruthy();
    expect(screen.getAllByText(`${K}.unusable`)).toHaveLength(1);
    // Only keys that may call this pool are offered.
    const keySelect = screen.getByLabelText(`${K}.key`) as HTMLSelectElement;
    expect([...keySelect.options].map((option) => option.value)).toEqual(["", "k-1"]);
  });

  it("validates the name, then points it at this pool", async () => {
    await mount();
    const name = screen.getByLabelText(`${K}.name`);
    fireEvent.change(name, { target: { value: "gpt-4o:external" } });
    fireEvent.click(screen.getByRole("button", { name: `${K}.addButton` }));
    await screen.findByText(`${K}.errors.nameExternal`);
    expect(state.set).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "gpt-4o-mini" } });
    fireEvent.click(screen.getByRole("button", { name: `${K}.addButton` }));
    await waitFor(() =>
      expect(state.set).toHaveBeenCalledWith({
        name: "gpt-4o-mini",
        poolId: "pool-1",
        apiKeyId: null,
      }),
    );
  });

  it("removes an alias by id", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: `${K}.remove:gpt-4o` }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith({ aliasId: "a-1" }));
  });
});
