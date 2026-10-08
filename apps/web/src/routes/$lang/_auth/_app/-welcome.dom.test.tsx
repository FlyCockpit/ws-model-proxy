// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Welcome: the five skippable steps, their done marks, and the actions each step offers. */

type Steps = { node: boolean; runtime: boolean; pool: boolean; agent: boolean; apiKey: boolean };

const NONE: Steps = { node: false, runtime: false, pool: false, agent: false, apiKey: false };

const state = vi.hoisted(() => ({
  search: {} as { step?: string },
  steps: null as Steps | null,
  navigations: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ name: string; input: unknown }>,
  nodes: [] as Array<Record<string, unknown>>,
  codes: [] as Array<Record<string, unknown>>,
  runtimes: [] as Array<Record<string, unknown>>,
  pools: [] as Array<Record<string, unknown>>,
  minted: 0,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US" }),
      useSearch: () => state.search,
    }),
    useNavigate: () => async (options: Record<string, unknown>) => {
      state.navigations.push(options);
    },
    Link: ({
      children,
      className,
      search,
      to,
      ...rest
    }: {
      children: ReactNode;
      className?: string;
      search?: { step?: string };
      to?: string;
      "aria-current"?: "step";
    }) => (
      <a
        href={`${to ?? ""}${search?.step ? `?step=${search.step}` : ""}`}
        className={className}
        aria-current={rest["aria-current"]}
      >
        {children}
      </a>
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const value = opts.slug ?? opts.node ?? opts.time ?? opts.count ?? opts.step;
      return value === undefined ? key : `${key}:${String(value)}`;
    },
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The dialogs (New pool, agent token, API key) are not under test here (they need matchMedia).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  ResponsiveDialog: () => null,
}));

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function codeView(id: string, enrolled: Array<Record<string, unknown>> = []) {
  return {
    id,
    codePrefix: "ABCDEFGH",
    createdAt: new Date().toISOString(),
    expiresAt: FUTURE,
    suggestedSlug: null,
    replaceNodeId: null,
    maxUses: 1,
    usedCount: enrolled.length,
    lastUsedAt: null,
    labels: [],
    removeAfterOfflineMs: null,
    enrolled,
    revokedAt: null,
  };
}

vi.mock("@/utils/orpc", () => {
  const query = (key: string[], data: () => unknown) => ({
    key: () => key,
    queryKey: () => key,
    queryOptions: (options?: { input?: unknown }) => ({
      queryKey: [...key, options?.input ?? null],
      queryFn: async () => data(),
    }),
  });
  const mutation = (name: string, result: (input: Record<string, unknown>) => unknown) => ({
    mutationOptions: (options?: Record<string, unknown>) => ({
      ...options,
      mutationFn: async (input: Record<string, unknown>) => {
        state.calls.push({ name, input });
        return result(input);
      },
    }),
  });
  return {
    orpc: {
      activity: {
        overview: {
          key: () => ["activity", "overview"],
          summary: query(["activity", "overview", "summary"], () => ({
            onboarding: { done: false, steps: state.steps ?? NONE },
          })),
        },
      },
      settings: {
        get: query(["settings", "get"], () => ({})),
        onboarding: { complete: mutation("settings.onboarding.complete", () => ({})) },
      },
      app: { flags: query(["app", "flags"], () => ({ mcpEnabled: true })) },
      nodes: {
        list: query(["nodes", "list"], () => ({ nodes: state.nodes })),
        enrollmentCodes: {
          key: () => ["nodes", "enrollmentCodes"],
          list: query(["nodes", "enrollmentCodes", "list"], () => ({ codes: state.codes })),
          create: mutation("nodes.enrollmentCodes.create", () => {
            state.minted += 1;
            const id = `code-${state.minted}`;
            return {
              code: codeView(id),
              secret: "wsmp_enr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
              installCommand: `curl -fsSL https://proxy.test/install.sh | sh && ~/.cargo/bin/wsmp login https://proxy.test --code ${id}`,
            };
          }),
          revoke: mutation("nodes.enrollmentCodes.revoke", () => ({ ok: true })),
        },
      },
      runtimes: {
        key: () => ["runtimes"],
        list: query(["runtimes", "list"], () => ({ runtimes: state.runtimes })),
      },
      pools: {
        key: () => ["pools"],
        list: query(["pools", "list"], () => ({ pools: state.pools, sharedWithMe: [] })),
        create: mutation("pools.create", (input) => ({
          id: "p-new",
          slug: input.slug,
          callableIds: [`alex/${String(input.slug)}`],
        })),
        // The New pool dialog's optional cloud step (not under test here).
        update: mutation("pools.update", () => ({})),
        cloud: { setMode: mutation("pools.cloud.setMode", () => ({})) },
      },
      providers: {
        models: { list: query(["providers", "models", "list"], () => ({ models: [] })) },
      },
      models: { key: () => ["models"] },
      access: {
        agentTokens: {
          list: query(["access", "agentTokens", "list"], () => ({
            tokens: [],
            mcpUrl: "https://proxy.test/mcp",
          })),
          create: mutation("access.agentTokens.create", () => ({ secret: "wsmp_at_x" })),
        },
        apiKeys: {
          list: query(["access", "apiKeys", "list"], () => ({
            keys: [],
            baseUrl: "https://proxy.test/v1",
          })),
          create: mutation("access.apiKeys.create", () => ({ secret: "wsmp_k_x" })),
        },
      },
    },
  };
});

import { Route } from "./welcome";

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    slug: "spark-1",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: new Date().toISOString(),
    version: "0.4.0",
    rejectedProtocolVersion: null,
    trust: { effective: "FULL", lowerPending: false, changedAt: null, changedBy: null },
    labels: [],
    hardwareKind: "discrete",
    liveFreeMemoryGb: 60,
    runningInstances: 0,
    alwaysOnRuntimes: 0,
    needsYou: 0,
    hold: null,
    removeAfterOfflineMs: null,
    hostname: "spark-1",
    fabrics: [],
    gpus: [{ vendor: "nvidia", name: "GB10" }],
    secretNames: [],
    ...overrides,
  };
}

async function mount(search: { step?: string } = {}, steps: Steps = NONE) {
  state.search = search;
  state.steps = steps;
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
  await screen.findByRole("navigation", { name: "dashboard:welcome.stepsLabel" });
}

function callsOf(name: string) {
  return state.calls.filter((call) => call.name === name).map((call) => call.input);
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  state.search = {};
  state.steps = null;
  state.navigations = [];
  state.calls = [];
  state.nodes = [];
  state.codes = [];
  state.runtimes = [];
  state.pools = [];
  state.minted = 0;
});

describe("Welcome", () => {
  it("puts the first step not done in the URL, once", async () => {
    await mount({}, { ...NONE, node: true });
    await waitFor(() =>
      expect(state.navigations).toEqual([
        {
          to: "/$lang/welcome",
          params: { lang: "en-US" },
          search: { step: "runtime" },
          replace: true,
        },
      ]),
    );
    // No step body until the step is pinned: progress refreshes never move the person.
    expect(screen.queryByRole("heading", { name: "dashboard:welcome.node.title" })).toBeNull();
  });

  it("marks done steps and shows the chosen one", async () => {
    await mount({ step: "runtime" }, { ...NONE, node: true });
    const nav = screen.getByRole("navigation", { name: "dashboard:welcome.stepsLabel" });
    const links = await waitFor(() => {
      const found = within(nav).getAllByRole("link");
      expect(found[0]?.textContent).toContain("dashboard:welcome.doneSr");
      return found;
    });
    expect(links).toHaveLength(5);
    expect(links[1]?.getAttribute("aria-current")).toBe("step");
    expect(links[1]?.getAttribute("href")).toBe("/$lang/welcome?step=runtime");
    expect(
      await screen.findByRole("heading", { name: "dashboard:welcome.runtime.title" }),
    ).toBeTruthy();
    // Server detection is not built: the step offers New runtime, nothing "found".
    expect(screen.getByText("dashboard:welcome.runtime.noDetection")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /dashboard:welcome.runtime.presetAction/ })
        .getAttribute("href"),
    ).toBe("/$lang/runtimes/new");
    // Visiting Welcome counts as offering it: the Overview stops sending this tab here.
    expect(window.sessionStorage.getItem("wsmp:welcome-offered")).toBe("true");
  });

  it("skips to the next step and goes back", async () => {
    await mount({ step: "pool" });
    fireEvent.click(screen.getByRole("button", { name: /dashboard:welcome.skip$/ }));
    fireEvent.click(screen.getByRole("button", { name: /dashboard:welcome.back/ }));
    expect(state.navigations).toEqual([
      { to: "/$lang/welcome", params: { lang: "en-US" }, search: { step: "agent" } },
      { to: "/$lang/welcome", params: { lang: "en-US" }, search: { step: "runtime" } },
    ]);
  });

  it("mints a single-use code, offers a new one, and turns green when the node connects", async () => {
    await mount({ step: "node" });
    fireEvent.click(screen.getByRole("button", { name: /dashboard:welcome.node.mint/ }));
    expect(await screen.findByText(/--code code-1/)).toBeTruthy();
    expect(callsOf("nodes.enrollmentCodes.create")).toEqual([{ ttlHours: 1, maxUses: 1 }]);
    expect(screen.getByText(/dashboard:nodes.add.expiresIn:(59:\d\d|1:00:00)/)).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.add.machineSteps.trust")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("dashboard:nodes.add.waiting");

    // New code: a fresh code, and the one it replaces is revoked.
    fireEvent.click(screen.getByRole("button", { name: /dashboard:nodes.add.newCode/ }));
    expect(await screen.findByText(/--code code-2/)).toBeTruthy();
    await waitFor(() =>
      expect(callsOf("nodes.enrollmentCodes.revoke")).toEqual([{ codeId: "code-1" }]),
    );

    // The node enrolls: its name and hardware show, in green.
    state.codes = [codeView("code-2", [{ nodeId: "n1", slug: "spark-1", usedAt: FUTURE }])];
    state.nodes = [node()];
    const joined = await screen.findByText(
      "dashboard:nodes.add.joined:spark-1",
      {},
      { timeout: 8_000 },
    );
    const row = joined.closest("li");
    await waitFor(() => expect(row?.getAttribute("data-online")).toBe("true"));
    expect(row?.textContent).toContain("GB10");
    expect(row?.textContent).toContain("dashboard:nodes.hardwareKind.discrete");
  });

  it("creates a pool from a served model in one click, with a free slug", async () => {
    state.runtimes = [
      {
        id: "r1",
        name: "vLLM",
        slug: "vllm",
        modelType: "LLM",
        models: ["Qwen/Qwen3-32B"],
      },
    ];
    state.pools = [{ id: "p0", slug: "qwen3-32b", callableIds: ["alex/qwen3-32b"], members: [] }];
    await mount({ step: "pool" });
    expect(await screen.findByText("alex/qwen3-32b")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "dashboard:welcome.pool.createNamed:qwen3-32b-2" }),
    );
    await waitFor(() =>
      expect(callsOf("pools.create")).toEqual([
        {
          name: "Qwen/Qwen3-32B",
          slug: "qwen3-32b-2",
          type: "LLM",
          members: [{ runtimeId: "r1", model: "Qwen/Qwen3-32B" }],
        },
      ]),
    );
  });

  it("says what to do when no model is served yet", async () => {
    await mount({ step: "pool" });
    expect(await screen.findByText("dashboard:welcome.pool.noModels")).toBeTruthy();
  });

  it("shows the MCP URL, OAuth and a first prompt naming your node", async () => {
    state.nodes = [node()];
    await mount({ step: "agent" });
    expect(await screen.findByText("https://proxy.test/mcp")).toBeTruthy();
    expect(screen.getByText("dashboard:welcome.agent.oauthHint")).toBeTruthy();
    expect(await screen.findByText("dashboard:welcome.agent.promptNode:spark-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: /access:agents.create/ })).toBeTruthy();
  });

  it("shows the base URL with a curl example and finishes to the Overview", async () => {
    state.pools = [{ id: "p0", slug: "chat", callableIds: ["alex/chat"], members: [] }];
    await mount({ step: "apiKey" });
    expect(await screen.findByText("https://proxy.test/v1")).toBeTruthy();
    expect(await screen.findByText(/"model": "alex\/chat"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dashboard:welcome.finish/ }));
    await waitFor(() =>
      expect(state.navigations).toEqual([{ to: "/$lang/overview", params: { lang: "en-US" } }]),
    );
    expect(callsOf("settings.onboarding.complete")).toHaveLength(1);
  });

  it("skips the whole setup", async () => {
    await mount({ step: "node" });
    fireEvent.click(screen.getByRole("button", { name: "dashboard:welcome.skipSetup" }));
    await waitFor(() =>
      expect(state.navigations).toEqual([{ to: "/$lang/overview", params: { lang: "en-US" } }]),
    );
    expect(callsOf("settings.onboarding.complete")).toHaveLength(1);
  });
});
