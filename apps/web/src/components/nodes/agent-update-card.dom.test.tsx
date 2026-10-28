// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string | string[], options?: Record<string, unknown>) => {
      const first = Array.isArray(key) ? key[0] : key;
      return options ? `${first}(${JSON.stringify(options)})` : first;
    },
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/components/time-ago", () => ({
  TimeAgo: ({ value }: { value: string }) => <time>{value}</time>,
}));
const startFn = vi.fn();
const startAllFn = vi.fn();
vi.mock("@/utils/orpc", () => {
  const mutation = (fn?: (input: unknown) => unknown) => ({
    mutationOptions: (options?: object) => ({
      ...options,
      mutationFn: fn ?? (async () => ({})),
    }),
  });
  return {
    orpc: {
      nodes: {
        key: () => ["nodes"],
        agentUpdate: {
          start: mutation((input) => {
            startFn(input);
            return {};
          }),
          startAll: mutation((input) => {
            startAllFn(input);
            return {};
          }),
          stopAll: mutation(),
          setPolicy: mutation(),
        },
      },
    },
  };
});

import { AgentUpdateAllPanel } from "./agent-update-all-card";
import { AgentUpdatePanel } from "./agent-update-card";
import type { AgentUpdateOverview, NodeAgentUpdateView } from "./node-types";

afterEach(() => {
  cleanup();
  startFn.mockReset();
  startAllFn.mockReset();
});

const server: AgentUpdateOverview["server"] = {
  version: "0.4.3",
  commit: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceBuild: false,
};

/** Only the fields the panels read; the rest of a view is irrelevant here. */
function nodeView(overrides: Partial<NodeAgentUpdateView> = {}): NodeAgentUpdateView {
  const base = {
    nodeId: "node-1",
    slug: "spark-1",
    connection: "ONLINE",
    version: "0.4.2",
    build: {
      commit: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      installMethod: "script",
      target: "x86_64-unknown-linux-gnu",
    },
    wsl: false,
    outdated: true,
    policy: "ALLOWED",
    selfUpdate: { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" },
    canUpdate: true,
    blockedReason: null,
    manualCommand: null,
    runningInstances: [],
    latest: null,
  };
  return { ...base, ...overrides } as unknown as NodeAgentUpdateView;
}

function wrap(children: ReactNode) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const K = "dashboard:nodes.agentUpdate";

describe("AgentUpdatePanel", () => {
  it("shows the version, build, Outdated and an Update button", () => {
    wrap(<AgentUpdatePanel server={server} view={nodeView()} />);
    expect(screen.getByText(`${K}.outdated`)).toBeTruthy();
    expect(screen.getByText("0.4.2")).toBeTruthy();
    expect(screen.getByText("2222222")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${K}.update` }));
    return vi.waitFor(() => expect(startFn).toHaveBeenCalledWith({ nodeId: "node-1" }));
  });

  it("offers Force only when instances would stop, and lists exactly them", async () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          selfUpdate: { strategies: ["self-replace"], instancesSurvive: false, remote: "allowed" },
          runningInstances: [
            { id: "i-1", name: "embeddinggemma" },
            { id: "i-2", name: "ds41" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `${K}.updateNow` }));
    expect(await screen.findByText("embeddinggemma")).toBeTruthy();
    expect(screen.getByText("ds41")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${K}.forceConfirm({"count":2})` }));
    await vi.waitFor(() => expect(startFn).toHaveBeenCalledWith({ nodeId: "node-1", force: true }));
  });

  it("has no Force when instances survive the restart", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({ runningInstances: [{ id: "i-1", name: "embeddinggemma" }] })}
      />,
    );
    expect(screen.queryByRole("button", { name: `${K}.updateNow` })).toBeNull();
    expect(screen.getByText(`${K}.instancesKeepRunning`)).toBeTruthy();
  });

  it("tells a source build to run the command on the node", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          build: { commit: null, installMethod: "source", target: "x86_64-unknown-linux-gnu" },
          selfUpdate: { strategies: [], instancesSurvive: true, remote: "allowed" },
          canUpdate: false,
          manualCommand: "cargo install --git https://example.test/wsmp --rev abc wsmp",
        })}
      />,
    );
    expect(screen.getByText(`${K}.runOnNode`)).toBeTruthy();
    expect(screen.getByText(/cargo install --git/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: `${K}.update` })).toBeNull();
  });

  it("shows the install command for an agent too old to update itself", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          selfUpdate: null,
          canUpdate: false,
          manualCommand: "curl -fsSL https://example.test/install.sh | sh",
        })}
      />,
    );
    expect(screen.getByText(`${K}.tooOld`)).toBeTruthy();
    expect(screen.getByText(/install\.sh/)).toBeTruthy();
  });

  it("renders a rolled-back node's detail as plain text", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: {
            id: "u-1",
            phase: "rolled_back",
            reason: null,
            detail: "<b>panic</b> at definition sync",
            fromVersion: "0.4.2",
            toVersion: "0.4.3",
            force: false,
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:02:00.000Z",
            endedAt: "2026-10-28T10:02:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText(`${K}.rolledBackTitle`)).toBeTruthy();
    const detail = screen.getByLabelText(`${K}.nodeSaid`);
    expect(detail.textContent).toBe("<b>panic</b> at definition sync");
    expect(detail.querySelector("b")).toBeNull();
  });

  it("shows progress and no Update button while an update runs", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: {
            id: "u-1",
            phase: "downloading",
            reason: null,
            detail: null,
            fromVersion: "0.4.2",
            toVersion: "0.4.3",
            force: false,
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:00:05.000Z",
            endedAt: null,
          },
        })}
      />,
    );
    const current = screen.getByText(`${K}.step.downloading`).closest("li");
    expect(current?.getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: `${K}.update` })).toBeNull();
  });

  it("offers Force while the node waits for idle, forcing that update", async () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          selfUpdate: { strategies: ["self-replace"], instancesSurvive: false, remote: "allowed" },
          runningInstances: [{ id: "i-1", name: "embeddinggemma" }],
          latest: {
            id: "u-1",
            phase: "waiting_idle",
            reason: null,
            detail: null,
            fromVersion: "0.4.2",
            toVersion: "0.4.3",
            force: false,
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:00:05.000Z",
            endedAt: null,
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `${K}.updateNow` }));
    expect(await screen.findByText("embeddinggemma")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${K}.forceConfirm({"count":1})` }));
    await vi.waitFor(() => expect(startFn).toHaveBeenCalledWith({ nodeId: "node-1", force: true }));
  });

  it("says which phase a timed-out update was stuck in", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: {
            id: "u-1",
            phase: "timed_out",
            reason: "restarting",
            detail: null,
            fromVersion: null,
            toVersion: "0.4.3",
            force: false,
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:05:00.000Z",
            endedAt: "2026-10-28T10:05:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText(new RegExp(`"phase":"${K}.stuck.restarting"`))).toBeTruthy();
  });

  it("warns on WSL", () => {
    wrap(<AgentUpdatePanel server={server} view={nodeView({ wsl: true })} />);
    expect(screen.getByText(`${K}.wslWarning`)).toBeTruthy();
  });
});

describe("AgentUpdateAllPanel", () => {
  it("is hidden when nothing is outdated and there is no batch", () => {
    const { container } = wrap(
      <AgentUpdateAllPanel
        overview={{
          server,
          nodes: [nodeView({ outdated: false })],
          defaultCanaryNodeId: null,
          batch: null,
        }}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("names the untouched nodes after a stop and offers no Stop", () => {
    wrap(
      <AgentUpdateAllPanel
        overview={{
          server,
          nodes: [nodeView({ nodeId: "a", slug: "t420" }), nodeView({ nodeId: "b", slug: "t530" })],
          defaultCanaryNodeId: "a",
          batch: {
            id: "batch-1",
            state: "stopped",
            canaryNodeId: "a",
            nodeIds: ["a", "b"],
            currentNodeId: null,
            stoppedReason: "rolled_back",
            untouchedNodeIds: ["b"],
          },
        }}
      />,
    );
    expect(screen.getByText(`${K}.all.stoppedReason.rolled_back`)).toBeTruthy();
    expect(screen.getByText(`${K}.all.untouched({"count":1,"slugs":"t530"})`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: `${K}.all.stop` })).toBeNull();
  });

  it("preselects the server's canary and sends no canaryNodeId for it", async () => {
    wrap(
      <AgentUpdateAllPanel
        overview={{
          server,
          nodes: [nodeView({ nodeId: "a", slug: "t420" }), nodeView({ nodeId: "b", slug: "t530" })],
          defaultCanaryNodeId: "b",
          batch: null,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `${K}.all.start({"count":2})` }));
    expect(await screen.findByText(`${K}.all.canarySuggested({"slug":"t530"})`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${K}.all.confirm` }));
    await vi.waitFor(() => expect(startAllFn).toHaveBeenCalledWith({}));
  });

  it("offers Stop while a batch runs", () => {
    wrap(
      <AgentUpdateAllPanel
        overview={{
          server,
          nodes: [nodeView({ nodeId: "a", slug: "t420" })],
          defaultCanaryNodeId: null,
          batch: {
            id: "batch-1",
            state: "running",
            canaryNodeId: "a",
            nodeIds: ["a"],
            currentNodeId: "a",
            stoppedReason: null,
            untouchedNodeIds: [],
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: `${K}.all.stop` })).toBeTruthy();
    expect(screen.getByText(`${K}.all.canaryRunning({"slug":"t420"})`)).toBeTruthy();
  });
});
