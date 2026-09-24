// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => ({ enabledCalls: [] as boolean[] }));

vi.mock("@/hooks/use-terminal-sessions", () => ({
  useTerminalSessions: (options: { enabled?: boolean }) => {
    sessions.enabledCalls.push(options.enabled ?? true);
    return { clis: [], tabs: [] };
  },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      listCliDevices: {
        queryOptions: () => ({ queryKey: ["cli-devices"], queryFn: async () => [] }),
      },
    },
  },
}));

import type { TerminalTab } from "./use-terminal-sessions";
import { TerminalWorkspaceProvider, terminalTabLabel } from "./use-terminal-workspace";

afterEach(() => {
  cleanup();
  sessions.enabledCalls.length = 0;
});

function renderProvider(active: boolean, client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <TerminalWorkspaceProvider active={active}>
        <span />
      </TerminalWorkspaceProvider>
    </QueryClientProvider>,
  );
}

describe("TerminalWorkspaceProvider", () => {
  it("connects only after Terminals is shown, then stays connected", () => {
    const client = new QueryClient();
    const view = renderProvider(false, client);
    // Another dashboard page: no connection, so no viewer slots are taken.
    expect(sessions.enabledCalls.every((enabled) => enabled === false)).toBe(true);

    const rerender = (active: boolean) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <TerminalWorkspaceProvider active={active}>
            <span />
          </TerminalWorkspaceProvider>
        </QueryClientProvider>,
      );
    rerender(true);
    expect(sessions.enabledCalls.at(-1)).toBe(true);

    // Leaving Terminals keeps the connection so open terminals survive.
    rerender(false);
    expect(sessions.enabledCalls.at(-1)).toBe(true);
  });
});

function tab(localId: string, cliDeviceId: string): TerminalTab {
  return {
    localId,
    terminalId: null,
    cliDeviceId,
    cols: 80,
    rows: 24,
    phase: "live",
    approvalCode: null,
    rejectionReason: null,
    error: null,
    multiViewer: true,
    viewerId: null,
    writer: "none",
    viewerCount: 1,
    ptyCols: null,
    ptyRows: null,
    opener: false,
  };
}

describe("terminalTabLabel", () => {
  const names: Record<string, string> = { a: "desk", b: "desk", c: "laptop" };
  const slugs: Record<string, string> = { a: "desk-a", b: "desk-b", c: "laptop" };
  const name = (id: string) => names[id] ?? id;
  const slug = (id: string) => slugs[id] ?? null;

  it("shows just the display name when it is unique", () => {
    const tabs = [tab("1", "a"), tab("2", "c")];
    expect(terminalTabLabel(tabs[0] as TerminalTab, tabs, name, slug)).toBe("desk");
    expect(terminalTabLabel(tabs[1] as TerminalTab, tabs, name, slug)).toBe("laptop");
  });

  it("appends the slug when two open CLIs share a display name", () => {
    const tabs = [tab("1", "a"), tab("2", "b")];
    expect(terminalTabLabel(tabs[0] as TerminalTab, tabs, name, slug)).toBe("desk · desk-a");
    expect(terminalTabLabel(tabs[1] as TerminalTab, tabs, name, slug)).toBe("desk · desk-b");
  });

  it("numbers several tabs on one CLI without adding the slug", () => {
    const tabs = [tab("1", "a"), tab("2", "a")];
    expect(terminalTabLabel(tabs[0] as TerminalTab, tabs, name, slug)).toBe("desk (1)");
    expect(terminalTabLabel(tabs[1] as TerminalTab, tabs, name, slug)).toBe("desk (2)");
  });

  it("combines the slug and numbering", () => {
    const tabs = [tab("1", "a"), tab("2", "a"), tab("3", "b")];
    expect(terminalTabLabel(tabs[1] as TerminalTab, tabs, name, slug)).toBe("desk · desk-a (2)");
    expect(terminalTabLabel(tabs[2] as TerminalTab, tabs, name, slug)).toBe("desk · desk-b");
  });
});
