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

import { TerminalWorkspaceProvider } from "./use-terminal-workspace";

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
