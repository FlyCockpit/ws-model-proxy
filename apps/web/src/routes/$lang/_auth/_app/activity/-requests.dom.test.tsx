// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listInputs: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  deleteResults: [] as number[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/page-stub", () => ({ PageHeading: () => <h1>requests</h1> }));
vi.mock("@/components/segmented-control", () => ({ SegmentedControl: () => null }));
vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => {
  const listOf = (key: string, data: unknown) => ({
    queryOptions: (options?: { input?: unknown }) => ({
      queryKey: [key, options?.input ?? null],
      queryFn: async () => data,
    }),
  });
  return {
    orpc: {
      activity: {
        requests: {
          list: {
            key: () => ["requests"],
            infiniteOptions: (options: {
              input: (cursor: string | undefined) => Record<string, unknown>;
            }) => {
              const input = options.input(undefined);
              return {
                queryKey: ["requests", input],
                queryFn: async () => {
                  state.listInputs.push(input);
                  return { items: [], nextCursor: null };
                },
                initialPageParam: undefined,
                getNextPageParam: () => undefined,
              };
            },
          },
          delete: {
            mutationOptions: () => ({
              mutationFn: async (input: Record<string, unknown>) => {
                state.deletes.push(input);
                return { deleted: state.deleteResults.shift() ?? 0 };
              },
            }),
          },
        },
      },
      pools: {
        list: listOf("pools", {
          pools: [{ id: "pool-1", slug: "qwen", callableIds: ["ada/qwen"] }],
          sharedWithMe: [{ poolId: "pool-2", callableIds: ["bob/llama"] }],
        }),
      },
      runtimes: {
        list: listOf("runtimes", { runtimes: [{ id: "rt-1", name: "Qwen vLLM" }] }),
        versions: {
          list: listOf("versions", {
            items: [
              { id: "v-2", version: 2 },
              { id: "v-1", version: 1 },
            ],
            nextCursor: null,
          }),
        },
      },
      nodes: { list: listOf("nodes", { nodes: [{ id: "node-1", slug: "spark-1", name: null }] }) },
    },
  };
});

import { Route } from "./requests";

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Component = Route.options.component as ComponentType & {
    preload?: () => Promise<unknown>;
  };
  await Component.preload?.();
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText("activity:requests.empty");
}

const lastInput = () => state.listInputs.at(-1) ?? {};

afterEach(() => {
  cleanup();
  state.listInputs = [];
  state.deletes = [];
  state.deleteResults = [];
});

describe("request log filters", () => {
  it("lists own and shared pools and filters by pool and node", async () => {
    await mount();
    const pool = screen.getByLabelText("activity:requests.filter.poolId");
    expect(within(pool).getByRole("option", { name: "bob/llama" })).toBeTruthy();
    fireEvent.change(pool, { target: { value: "pool-1" } });
    await waitFor(() => expect(lastInput()).toMatchObject({ poolId: "pool-1" }));
    await screen.findByRole("option", { name: "spark-1" });
    fireEvent.change(screen.getByLabelText("activity:requests.filter.nodeId"), {
      target: { value: "node-1" },
    });
    await waitFor(() => expect(lastInput()).toMatchObject({ poolId: "pool-1", nodeId: "node-1" }));
  });

  it("picks a version only after a runtime and clears it with a new runtime", async () => {
    await mount();
    const version = screen.getByLabelText(
      "activity:requests.filter.versionId",
    ) as HTMLSelectElement;
    expect(version.disabled).toBe(true);
    await screen.findByRole("option", { name: "Qwen vLLM" });
    const runtime = screen.getByLabelText("activity:requests.filter.runtimeId");
    fireEvent.change(runtime, { target: { value: "rt-1" } });
    await screen.findByRole("option", {
      name: 'activity:requests.filter.versionNumber({"version":1})',
    });
    expect(version.disabled).toBe(false);
    fireEvent.change(version, { target: { value: "v-1" } });
    await waitFor(() => expect(lastInput()).toMatchObject({ runtimeId: "rt-1", versionId: "v-1" }));
    fireEvent.change(runtime, { target: { value: "" } });
    await waitFor(() => expect(lastInput()).not.toHaveProperty("versionId"));
    expect(lastInput()).not.toHaveProperty("runtimeId");
  });

  it("filters since a range and resets every filter", async () => {
    await mount();
    const before = Date.now();
    fireEvent.change(screen.getByLabelText("activity:requests.filter.since"), {
      target: { value: "24h" },
    });
    await waitFor(() => expect(lastInput()).toHaveProperty("since"));
    const since = Date.parse(String(lastInput().since));
    expect(before - since).toBeGreaterThanOrEqual(24 * 3_600_000 - 1_000);
    expect(before - since).toBeLessThanOrEqual(24 * 3_600_000 + 1_000);
    fireEvent.click(screen.getByRole("button", { name: "activity:requests.filter.reset" }));
    await waitFor(() => expect(lastInput()).not.toHaveProperty("since"));
  });
});

describe("request log deletes", () => {
  it("deletes finished requests older than the chosen range after a confirm", async () => {
    state.deleteResults = [3, 0];
    await mount();
    fireEvent.change(screen.getByLabelText("activity:requests.olderThan"), {
      target: { value: "7d" },
    });
    const now = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "activity:requests.deleteOlder" }));
    expect(state.deletes).toEqual([]);
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button"));
    await waitFor(() => expect(state.deletes).toHaveLength(2));
    const before = Date.parse(String(state.deletes[0]?.before));
    expect(now - before).toBeGreaterThanOrEqual(7 * 24 * 3_600_000 - 1_000);
    expect(now - before).toBeLessThanOrEqual(7 * 24 * 3_600_000 + 1_000);
  });

  it("keeps clear-all behind a confirm", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "activity:requests.clear" }));
    expect(state.deletes).toEqual([]);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "activity:requests.clear",
      }),
    );
    await waitFor(() => expect(state.deletes).toHaveLength(1));
    expect(Date.parse(String(state.deletes[0]?.before))).toBeGreaterThan(Date.now());
  });
});
