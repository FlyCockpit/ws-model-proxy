// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Runtimes: Needs you, then one group per node, then the runtimes on no node. */

const state = vi.hoisted(() => ({ runtimes: [] as Array<Record<string, unknown>> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    Link: ({ children, className }: { children: ReactNode; className?: string }) => (
      <a href="#x" className={className}>
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "node" in opts ? `${key}:${String(opts.node)}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      list: {
        queryOptions: () => ({
          queryKey: ["runtimes", "list"],
          queryFn: async () => ({ runtimes: state.runtimes }),
        }),
      },
    },
    pools: {
      list: {
        queryOptions: () => ({
          queryKey: ["pools", "list"],
          queryFn: async () => ({ pools: [], sharedWithMe: [] }),
        }),
      },
    },
  },
}));

import { Route } from "./index";

function runtime(
  name: string,
  nodes: Array<{ id: string; slug: string }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `rt-${name}`,
    slug: name,
    name,
    kind: "STARTABLE",
    origin: "SERVER",
    nodeId: null,
    modelType: "LLM",
    service: false,
    currentVersion: { version: 1 },
    models: [],
    instances: { running: nodes.length > 0 ? 1 : 0, starting: 0, failed: 0, needsYou: 0 },
    nodes,
    forkedFromVersionId: null,
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
  await screen.findAllByRole("region");
}

function groups() {
  return screen.getAllByRole("region").map((region) => ({
    title: within(region).getByRole("heading").textContent,
    runtimes: within(region)
      .getAllByRole("listitem")
      .map((item) => within(item).getAllByRole("link")[0]?.textContent),
  }));
}

afterEach(() => {
  cleanup();
  state.runtimes = [];
});

describe("Runtimes page", { timeout: 30_000 }, () => {
  it("groups by node, Needs you first and the runtimes on no node last", async () => {
    const box = { id: "n-box", slug: "box" };
    const spark = { id: "n-spark", slug: "spark" };
    state.runtimes = [
      runtime("always", [spark], { kind: "ALWAYS_ON", nodeId: "n-spark" }),
      runtime("big", [box, spark]),
      runtime("idle", []),
      runtime("stuck", [box], {
        instances: { running: 0, starting: 0, failed: 1, needsYou: 1 },
      }),
    ];
    await mount();
    expect(groups()).toEqual([
      { title: "dashboard:runtime.groups.needsYou", runtimes: ["stuck"] },
      { title: "dashboard:runtime.groups.node:box", runtimes: ["big"] },
      { title: "dashboard:runtime.groups.node:spark", runtimes: ["always", "big"] },
      { title: "dashboard:runtime.groups.notRunning", runtimes: ["idle"] },
    ]);
  });

  it("leaves empty groups out", async () => {
    state.runtimes = [runtime("idle", [])];
    await mount();
    expect(groups()).toEqual([
      { title: "dashboard:runtime.groups.notRunning", runtimes: ["idle"] },
    ]);
  });
});
