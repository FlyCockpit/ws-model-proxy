// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { memberFixture, poolFixture } from "./-pool-fixture";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  ownKey: vi.fn(),
  pool: undefined as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
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

const mutation = (spy: (input: unknown) => void) => ({
  mutationOptions: () => ({
    mutationFn: async (input: unknown) => {
      spy(input);
      return state.pool;
    },
  }),
});

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      key: () => ["pools"],
      get: {
        queryOptions: () => ({ queryKey: ["pools", "get"], queryFn: async () => state.pool }),
      },
      update: mutation((input) => state.update(input)),
      cloud: {
        setMode: mutation(() => {}),
        setPaidWarmProtection: mutation(() => {}),
        setOwnKeyEquivalent: mutation((input) => state.ownKey(input)),
      },
      history: {
        list: {
          infiniteOptions: () => ({
            queryKey: ["pools", "history"],
            queryFn: async () => ({
              items: [
                {
                  id: "ev-1",
                  createdAt: new Date().toISOString(),
                  actor: { actor: "AGENT", userId: null, agentTokenId: "t-1", label: null },
                  action: "pool.update",
                  before: null,
                  after: null,
                },
                {
                  id: "ev-2",
                  createdAt: new Date().toISOString(),
                  actor: { actor: "USER", userId: "user-1", agentTokenId: null, label: null },
                  action: "pool.fallback.mode",
                  before: null,
                  after: null,
                },
              ],
              nextCursor: null,
            }),
            initialPageParam: undefined,
            getNextPageParam: () => undefined,
          }),
        },
      },
    },
    models: { key: () => ["models"] },
    providers: {
      models: {
        list: {
          queryOptions: () => ({
            queryKey: ["providers", "models"],
            queryFn: async () => ({ models: [] }),
          }),
        },
      },
    },
  },
}));

import { Route } from "./cloud";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

const cloudMember = (id: string, order: number, model: string) =>
  memberFixture({
    id,
    kind: "CLOUD",
    status: "cloud_standby",
    runtimeId: null,
    runtimeSlug: null,
    runtimeModelId: null,
    upstreamModelId: model,
    providerModelId: `pm-${id}`,
    cloudOrder: order,
  });

async function mount(pool = poolFixture()) {
  state.pool = pool;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("dashboard:pool.cloud.title");
}

afterEach(() => {
  cleanup();
  state.update.mockReset();
  state.ownKey.mockReset();
});

describe("pool cloud tab", () => {
  it("notes that :external waits for the pool's max wait, with its current value", async () => {
    await mount();
    expect(screen.getByText("dashboard:pool.cloud.externalNote:ann/chat:external")).toBeTruthy();
    expect(
      screen.getByText(
        "dashboard:pool.cloud.maxWait:30 sec|dashboard:pool.advanced.source.default:default",
      ),
    ).toBeTruthy();
  });

  it("moves a cloud member up and down by resending the order", async () => {
    await mount(
      poolFixture({
        members: [cloudMember("b", 1, "model-b"), cloudMember("a", 0, "model-a")],
      }),
    );
    const upA = screen.getByRole("button", { name: "dashboard:pool.cloud.moveUp:model-a" });
    expect((upA as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.cloud.moveUp:model-b" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        cloudMembers: [{ providerModelId: "pm-b" }, { providerModelId: "pm-a" }],
      }),
    );
    state.update.mockReset();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.cloud.moveDown:model-a" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        cloudMembers: [{ providerModelId: "pm-b" }, { providerModelId: "pm-a" }],
      }),
    );
  });

  it("shows the embedding contract only for embeddings pools and saves it", async () => {
    await mount();
    expect(screen.queryByText("dashboard:pool.contract.title")).toBeNull();
    cleanup();
    await mount(poolFixture({ modelType: "EMBEDDINGS" }));
    const fill = (field: string, value: string) =>
      fireEvent.change(screen.getByLabelText(`dashboard:pool.contract.fields.${field}`), {
        target: { value },
      });
    fill("model", "BAAI/bge-m3");
    fill("revision", "main");
    fill("dimensions", "0");
    fill("vectorSpace", "bge");
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await screen.findByText("dashboard:pool.contract.dimensionsInvalid");
    expect(state.update).not.toHaveBeenCalled();
    fill("dimensions", "1024");
    fireEvent.change(screen.getByLabelText("dashboard:pool.contract.fields.normalization"), {
      target: { value: "l2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common:actions.save" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        cloud: {
          embeddingContract: {
            model: "BAAI/bge-m3",
            revision: "main",
            dimensions: 1024,
            normalization: "l2",
            vectorSpace: "bge",
          },
        },
      }),
    );
  });

  it("gives and withdraws own-key consent", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("dashboard:pool.ownKey.model"), {
      target: { value: " openai/gpt-4o-mini " },
    });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.ownKey.save" }));
    await waitFor(() =>
      expect(state.ownKey).toHaveBeenCalledWith({ poolId: "pool-1", model: "openai/gpt-4o-mini" }),
    );
    cleanup();
    await mount(
      poolFixture({
        cloud: {
          mode: "OWNER_AND_SHARES",
          embeddingContract: null,
          paidWarmProtection: false,
          ownKeyEquivalentModel: "openai/gpt-4o-mini",
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.ownKey.withdraw" }));
    await waitFor(() =>
      expect(state.ownKey).toHaveBeenCalledWith({ poolId: "pool-1", model: null }),
    );
  });

  it("lists the pool history with who made each change", async () => {
    await mount();
    expect(
      await screen.findByText("dashboard:pool.history.actions.pool_update:pool.update"),
    ).toBeTruthy();
    expect(
      screen.getByText("dashboard:pool.history.actions.pool_fallback_mode:pool.fallback.mode"),
    ).toBeTruthy();
    expect(screen.getByText("dashboard:pool.history.actor.AGENT")).toBeTruthy();
    expect(screen.getByText("dashboard:pool.history.actor.USER")).toBeTruthy();
  });
});
