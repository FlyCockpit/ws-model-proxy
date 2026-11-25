// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import type { ComponentType } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The session hook's state for each test: tabs, the socket, and the actions the page calls. */
const session = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: ComponentType }) => ({ options }),
}));
vi.mock("@/hooks/use-terminal-sessions", () => ({ useTerminalSessions: () => session.current }));
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
        queryOptions: () => ({
          queryKey: ["nodes"],
          queryFn: async () => ({
            nodes: [
              { id: "node-1", slug: "hermes" },
              { id: "node-2", slug: "mini" },
            ],
          }),
        }),
      },
    },
  },
}));

import enDashboard from "@/locales/en-US/dashboard.json";
import enTerminals from "@/locales/en-US/terminals.json";
import { Route } from "@/routes/$lang/_auth/_app/terminals";
import { useUiPreferences } from "@/stores/ui-preferences";

const Component = Route.options.component as ComponentType & { preload?: () => Promise<unknown> };

function tab(localId: string, cliDeviceId: string, status: Record<string, unknown>) {
  return {
    localId,
    terminalId: `terminal-${localId}`,
    cliDeviceId,
    status,
    stepId: null,
    ending: null,
    writer: "you",
    viewerCount: 1,
    ptyCols: null,
    ptyRows: null,
  };
}

const LIVE = { phase: "live", inputDropped: false };

function setSession(overrides: Record<string, unknown>) {
  session.current = {
    status: "open",
    identityStatus: "ready",
    activeLocalId: "a",
    selectingLocalId: null,
    cliTrust: {},
    tabs: [tab("a", "node-1", LIVE), tab("b", "node-2", LIVE)],
    endSession: vi.fn(),
    detachTab: vi.fn(),
    selectTab: vi.fn(),
    setSelecting: vi.fn(),
    ...overrides,
  };
}

function stubPhone(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query.includes("max-width: 640px"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

let rerenderPage: () => void = () => undefined;

async function renderPage() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { terminals: enTerminals, dashboard: enDashboard } },
  });
  const queryClient = new QueryClient();
  await Component.preload?.();
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Component />
      </I18nextProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    const view = render(tree());
    rerenderPage = () => view.rerender(tree());
  });
  await screen.findAllByText("hermes");
}

beforeEach(() => {
  useUiPreferences.getState().setTerminalMaximized(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiPreferences.getState().setTerminalMaximized(false);
});

describe("Terminals page header", () => {
  it("shows a lost connection inside the terminal area on a phone, not as a row", async () => {
    stubPhone(true);
    setSession({ status: "closed" });
    await renderPage();
    const message = screen.getByText(enTerminals.socket.closed);
    expect(message.closest("[data-terminal-notice]")).not.toBeNull();
    // Nothing between the card and the header row.
    const header = document.querySelector('[data-terminal-header="phone"]') as HTMLElement;
    expect(header.previousElementSibling).toBeNull();
  });

  it("keeps the connection message above the tabs on a wide screen", async () => {
    stubPhone(false);
    setSession({ status: "closed" });
    await renderPage();
    const message = screen.getByText(enTerminals.socket.closed);
    expect(message.closest("[data-terminal-notice]")).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("lets the phone notice be closed, and shows the next message again", async () => {
    stubPhone(true);
    setSession({ tabs: [tab("a", "node-1", { phase: "rejected", reason: "offline" })] });
    await renderPage();
    expect(screen.getByText(enTerminals.rejection.offline)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: enTerminals.header.closeNotice }));
    expect(screen.queryByText(enTerminals.rejection.offline)).toBeNull();
    // Still closed on the next render with the same message...
    act(() => rerenderPage());
    expect(screen.queryByText(enTerminals.rejection.offline)).toBeNull();
    // ...and back for a different one.
    setSession({ tabs: [tab("a", "node-1", { phase: "rejected", reason: "not_granted" })] });
    act(() => rerenderPage());
    expect(screen.getByText(enTerminals.rejection.not_granted)).toBeTruthy();
  });

  it("names the approval command on a tab refused until this browser is approved", async () => {
    const command = enTerminals.approvalNeededReopen.replace(
      "{{command}}",
      "wsmp terminal approve ABCD",
    );
    for (const phone of [false, true]) {
      stubPhone(phone);
      setSession({
        tabs: [
          tab("a", "node-1", {
            phase: "rejected",
            reason: "approval_required",
            approvalCode: "ABCD",
          }),
        ],
      });
      await renderPage();
      expect(screen.getByText(enTerminals.rejection.approval_required)).toBeTruthy();
      expect(screen.getByText(command)).toBeTruthy();
      cleanup();
    }
  });

  it("asks before End session on a wide screen, for the tab it was pressed on only", async () => {
    stubPhone(false);
    setSession({});
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: enTerminals.header.endSession }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    const endSession = session.current.endSession as ReturnType<typeof vi.fn>;
    expect(endSession).not.toHaveBeenCalled();
    // Another tab becomes the visible one (a terminal finished opening): the question goes away.
    setSession({ activeLocalId: "b", endSession });
    act(() => rerenderPage());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(endSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: enTerminals.header.endSession }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("mini");
    fireEvent.click(screen.getByRole("button", { name: enTerminals.endSession }));
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith("b");
  });

  it("keeps the phone notice during Select text, at the bottom, clear of its bar", async () => {
    stubPhone(true);
    setSession({
      selectingLocalId: "a",
      tabs: [{ ...tab("a", "node-1", LIVE), ending: "failed" }],
    });
    await renderPage();
    const message = screen.getByText(enTerminals.endFailed);
    const notice = message.closest("[data-terminal-notice]") as HTMLElement;
    expect(notice.dataset.terminalNotice).toBe("bottom");
    expect(notice.className).toContain("bottom-0");
    setSession({ tabs: [{ ...tab("a", "node-1", LIVE), ending: "failed" }] });
    act(() => rerenderPage());
    const top = screen.getByText(enTerminals.endFailed).closest("[data-terminal-notice]");
    expect((top as HTMLElement).dataset.terminalNotice).toBe("top");
  });

  it("has no status row on a phone: who types is the picker's icon", async () => {
    stubPhone(true);
    setSession({
      tabs: [{ ...tab("a", "node-1", LIVE), writer: "other", viewerCount: 2 }],
    });
    await renderPage();
    expect(screen.queryByText(enDashboard.terminals.status.otherTyping)).toBeNull();
    expect(document.querySelector("[data-terminal-notice]")).toBeNull();
    const icon = document.querySelector("[data-terminal-picker] svg[data-icon]") as SVGElement;
    expect(icon.dataset.icon).toBe("eye");
  });
});
