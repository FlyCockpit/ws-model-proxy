// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Overview: KPIs, getting started, what needs you, nodes and pools from the summary. */

const state = vi.hoisted(() => ({
  summary: null as Record<string, unknown> | null,
  needsYou: { items: [] as Array<Record<string, unknown>>, queuedCommands: 0 },
  ranges: [] as string[],
  dismissed: 0,
}));

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
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
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
  state.needsYou = { items: [], queuedCommands: 0 };
  state.ranges = [];
  state.dismissed = 0;
});

describe("Overview", { timeout: 30_000 }, () => {
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
    };
    await mount();
    expect(await screen.findByText("Qwen")).toBeTruthy();
    expect(screen.getByText("dashboard:overview.needsYou.need.RESTART")).toBeTruthy();
    expect(screen.getByText("dashboard:overview.needsYou.queuedCount:2")).toBeTruthy();
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
});
