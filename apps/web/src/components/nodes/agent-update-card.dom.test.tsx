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

import enDashboard from "@/locales/en-US/dashboard.json";
import esDashboard from "@/locales/es-MX/dashboard.json";

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
    availableVersion: null,
    availableVersionAhead: false,
    newerThanServer: false,
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
            strategy: "self-replace",
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
            strategy: "self-replace",
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

  it("says Updating, not Up to date, while the new build has not confirmed", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          version: "0.4.3",
          outdated: false,
          latest: {
            id: "u-1",
            phase: "restarting",
            reason: null,
            detail: null,
            fromVersion: "0.4.2",
            toVersion: "0.4.3",
            force: false,
            strategy: "self-replace",
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:00:05.000Z",
            endedAt: null,
          },
        })}
      />,
    );
    expect(screen.getByText(`${K}.updatingBadge`)).toBeTruthy();
    expect(screen.queryByText(`${K}.current`)).toBeNull();
  });

  it("drops an old success once the node runs another version", () => {
    const confirmed = {
      id: "u-1",
      phase: "confirmed" as const,
      reason: null,
      detail: null,
      fromVersion: "0.4.2",
      toVersion: "0.4.3",
      force: false,
      strategy: "self-replace",
      createdAt: "2026-10-28T10:00:00.000Z",
      updatedAt: "2026-10-28T10:01:00.000Z",
      endedAt: "2026-10-28T10:01:00.000Z",
    };
    const { unmount } = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({ version: "0.4.3", outdated: false, latest: confirmed })}
      />,
    );
    expect(screen.getByText(`${K}.confirmed`, { exact: false })).toBeTruthy();
    unmount();
    wrap(<AgentUpdatePanel server={server} view={nodeView({ latest: confirmed })} />);
    expect(screen.queryByText(`${K}.confirmed`, { exact: false })).toBeNull();
    expect(screen.getByText(`${K}.outdated`)).toBeTruthy();
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
            strategy: "self-replace",
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
            strategy: "self-replace",
            createdAt: "2026-10-28T10:00:00.000Z",
            updatedAt: "2026-10-28T10:05:00.000Z",
            endedAt: "2026-10-28T10:05:00.000Z",
          },
        })}
      />,
    );
    expect(screen.getByText(new RegExp(`"phase":"${K}.stuck.restarting"`))).toBeTruthy();
  });

  it("offers Install anyway after a Homebrew tap refusal, sending that version", async () => {
    const refused = {
      id: "u-1",
      phase: "refused",
      reason: "version_mismatch",
      detail: "the Homebrew tap `flycockpit/tap` has wsmp 0.4.4, not 0.4.3",
      fromVersion: "0.4.2",
      toVersion: "0.4.3",
      force: false,
      strategy: "homebrew",
      createdAt: "2026-10-29T10:00:00.000Z",
      updatedAt: "2026-10-29T10:00:05.000Z",
      endedAt: "2026-10-29T10:00:05.000Z",
    } as const;
    const homebrew = {
      build: {
        commit: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        installMethod: "homebrew",
        target: "aarch64-apple-darwin",
      },
      selfUpdate: {
        strategies: ["homebrew"],
        instancesSurvive: false,
        remote: "allowed",
      },
      latest: refused,
    } as unknown as Partial<NodeAgentUpdateView>;
    // Not offered by the server (an older wsmp, say): no button.
    const { unmount } = wrap(<AgentUpdatePanel server={server} view={nodeView(homebrew)} />);
    // The tap's version, before anything is installed: not "a downloaded binary".
    expect(screen.getByText(`${K}.homebrewReason.version_mismatch_refused`)).toBeTruthy();
    expect(screen.queryByText(`${K}.reason.version_mismatch`)).toBeNull();
    expect(screen.queryByRole("button", { name: /anyway\.button/ })).toBeNull();
    unmount();

    // After `brew upgrade` switched the keg: never "nothing was installed".
    const failed = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({ ...homebrew, latest: { ...refused, phase: "failed" } })}
      />,
    );
    expect(screen.getByText(`${K}.homebrewReason.version_mismatch_failed`)).toBeTruthy();
    expect(screen.queryByText(`${K}.reason.version_mismatch`)).toBeNull();
    failed.unmount();

    // A self-replace mismatch is the downloaded binary's (checked before the swap).
    const selfReplace = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: { ...refused, phase: "failed", strategy: "self-replace" },
        } as Partial<NodeAgentUpdateView>)}
      />,
    );
    expect(screen.getByText(`${K}.reason.version_mismatch`)).toBeTruthy();
    selfReplace.unmount();

    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({ ...homebrew, availableVersion: "0.4.4", availableVersionAhead: true })}
      />,
    );
    const values = JSON.stringify({ version: "0.4.4", server: "0.4.3", slug: "spark-1" });
    // The tap is ahead of the server: upgrading the server is the advice.
    expect(screen.getByText(`${K}.anyway.offer(${values})`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${K}.anyway.button(${values})` }));
    expect(await screen.findByText(`${K}.anyway.risk(${values})`)).toBeTruthy();
    expect(screen.getByText(`${K}.anyway.description(${values})`)).toBeTruthy();
    expect(startFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `${K}.anyway.confirm(${values})` }));
    await vi.waitFor(() =>
      expect(startFn).toHaveBeenCalledWith({ nodeId: "node-1", version: "0.4.4" }),
    );
  });

  it("words a past attempt by the strategy it used, not by how the node is installed now", () => {
    const failed = {
      id: "u-1",
      phase: "failed",
      reason: "version_mismatch",
      detail: null,
      fromVersion: "0.4.2",
      toVersion: "0.4.3",
      force: false,
      createdAt: "2026-10-29T10:00:00.000Z",
      updatedAt: "2026-10-29T10:00:05.000Z",
      endedAt: "2026-10-29T10:00:05.000Z",
    } as const;
    const homebrewNow = {
      build: { commit: null, installMethod: "homebrew", target: "aarch64-apple-darwin" },
      selfUpdate: { strategies: ["homebrew"], instancesSurvive: false, remote: "allowed" },
    } as const;
    // A Homebrew attempt, then reinstalled with the install script: still Homebrew's copy.
    // The repair the server gives follows the current install (the script's), next to it.
    const scriptRepair = "curl -fsSL https://example.test/install.sh | sh";
    const reinstalledByScript = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: { ...failed, strategy: "homebrew" },
          manualCommand: scriptRepair,
        })}
      />,
    );
    expect(screen.getByText(`${K}.homebrewReason.version_mismatch_failed`)).toBeTruthy();
    expect(screen.queryByText(`${K}.reason.version_mismatch`)).toBeNull();
    expect(screen.getByText(scriptRepair)).toBeTruthy();
    expect(screen.queryByText(/brew reinstall/)).toBeNull();
    reinstalledByScript.unmount();
    // A self-replace attempt, then reinstalled with Homebrew: still the downloaded binary's.
    const reinstalledByBrew = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          ...homebrewNow,
          latest: { ...failed, strategy: "self-replace" },
        } as unknown as Partial<NodeAgentUpdateView>)}
      />,
    );
    expect(screen.getByText(`${K}.reason.version_mismatch`)).toBeTruthy();
    expect(screen.queryByText(`${K}.homebrewReason.version_mismatch_failed`)).toBeNull();
    reinstalledByBrew.unmount();
    // A timed-out Homebrew attempt on a node installed by script now: no rollback.
    const timedOut = wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          latest: { ...failed, phase: "timed_out", reason: "restarting", strategy: "homebrew" },
        })}
      />,
    );
    expect(screen.getByText(`${K}.timedOutHomebrew`)).toBeTruthy();
    timedOut.unmount();
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          ...homebrewNow,
          latest: { ...failed, phase: "timed_out", reason: "restarting", strategy: "self-replace" },
        } as unknown as Partial<NodeAgentUpdateView>)}
      />,
    );
    expect(screen.getByText(`${K}.timedOut`)).toBeTruthy();
  });

  it("words a Homebrew failure without claiming which version is installed", () => {
    const en = enDashboard.nodes.agentUpdate;
    const es = esDashboard.nodes.agentUpdate;
    // The node also reports it when the installed version could not be read back.
    expect(en.homebrewReason.version_mismatch_failed).toMatch(/could not be checked/);
    expect(en.homebrewReason.version_mismatch_failed).not.toMatch(/installed a different/);
    expect(es.homebrewReason.version_mismatch_failed).toMatch(/no se pudo comprobar/);
    // Install anyway installs the tap's version; Homebrew cannot roll back.
    expect(en.policy.help.ALLOWED).not.toMatch(/only ever/);
    expect(en.policy.help.ALLOWED).toMatch(/Install anyway/);
    expect(es.policy.help.ALLOWED).toMatch(/Instalar de todos modos/);
    expect(en.description).toMatch(/except for a Homebrew install/);
    expect(es.description).toMatch(/salvo una instalación de Homebrew/);
  });

  it("does not tell the owner to upgrade the server to a tap that is behind it", async () => {
    const homebrew = {
      version: "0.4.1",
      build: { commit: null, installMethod: "homebrew", target: "aarch64-apple-darwin" },
      selfUpdate: { strategies: ["homebrew"], instancesSurvive: false, remote: "allowed" },
      availableVersion: "0.4.2",
      availableVersionAhead: false,
      latest: {
        id: "u-1",
        phase: "refused",
        reason: "version_mismatch",
        detail: "the Homebrew tap `flycockpit/tap` has wsmp 0.4.2, not 0.4.3 yet",
        fromVersion: "0.4.1",
        toVersion: "0.4.3",
        force: false,
        strategy: "homebrew",
        createdAt: "2026-10-29T10:00:00.000Z",
        updatedAt: "2026-10-29T10:00:05.000Z",
        endedAt: "2026-10-29T10:00:05.000Z",
      },
    } as unknown as Partial<NodeAgentUpdateView>;
    wrap(<AgentUpdatePanel server={server} view={nodeView(homebrew)} />);
    const values = JSON.stringify({ version: "0.4.2", server: "0.4.3", slug: "spark-1" });
    expect(screen.getByText(`${K}.anyway.offerBehind(${values})`)).toBeTruthy();
    expect(screen.queryByText(`${K}.anyway.offer(${values})`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${K}.anyway.button(${values})` }));
    expect(await screen.findByText(`${K}.anyway.riskBehind(${values})`)).toBeTruthy();
    expect(screen.getByText(`${K}.anyway.descriptionBehind(${values})`)).toBeTruthy();
    expect(screen.queryByText(`${K}.anyway.risk(${values})`)).toBeNull();
  });

  it("says a node newer than the server is newer, not outdated", () => {
    wrap(
      <AgentUpdatePanel
        server={server}
        view={nodeView({
          version: "0.4.4",
          outdated: false,
          newerThanServer: true,
          canUpdate: false,
          blockedReason: "agent_update_current",
        })}
      />,
    );
    expect(screen.getByText(`${K}.newerThanServer`)).toBeTruthy();
    expect(screen.queryByText(`${K}.current`)).toBeNull();
    expect(screen.queryByText(`${K}.outdated`)).toBeNull();
    expect(screen.queryByRole("button", { name: `${K}.update` })).toBeNull();
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
