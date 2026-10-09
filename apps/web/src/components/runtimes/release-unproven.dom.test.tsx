// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Release without proof: the dialog's warning and reason, an agent's findings, what it sends. */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; input: Record<string, unknown> }>,
  fail: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const values = Object.entries(options ?? {})
        .filter(([name]) => name !== "defaultValue")
        .map(([, value]) => String(value));
      return values.length > 0 ? `${key}:${values.join("|")}` : key;
    },
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({ toast: state.toast }));

// The alert dialog itself is not under test (portals and focus traps): it shows its parts.
vi.mock("@/components/access/confirm-action", () => ({
  ConfirmAction: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
    children,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => void;
    children?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{description}</p>
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const rank = (nodeNumber: number, overrides: Record<string, unknown> = {}) => ({
  nodeNumber,
  nodeId: `node-${nodeNumber}`,
  nodeSlug: nodeNumber === 1 ? "box" : "spark",
  port: 30000 + nodeNumber,
  reserved: "HELD_UNKNOWN",
  unitName: "u",
  nodeConnection: { state: "ONLINE", since: "2026-10-07T08:00:00.000Z" },
  lastStopCheck: { at: "2026-10-07T10:05:00.000Z", proven: false, errorCode: "status_running" },
  releasedUnproven: null,
  releaseRequestId: null,
  ...overrides,
});

const RUNTIME = {
  id: "rt-1",
  instanceList: [
    {
      id: "inst-1",
      phase: "STOPPED",
      needsOperator: null,
      ranks: [
        rank(1),
        rank(2, {
          nodeConnection: { state: "OFFLINE", since: "2026-10-07T09:00:00.000Z" },
          releaseRequestId: "req-1",
        }),
      ],
    },
  ],
};

const REQUESTS = {
  items: [
    {
      id: "req-1",
      instanceId: "inst-1",
      runtimeId: "rt-1",
      runtimeName: "Qwen",
      nodeNumber: 2,
      nodeId: "node-2",
      nodeSlug: "spark",
      state: "PENDING",
      agentName: "codex",
      findings: "<b>port</b> 30002 is free; trust me",
      evidence: [{ command: "ss -ltnp", output: "State Recv-Q" }],
      createdAt: "2026-10-07T10:10:00.000Z",
      expiresAt: "2026-10-08T10:10:00.000Z",
      decidedAt: null,
    },
  ],
};

function mutation(path: string) {
  return {
    mutationOptions: () => ({
      mutationFn: async (input: Record<string, unknown>) => {
        state.calls.push({ path, input });
        if (state.fail) throw new Error("refused");
        return {};
      },
    }),
  };
}

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      get: {
        queryOptions: () => ({ queryKey: ["runtimes", "get"], queryFn: async () => RUNTIME }),
      },
      instances: { releaseUnproven: mutation("releaseUnproven") },
      releaseRequests: {
        list: {
          queryOptions: () => ({
            queryKey: ["runtimes", "releaseRequests"],
            queryFn: async () => REQUESTS,
          }),
        },
        approve: mutation("approve"),
        decline: mutation("decline"),
      },
    },
    nodes: { key: () => ["nodes"] },
    pools: { key: () => ["pools"] },
    models: { key: () => ["models"] },
    activity: { needsYou: { key: () => ["activity", "needsYou"] } },
  },
}));

import { HeldPartsRelease, ReleaseUnprovenAction } from "./release-unproven";

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { invalidate };
}

const ACTION = "dashboard:runtime.releaseUnproven.action";
const REVIEW = "dashboard:runtime.releaseUnproven.review";
const CONFIRM = "dashboard:runtime.releaseUnproven.confirm";
const APPROVE = "dashboard:runtime.releaseUnproven.approve";

beforeEach(() => {
  state.calls = [];
  state.fail = false;
  state.toast.success.mockReset();
  state.toast.error.mockReset();
});
afterEach(cleanup);

describe("ReleaseUnprovenAction", () => {
  it("asks first, says what it does and why the stop is unproven, then releases and refreshes", async () => {
    const { invalidate } = mount(
      <ReleaseUnprovenAction runtimeId="rt-1" instanceId="inst-1" nodeNumber={1} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    const dialog = screen.getByRole("dialog", { name: "dashboard:runtime.releaseUnproven.title" });
    // Plain warning: frees the capacity, the old process may still run, check the node first.
    expect(within(dialog).getByText("dashboard:runtime.releaseUnproven.description")).toBeTruthy();
    // The current stop-proof reason: the node's status command says it is running.
    expect(
      await within(dialog).findByText("dashboard:runtime.releaseUnproven.reason.status_running"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("dashboard:runtime.releaseUnproven.place:box|30001"),
    ).toBeTruthy();
    // No agent request here: nothing to decline, no findings.
    expect(
      within(dialog).queryByRole("button", { name: "dashboard:runtime.releaseUnproven.decline" }),
    ).toBeNull();
    expect(state.calls).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { path: "releaseUnproven", input: { instanceId: "inst-1", nodeNumber: 1 } },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.toast.success).toHaveBeenCalledWith("dashboard:runtime.releaseUnproven.done");
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["runtimes"],
        ["nodes"],
        ["pools"],
        ["models"],
        ["activity", "needsYou"],
      ]),
    );
  });

  it("names an offline node as the reason", async () => {
    mount(<ReleaseUnprovenAction runtimeId="rt-1" instanceId="inst-1" nodeNumber={2} />);
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    expect(
      await screen.findByText("dashboard:runtime.releaseUnproven.reason.node_offline"),
    ).toBeTruthy();
  });

  it("shows an agent's findings as untrusted plain text; approving runs the same release", async () => {
    mount(
      <ReleaseUnprovenAction
        runtimeId="rt-1"
        instanceId="inst-1"
        nodeNumber={2}
        requestId="req-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: REVIEW }));
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(
        "dashboard:runtime.releaseUnproven.request.untrustedNamed:codex",
      ),
    ).toBeTruthy();
    // Text, never markup: the agent's tags are shown as typed.
    const findings = within(dialog).getByText("<b>port</b> 30002 is free; trust me");
    expect(findings.tagName).toBe("PRE");
    expect(findings.querySelector("b")).toBeNull();
    expect(within(dialog).getByText("ss -ltnp")).toBeTruthy();
    expect(within(dialog).getByText("State Recv-Q")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: APPROVE }));
    await waitFor(() =>
      expect(state.calls).toEqual([{ path: "approve", input: { requestId: "req-1" } }]),
    );
  });

  it("declines a request without releasing", async () => {
    mount(
      <ReleaseUnprovenAction
        runtimeId="rt-1"
        instanceId="inst-1"
        nodeNumber={2}
        requestId="req-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: REVIEW }));
    fireEvent.click(
      screen.getByRole("button", { name: "dashboard:runtime.releaseUnproven.decline" }),
    );
    await waitFor(() =>
      expect(state.calls).toEqual([{ path: "decline", input: { requestId: "req-1" } }]),
    );
    expect(state.toast.success).toHaveBeenCalledWith("dashboard:runtime.releaseUnproven.declined");
  });

  it("keeps the dialog open with an error when the server refuses", async () => {
    state.fail = true;
    mount(<ReleaseUnprovenAction runtimeId="rt-1" instanceId="inst-1" nodeNumber={1} />);
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(state.toast.success).not.toHaveBeenCalled();
  });
});

describe("HeldPartsRelease", () => {
  it("offers a release for each part marked stopped, and review where an agent asked", () => {
    mount(
      <HeldPartsRelease
        runtimeId="rt-1"
        instance={
          {
            ...RUNTIME.instanceList[0],
            ranks: [...RUNTIME.instanceList[0].ranks, rank(3, { reserved: "HELD" })],
          } as never
        }
      />,
    );
    expect(screen.getAllByRole("button", { name: ACTION })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: REVIEW })).toHaveLength(1);
    expect(screen.getByText("dashboard:runtime.releaseUnproven.requested")).toBeTruthy();
    // A part still waiting for its stop is not offered.
    expect(screen.queryByText("dashboard:runtime.releaseUnproven.place:spark|30003")).toBeNull();
  });

  it("shows nothing when no part is marked stopped", () => {
    mount(
      <HeldPartsRelease
        runtimeId="rt-1"
        instance={{ ...RUNTIME.instanceList[0], ranks: [rank(1, { reserved: "HELD" })] } as never}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
