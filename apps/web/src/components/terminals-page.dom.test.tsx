// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  openCli: vi.fn(),
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
    tabs: [],
    activeLocalId: null,
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
