// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  openCli: vi.fn(),
  endSession: vi.fn(),
  declineRequest: vi.fn(),
  tabs: [] as Array<Record<string, unknown>>,
  activeLocalId: null as string | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/terminal-pane", () => ({ TerminalPane: () => null }));

vi.mock("@/hooks/use-terminal-workspace", () => ({
  deviceId: (device: { id: string }) => device.id,
  deviceText: (device: Record<string, unknown>, key: string) => {
    const value = device[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  },
  useTerminalWorkspace: () => ({
    status: "open",
    identityReady: true,
    clis: [{ cliDeviceId: "cli-1", slug: "desk", publicKey: "key" }],
    cliTrust: { "cli-1": { status: "trusted", fingerprint: "ABCD EFGH" } },
    tabs: state.tabs,
    activeLocalId: state.activeLocalId,
    selectTab: () => undefined,
    detachTab: () => undefined,
    endSession: state.endSession,
    declineRequest: state.declineRequest,
    setReviewOutput: () => undefined,
    clearReviewCapture: () => undefined,
    devicesQuery: {
      data: state.devices,
      isPending: false,
      isError: false,
      refetch: async () => undefined,
    },
    labelFor: () => "desk",
    tabLabel: () => "desk",
    refreshClis: async () => undefined,
    openCli: state.openCli,
  }),
}));

import { TerminalWorkspaceView } from "./terminals-page";

const usableTerminal = {
  granted: true,
  deviceAllows: true,
  supported: true,
  live: true,
  available: true,
};

function device(overrides: Record<string, unknown>) {
  return {
    id: "cli-1",
    slug: "desk",
    name: null,
    reportedHostname: "desk-01.local",
    displayName: "desk-01.local",
    features: { terminal: usableTerminal },
    ...overrides,
  };
}

beforeAll(() => {
  // cmdk scrolls the selected item into view and observes its list size.
  Element.prototype.scrollIntoView ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  state.devices = [];
  state.openCli.mockReset();
  state.endSession.mockReset();
  state.declineRequest.mockReset();
  state.tabs = [];
  state.activeLocalId = null;
});

function openPicker() {
  fireEvent.click(screen.getAllByRole("button", { name: "dashboard:terminals.add" })[0]);
}

describe("TerminalWorkspaceView", () => {
  it("closes its dialogs while another dashboard page hides it", () => {
    const view = render(<TerminalWorkspaceView visible />);
    fireEvent.click(screen.getByRole("button", { name: "dashboard:terminals.identity.title" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Browser Back to another dashboard page: the portaled dialog must go.
    view.rerender(<TerminalWorkspaceView visible={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Coming back does not reopen it.
    view.rerender(<TerminalWorkspaceView visible />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("new-terminal CLI picker", () => {
  it("says there are no CLIs when none are listed", () => {
    render(<TerminalWorkspaceView visible />);
    // A screen-reader-only page h1 replaces the removed shared dashboard header.
    const heading = screen.getByRole("heading", { level: 1, name: "dashboard:terminals.title" });
    expect(heading.className).toContain("sr-only");
    openPicker();

    expect(screen.getByText("dashboard:terminals.emptyClis")).toBeTruthy();
    expect(screen.queryByPlaceholderText("dashboard:terminals.cliSearch")).toBeNull();
  });

  it("finds a CLI by name, hostname, or slug and opens it", () => {
    state.devices = [
      device({ name: "Work laptop", displayName: "Work laptop" }),
      device({
        id: "cli-2",
        slug: "tower",
        reportedHostname: "tower.lan",
        displayName: "tower.lan",
      }),
    ];
    render(<TerminalWorkspaceView visible />);
    openPicker();
    const search = screen.getByPlaceholderText("dashboard:terminals.cliSearch");

    for (const query of ["work", "desk-01", "desk"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByText("Work laptop")).toBeTruthy();
      expect(screen.queryByText("tower.lan")).toBeNull();
    }

    fireEvent.change(search, { target: { value: "no such cli" } });
    expect(screen.getByText("dashboard:terminals.cliSearchEmpty")).toBeTruthy();

    fireEvent.change(search, { target: { value: "tower" } });
    fireEvent.click(screen.getByText("tower.lan"));
    expect(state.openCli).toHaveBeenCalledWith("cli-2");
  });

  it("shows why a CLI is blocked and does not open it", () => {
    state.devices = [device({ features: { terminal: { ...usableTerminal, live: false } } })];
    render(<TerminalWorkspaceView visible />);
    openPicker();

    expect(screen.getByText("dashboard:terminals.reasons.offline")).toBeTruthy();
    fireEvent.click(screen.getByText("desk-01.local"));
    expect(state.openCli).not.toHaveBeenCalled();
  });

  it("clears the search when the picker closes", () => {
    state.devices = [device({})];
    render(<TerminalWorkspaceView visible />);
    openPicker();
    fireEvent.change(screen.getByPlaceholderText("dashboard:terminals.cliSearch"), {
      target: { value: "nothing" },
    });

    fireEvent.keyDown(screen.getByPlaceholderText("dashboard:terminals.cliSearch"), {
      key: "Escape",
    });
    expect(screen.queryByPlaceholderText("dashboard:terminals.cliSearch")).toBeNull();

    openPicker();
    const search = screen.getByPlaceholderText("dashboard:terminals.cliSearch") as HTMLInputElement;
    expect(search.value).toBe("");
    expect(screen.getByText("desk-01.local")).toBeTruthy();
  });

  it("clears the search when the workspace is hidden with the picker open", () => {
    state.devices = [device({})];
    const view = render(<TerminalWorkspaceView visible />);
    openPicker();
    fireEvent.change(screen.getByPlaceholderText("dashboard:terminals.cliSearch"), {
      target: { value: "nothing" },
    });

    view.rerender(<TerminalWorkspaceView visible={false} />);
    expect(screen.queryByPlaceholderText("dashboard:terminals.cliSearch")).toBeNull();

    view.rerender(<TerminalWorkspaceView visible />);
    openPicker();
    const search = screen.getByPlaceholderText("dashboard:terminals.cliSearch") as HTMLInputElement;
    expect(search.value).toBe("");
    expect(screen.getByText("desk-01.local")).toBeTruthy();
  });

  it("clears the search after a CLI is picked", () => {
    state.devices = [device({})];
    render(<TerminalWorkspaceView visible />);
    openPicker();
    fireEvent.change(screen.getByPlaceholderText("dashboard:terminals.cliSearch"), {
      target: { value: "desk" },
    });
    fireEvent.click(screen.getByText("desk-01.local"));
    expect(state.openCli).toHaveBeenCalledWith("cli-1");

    openPicker();
    const search = screen.getByPlaceholderText("dashboard:terminals.cliSearch") as HTMLInputElement;
    expect(search.value).toBe("");
  });
});

describe("agent request tabs", () => {
  function agentTab(status: string) {
    return {
      localId: "local-1",
      terminalId: "term-1",
      cliDeviceId: "cli-1",
      cols: 80,
      rows: 24,
      phase: "waiting",
      approvalCode: null,
      rejectionReason: null,
      error: null,
      multiViewer: true,
      viewerId: null,
      writer: "none",
      viewerCount: 0,
      ptyCols: null,
      ptyRows: null,
      opener: false,
      origin: "agent",
      supervised: {
        commandId: "cmd",
        status,
        requester: "laptop agent",
        reason: null,
        command: "sudo true",
        cwd: null,
        shareOutput: false,
        createdAt: null,
        expiresAt: null,
        exitCode: null,
        signal: null,
      },
      reviewOutput: null,
      reviewCapture: null,
      exitCode: null,
      exitSignal: null,
      decline: null,
      ending: null,
    };
  }

  function confirmEndAction(label: string) {
    fireEvent.click(screen.getByRole("button", { name: "dashboard:terminals.actions" }));
    fireEvent.click(screen.getByText(label));
    const dialog = screen.getByRole("alertdialog");
    const buttons = [...dialog.querySelectorAll("button")].filter(
      (button) => button.textContent === label,
    );
    fireEvent.click(buttons[0] as HTMLElement);
  }

  it("sends Decline as a decline, never as End session", () => {
    state.tabs = [agentTab("awaiting_user")];
    state.activeLocalId = "local-1";
    render(<TerminalWorkspaceView visible />);
    confirmEndAction("dashboard:agentRequests.decline");
    expect(state.declineRequest).toHaveBeenCalledWith("local-1");
    expect(state.endSession).not.toHaveBeenCalled();
  });

  it("offers End session once the command runs, and says when an Enter beat this tab's Decline", () => {
    state.tabs = [{ ...agentTab("running"), phase: "live", decline: "started" }];
    state.activeLocalId = "local-1";
    render(<TerminalWorkspaceView visible />);
    expect(screen.getByText("dashboard:agentRequests.startedBeforeDecline")).toBeTruthy();
    confirmEndAction("dashboard:terminals.endSession");
    expect(state.endSession).toHaveBeenCalledWith("local-1");
    expect(state.declineRequest).not.toHaveBeenCalled();
  });

  it("shows a session being ended without offering End session again, and a refused one", () => {
    state.tabs = [{ ...agentTab("running"), phase: "live", ending: "pending" }];
    state.activeLocalId = "local-1";
    render(<TerminalWorkspaceView visible />);
    expect(screen.getByText("dashboard:terminals.ending")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "dashboard:terminals.actions" })).toBeNull();
    cleanup();
    state.tabs = [{ ...agentTab("running"), phase: "live", ending: "failed" }];
    render(<TerminalWorkspaceView visible />);
    expect(screen.getByRole("alert").textContent).toBe("dashboard:terminals.endFailed");
    confirmEndAction("dashboard:terminals.endSession");
    expect(state.endSession).toHaveBeenCalledWith("local-1");
  });

  it("marks the tab as an agent request and offers Decline while it waits", () => {
    state.tabs = [agentTab("awaiting_user")];
    state.activeLocalId = "local-1";
    render(<TerminalWorkspaceView visible />);
    expect(screen.getByText("dashboard:agentRequests.tabLabel")).toBeTruthy();
    expect(screen.getByText("dashboard:agentRequests.requestedBy")).toBeTruthy();
    expect(screen.getByText("sudo true")).toBeTruthy();
    expect(screen.getByRole("button", { name: "dashboard:agentRequests.view" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dashboard:terminals.actions" }));
    expect(screen.getByText("dashboard:agentRequests.decline")).toBeTruthy();
  });
});
