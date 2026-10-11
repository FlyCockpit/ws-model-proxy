// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Access → API keys: what each key can use, as chips naming the pools. */

const state = vi.hoisted(() => ({ keys: [] as Array<Record<string, unknown>> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.count === "number" ? `${key}:${opts.count}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/components/access/api-endpoint-card", () => ({ EndpointCard: () => null }));
vi.mock("@/components/access/create-api-key-dialog", () => ({ CreateApiKeyDialog: () => null }));
vi.mock("@/components/time-ago", () => ({ TimeAgo: () => null }));

vi.mock("@/utils/orpc", () => {
  const query = (path: string[], data: () => unknown) => ({
    key: () => path,
    queryOptions: () => ({ queryKey: path, queryFn: async () => data() }),
  });
  return {
    orpc: {
      access: {
        apiKeys: {
          list: query(["access", "apiKeys", "list"], () => ({
            keys: state.keys,
            baseUrl: "https://proxy.example.com/v1",
          })),
          revoke: { mutationOptions: () => ({ mutationFn: async () => ({ ok: true }) }) },
        },
      },
      pools: {
        list: query(["pools", "list"], () => ({
          pools: [{ id: "p-own", slug: "chat", callableIds: ["me/chat"] }],
          sharedWithMe: [
            { poolId: "p-shared", callableIds: ["alice/embed"], canUse: true },
            { poolId: "p-contribute-only", callableIds: ["alice/batch"], canUse: false },
          ],
        })),
      },
    },
  };
});

import { Route } from "./api-keys";

function key(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    name: id,
    scope: "SELECTED_POOLS",
    poolIds: [],
    lookupPrefix: `wsmp_key_${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.keys = [];
});

describe("Access → API keys: can use", () => {
  it("names each selected pool, own and shared, and marks those no longer usable", async () => {
    state.keys = [key("laptop", { poolIds: ["p-own", "p-shared", "p-contribute-only", "p-gone"] })];
    await mount();
    await screen.findByText("me/chat");
    const chips = screen.getByText("me/chat").closest("ul");
    if (!chips) throw new Error("no chips");
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["me/chat", "alice/embed", "access:apiKeys.poolGone", "access:apiKeys.poolGone"]);
    expect(screen.queryByText(/access:apiKeys.poolCount/)).toBeNull();
  });

  it("shows one All pools chip for an all-pools key", async () => {
    state.keys = [key("ci", { scope: "ALL_POOLS" })];
    await mount();
    expect(await screen.findByText("access:apiKeys.allPools")).toBeTruthy();
  });
});
