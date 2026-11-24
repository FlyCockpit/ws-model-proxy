// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join(",")}` : key,
    i18n: { language: "en-US" },
  }),
}));

import { useTerminalModifiersLifetime } from "@/hooks/use-terminal-modifiers-lifetime";
import type { TerminalControls } from "@/hooks/use-xterm";
import { HOLD_MODIFIER_MS } from "@/lib/terminal-key-gestures";
import { useTerminalModifiers } from "@/stores/terminal-modifiers";
import { useUiPreferences } from "@/stores/ui-preferences";
import { TerminalKeyRow } from "./terminal-key-row";
import { TerminalUtilities } from "./terminal-utilities";

function fakeControls(overrides: Partial<TerminalControls> = {}): TerminalControls {
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
    ...overrides,
  };
}

beforeEach(() => {
  useUiPreferences.setState({ terminalKeysShown: false, terminalFontSize: null });
  useTerminalModifiers.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderUtilities(controls: TerminalControls) {
  const onCells = vi.fn();
  render(
    <TerminalUtilities
      controls={() => controls}
      disabled={false}
      cells={{ cols: 44, rows: 37 }}
      onCells={onCells}
    />,
  );
  return { onCells };
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "utilities.button" }));
  return screen.findByRole("menu");
}

describe("TerminalUtilities", () => {
  it("opens the menu, shows the keys and remembers it", async () => {
    const { onCells } = renderUtilities(fakeControls());
    await openMenu();
    expect(onCells).toHaveBeenCalledWith({ cols: 44, rows: 37 });
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.showKeys/ }));
    expect(useUiPreferences.getState().terminalKeysShown).toBe(true);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /utilities.hideKeys/ })).toBeTruthy();
  });

  it("steps the text size by 1 px within the range and resets it", async () => {
    renderUtilities(fakeControls());
    await openMenu();
    const larger = screen.getByRole("menuitem", { name: "utilities.larger" });
    fireEvent.click(larger);
    fireEvent.click(larger);
    expect(useUiPreferences.getState().terminalFontSize).toBe(15);
    // The menu stays open for more steps.
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "utilities.reset" }));
    expect(useUiPreferences.getState().terminalFontSize).toBeNull();
    act(() => useUiPreferences.getState().setTerminalFontSize(2));
    const smaller = screen.getByRole("menuitem", { name: "utilities.smaller" });
    expect(smaller.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(smaller);
    // 1 px is the minimum: A− stops there, and nothing goes below it.
    expect(useUiPreferences.getState().terminalFontSize).toBe(1);
    expect(screen.getByText("utilities.sizePx:1")).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "utilities.smaller" }).getAttribute("aria-disabled"),
    ).toBe("true");
    act(() => useUiPreferences.getState().setTerminalFontSize(0));
    expect(useUiPreferences.getState().terminalFontSize).toBe(1);
    act(() => useUiPreferences.getState().setTerminalFontSize(40));
    expect(useUiPreferences.getState().terminalFontSize).toBe(20);
  });

  it("pastes the dialog's text through the terminal's paste path, then Enter", async () => {
    const controls = fakeControls();
    renderUtilities(controls);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.paste/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("textarea") as HTMLTextAreaElement, {
      target: { value: "echo one\necho two" },
    });
    fireEvent.click(dialog.querySelector('[data-utility="paste-enter"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "utilities.pasteDialog.send" }));
    expect(controls.paste).toHaveBeenCalledWith("echo one\necho two");
    expect(controls.sendKeys).toHaveBeenCalledWith("\r");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when the browser blocks reading the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
    const controls = fakeControls();
    renderUtilities(controls);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.paste/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /utilities.pasteDialog.fromClipboard/ }),
    );
    expect(await screen.findByText("utilities.pasteDialog.clipboardBlocked")).toBeTruthy();
    // Nothing to send yet.
    fireEvent.click(screen.getByRole("button", { name: "utilities.pasteDialog.send" }));
    expect(controls.paste).not.toHaveBeenCalled();
  });

  it("never fills a later opening with a clipboard read from before it closed", async () => {
    let resolve: (text: string) => void = () => {};
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => new Promise<string>((done) => (resolve = done)) },
    });
    renderUtilities(fakeControls());
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.paste/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /utilities.pasteDialog.fromClipboard/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "utilities.cancel" }));
    await act(async () => resolve("stale secret"));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.paste/ }));
    const dialog = await screen.findByRole("dialog");
    expect((dialog.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("sends a chosen photo through the image paste, and refuses other types up front", async () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const controls = fakeControls();
    renderUtilities(controls);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /utilities.photo/ }));
    const dialog = await screen.findByRole("dialog");
    const camera = dialog.querySelector('[data-utility="photo-camera"]') as HTMLInputElement;
    expect(camera.getAttribute("capture")).toBe("environment");
    const choose = dialog.querySelector('[data-utility="photo-choose"]') as HTMLInputElement;
    const send = () => screen.getByRole("button", { name: "utilities.photoDialog.send" });
    fireEvent.change(choose, {
      target: { files: [new File(["x"], "a.heic", { type: "image/heic" })] },
    });
    expect(screen.getByText("imagePaste.unsupported")).toBeTruthy();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    const photo = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(choose, { target: { files: [photo] } });
    expect(screen.getByRole("img", { name: "utilities.photoDialog.thumbnail" })).toBeTruthy();
    fireEvent.click(send());
    expect(controls.pasteImages).toHaveBeenCalledWith([photo]);
    vi.unstubAllGlobals();
  });
});

describe("TerminalKeyRow", () => {
  const pointer = (type: string, x = 0, y = 0, pointerId = 1) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId });

  it("sends Esc and Tab without taking focus, with a latched Ctrl or Alt", () => {
    const controls = fakeControls();
    render(<TerminalKeyRow controls={() => controls} />);
    const esc = screen.getByRole("button", { name: "keys.esc" });
    const down = pointer("pointerdown");
    esc.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(esc);
    fireEvent.click(screen.getByRole("button", { name: "keys.tab" }));
    // Alt latched for the next key only.
    fireEvent.click(screen.getByRole("button", { name: "keys.latch.off:keys.alt" }));
    fireEvent.click(esc);
    fireEvent.click(esc);
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([
      ["\x1b"],
      ["\t"],
      ["\x1b\x1b"],
      ["\x1b"],
    ]);
  });

  it("latches Ctrl on a tap and locks it on a double tap", () => {
    render(<TerminalKeyRow controls={() => fakeControls()} />);
    const ctrl = () => screen.getByRole("button", { name: /keys.latch.*keys.ctrl/ });
    fireEvent.click(ctrl());
    expect(useTerminalModifiers.getState().ctrl).toBe("once");
    expect(ctrl().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ctrl());
    expect(useTerminalModifiers.getState().ctrl).toBe("lock");
    fireEvent.click(ctrl());
    expect(useTerminalModifiers.getState().ctrl).toBe("off");
  });

  it("opens the letter grid on a held Ctrl and sends the key it is released over", () => {
    vi.useFakeTimers();
    const controls = fakeControls();
    render(<TerminalKeyRow controls={() => controls} />);
    const ctrl = screen.getByRole("button", { name: /keys.latch.*keys.ctrl/ });
    act(() => {
      ctrl.dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      vi.advanceTimersByTime(HOLD_MODIFIER_MS);
    });
    const cell = document.querySelector('[data-grid-key="c"]');
    expect(cell).not.toBeNull();
    document.elementFromPoint = () => cell;
    act(() => {
      ctrl.dispatchEvent(pointer("pointermove", 10, 10));
    });
    act(() => {
      ctrl.dispatchEvent(pointer("pointerup", 10, 10));
    });
    fireEvent.click(ctrl);
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([["\x03"]]);
    // The hold is no tap: nothing stays latched, and the grid is gone.
    expect(useTerminalModifiers.getState().ctrl).toBe("off");
    expect(document.querySelector("[data-grid-key]")).toBeNull();
  });

  it("joins latched modifiers to a held one's key and ends the one-key latch", () => {
    vi.useFakeTimers();
    const controls = fakeControls();
    render(<TerminalKeyRow controls={() => controls} />);
    fireEvent.click(screen.getByRole("button", { name: /keys.latch.*keys.ctrl/ }));
    const alt = screen.getByRole("button", { name: /keys.latch.*keys.alt/ });
    act(() => {
      alt.dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      vi.advanceTimersByTime(HOLD_MODIFIER_MS);
    });
    const cell = document.querySelector('[data-grid-key="b"]');
    document.elementFromPoint = () => cell;
    act(() => {
      alt.dispatchEvent(pointer("pointermove", 5, 5));
      alt.dispatchEvent(pointer("pointerup", 5, 5));
    });
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([["\x1b\x02"]]);
    expect(useTerminalModifiers.getState().ctrl).toBe("off");
  });

  it("sends the key under the finger as it lifts, or nothing off the grid", () => {
    vi.useFakeTimers();
    const controls = fakeControls();
    render(<TerminalKeyRow controls={() => controls} />);
    const ctrl = screen.getByRole("button", { name: /keys.latch.*keys.ctrl/ });
    const hold = () => {
      act(() => {
        ctrl.dispatchEvent(pointer("pointerdown"));
      });
      act(() => {
        vi.advanceTimersByTime(HOLD_MODIFIER_MS);
      });
    };
    const cellOf = (key: string) => document.querySelector(`[data-grid-key="${key}"]`);
    // Hovered c, lifted over l with no move in between: Ctrl+L.
    hold();
    document.elementFromPoint = () => cellOf("c");
    act(() => {
      ctrl.dispatchEvent(pointer("pointermove", 1, 1));
    });
    document.elementFromPoint = () => cellOf("l");
    act(() => {
      ctrl.dispatchEvent(pointer("pointerup", 2, 2));
    });
    // Hovered c, lifted off the grid: nothing.
    hold();
    document.elementFromPoint = () => cellOf("c");
    act(() => {
      ctrl.dispatchEvent(pointer("pointermove", 1, 1));
    });
    document.elementFromPoint = () => document.body;
    act(() => {
      ctrl.dispatchEvent(pointer("pointerup", 3, 3));
    });
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([["\x0c"]]);
  });

  it("keeps a swipe to its own finger: a second one moves nothing", () => {
    const controls = fakeControls();
    render(<TerminalKeyRow controls={() => controls} />);
    const pad = document.querySelector("[data-swipe-pad]") as HTMLElement;
    act(() => {
      pad.dispatchEvent(pointer("pointerdown", 100, 20, 1));
      pad.dispatchEvent(pointer("pointerdown", 300, 20, 2));
      pad.dispatchEvent(pointer("pointermove", 400, 20, 2));
      pad.dispatchEvent(pointer("pointerup", 400, 20, 2));
      pad.dispatchEvent(pointer("pointermove", 125, 20, 1));
      pad.dispatchEvent(pointer("pointerup", 125, 20, 1));
    });
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([["\x1b[C"]]);
  });

  it("sends one arrow per 20 px of swipe, in application cursor mode too", () => {
    let app = false;
    const controls = fakeControls({ applicationCursor: () => app });
    render(<TerminalKeyRow controls={() => controls} />);
    const pad = document.querySelector("[data-swipe-pad]") as HTMLElement;
    act(() => {
      pad.dispatchEvent(pointer("pointerdown", 100, 20));
      pad.dispatchEvent(pointer("pointermove", 145, 22));
      pad.dispatchEvent(pointer("pointerup", 145, 22));
    });
    app = true;
    act(() => {
      pad.dispatchEvent(pointer("pointerdown", 100, 20));
      pad.dispatchEvent(pointer("pointermove", 100, -5));
      pad.dispatchEvent(pointer("pointerup", 100, -5));
    });
    expect(vi.mocked(controls.sendKeys).mock.calls).toEqual([["\x1b[C"], ["\x1b[C"], ["\x1bOA"]]);
  });
});

describe("useTerminalModifiersLifetime", () => {
  it("drops latched modifiers when the terminal workspace goes away", () => {
    const hook = renderHook(() => useTerminalModifiersLifetime());
    act(() => {
      useTerminalModifiers.getState().tap("ctrl", 0);
      useTerminalModifiers.getState().tap("ctrl", 100);
    });
    expect(useTerminalModifiers.getState().ctrl).toBe("lock");
    hook.unmount();
    expect(useTerminalModifiers.getState().ctrl).toBe("off");
  });
});
