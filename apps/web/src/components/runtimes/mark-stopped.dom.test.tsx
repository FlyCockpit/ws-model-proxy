// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mark as stopped: who sees the action, the evidence in its dialog, and what it sends. */

const state = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  fail: false,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join("|")}` : key,
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

const RUNTIME = {
  id: "rt-1",
  instanceList: [
    {
      id: "inst-1",
      phase: "STOPPING",
      phaseChangedAt: "2026-10-07T10:00:00.000Z",
      needsOperator: "MARK_STOPPED",
      ranks: [
        {
          nodeNumber: 1,
          nodeId: "node-1",
          nodeSlug: "box",
          port: 30001,
          reserved: "HELD",
          unitName: "u",
          nodeConnection: { state: "OFFLINE", since: "2026-10-07T09:00:00.000Z" },
          lastStopCheck: {
            at: "2026-10-07T10:05:00.000Z",
            proven: false,
            errorCode: null,
          },
        },
        {
          nodeNumber: 2,
          nodeId: "node-2",
          nodeSlug: "other",
          port: 30001,
          reserved: "HELD",
          unitName: "u",
          nodeConnection: { state: "ONLINE", since: "2026-10-07T08:00:00.000Z" },
          lastStopCheck: null,
        },
      ],
    },
  ],
};

vi.mock("@/utils/orpc", () => ({
  orpc: {
    runtimes: {
      key: () => ["runtimes"],
      get: {
        queryOptions: () => ({
          queryKey: ["runtimes", "get"],
          queryFn: async () => RUNTIME,
        }),
      },
      instances: {
        markStopped: {
          mutationOptions: () => ({
            mutationFn: async (input: Record<string, unknown>) => {
              state.calls.push(input);
              if (state.fail) throw new Error("refused");
              return {};
            },
          }),
        },
        releaseUnproven: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      },
      releaseRequests: {
        approve: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
        decline: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
      },
    },
    nodes: { key: () => ["nodes"] },
    pools: { key: () => ["pools"] },
    models: { key: () => ["models"] },
    activity: { needsYou: { key: () => ["activity", "needsYou"] } },
  },
}));

import { RunsHereCard } from "@/components/nodes/node-info-cards";
import type { NodeDetail } from "@/components/nodes/node-types";
import { MarkStoppedAction } from "./mark-stopped";

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { invalidate };
}

const ACTION = "dashboard:runtime.markStopped.action";
const CONFIRM = "dashboard:runtime.markStopped.confirm";

beforeEach(() => {
  state.calls = [];
  state.fail = false;
  state.toast.success.mockReset();
  state.toast.error.mockReset();
});
afterEach(cleanup);

describe("MarkStoppedAction", () => {
  it("asks first, shows the evidence, then marks the instance stopped and refreshes", async () => {
    const { invalidate } = mount(<MarkStoppedAction runtimeId="rt-1" instanceId="inst-1" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    const dialog = screen.getByRole("dialog", { name: "dashboard:runtime.markStopped.title" });
    expect(within(dialog).getByText("dashboard:runtime.markStopped.description")).toBeTruthy();
    // Evidence: when the stop was asked for, each node's connection and its last check.
    await within(dialog).findByText("dashboard:runtime.markStopped.evidence.stopRequested");
    expect(
      within(dialog).getByText("dashboard:runtime.markStopped.evidence.node:box"),
    ).toBeTruthy();
    expect(within(dialog).getByText("dashboard:runtime.markStopped.evidence.offline")).toBeTruthy();
    expect(within(dialog).getByText("dashboard:runtime.markStopped.evidence.online")).toBeTruthy();
    expect(
      within(dialog).getByText("dashboard:runtime.markStopped.evidence.checkNotProven"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("dashboard:runtime.markStopped.evidence.checkNone"),
    ).toBeTruthy();
    expect(state.calls).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText("dashboard:runtime.markStopped.noteLabel"), {
      target: { value: "  checked: no process, port free  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM }));
    await waitFor(() =>
      expect(state.calls).toEqual([
        { instanceId: "inst-1", note: "checked: no process, port free" },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.toast.success).toHaveBeenCalledWith("dashboard:runtime.markStopped.done");
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

  it("leaves an empty note out and sends a node number for one node's part", async () => {
    mount(<MarkStoppedAction runtimeId="rt-1" instanceId="inst-1" nodeNumber={2} />);
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    const dialog = screen.getByRole("dialog");
    // Only that node's evidence.
    await within(dialog).findByText("dashboard:runtime.markStopped.evidence.node:other");
    expect(
      within(dialog).queryByText("dashboard:runtime.markStopped.evidence.node:box"),
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(state.calls).toEqual([{ instanceId: "inst-1", nodeNumber: 2 }]));
  });

  it("keeps the dialog open with an error when the server refuses", async () => {
    state.fail = true;
    mount(<MarkStoppedAction runtimeId="rt-1" instanceId="inst-1" />);
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(state.toast.success).not.toHaveBeenCalled();
  });

  it("refuses a note over 500 characters without calling the server", async () => {
    mount(<MarkStoppedAction runtimeId="rt-1" instanceId="inst-1" />);
    fireEvent.click(screen.getByRole("button", { name: ACTION }));
    fireEvent.change(screen.getByLabelText("dashboard:runtime.markStopped.noteLabel"), {
      target: { value: "x".repeat(501) },
    });
    fireEvent.click(screen.getByRole("button", { name: CONFIRM }));
    await screen.findByText("dashboard:runtime.markStopped.noteTooLong");
    expect(state.calls).toEqual([]);
  });
});

describe("RunsHereCard", () => {
  function node(instances: Array<Record<string, unknown>>): NodeDetail {
    return {
      instances,
      heldDefinitions: [],
      detectedServers: [],
      detectedAt: null,
    } as unknown as NodeDetail;
  }
  const part = {
    instanceId: "inst-1",
    runtimeId: "rt-1",
    runtimeSlug: "llm",
    nodeNumber: 1,
    nodeCount: 1,
    phase: "STOPPING",
    reserved: "HELD",
    needsOperator: "MARK_STOPPED",
  };

  it("offers Mark as stopped only while the instance needs it and this part is held", () => {
    mount(
      <RunsHereCard
        lang="en-US"
        node={node([
          part,
          { ...part, instanceId: "inst-2", needsOperator: null },
          { ...part, instanceId: "inst-3", reserved: "HELD_UNKNOWN" },
          { ...part, instanceId: "inst-4", needsOperator: "STEP" },
        ])}
      />,
    );
    expect(screen.getAllByText("dashboard:runtime.needsOperator.MARK_STOPPED")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: ACTION })).toHaveLength(1);
    expect(screen.getByText("dashboard:nodes.runs.needsYou")).toBeTruthy();
    // The part already marked stopped offers the person-only release instead.
    expect(
      screen.getAllByRole("button", { name: "dashboard:runtime.releaseUnproven.action" }),
    ).toHaveLength(1);
  });
});
