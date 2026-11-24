// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join(",")}` : key,
    i18n: { language: "en-US" },
  }),
}));

import type { TerminalControls } from "@/hooks/use-xterm";
import type { TerminalWriterLabel } from "@/lib/terminal-protocol";
import type { TabStatus } from "@/lib/terminal-tab-status";
import { useUiPreferences } from "@/stores/ui-preferences";
import { PhoneTerminalHeader } from "./terminal-header";

type Tab = {
  localId: string;
  name: string;
  status: TabStatus;
  writer: TerminalWriterLabel;
  stepId: string | null;
  ending: "pending" | "failed" | null;
};

const LIVE: TabStatus = { phase: "live", inputDropped: false };
const ENDED: TabStatus = { phase: "exited", cause: "exit", exitCode: 0, exitSignal: null };

const TABS: Tab[] = [
  { localId: "a", name: "hermes", status: LIVE, writer: "you", stepId: null, ending: null },
  { localId: "b", name: "gtr", status: LIVE, writer: "other", stepId: null, ending: null },
  { localId: "c", name: "mini", status: ENDED, writer: "none", stepId: null, ending: null },
  {
    localId: "d",
    name: "box",
    status: { phase: "opening", approvalCode: null, reopen: null },
    writer: "none",
    stepId: null,
    ending: null,
  },
  {
    localId: "e",
    name: "lab",
    status: { phase: "rejected", reason: "offline" },
    writer: "none",
    stepId: null,
    ending: null,
  },
];

function fakeControls(): TerminalControls {
  const textarea = document.createElement("textarea");
  return {
    sendKeys: vi.fn(),
    paste: vi.fn(),
    pasteImages: vi.fn(),
    applicationCursor: () => false,
    bracketedPaste: () => true,
    focused: () => false,
    focus: vi.fn(),
    blur: vi.fn(),
    focusTarget: () => textarea,
    size: () => ({ cols: 44, rows: 37 }),
  };
}

function renderHeader(activeId = "a", tabs: Tab[] = TABS) {
  const props = {
    onSelect: vi.fn(),
    onNewTerminal: vi.fn(),
    onToggleSelecting: vi.fn(),
    onToggleMaximized: vi.fn(),
    onDetach: vi.fn(),
    onEndSession: vi.fn(),
  };
  const controls = fakeControls();
  const view = render(
    <PhoneTerminalHeader
      tabs={tabs}
      active={tabs.find((tab) => tab.localId === activeId) ?? null}
      nameOf={(tab) => tab.name}
      controls={() => controls}
      cells={{ cols: 44, rows: 37 }}
      onCells={vi.fn()}
      selecting={false}
      maximized
      {...props}
    />,
  );
  return { ...props, controls, view };
}

beforeEach(() => {
  useUiPreferences.setState({ terminalKeysShown: false, terminalFontSize: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const picker = () => document.querySelector("[data-terminal-picker]") as HTMLElement;
const more = () => screen.getByRole("button", { name: "header.more" });

async function openMore() {
  fireEvent.click(more());
  return screen.findByRole("menu");
}

describe("PhoneTerminalHeader", () => {
  it("is one row: picker, ⋯ and Maximize/Restore, nothing else", () => {
    renderHeader();
    const row = document.querySelector('[data-terminal-header="phone"]') as HTMLElement;
    const buttons = within(row).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toBe(picker());
    expect(buttons[1]).toBe(more());
    expect(buttons[2]?.getAttribute("aria-label")).toBe("terminals:toolbar.restore");
    // No status line, End session or × in the row itself.
    expect(row.querySelector('[role="status"]')).toBeNull();
  });

  it("shows the visible terminal's icon and color in the picker", () => {
    const { view } = renderHeader("a");
    let icon = picker().querySelector("svg[data-icon]") as SVGElement;
    expect(icon.dataset.icon).toBe("keyboard");
    expect(icon.dataset.tone).toBe("live");
    expect(picker().getAttribute("aria-label")).toContain("hermes");
    view.unmount();
    renderHeader("b");
    icon = picker().querySelector("svg[data-icon]") as SVGElement;
    expect(icon.dataset.icon).toBe("eye");
    expect(picker().getAttribute("aria-label")).toContain("terminals:header.viewing");
  });

  it("lists the open terminals with icon, name and state, and switches", async () => {
    const { onSelect, onNewTerminal } = renderHeader("a");
    fireEvent.click(picker());
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("terminals:header.openTerminals")).toBeTruthy();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(5);
    const states = items.map((item) => {
      const svg = item.querySelector("svg[data-icon]") as SVGElement;
      return [svg.dataset.icon, svg.dataset.tone, item.textContent];
    });
    expect(states).toEqual([
      ["keyboard", "live", "hermesterminals:phase.live · terminals:header.typing"],
      ["eye", "live", "gtrterminals:phase.live · terminals:header.viewing"],
      ["keyboard", "exited", "miniterminals:phase.exited"],
      ["keyboard", "opening", "boxterminals:phase.opening"],
      ["keyboard", "rejected", "labterminals:phase.rejected"],
    ]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(picker());
    fireEvent.click(await screen.findByRole("menuitem", { name: "terminals:header.newTerminal" }));
    expect(onNewTerminal).toHaveBeenCalledTimes(1);
  });

  it("has one ⋯ menu with Type & view, then Session", async () => {
    renderHeader("a");
    const menu = await openMore();
    const groups = within(menu).getAllByRole("group");
    const labelled = groups.map((group) => {
      const id = group.getAttribute("aria-labelledby");
      return id ? document.getElementById(id)?.textContent : null;
    });
    expect(labelled).toContain("header.typeAndView");
    expect(labelled).toContain("terminals:header.session");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("data-utility"));
    expect(names).toEqual([
      "keys",
      "paste",
      "photo",
      "smaller",
      "larger",
      "reset",
      "select",
      "settings",
      "detach",
      "end",
    ]);
    // Type & view comes first.
    const typeGroup = groups[labelled.indexOf("header.typeAndView")] as HTMLElement;
    expect(within(typeGroup).getByText("utilities.showKeys")).toBeTruthy();
  });

  it("works the Type & view items", async () => {
    const { onToggleSelecting } = renderHeader("a");
    let menu = await openMore();
    fireEvent.click(within(menu).getByText("utilities.showKeys"));
    expect(useUiPreferences.getState().terminalKeysShown).toBe(true);
    menu = await openMore();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "utilities.smaller" }));
    expect(useUiPreferences.getState().terminalFontSize).toBe(12);
    fireEvent.click(within(menu).getByText("terminals:toolbar.selectText"));
    expect(onToggleSelecting).toHaveBeenCalledTimes(1);
  });

  it("asks before End session, and only Confirm ends it", async () => {
    const { onEndSession, onDetach } = renderHeader("a");
    let menu = await openMore();
    fireEvent.click(within(menu).getByText("terminals:header.endSession"));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("terminals:endConfirm.title")).toBeTruthy();
    expect(within(dialog).getByText("terminals:endConfirm.description:hermes")).toBeTruthy();
    expect(onEndSession).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "terminals:utilities.cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onEndSession).not.toHaveBeenCalled();
    menu = await openMore();
    fireEvent.click(within(menu).getByText("terminals:header.endSession"));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "terminals:endSession" }));
    expect(onEndSession).toHaveBeenCalledWith("a");
    expect(onDetach).not.toHaveBeenCalled();
  });

  it("Stop viewing detaches without ending, and says the shell keeps running", async () => {
    const { onEndSession, onDetach } = renderHeader("a");
    const menu = await openMore();
    const item = within(menu).getByText("terminals:detach").closest("[role=menuitem]");
    expect(item?.textContent).toContain("terminals:header.keepsRunning");
    fireEvent.click(item as HTMLElement);
    expect(onDetach).toHaveBeenCalledWith("a");
    expect(onEndSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers Close tab and no End session on an ended terminal", async () => {
    const { onDetach } = renderHeader("c");
    const menu = await openMore();
    expect(within(menu).queryByText("terminals:header.endSession")).toBeNull();
    expect(within(menu).queryByText("terminals:header.keepsRunning")).toBeNull();
    fireEvent.click(within(menu).getByText("terminals:closeTab"));
    expect(onDetach).toHaveBeenCalledWith("c");
  });

  it("has no End session for an operator terminal, and shows Ending… while it ends", async () => {
    const tabs: Tab[] = [
      { ...TABS[0], stepId: "step" } as Tab,
      { ...TABS[1], ending: "pending" } as Tab,
    ];
    const { view } = renderHeader("a", tabs);
    let menu = await openMore();
    expect(within(menu).queryByText("terminals:header.endSession")).toBeNull();
    view.unmount();
    renderHeader("b", tabs);
    menu = await openMore();
    const ending = within(menu).getByText("terminals:ending").closest("[role=menuitem]");
    expect(ending?.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens Terminal settings from the menu", async () => {
    renderHeader("a");
    const menu = await openMore();
    fireEvent.click(within(menu).getByText("terminals:header.settings"));
    await waitFor(() =>
      expect(screen.getByRole("menu", { name: "terminals:toolbar.settings" })).toBeTruthy(),
    );
    expect(screen.getByText("terminals:settings.copy.label")).toBeTruthy();
  });

  it("toggles Maximize/Restore from the corner", () => {
    const { onToggleMaximized } = renderHeader("a");
    fireEvent.click(screen.getByRole("button", { name: "terminals:toolbar.restore" }));
    expect(onToggleMaximized).toHaveBeenCalledTimes(1);
  });
});
