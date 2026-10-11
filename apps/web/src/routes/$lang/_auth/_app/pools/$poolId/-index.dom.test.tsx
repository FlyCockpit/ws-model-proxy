// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { memberFixture, poolFixture } from "./-pool-fixture";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  metricsInput: undefined as unknown,
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

vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: ReactNode;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    pools: {
      key: () => ["pools"],
      get: {
        queryOptions: () => ({ queryKey: ["pools", "get"], queryFn: async () => state.pool }),
      },
      update: {
        mutationOptions: () => ({
          mutationFn: async (input: unknown) => {
            state.update(input);
            return state.pool;
          },
        }),
      },
      members: {
        removeContributed: { mutationOptions: () => ({ mutationFn: async () => ({ ok: true }) }) },
      },
    },
    models: {
      key: () => ["models"],
      list: {
        queryOptions: () => ({
          queryKey: ["models", "list"],
          queryFn: async () => ({ baseUrl: "https://proxy.test/v1", models: [] }),
        }),
      },
    },
    runtimes: {
      key: () => ["runtimes"],
      list: {
        queryOptions: () => ({
          queryKey: ["runtimes", "list"],
          queryFn: async () => ({ runtimes: [] }),
        }),
      },
    },
    activity: {
      metrics: {
        query: {
          queryOptions: ({ input }: { input: unknown }) => {
            state.metricsInput = input;
            return {
              queryKey: ["metrics"],
              queryFn: async () => ({
                start: "2026-10-07T00:00:00.000Z",
                series: [],
                totals: { requests: 1234, errors: 5, latency_p95: 850, queue_wait_p95: 2400 },
                histogramVersion: "v1",
              }),
            };
          },
        },
      },
    },
  },
}));

import { Route } from "./index";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

async function mount(pool = poolFixture()) {
  state.pool = pool;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  await screen.findByText(pool.name);
}

afterEach(() => {
  cleanup();
  state.update.mockReset();
});

describe("pool overview", () => {
  it("shows the 24 h stats row from the pool's metrics", async () => {
    await mount();
    expect(await screen.findByText("1.2K")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("850 ms")).toBeTruthy();
    expect(screen.getByText("2.4 sec")).toBeTruthy();
    expect(state.metricsInput).toMatchObject({
      scope: { pool: "pool-1" },
      metrics: ["requests", "errors", "latency_p95", "queue_wait_p95"],
      range: "24h",
    });
  });

  it("switches the call snippet between curl, OpenAI and Anthropic", async () => {
    await mount();
    expect(
      await screen.findByText(/curl https:\/\/proxy\.test\/v1\/chat\/completions/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.call.kinds.openai" }));
    expect(await screen.findByText(/from openai import OpenAI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.call.kinds.anthropic" }));
    // The Anthropic SDK adds /v1 itself.
    expect(await screen.findByText(/base_url="https:\/\/proxy\.test"/)).toBeTruthy();
  });

  it("offers no Anthropic snippet for an embeddings pool", async () => {
    await mount(poolFixture({ modelType: "EMBEDDINGS" }));
    await screen.findByRole("button", { name: "dashboard:pool.call.kinds.openai" });
    expect(
      screen.queryByRole("button", { name: "dashboard:pool.call.kinds.anthropic" }),
    ).toBeNull();
  });

  it("sets a member's weight, refusing values outside 1–1000", async () => {
    await mount();
    const input = screen.getByLabelText("dashboard:pool.weight.aria:qwen · Qwen/Qwen3-8B");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.weight.save" }));
    await screen.findByText("dashboard:pool.weight.invalid");
    expect(state.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.weight.save" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        members: { set: [{ memberId: "mem-1", weight: 5 }] },
      }),
    );
  });

  it("edits the name and description", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:pool.details.edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.form.name"), {
      target: { value: "  Team chat " },
    });
    fireEvent.change(within(dialog).getByLabelText("dashboard:pool.details.description"), {
      target: { value: "For the team" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "common:actions.save" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({
        poolId: "pool-1",
        name: "Team chat",
        description: "For the team",
      }),
    );
  });

  const cloudMember = memberFixture({
    id: "cloud-1",
    kind: "CLOUD",
    status: "cloud_standby",
    runtimeId: null,
    runtimeSlug: null,
    runtimeModelId: null,
    upstreamModelId: "openai/gpt-4o",
    providerModelId: "pm-1",
    cloudOrder: 0,
    live: {
      instances: 0,
      running: 0,
      waiting: null,
      p95LatencyMs: 2100,
      share: 0.1,
      active: null,
      slots: null,
    },
  });
  const contributed = memberFixture({
    id: "mem-2",
    upstreamModelId: "theirs",
    runtimeSlug: "bob-rt",
    shareId: "share-1",
    contributorEmail: "bob@example.test",
    live: {
      instances: 1,
      running: 1,
      waiting: null,
      p95LatencyMs: null,
      share: 0.25,
      active: null,
      slots: null,
    },
  });
  const own = memberFixture({
    live: {
      instances: 2,
      running: 2,
      waiting: 3,
      p95LatencyMs: 1500,
      share: 0.654,
      active: 5,
      slots: 8,
    },
  });

  function rowOf(label: string): HTMLElement {
    const row = screen.getByText(label, { exact: false }).closest("tr");
    if (!row) throw new Error(`no row for ${label}`);
    return row;
  }

  it("splits members into your models (own, then contributed) and cloud fallback, in wide tables", async () => {
    await mount(poolFixture({ members: [cloudMember, contributed, own] }));
    const [local, cloud] = screen.getAllByRole("table");
    if (!local || !cloud) throw new Error("expected two tables");
    expect(within(local).getByText("dashboard:pool.table.local")).toBeTruthy();
    expect(within(cloud).getByText("dashboard:pool.table.cloud")).toBeTruthy();
    const localRows = within(local)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent ?? "");
    expect(localRows).toHaveLength(2);
    expect(localRows[0]).toContain("Qwen/Qwen3-8B");
    expect(localRows[1]).toContain("theirs");
    expect(within(cloud).getAllByRole("row")).toHaveLength(2);
    expect(within(cloud).getByText(/openai\/gpt-4o/)).toBeTruthy();
    // Each table scrolls on its own, never the page.
    for (const table of [local, cloud])
      expect(table.parentElement?.className).toContain("overflow-x-auto");
    expect(screen.queryByRole("button", { name: "dashboard:pool.delete" })).toBeNull();
  });

  it("shows each member's traffic share next to its weight, and p95", async () => {
    await mount(poolFixture({ members: [cloudMember, contributed, own] }));
    const row = rowOf("Qwen/Qwen3-8B");
    const share = within(row).getByRole("meter", {
      name: "dashboard:pool.share.aria:qwen · Qwen/Qwen3-8B|65",
    });
    expect(share.getAttribute("aria-valuenow")).toBe("65");
    expect(within(row).getByText("dashboard:pool.share.percent:65")).toBeTruthy();
    expect(
      within(row).getByLabelText("dashboard:pool.weight.aria:qwen · Qwen/Qwen3-8B"),
    ).toBeTruthy();
    expect(within(row).getByText("1.5 sec")).toBeTruthy();
    expect(
      within(rowOf("openai/gpt-4o")).getByRole("meter", {
        name: "dashboard:pool.share.aria:openai/gpt-4o|10",
      }),
    ).toBeTruthy();
    expect(within(rowOf("openai/gpt-4o")).getByText("2.1 sec")).toBeTruthy();
  });

  it("says when the pool had no requests instead of drawing an empty share", async () => {
    await mount();
    const row = rowOf("Qwen/Qwen3-8B");
    expect(within(row).getByText("dashboard:pool.share.none")).toBeTruthy();
    expect(within(row).queryByRole("meter")).toBeNull();
  });

  it("draws the runtime slot meter with the waiting queue and this pool's kept slice", async () => {
    await mount(
      poolFixture({
        members: [cloudMember, contributed, own],
        routing: { ...poolFixture().routing, keptSlots: 2 },
      }),
    );
    const row = rowOf("Qwen/Qwen3-8B");
    const slots = within(row)
      .getAllByRole("meter")
      .find((meter) => meter.getAttribute("aria-valuemax") === "8");
    expect(slots?.getAttribute("aria-valuenow")).toBe("5");
    // Two kept slots on each of the two ready instances.
    expect(slots?.getAttribute("aria-label")).toContain("dashboard:slots.kept:4");
    expect(within(row).getByText(/dashboard:slots\.waiting/)).toBeTruthy();
    expect(within(rowOf("openai/gpt-4o")).getByText("dashboard:pool.slots.none")).toBeTruthy();
    // A contributed member runs on its contributor's engine: its load stays theirs.
    expect(within(rowOf("theirs")).getByText("dashboard:pool.slots.contributed")).toBeTruthy();
  });

  it("states a known slot limit without a live reading, and nothing known as no reading", async () => {
    await mount(
      poolFixture({
        members: [
          own,
          memberFixture({
            id: "mem-3",
            upstreamModelId: "other",
            runtimeSlug: "other-rt",
            live: { ...own.live, active: null, slots: 8 },
          }),
          memberFixture({
            id: "mem-4",
            upstreamModelId: "idle",
            runtimeSlug: "idle-rt",
            live: { ...own.live, active: null, slots: null },
          }),
        ],
      }),
    );
    expect(within(rowOf("other")).getByText("dashboard:pool.slots.limitOnly:8")).toBeTruthy();
    expect(within(rowOf("idle")).getByText("dashboard:pool.slots.unknown")).toBeTruthy();
  });
});
