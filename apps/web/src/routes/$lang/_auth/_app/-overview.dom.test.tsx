// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Overview: KPIs, getting started, what needs you, nodes and pools from the summary. */

const state = vi.hoisted(() => ({
  summary: null as Record<string, unknown> | null,
  needsYou: {
    items: [] as Array<Record<string, unknown>>,
    queuedCommands: 0,
    releaseRequests: [] as Array<Record<string, unknown>>,
  },
  aliases: [] as Array<Record<string, unknown>>,
  ranges: [] as string[],
  dismissed: 0,
  navigations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
    }),
    useNavigate: () => async (options: Record<string, unknown>) => {
      state.navigations.push(options);
    },
    Link: ({
      children,
      className,
      to,
      params,
      search,
    }: {
      children: ReactNode;
      className?: string;
      to?: string;
      params?: Record<string, string>;
      search?: { step?: string };
    }) => {
      const path = (to ?? "#x").replace(
        /\$(\w+)/g,
        (_, name: string) => params?.[name] ?? `$${name}`,
      );
      return (
        <a href={search?.step ? `${path}?step=${search.step}` : path} className={className}>
          {children}
        </a>
      );
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "name" in opts
        ? `${key}:${String(opts.name)}|${String(opts.callableId)}`
        : opts && "count" in opts
          ? `${key}:${String(opts.count)}`
          : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    activity: {
      overview: {
        summary: {
          key: () => ["activity", "overview", "summary"],
          queryOptions: ({ input }: { input: { range: string } }) => ({
            queryKey: ["activity", "overview", "summary", input.range],
            queryFn: async () => {
              state.ranges.push(input.range);
              if (!state.summary) throw new Error("summary down");
              return state.summary;
            },
          }),
        },
      },
      needsYou: {
        list: {
          queryOptions: () => ({
            queryKey: ["activity", "needsYou"],
            queryFn: async () => state.needsYou,
          }),
        },
      },
    },
    pools: {
      aliases: {
        list: {
          queryOptions: () => ({
            queryKey: ["pools", "aliases", "list"],
            queryFn: async () => ({ aliases: state.aliases }),
          }),
        },
      },
    },
    settings: {
      onboarding: {
        complete: {
          mutationOptions: () => ({
            mutationFn: async () => {
              state.dismissed += 1;
              return { success: true };
            },
          }),
        },
      },
    },
  },
}));

import { Route } from "./overview";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    kpis: {
      requests: 1200,
      errors: 12,
      p95LatencyMs: 2400,
      p95TtftMs: 310,
      p95QueueWaitMs: null,
      cloudShare: 0.25,
    },
    nodes: [
      { id: "n1", slug: "desk", online: true, trust: "FULL" },
      { id: "n2", slug: "laptop", online: false, trust: "RELAY" },
    ],
    nodesTotal: 60,
    nodesOnline: 41,
    pools: [
      {
        id: "p1",
        callableId: "alex/chat",
        requests: 40,
        errors: 2,
        sparkline: new Array(24).fill(0),
      },
    ],
    onboarding: {
      done: false,
      steps: { node: true, runtime: true, pool: true, agent: false, apiKey: false },
    },
    ...overrides,
  };
}

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
  await screen.findByText("dashboard:overview.kpi.title");
}

afterEach(() => {
  cleanup();
  state.summary = null;
  state.needsYou = { items: [], queuedCommands: 0, releaseRequests: [] };
  state.aliases = [];
  state.ranges = [];
  state.dismissed = 0;
  state.navigations = [];
  window.sessionStorage.clear();
});

describe("Overview", () => {
  it("shows the KPIs, nodes and pools of the summary", async () => {
    state.summary = summary();
    await mount();
    expect(screen.getByText("2.4 sec")).toBeTruthy();
    expect(screen.getByText("310 ms")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("1%")).toBeTruthy();
    expect(screen.getByText("desk")).toBeTruthy();
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText("alex/chat")).toBeTruthy();
    expect(screen.getByText(/dashboard:overview.pools.errors:2/)).toBeTruthy();
    // The counts cover every node, beyond the 50 the strip shows.
    expect(screen.getByText("dashboard:overview.nodes.online")).toBeTruthy();
    expect(screen.getByText("dashboard:overview.nodes.more:58")).toBeTruthy();
    // No queue wait yet: a dash, not a zero.
    expect(screen.getAllByText("dashboard:overview.kpi.none")).toHaveLength(1);
  });

  it("asks for the 7-day summary when the range changes", async () => {
    state.summary = summary();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:overview.rangeValue.7d" }));
    await waitFor(() => expect(state.ranges).toContain("7d"));
  });

  it("lists getting-started steps until dismissed, and hides them once done", async () => {
    state.summary = summary();
    await mount();
    expect(screen.getByText("dashboard:overview.start.step.agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:overview.start.dismiss" }));
    await waitFor(() => expect(state.dismissed).toBe(1));
    cleanup();
    state.summary = summary({ onboarding: { done: true, steps: {} } });
    await mount();
    expect(screen.queryByText("dashboard:overview.start.title")).toBeNull();
  });

  it("opens each getting-started step on Welcome", async () => {
    state.summary = summary();
    await mount();
    const link = screen.getByText("dashboard:overview.start.step.agent").closest("a");
    expect(link?.getAttribute("href")).toBe("/en-US/welcome?step=agent");
    const node = screen.getByText("dashboard:overview.start.step.node").closest("a");
    expect(node?.getAttribute("href")).toBe("/en-US/welcome?step=node");
    expect(state.navigations).toEqual([]);
  });

  it("sends a first sign-in (nothing set up) to Welcome once per tab", async () => {
    const fresh = {
      onboarding: {
        done: false,
        steps: { node: false, runtime: false, pool: false, agent: false, apiKey: false },
      },
    };
    state.summary = summary(fresh);
    await mount();
    await waitFor(() =>
      expect(state.navigations).toEqual([
        { to: "/$lang/welcome", params: { lang: "en-US" }, replace: true },
      ]),
    );
    cleanup();
    state.navigations = [];
    await mount();
    expect(state.navigations).toEqual([]);
    // Dismissed getting started never redirects.
    cleanup();
    window.sessionStorage.clear();
    state.summary = summary({ onboarding: { ...fresh.onboarding, done: true } });
    await mount();
    expect(state.navigations).toEqual([]);
  });

  it("lists what needs a person and agent commands waiting", async () => {
    state.summary = summary();
    state.needsYou = {
      items: [
        {
          need: "RESTART",
          instanceId: "i1",
          runtimeId: "r1",
          runtimeName: "Qwen",
          nodeId: "n1",
          since: new Date().toISOString(),
          stepId: null,
        },
      ],
      queuedCommands: 2,
      releaseRequests: [],
    };
    await mount();
    expect(await screen.findByText("Qwen")).toBeTruthy();
    expect(screen.getByText("dashboard:overview.needsYou.need.RESTART")).toBeTruthy();
    expect(screen.getByText("dashboard:overview.needsYou.queuedCount:2")).toBeTruthy();
  });

  it("links each need to where it is resolved", async () => {
    state.summary = summary();
    const item = (need: string, runtimeId: string, runtimeName: string) => ({
      need,
      instanceId: `i-${runtimeId}`,
      runtimeId,
      runtimeName,
      nodeId: "n1",
      since: new Date().toISOString(),
      stepId: need === "STEP" ? "s1" : null,
    });
    state.needsYou = {
      items: [
        item("STEP", "r1", "Stepper"),
        item("RESTART", "r2", "Restarter"),
        item("MARK_STOPPED", "r3", "Stopper"),
      ],
      queuedCommands: 1,
      releaseRequests: [
        {
          requestId: "q1",
          instanceId: "i-r4",
          runtimeId: "r4",
          runtimeName: "Releaser",
          nodeId: "n1",
          nodeNumber: 1,
          since: new Date().toISOString(),
        },
      ],
    };
    await mount();
    const hrefOf = async (text: string) =>
      (await screen.findByText(text)).closest("a")?.getAttribute("href");
    expect(await hrefOf("Stepper")).toBe("/en-US/terminals");
    expect(await hrefOf("Restarter")).toBe("/en-US/runtimes/r2");
    expect(await hrefOf("Stopper")).toBe("/en-US/runtimes/r3");
    // An agent's release request is decided on the runtime page.
    expect(await hrefOf("Releaser")).toBe("/en-US/runtimes/r4");
    expect(screen.getByText("dashboard:overview.needsYou.releaseRequest")).toBeTruthy();
    expect(await hrefOf("dashboard:overview.needsYou.queuedCount:1")).toBe("/en-US/terminals");
  });

  it("keeps what needs you when the summary fails", async () => {
    state.summary = null;
    state.needsYou = {
      items: [
        {
          need: "STEP",
          instanceId: "i1",
          runtimeId: "r1",
          runtimeName: "Whisper",
          nodeId: null,
          since: new Date().toISOString(),
          stepId: "s1",
        },
      ],
      queuedCommands: 0,
      releaseRequests: [],
    };
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
    expect(await screen.findByText("Whisper")).toBeTruthy();
    expect(await screen.findByText("dashboard:overview.loadFailed")).toBeTruthy();
  });

  it("shows nothing for what needs you when nothing does", async () => {
    state.summary = summary();
    await mount();
    await waitFor(() => expect(screen.queryByText("dashboard:overview.needsYou.title")).toBeNull());
  });

  it("warns about each alias that hides a pool, linking to its Aliases tab", async () => {
    state.summary = summary();
    const alias = (overrides: Record<string, unknown>) => ({
      id: "a1",
      name: "gpt-4o",
      poolId: "p-own",
      callableId: "me/own",
      apiKeyId: null,
      apiKeyName: null,
      usable: true,
      hides: null,
      ...overrides,
    });
    state.aliases = [
      alias({}),
      alias({ id: "a2", name: "ann/chat", hides: { callableId: "ann/chat", shared: true } }),
      alias({
        id: "a3",
        name: "me/old",
        poolId: "p-2",
        hides: { callableId: "me/old", shared: false },
      }),
    ];
    await mount();
    const K = "dashboard:overview.aliasShadows";
    expect(await screen.findByText(`${K}.title:2`)).toBeTruthy();
    const shared = screen.getByText(`${K}.row:ann/chat|ann/chat`);
    expect(shared.closest("a")?.getAttribute("href")).toBe("/en-US/pools/p-own/aliases");
    const own = screen.getByText(`${K}.rowOwn:me/old|me/old`);
    expect(own.closest("a")?.getAttribute("href")).toBe("/en-US/pools/p-2/aliases");
    // An alias that hides nothing is not mentioned.
    expect(screen.queryByText(/gpt-4o/)).toBeNull();
  });

  it("shows no alias warning when no alias hides a pool", async () => {
    state.summary = summary();
    state.aliases = [
      {
        id: "a1",
        name: "gpt-4o",
        poolId: "p1",
        callableId: "alex/chat",
        apiKeyId: null,
        apiKeyName: null,
        usable: true,
        hides: null,
      },
    ];
    await mount();
    expect(screen.queryByText(/dashboard:overview\.aliasShadows/)).toBeNull();
  });
});
