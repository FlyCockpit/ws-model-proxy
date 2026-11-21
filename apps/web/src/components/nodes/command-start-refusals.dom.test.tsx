// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import type { ComponentType } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
}));
vi.mock("@/hooks/use-terminal-sessions", () => ({
  useTerminalSessions: () => ({
    status: "open",
    identityStatus: "ready",
    activeLocalId: "queued-tab",
    selectingLocalId: null,
    cliTrust: {},
    tabs: [
      {
        localId: "queued-tab",
        terminalId: "terminal-1",
        cliDeviceId: "node-1",
        status: { phase: "rejected", reason: "bad_cwd" },
        stepId: null,
        ending: null,
        writer: "you",
        viewerCount: 1,
        ptyCols: null,
        ptyRows: null,
      },
    ],
  }),
}));
vi.mock("@/hooks/use-hide-app-chrome", () => ({ useHideAppChrome: () => undefined }));
vi.mock("@/hooks/use-terminal-layout", () => ({
  useTerminalLayout: () => ({ ready: false, tabOrder: [], nodeOrder: [] }),
}));
vi.mock("@/hooks/use-pointer-reorder", () => ({
  usePointerReorder: () => ({ itemRef: () => undefined, drag: null }),
}));
vi.mock("@/components/terminal-pane", () => ({ TerminalPane: () => null }));
vi.mock("@/stores/node-live", () => ({ useNodeLive: () => "open" }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    nodes: {
      list: {
        queryOptions: () => ({ queryKey: ["nodes"], queryFn: async () => ({ nodes: [] }) }),
      },
    },
  },
}));

import enDashboard from "@/locales/en-US/dashboard.json";
import enTerminals from "@/locales/en-US/terminals.json";
import esDashboard from "@/locales/es-MX/dashboard.json";
import esTerminals from "@/locales/es-MX/terminals.json";
import { Route } from "@/routes/$lang/_auth/_app/terminals";
import { useUiPreferences } from "@/stores/ui-preferences";

const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };
afterEach(() => {
  cleanup();
  useUiPreferences.getState().setTerminalMaximized(false);
});

describe("command startup failures in the Terminals page", () => {
  it.each([
    ["en-US", enTerminals, enDashboard],
    ["es-MX", esTerminals, esDashboard],
  ])(
    "explains bad_cwd after a queued command opens a terminal in %s",
    async (lng, terminals, dashboard) => {
      const i18n = createInstance();
      await i18n.init({ lng, resources: { [lng]: { terminals, dashboard } } });
      // Show just the terminal workspace, as a person maximizing the queued command's tab does.
      useUiPreferences.getState().setTerminalMaximized(true);
      const queryClient = new QueryClient();
      await Component.preload?.();
      await act(async () => {
        render(
          <QueryClientProvider client={queryClient}>
            <I18nextProvider i18n={i18n}>
              <Component />
            </I18nextProvider>
          </QueryClientProvider>,
        );
      });
      expect(await screen.findByText(terminals.rejection.bad_cwd)).toBeTruthy();
      expect(screen.queryByText(/bad_cwd/)).toBeNull();
      queryClient.clear();
    },
  );
});
