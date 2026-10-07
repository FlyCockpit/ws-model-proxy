// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Admin → Observability: nodes, runtimes, pools and requests across accounts, paged. */

const state = vi.hoisted(() => ({
  inputs: [] as Array<{ list: string; input: Record<string, unknown> }>,
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
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
    i18n: { language: "en-US" },
  }),
}));

const owner = { id: "u1", email: "u1@example.test", name: "U One", slug: "u-one" };
const rows: Record<string, Array<Record<string, unknown>>> = {
  nodes: [
    {
      id: "n1",
      slug: "desk",
      owner,
      connection: "ONLINE",
      trust: "FULL",
      version: "0.4.0",
      lastHeartbeatAt: null,
      runningInstances: 2,
    },
  ],
  runtimes: [
    {
      id: "r1",
      slug: "qwen",
      owner,
      kind: "STARTABLE",
      modelType: null,
      instances: [{ id: "i1", phase: "READY" }],
    },
  ],
  pools: [],
  relay: [
    {
      id: "q1",
      createdAt: new Date().toISOString(),
      owner,
      status: "FAILED",
      callableId: "u-one/chat",
      durationMs: 950,
      errorClass: "upstream_5xx",
    },
  ],
};

vi.mock("@/utils/orpc", () => {
  const list = (name: string) => ({
    queryOptions: ({ input }: { input: Record<string, unknown> }) => ({
      queryKey: ["adminObservability", name, input],
      queryFn: async () => {
        state.inputs.push({ list: name, input });
        const items = rows[name] ?? [];
        return {
          items,
          total: name === "nodes" ? 60 : items.length,
          page: input.page,
          pageSize: 25,
        };
      },
    }),
  });
  return {
    orpc: {
      adminObservability: {
        nodes: list("nodes"),
        runtimes: list("runtimes"),
        pools: list("pools"),
        relay: list("relay"),
      },
    },
  };
});

import { Route } from "./observability";

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
  await screen.findByText("desk");
}

afterEach(() => {
  cleanup();
  state.inputs = [];
});

describe("Admin observability", { timeout: 30_000 }, () => {
  it("lists nodes with owners and pages through them", async () => {
    await mount();
    expect(screen.getByText("U One · u1@example.test")).toBeTruthy();
    expect(screen.getByText(/admin:observability.running:2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "admin:observability.next" }));
    await waitFor(() =>
      expect(state.inputs).toContainEqual({
        list: "nodes",
        input: { page: 2, pageSize: 25 },
      }),
    );
  });

  it("switches lists and narrows them to an owner", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "admin:observability.tabs.runtimes" }));
    expect(await screen.findByText("qwen")).toBeTruthy();
    expect(screen.getByText("admin:observability.service")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "admin:observability.tabs.pools" }));
    expect(await screen.findByText("admin:observability.empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "admin:observability.tabs.requests" }));
    expect(await screen.findByText("u-one/chat")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("admin:observability.ownerLabel"), {
      target: { value: " one " },
    });
    await waitFor(() =>
      expect(state.inputs).toContainEqual({
        list: "relay",
        input: { page: 1, pageSize: 25, ownerQuery: "one" },
      }),
    );
  });
});
