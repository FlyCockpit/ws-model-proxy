// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Runtime overview: an instance whose stop is not confirmed offers Mark as stopped. */

const state = vi.hoisted(() => ({
  kind: "STARTABLE" as "STARTABLE" | "ALWAYS_ON",
  extra: [] as Array<Record<string, unknown>>,
  refusedOn: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: { component: ComponentType }) => ({
      options,
      useParams: () => ({ lang: "en-US", runtimeId: "rt-1" }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  // Reservation copy shows the values it interpolates; everything else its key.
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.startsWith("dashboard:runtime.reservation") ||
      key === "dashboard:runtime.waitingToRestart"
        ? `${key} ${JSON.stringify(values)}`
        : key.startsWith("dashboard:runtime.refusals.")
          ? `${key} (copy)`
          : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Dialogs are not under test here (they need matchMedia and portals).
vi.mock("@ws-model-proxy/ui/components/responsive-dialog", () => ({
  // Mounted only while open (the page renders it for an open start): its content and footer.
  ResponsiveDialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("@/components/access/confirm-action", () => ({ ConfirmAction: () => null }));

function instance(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    handle: `i-${id}`,
    versionNumber: 1,
    desiredState: "STOPPED",
    phase: "STOPPING",
    phaseReason: null,
    phaseChangedAt: "2026-10-07T10:00:00.000Z",
    needsOperator: null,
    ranks: [],
    reservations: [],
    openSteps: [],
    live: { running: null, waiting: null, kvUsage: null, slots: null, at: null },
    ...overrides,
  };
}

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      get: {
        queryOptions: () => ({
          queryKey: ["runtimes", "get", state.kind],
          queryFn: async () => ({
            id: "rt-1",
            name: "LLM",
            slug: "llm",
            kind: state.kind,
            service: false,
            origin: "SERVER",
            currentVersion: { id: "v-1", version: 1 },
            refusedOn: state.refusedOn,
            current: { spec: { launch: { groupSize: 1 } } },
            servedModels: [],
            shares: [],
            instanceList: [
              instance("stuck", { needsOperator: "MARK_STOPPED" }),
              instance("stopping", {}),
              instance("ready", { phase: "READY", desiredState: "RUNNING" }),
              ...state.extra,
            ],
          }),
        }),
      },
      // A preview refused for a reservation (contracts/refusals.ts `reservation`).
      start: {
        mutationOptions: () => ({
          mutationFn: async () => ({
            mode: "preview",
            preview: {
              fingerprint: "fp",
              starts: [],
              stops: [],
              kept: [],
              holds: [],
              warnings: [],
              refusals: [
                {
                  reason: "not_enough_memory",
                  subjectId: "node-w2",
                  message: "Reservation 1 (labels ds-worker) cannot be placed: …",
                  reservation: { index: 0, labels: ["ds-worker"], nodeSlug: "w2" },
                },
              ],
            },
          }),
        }),
      },
      stop: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      delete: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      shares: {
        create: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
        delete: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      },
      instances: {
        markStopped: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      },
    },
    nodes: {
      key: () => ["nodes"],
      list: {
        queryOptions: () => ({ queryKey: ["nodes", "list"], queryFn: async () => ({ nodes: [] }) }),
      },
    },
    pools: { key: () => ["pools"] },
    models: { key: () => ["models"] },
    activity: { needsYou: { key: () => ["activity", "needsYou"] } },
  },
}));

import { Route } from "./index";

const Component = Route.options.component as ComponentType & {
  preload?: () => Promise<unknown>;
};

beforeAll(async () => {
  await Component.preload?.();
}, 30_000);

afterEach(() => {
  cleanup();
  // Reset here, not at the end of a test: a failed test must not leak its kind.
  state.kind = "STARTABLE";
  state.extra = [];
  state.refusedOn = [];
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("runtime overview instances", () => {
  it("offers no Start, Stop or Restart for an always-on runtime", async () => {
    state.kind = "ALWAYS_ON";
    mount();
    await screen.findByText("i-stuck");
    for (const name of ["start", "stop", "restart"])
      expect(screen.queryByRole("button", { name: `dashboard:runtime.${name}` })).toBeNull();
  });

  it("links metrics by version and shows the sharing card", async () => {
    mount();
    await screen.findByText("i-stuck");
    expect(screen.getByText("dashboard:runtime.metrics.compare")).toBeTruthy();
    expect(screen.getByText("dashboard:runtime.sharing.title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "dashboard:runtime.start" })).toBeTruthy();
  });

  it("shows Stop not confirmed, its explanation and Mark as stopped only on that instance", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
    const stuck = (await screen.findByText("i-stuck")).closest("li");
    if (!stuck) throw new Error("no row");
    expect(within(stuck).getByText("dashboard:runtime.needsOperator.MARK_STOPPED")).toBeTruthy();
    expect(within(stuck).getByRole("button", { name: "dashboard:help.ariaLabel" })).toBeTruthy();
    expect(
      within(stuck).getByRole("button", { name: "dashboard:runtime.markStopped.action" }),
    ).toBeTruthy();
    // One action in the whole list: the other stopping and the ready instance have none.
    expect(
      screen.getAllByRole("button", { name: "dashboard:runtime.markStopped.action" }),
    ).toHaveLength(1);
    expect(screen.queryAllByText("dashboard:runtime.needsOperator.MARK_STOPPED")).toHaveLength(1);
  });
});

describe("runtime overview refused nodes", () => {
  it("lists a node that refused a version as refused, with its reason, path and version", async () => {
    state.refusedOn = [
      {
        nodeId: "n-1",
        nodeSlug: "t420",
        versionId: "v-1",
        reason: "invalid",
        detail: "launch.argv",
      },
      { nodeId: "n-2", nodeSlug: "t530", versionId: "v-0", reason: "weird_code", detail: null },
    ];
    mount();
    await screen.findByText("t420");
    expect(screen.getAllByText("dashboard:runtime.refusedOn.refused")).toHaveLength(2);
    expect(screen.getByText("dashboard:runtime.refusedOn.currentVersion")).toBeTruthy();
    expect(screen.getByText("dashboard:runtime.refusedOn.olderVersion")).toBeTruthy();
    expect(screen.getByText("dashboard:runtime.defineReject.invalid")).toBeTruthy();
    expect(screen.getByText("dashboard:runtime.defineReject.other")).toBeTruthy();
    expect(screen.getByText("launch.argv").tagName).toBe("CODE");
  });

  it("shows nothing when no node refused", async () => {
    mount();
    await screen.findByText("i-stuck");
    expect(screen.queryByText("dashboard:runtime.refusedOn.refused")).toBeNull();
  });
});

describe("runtime overview reservations", () => {
  it("says which reservation a start preview refusal is about", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "dashboard:runtime.start" }));
    fireEvent.click(await screen.findByRole("button", { name: "dashboard:runtime.preview" }));
    const line = await screen.findByText(/dashboard:runtime\.reservationRefusalNode/);
    expect(line.textContent).toContain('"labels":"ds-worker"');
    expect(line.textContent).toContain('"node":"w2"');
    expect(line.textContent).toContain('"number":1');
    expect(line.textContent).toContain("dashboard:runtime.refusals.not_enough_memory");
  });

  it("describes a reservation by its claim: held, held until confirmed, or not held", async () => {
    const reservation = (reserved: string) => ({
      index: 0,
      nodeId: "node-w1",
      nodeSlug: "w1",
      labels: ["ds-worker"],
      memoryGb: 100,
      reserved,
      nodeConnection: null,
    });
    state.extra = [
      instance("held", {
        phase: "READY",
        desiredState: "RUNNING",
        reservations: [reservation("HELD")],
      }),
      instance("unknown", { phase: "STOPPED", reservations: [reservation("HELD_UNKNOWN")] }),
      instance("failed", {
        phase: "FAILED",
        desiredState: "RUNNING",
        reservations: [reservation("RELEASED")],
      }),
    ];
    mount();
    const row = async (handle: string) => {
      const found = (await screen.findByText(handle)).closest("li");
      if (!found) throw new Error(`no row ${handle}`);
      return found;
    };
    expect(
      within(await row("i-held")).getByText(/dashboard:runtime\.reservationHeld /),
    ).toBeTruthy();
    expect(
      within(await row("i-unknown")).getByText(/dashboard:runtime\.reservationUnconfirmed /),
    ).toBeTruthy();
    const failed = await row("i-failed");
    expect(within(failed).getByText(/dashboard:runtime\.reservationIdle /)).toBeTruthy();
    expect(within(failed).queryByText(/dashboard:runtime\.reservationHeld /)).toBeNull();
  });

  it("explains an automatic restart that waits, with the planner's actual reason", async () => {
    state.extra = [
      instance("waiting", {
        phase: "STOPPED",
        desiredState: "RUNNING",
        phaseReason: "waiting_node_offline",
      }),
    ];
    mount();
    const row = (await screen.findByText("i-waiting")).closest("li");
    if (!row) throw new Error("no row");
    // The specific copy names the refusal's own reason (a node offline here), never memory.
    expect(
      within(row).getByText(
        'dashboard:runtime.waitingToRestart {"reason":"dashboard:runtime.refusals.node_offline (copy)"}',
      ),
    ).toBeTruthy();
    expect(within(row).queryByText(/not_enough_memory/)).toBeNull();
  });

  it("explains a wait without copy for its reason neutrally, and nothing once it runs", async () => {
    state.extra = [
      instance("odd", { phase: "STOPPED", desiredState: "RUNNING", phaseReason: "waiting_9" }),
      instance("going", { phase: "STARTING", phaseReason: "waiting_node_offline" }),
    ];
    mount();
    const odd = (await screen.findByText("i-odd")).closest("li");
    if (!odd) throw new Error("no row");
    expect(within(odd).getByText("dashboard:runtime.waitingToRestartNeutral")).toBeTruthy();
    const going = (await screen.findByText("i-going")).closest("li");
    if (!going) throw new Error("no row");
    expect(within(going).queryByText(/waitingToRestart/)).toBeNull();
  });
});
