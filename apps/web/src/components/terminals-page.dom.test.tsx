// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/terminal-pane", () => ({ TerminalPane: () => null }));

vi.mock("@/hooks/use-terminal-workspace", () => ({
  deviceId: (device: { id: string }) => device.id,
  deviceText: () => null,
  useTerminalWorkspace: () => ({
    status: "open",
    identityReady: true,
    clis: [{ cliDeviceId: "cli-1", slug: "desk", publicKey: "key" }],
    cliTrust: { "cli-1": { status: "trusted", fingerprint: "ABCD EFGH" } },
    tabs: [],
    activeLocalId: null,
    devicesQuery: { data: [], isPending: false, isError: false, refetch: async () => undefined },
    labelFor: () => "desk",
    tabLabel: () => "desk",
    refreshClis: async () => undefined,
  }),
}));

import { TerminalWorkspaceView } from "./terminals-page";

afterEach(cleanup);

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
