// @vitest-environment jsdom

/**
 * The real xterm 6.0.0 under the real useXterm hook: which origin each kind of input leaves with
 * (only xterm's own wheel handling is `wheel`), and which touches may open the copy window. jsdom
 * lays nothing out, so the canvas, ResizeObserver and matchMedia are stand-ins; event dispatch,
 * xterm's input handling, its parser and the hook's gates are the real ones.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { createElement, type ReactNode, StrictMode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import type { Osc52Copy } from "@/lib/terminal-copy-out";

import type { TerminalCopyMode } from "@/lib/terminal-settings";
import { useUiPreferences } from "@/stores/ui-preferences";

import { useTerminalCopy } from "./use-terminal-copy";
import { useXterm } from "./use-xterm";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    (): Pick<
      MediaQueryList,
      "matches" | "addListener" | "removeListener" | "addEventListener" | "removeEventListener"
    > => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  );
  const context: Partial<CanvasRenderingContext2D> = {
    measureText: () => ({ width: 8 }) as TextMetrics,
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    clearRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) as ImageData,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  // A mouse press a test left in progress: release it while its xterm is alive, so xterm takes its
  // listeners off the document (a disposed one's would throw at the next test's mouse events).
  const release = new MouseEvent("mouseup", { bubbles: true, buttons: 0 });
  Object.defineProperty(release, "sourceCapabilities", { value: { firesTouchEvents: false } });
  document.dispatchEvent(release);
  cleanup();
  document.body.replaceChildren();
});

type Pane = { active: boolean; selecting: boolean; follow: { cols: number; rows: number } | null };
const WRITER: Pane = { active: true, selecting: false, follow: null };
const FOLLOWER: Pane = { active: true, selecting: false, follow: { cols: 80, rows: 24 } };

/**
 * The page has focus for this test (jsdom's depends on what earlier tests focused): a copy window
 * a gesture opens is then all that decides whether OSC 52 is copied.
 */
function pageFocused() {
  const spy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  onTestFinished(() => spy.mockRestore());
}

async function setup(
  initial: Pane,
  { strict = false, onCopy }: { strict?: boolean; onCopy?: (copy: Osc52Copy) => void } = {},
) {
  let opened: Terminal | null = null;
  const open = Terminal.prototype.open;
  const spy = vi.spyOn(Terminal.prototype, "open").mockImplementation(function (
    this: Terminal,
    parent: HTMLElement,
  ) {
    opened = this;
    open.call(this, parent);
  });
  const onData = vi.fn<(data: string | Uint8Array, origin: string) => void>();
  const copies: Osc52Copy[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const view = renderHook(
    (pane: Pane) =>
      useXterm({
        ...pane,
        shiftEnter: "off",
        onData,
        onResize() {},
        onCopy: (copy) => {
          copies.push(copy);
          onCopy?.(copy);
        },
      }),
    {
      initialProps: initial,
      wrapper: strict
        ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children)
        : undefined,
    },
  );
  act(() => view.result.current.containerRef(container));
  spy.mockRestore();
  const term: Terminal | null = opened;
  if (!term) throw new Error("no xterm");
  const terminal: Terminal = term;
  const element = terminal.element;
  const textarea = terminal.textarea;
  if (!element || !textarea) throw new Error("xterm not open");
  /** Output through the hook, parsed. */
  const write = async (data: string) => {
    await act(async () => {
      view.result.current.write(new TextEncoder().encode(data));
      await new Promise<void>((resolve) => terminal.write("", resolve));
    });
  };
  const wheel = (deltaY = 1) =>
    element.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 1, cancelable: true }));
  const key = (keyName = "ArrowUp", keyCode = 38) =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: keyName,
        code: keyName,
        keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
  const paste = (text: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["text/plain"],
        items: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    textarea.dispatchEvent(event);
  };
  const insertText = (text: string) =>
    textarea.dispatchEvent(
      new InputEvent("input", { data: text, inputType: "insertText", bubbles: true }),
    );
  /** Run `action` from a later listener of the next wheel event, while that wheel is dispatching. */
  const duringNextWheel = (action: () => void) =>
    element.addEventListener("wheel", action, { once: true });
  const calls = () => onData.mock.calls.map(([data, origin]) => [data, origin]);
  return {
    terminal,
    element,
    textarea,
    container,
    view,
    onData,
    copies,
    write,
    wheel,
    key,
    paste,
    insertText,
    duringNextWheel,
    calls,
  };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("input origin: only xterm's own wheel handling is the wheel", () => {
  it("labels alternate-screen wheel arrows `wheel` and a key after it `user`", async () => {
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h");
    p.wheel();
    p.key();
    expect(p.calls()).toEqual([
      ["\x1b[B", "wheel"],
      ["\x1b[A", "user"],
    ]);
  });

  it("labels application-cursor (DECCKM) wheel arrows `wheel`", async () => {
    // Mouse reports need a laid-out screen, which jsdom has none of: the browser probe covers the
    // SGR and binary wheel reports, and a click report nested in a wheel.
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h\x1b[?1h");
    p.wheel(-1);
    p.key();
    expect(p.calls()).toEqual([
      ["\x1bOA", "wheel"],
      ["\x1bOA", "user"],
    ]);
  });

  it("keeps a key dispatched from inside the wheel's dispatch `user` (writer)", async () => {
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h");
    p.duringNextWheel(() => p.key());
    p.wheel();
    expect(p.calls()).toEqual([
      ["\x1b[B", "wheel"],
      ["\x1b[A", "user"],
    ]);
  });

  it("lets a follower's key dispatched inside the wheel's dispatch through as `user`", async () => {
    const p = await setup(FOLLOWER);
    await p.write("\x1b[?1049h");
    p.duringNextWheel(() => p.key());
    p.wheel();
    // The follower's wheel arrow is dropped; its key is real input (it may take over).
    expect(p.calls()).toEqual([["\x1b[A", "user"]]);
  });

  it.each([false, true])(
    "keeps paste (bracketed: %s) `user`, inside or after a wheel",
    async (bracketed) => {
      const p = await setup(FOLLOWER);
      if (bracketed) await p.write("\x1b[?2004h");
      const pasted = bracketed ? "\x1b[200~pasted\x1b[201~" : "pasted";
      p.wheel();
      p.paste("pasted");
      p.duringNextWheel(() => p.paste("pasted"));
      p.wheel();
      expect(p.calls()).toEqual([
        [pasted, "user"],
        [pasted, "user"],
      ]);
    },
  );

  it("keeps insertText `user`, inside or after a wheel", async () => {
    const p = await setup(FOLLOWER);
    p.wheel();
    p.insertText("字");
    p.duringNextWheel(() => p.insertText("字"));
    p.wheel();
    expect(p.calls()).toEqual([
      ["字", "user"],
      ["字", "user"],
    ]);
  });

  it("keeps IME text `user`: composed inside a wheel, or finalized by a nested or later key", async () => {
    const p = await setup(FOLLOWER);
    const compose = () => {
      p.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      p.textarea.value = "漢";
      p.textarea.dispatchEvent(
        new CompositionEvent("compositionupdate", { data: "漢", bubbles: true }),
      );
    };
    p.duringNextWheel(() => {
      compose();
      p.textarea.dispatchEvent(
        new CompositionEvent("compositionend", { data: "漢", bubbles: true }),
      );
    });
    p.wheel();
    await settle();
    expect(p.calls()).toEqual([["漢", "user"]]);

    p.onData.mockClear();
    p.textarea.value = "";
    compose();
    await settle();
    p.duringNextWheel(() => p.key());
    p.wheel();
    expect(p.calls()).toEqual([
      ["漢", "user"],
      ["\x1b[A", "user"],
    ]);
  });

  it("keeps focus reports and output replies `reply`, also during a wheel", async () => {
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h\x1b[?1004h");
    p.onData.mockClear();
    let reply: Promise<void> | null = null;
    p.duringNextWheel(() => {
      p.terminal.focus();
      p.terminal.blur();
      reply = new Promise<void>((resolve) => p.terminal.write("\x1b[5n", resolve));
    });
    p.wheel();
    await act(async () => {
      await reply;
    });
    expect(p.calls()).toEqual([
      ["\x1b[B", "wheel"],
      ["\x1b[I", "reply"],
      ["\x1b[O", "reply"],
      ["\x1b[0n", "reply"],
    ]);
  });

  // Round 9 (owner decision): a touch scroll's input is the person's own (`user`, it may take
  // over); the desktop wheel's stays `wheel`, before and after it, and nested input keeps its own.
  it("labels a touch scroll's arrows `user`, and a desktop wheel around it `wheel`", async () => {
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h");
    p.wheel();
    // A swipe up by two rows (16 px each, jsdom's fallback row height).
    touch(p.element, "touchstart", [[40, 300]]);
    touch(p.element, "touchmove", [[40, 283]]);
    touch(p.element, "touchmove", [[40, 267]]);
    touch(p.element, "touchend", []);
    p.wheel();
    // A key nested in a desktop wheel's dispatch is still a key.
    p.duringNextWheel(() => p.key());
    p.wheel();
    expect(p.calls()).toEqual([
      ["\x1b[B", "wheel"],
      ["\x1b[B", "user"],
      ["\x1b[B", "user"],
      ["\x1b[B", "wheel"],
      ["\x1b[B", "wheel"],
      ["\x1b[A", "user"],
    ]);
  });

  it("sends nothing for a swipe while following a size: the follow box pans natively", async () => {
    const p = await setup(FOLLOWER);
    await p.write("\x1b[?1049h");
    touch(p.element, "touchstart", [[40, 300]]);
    touch(p.element, "touchmove", [[40, 267]]);
    touch(p.element, "touchend", []);
    // Following a size, the box pans natively: no wheel events, nothing sent.
    expect(p.calls()).toEqual([]);
  });

  it("labels nothing after a wheel that sent nothing (the normal buffer)", async () => {
    const p = await setup(WRITER);
    p.duringNextWheel(() => p.key());
    p.wheel();
    p.key();
    expect(p.calls()).toEqual([
      ["\x1b[A", "user"],
      ["\x1b[A", "user"],
    ]);
  });
});

type FakeTouch = { identifier: number; clientX: number; clientY: number };
/** The fingers down, as the last touch event reported them (their identifiers stay theirs). */
let fingersDown: FakeTouch[] = [];
let nextFinger = 0;

/**
 * A touch event with the given fingers down (jsdom has no Touch constructor). Its changedTouches
 * are the fingers it puts down, moves or lifts; a lifted finger is where it was last unless
 * `liftedAt` says where it lifted (a touchend's own final position, with no move to it before).
 */
function touch(
  target: EventTarget,
  type: string,
  points: [number, number][],
  liftedAt?: [number, number][],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  // One finger down again: every earlier finger lifted (seen or not).
  if (type === "touchstart" && points.length <= fingersDown.length) fingersDown = [];
  const byOrder = ([clientX, clientY]: [number, number], index: number): FakeTouch => ({
    identifier: fingersDown[index]?.identifier ?? nextFinger++,
    clientX,
    clientY,
  });
  let touches: FakeTouch[];
  let changed: FakeTouch[];
  if (type === "touchend" || type === "touchcancel") {
    // The fingers still down are the ones where they were; the others lift.
    touches = points.map(
      (point, index) =>
        fingersDown.find((finger) => finger.clientX === point[0] && finger.clientY === point[1]) ??
        byOrder(point, index),
    );
    changed = fingersDown
      .filter((finger) => !touches.includes(finger))
      .map((finger, index) => {
        const at = liftedAt?.[index];
        return at ? { ...finger, clientX: at[0], clientY: at[1] } : finger;
      });
  } else {
    touches = points.map(byOrder);
    changed = type === "touchstart" ? touches.slice(fingersDown.length) : touches;
  }
  fingersDown = touches;
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changed });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: EventTarget, type: string) {
  target.dispatchEvent(new PointerEvent(type, { pointerType: "touch", bubbles: true }));
}

describe("a touch belongs to the attach and pane state it started in", () => {
  type P = Awaited<ReturnType<typeof setup>>;
  const osc52 = "\x1b]52;c;aGk=\x07";
  const ends: Record<string, (p: P) => Promise<void>> = {
    "a retire, a reset and a new attach": async (p) => {
      act(() => {
        p.view.result.current.retire();
        p.view.result.current.reset();
        p.view.result.current.attached();
      });
      await p.write("\x1b[?1049h");
    },
    "a reset": async (p) => {
      act(() => p.view.result.current.reset());
    },
    "a new attach": async (p) => {
      act(() => p.view.result.current.attached());
    },
    "following and back": async (p) => {
      p.view.rerender(FOLLOWER);
      p.view.rerender(WRITER);
    },
    "Select text and back": async (p) => {
      p.view.rerender({ ...WRITER, selecting: true });
      p.view.rerender(WRITER);
    },
    "hidden and shown": async (p) => {
      p.view.rerender({ ...WRITER, active: false });
      p.view.rerender(WRITER);
    },
    "the page hidden": async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    },
  };

  it.each(Object.keys(ends))(
    "a tap still down across %s opens no copy window and makes no click",
    async (name) => {
      const p = await setup(WRITER);
      p.textarea.focus();
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [[100, 200]]);
      await ends[name]?.(p);
      pointer(p.element, "pointerup");
      const end = touch(p.element, "touchend", []);
      await p.write(osc52);
      expect(p.copies).toEqual([]);
      expect(end.defaultPrevented).toBe(true);

      // A fresh tap afterwards is a tap: its release opens the copy window.
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [[100, 200]]);
      pointer(p.element, "pointerup");
      const tap = touch(p.element, "touchend", []);
      expect(tap.defaultPrevented).toBe(false);
      await p.write(osc52);
      expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
    },
  );

  /** A fresh one-finger tap: left alone, and the OSC 52 after it is copied. */
  const freshTap = async (p: P) => {
    p.copies.length = 0;
    pointer(p.element, "pointerdown");
    touch(p.element, "touchstart", [[100, 200]]);
    pointer(p.element, "pointerup");
    const tap = touch(p.element, "touchend", []);
    expect(tap.defaultPrevented).toBe(false);
    await p.write(osc52);
    expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
  };
  /**
   * The ways two fingers lift. The pane finger went down first (its pointer and touch events come
   * to the pane); the second went down inside or outside the pane. Returns the pane's releases.
   */
  const lifts: Record<string, (p: P) => Event[]> = {
    "a second finger inside, lifting first": (p) => {
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [
        [100, 200],
        [200, 260],
      ]);
      pointer(p.element, "pointerup");
      const second = touch(p.element, "touchend", [[100, 200]]);
      pointer(p.element, "pointerup");
      return [second, touch(p.element, "touchend", [])];
    },
    "a second finger inside, the pane finger lifting first": (p) => {
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [
        [100, 200],
        [200, 260],
      ]);
      pointer(p.element, "pointerup");
      const first = touch(p.element, "touchend", [[200, 260]]);
      pointer(p.element, "pointerup");
      return [first, touch(p.element, "touchend", [])];
    },
    "a second finger outside, the pane finger lifting first (the last lift outside)": (p) => {
      const outside = document.body.appendChild(document.createElement("div"));
      pointer(outside, "pointerdown");
      touch(outside, "touchstart", [
        [100, 200],
        [390, 600],
      ]);
      pointer(p.element, "pointerup");
      const pane = touch(p.element, "touchend", [[390, 600]]);
      pointer(outside, "pointerup");
      touch(outside, "touchend", []);
      outside.remove();
      return [pane];
    },
    "a second finger outside, lifting first": (p) => {
      const outside = document.body.appendChild(document.createElement("div"));
      pointer(outside, "pointerdown");
      touch(outside, "touchstart", [
        [100, 200],
        [390, 600],
      ]);
      pointer(outside, "pointerup");
      touch(outside, "touchend", [[100, 200]]);
      outside.remove();
      pointer(p.element, "pointerup");
      return [touch(p.element, "touchend", [])];
    },
  };
  const holds: Record<string, (p: P) => Promise<void>> = {
    "a pending tap": async (p) => {
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [[100, 200]]);
    },
    "a scrolling drag": async (p) => {
      await p.write("\x1b[?1049h");
      pointer(p.element, "pointerdown");
      touch(p.element, "touchstart", [[100, 300]]);
      touch(p.element, "touchmove", [[100, 200]]);
      p.onData.mockClear();
    },
  };
  /** Every pane release cancelled, nothing sent, no copy window; then a fresh tap still taps. */
  const expectNoTap = async (p: P, releases: Event[]) => {
    await p.write(osc52);
    expect(releases.map((release) => release.defaultPrevented)).toEqual(releases.map(() => true));
    expect(p.copies).toEqual([]);
    expect(p.onData).not.toHaveBeenCalled();
    await freshTap(p);
  };

  // R3-P-1: one finger down in the pane (a pending tap), then a second resting finger inside or
  // outside the pane: no tap in any lift order. (R4-A-1/R4-B-1: the pane touch starts first.)
  it.each(Object.keys(lifts))(
    "a pending pane tap, then a still finger with %s, is no tap",
    async (lift) => {
      const p = await setup(WRITER);
      p.textarea.focus();
      await holds["a pending tap"]?.(p);
      const releases = lifts[lift]?.(p) ?? [];
      await p.write(osc52);
      // Both reported: the pane's release is cancelled, and the parsed OSC 52 is not copied.
      expect
        .soft(releases.map((release) => release.defaultPrevented))
        .toEqual(releases.map(() => true));
      expect.soft(p.copies).toEqual([]);
      expect(p.onData).not.toHaveBeenCalled();
      await freshTap(p);
    },
  );

  // A pane release whose touch began outside the pane (no pane touch of its own) is no tap.
  it.each(Object.keys(lifts).filter((lift) => lift.includes("outside")))(
    "a pane release with no pane touch (%s) is no tap",
    async (lift) => {
      const p = await setup(WRITER);
      p.textarea.focus();
      const releases = lifts[lift]?.(p) ?? [];
      await expectNoTap(p, releases);
    },
  );

  // TRC1-tap: each end alone, with each lift order, from a pending tap and a scrolling drag.
  const lifted = Object.keys(holds).flatMap((hold) =>
    Object.keys(ends).flatMap((end) =>
      Object.keys(lifts).map((lift) => [hold, end, lift] as const),
    ),
  );
  it.each(lifted)(
    "%s across %s, then %s: every release cancelled, no copy",
    async (hold, end, lift) => {
      const p = await setup(WRITER);
      p.textarea.focus();
      await holds[hold]?.(p);
      await ends[end]?.(p);
      // The second finger comes after the end; the first is already void.
      const releases = (lifts[lift]?.(p) ?? []).slice();
      p.onData.mockClear();
      await expectNoTap(p, releases);
    },
  );

  // R3-A-2: a release is decided by its own touch; pointer events alone authorize nothing, also
  // after an earlier tap.
  it("a touch's pointer events alone open no copy window, also after an earlier tap", async () => {
    const p = await setup(WRITER);
    p.textarea.focus();
    pointer(p.element, "pointerdown");
    pointer(p.element, "pointerup");
    await p.write(osc52);
    expect(p.copies).toEqual([]);
    await freshTap(p);
    p.copies.length = 0;
    const later = Date.now() + 4_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => later);
    try {
      // The tap's window has closed.
      await p.write(osc52);
      expect(p.copies).toEqual([]);
      pointer(p.element, "pointerdown");
      pointer(p.element, "pointerup");
      await p.write(osc52);
      expect(p.copies).toEqual([]);
      // A release with no touch of its own seen (the touchstart never came) is no tap either.
      const stray = touch(p.element, "touchend", []);
      await p.write(osc52);
      expect(p.copies).toEqual([]);
      expect(stray.defaultPrevented).toBe(true);
    } finally {
      now.mockRestore();
    }
    await freshTap(p);
  });

  it("a mouse press still opens the copy window", async () => {
    const p = await setup(WRITER);
    p.element.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }),
    );
    await p.write(osc52);
    expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("a second finger from outside the pane ends the scroll for good", async () => {
    const p = await setup(WRITER);
    await p.write("\x1b[?1049h");
    touch(p.element, "touchstart", [[100, 300]]);
    touch(p.element, "touchmove", [[100, 260]]);
    const scrolled = p.onData.mock.calls.length;
    expect(scrolled).toBeGreaterThan(0);
    const outside = document.body.appendChild(document.createElement("div"));
    touch(outside, "touchstart", [
      [100, 260],
      [390, 500],
    ]);
    touch(p.element, "touchmove", [
      [100, 220],
      [390, 500],
    ]);
    // The second finger lifts: its touchend goes to where it started, outside the pane.
    touch(outside, "touchend", [[100, 220]]);
    touch(p.element, "touchmove", [[100, 120]]);
    touch(p.element, "touchend", []);
    expect(p.onData.mock.calls).toHaveLength(scrolled);
    // A fresh swipe scrolls again.
    touch(p.element, "touchstart", [[100, 300]]);
    touch(p.element, "touchmove", [[100, 220]]);
    expect(p.onData.mock.calls.length).toBeGreaterThan(scrolled);
  });

  // Round 10 (F-FA-1): the browser may coalesce a drag's moves into its touchend, so where the
  // finger lifted (the touchend's own changedTouches entry for it) decides whether it was a tap.
  it.each([
    ["no move delivered", []],
    ["only a move under the slop delivered", [[100, 198]]],
  ] as [string, [number, number][]][])(
    "FA-END-1: a finger lifting 160 px from where it went down is no tap (%s)",
    async (_, moves) => {
      const p = await setup(WRITER);
      pageFocused();
      touch(p.element, "touchstart", [[100, 200]]);
      for (const move of moves) touch(p.element, "touchmove", [move]);
      const end = touch(p.element, "touchend", [], [[100, 40]]);
      await p.write(osc52);
      expect(end.defaultPrevented).toBe(true);
      expect(p.copies).toEqual([]);
      expect(p.calls()).toEqual([]);
    },
  );

  it("a touchend that does not carry the touch's own finger is no tap (fails closed)", async () => {
    const p = await setup(WRITER);
    pageFocused();
    touch(p.element, "touchstart", [[100, 200]]);
    const end = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(end, "touches", { value: [] });
    Object.defineProperty(end, "changedTouches", {
      value: [{ identifier: -1, clientX: 100, clientY: 200 }],
    });
    p.element.dispatchEvent(end);
    await p.write(osc52);
    expect(end.defaultPrevented).toBe(true);
    expect(p.copies).toEqual([]);
  });

  it("a still tap, also one lifting a little off (under the slop), still opens the copy window", async () => {
    const p = await setup(WRITER);
    pageFocused();
    touch(p.element, "touchstart", [[100, 200]]);
    const end = touch(p.element, "touchend", [], [[106, 207]]);
    expect(end.defaultPrevented).toBe(false);
    await p.write(osc52);
    expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
  });

  // Owner decision (round 10): a long still press is a tap, as deliberate a gesture as a short one.
  it("a long still press is a tap: its release opens the copy window (intended)", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    try {
      const p = await setup(WRITER);
      pageFocused();
      touch(p.element, "touchstart", [[100, 200]]);
      clock.mockReturnValue(11_200);
      const end = touch(p.element, "touchend", []);
      expect(end.defaultPrevented).toBe(false);
      await p.write(osc52);
      expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a touch release and the real clipboard delivery", () => {
  const OSC = "\x1b]52;c;ZmEtY2xpcGJvYXJk\x07";
  const writeText = vi.fn<(text: string) => Promise<void>>();
  let initialMode: TerminalCopyMode;
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    initialMode = useUiPreferences.getState().terminalCopy;
    act(() => useUiPreferences.getState().setTerminalCopy("auto"));
    pageFocused();
  });
  afterEach(() => {
    act(() => useUiPreferences.getState().setTerminalCopy(initialMode));
    Reflect.deleteProperty(navigator, "clipboard");
  });

  /** The real useXterm wired to the real useTerminalCopy, in auto mode, with a clipboard sink. */
  async function delivering() {
    const copy = renderHook(() => useTerminalCopy());
    const p = await setup(WRITER, { onCopy: (osc) => copy.result.current.onCopy(osc) });
    return { p, copy };
  }

  it.each([
    ["no move delivered", false],
    ["a move under the slop delivered", true],
  ] as const)(
    "FA-END-COPY: a release 160 px from its start writes nothing to the clipboard (%s)",
    async (_, shortMove) => {
      const { p, copy } = await delivering();
      touch(p.element, "touchstart", [[40, 200]]);
      if (shortMove) touch(p.element, "touchmove", [[40, 198]]);
      const end = touch(p.element, "touchend", [], [[40, 40]]);
      await p.write(OSC);
      await act(async () => {});
      // The clipboard first: what this pins is that nothing reaches it.
      expect(writeText).not.toHaveBeenCalled();
      expect(copy.result.current.pending).toBeNull();
      expect(end.defaultPrevented).toBe(true);
    },
  );

  it("a genuine still tap copies to the clipboard (inverse)", async () => {
    const { p } = await delivering();
    touch(p.element, "touchstart", [[40, 200]]);
    const end = touch(p.element, "touchend", []);
    expect(end.defaultPrevented).toBe(false);
    await p.write(OSC);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("fa-clipboard");
  });
});

// R4-P-1: a finger resting on a pane that is replaced (a remount, a tab closing over the one under
// it) gets no touchend anywhere; the browser hit-tests its pointerup and compatibility mouse events
// onto the terminal now there. They act only after that terminal's own tap.
describe("a touch's mouse events act only after this pane's own tap", () => {
  type P = Awaited<ReturnType<typeof setup>>;
  const osc52 = "\x1b]52;c;aGk=\x07";
  const MOUSE_APP = "\x1b[?1000h\x1b[?1006h";
  /**
   * The mouse events of a click on xterm. `byTouch`: Chromium's `sourceCapabilities
   * .firesTouchEvents`; null leaves it out (WebKit, Firefox), and the pointer event announcing
   * each one decides (none announces them here: a mouse's own events need their pointer events).
   */
  const click = (p: P, byTouch: boolean | null) => {
    for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50 });
      if (byTouch !== null)
        Object.defineProperty(event, "sourceCapabilities", {
          value: { firesTouchEvents: byTouch },
        });
      p.element.dispatchEvent(event);
    }
  };
  /** Whether the click took effect: xterm focused, and `armClick` armed the follower's input. */
  const clicked = (p: P) => {
    p.onData.mockClear();
    p.terminal.input("x");
    return {
      focused: document.activeElement === p.textarea,
      claims: p.calls().some(([data, origin]) => data === "x" && origin === "user"),
    };
  };
  const tap = (p: P) => {
    pointer(p.element, "pointerdown");
    touch(p.element, "touchstart", [[100, 200]]);
    pointer(p.element, "pointerup");
    return touch(p.element, "touchend", []);
  };
  /** A finger down on `old`, which is then replaced by a new follower pane in a mouse app. */
  const replaced = async (old: P) => {
    pointer(old.element, "pointerdown");
    touch(old.element, "touchstart", [[100, 200]]);
    old.view.unmount();
    old.container.remove();
    const p = await setup(FOLLOWER);
    await p.write(MOUSE_APP);
    return p;
  };

  it.each([true])(
    "a finger held across its pane's remount clicks nothing into the new terminal (sourceCapabilities: %s)",
    async (byTouch) => {
      const p = await replaced(await setup(FOLLOWER));
      (document.activeElement as HTMLElement | null)?.blur();
      // The finger lifts: no touchend anywhere; its pointerup and click land on the new terminal.
      pointer(p.element, "pointerup");
      click(p, byTouch);
      expect(clicked(p)).toEqual({ focused: false, claims: false });
      await p.write(osc52);
      expect(p.copies).toEqual([]);

      // The new terminal's own tap clicks as before: focus, and a follower's click claims the writer.
      expect(tap(p).defaultPrevented).toBe(false);
      click(p, byTouch);
      expect(clicked(p)).toEqual({ focused: true, claims: true });
      await p.write(osc52);
      expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
    },
  );

  // Round 7: a mouse event is judged by its own data only. Without sourceCapabilities (WebKit,
  // Firefox) a plain mouse event is a mouse's, so the orphan's plain mousedown acts there, as it did
  // before this owner existed. Its PointerEvent click (where the engine makes one) is still held back.
  it("RESIDUAL without sourceCapabilities: a held finger's plain mouse events act in the new terminal; its PointerEvent click does not", async () => {
    const p = await replaced(await setup(FOLLOWER));
    (document.activeElement as HTMLElement | null)?.blur();
    pointer(p.element, "pointerup");
    const pointerClick = new PointerEvent("click", {
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
    });
    p.element.dispatchEvent(pointerClick);
    expect(pointerClick.defaultPrevented).toBe(true);
    click(p, null);
    expect(clicked(p)).toEqual({ focused: true, claims: true });
  });

  it("a finger held while its tab closes clicks nothing into the tab shown under it", async () => {
    // The tab under it was tapped earlier, then hidden when the other tab was opened.
    const under = await setup(FOLLOWER);
    await under.write(MOUSE_APP);
    tap(under);
    click(under, true);
    expect(clicked(under)).toEqual({ focused: true, claims: true });
    under.view.rerender({ ...FOLLOWER, active: false });
    (document.activeElement as HTMLElement | null)?.blur();
    const closing = await setup(WRITER);
    pointer(closing.element, "pointerdown");
    touch(closing.element, "touchstart", [[100, 200]]);
    // The tab closes: its pane goes, and the one under it is the active tab again.
    closing.view.unmount();
    closing.container.remove();
    under.view.rerender(FOLLOWER);
    pointer(under.element, "pointerup");
    click(under, true);
    expect(clicked(under)).toEqual({ focused: false, claims: false });
    expect(tap(under).defaultPrevented).toBe(false);
    click(under, true);
    expect(clicked(under)).toEqual({ focused: true, claims: true });
  });

  it.each([
    ["a mouse", "mouse", false],
    ["a pen", "pen", false],
    ["a mouse (no sourceCapabilities)", "mouse", null],
    ["a pen (no sourceCapabilities)", "pen", null],
  ] as const)(
    "%s still clicks, claims and opens the copy window, also right after a held touch's replacement",
    async (_name, pointerType, byTouch) => {
      const p = await replaced(await setup(FOLLOWER));
      (document.activeElement as HTMLElement | null)?.blur();
      p.element.dispatchEvent(new PointerEvent("pointerdown", { pointerType, bubbles: true }));
      click(p, byTouch);
      expect(clicked(p)).toEqual({ focused: true, claims: true });
      await p.write(osc52);
      expect(p.copies).toEqual([{ kind: "text", text: "hi" }]);
    },
  );
});

// Round 6: xterm also acts on mouse events from listeners it adds to the document after a press
// (the release and drag reports, a selection's end), whatever their target. One owner per page
// decides for every pane before any of them, on the pane or on the document.
describe("one owner per page decides a touch's mouse events, also for xterm's document listeners", () => {
  type P = Awaited<ReturnType<typeof setup>>;
  const osc52 = "\x1b]52;c;aGk=\x07";
  const MOUSE_APP = "\x1b[?1000h\x1b[?1006h";
  const DRAG_APP = "\x1b[?1002h\x1b[?1006h";
  // 8x16 cells from the page origin: (50, 50) is column 7, row 4.
  const PRESS = "\x1b[<0;7;4M";
  const RELEASE = "\x1b[<0;7;4m";
  const blur = () => (document.activeElement as HTMLElement | null)?.blur();

  /** A pane in a mouse app whose screen has a size, so xterm's reports carry real positions. */
  async function measured(initial: Pane, mode = MOUSE_APP, options?: { strict?: boolean }) {
    const p = await setup(initial, options);
    await p.write(mode);
    const core = (
      p.terminal as unknown as {
        _core: {
          _charSizeService: { width: number; height: number };
          _renderService: {
            dimensions: {
              css: {
                cell: { width: number; height: number };
                canvas: { width: number; height: number };
              };
            };
          };
        };
      }
    )._core;
    core._charSizeService.width = 8;
    core._charSizeService.height = 16;
    Object.assign(core._renderService.dimensions.css.cell, { width: 8, height: 16 });
    Object.assign(core._renderService.dimensions.css.canvas, { width: 640, height: 384 });
    const screen = p.element.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) throw new Error("no screen");
    screen.style.padding = "0px";
    screen.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 384 });
    p.onData.mockClear();
    return p;
  }
  /**
   * A mouse event at (50, 50). `byTouch`: Chromium's `sourceCapabilities.firesTouchEvents`; null
   * leaves it out (WebKit, Firefox: the pointer events before it decide).
   */
  const fire = (
    target: EventTarget,
    type: string,
    byTouch: boolean | null,
    init: MouseEventInit = {},
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
      button: 0,
      buttons: type === "mousedown" ? 1 : 0,
      detail: type === "click" || type === "dblclick" ? 1 : 0,
      ...init,
    });
    if (byTouch !== null)
      Object.defineProperty(event, "sourceCapabilities", { value: { firesTouchEvents: byTouch } });
    target.dispatchEvent(event);
    return event;
  };
  const point = (target: EventTarget, type: string, pointerType: string) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerType,
        pointerId: pointerType === "touch" ? 2 : 1,
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
      }),
    );
  /** A mouse's or pen's press, as the browser sends it (its pointer event first). */
  const press = (target: EventTarget, pointerType: string, caps: false | null) => {
    point(target, "pointerdown", pointerType);
    fire(target, "mousedown", caps);
  };
  const release = (target: EventTarget, pointerType: string, caps: false | null) => {
    point(target, "pointerup", pointerType);
    fire(target, "mouseup", caps);
    fire(target, "click", caps);
  };
  /** A finger tapping `target`, then the browser's compatibility mouse events there. */
  const tapThenCompat = (target: EventTarget, caps: true | null) => {
    point(target, "pointerdown", "touch");
    touch(target, "touchstart", [[50, 50]]);
    point(target, "pointerup", "touch");
    touch(target, "touchend", []);
    return ["mousemove", "mousedown", "mouseup", "click"].map((type) => fire(target, type, caps));
  };

  it.each([false] as const)(
    "A-DOCUMENT: a touch elsewhere never ends a mouse press in progress (sourceCapabilities: %s)",
    async (caps) => {
      const touchCaps = caps === null ? null : true;
      const p = await measured(WRITER);
      press(p.element, "mouse", caps);
      expect(p.calls()).toEqual([[PRESS, "user"]]);
      p.onData.mockClear();
      // A touch on the page outside the pane: its mouseup would reach xterm's document listener.
      tapThenCompat(document.body, touchCaps);
      expect(p.calls()).toEqual([]);
      // A blur ends nothing: xterm still waits for the mouse's release.
      window.dispatchEvent(new Event("blur"));
      tapThenCompat(document.body, touchCaps);
      expect(p.calls()).toEqual([]);
      // The mouse's own release outside the pane is still reported (a desktop drag out of it).
      release(document.body, "mouse", caps);
      expect(p.calls()).toEqual([[RELEASE, "user"]]);
      p.onData.mockClear();
      // Released: the pane's own tap clicks again.
      blur();
      tapThenCompat(p.element, touchCaps);
      expect(p.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      expect(document.activeElement).toBe(p.textarea);
    },
  );

  it("A-DOCUMENT-CROSS: another pane's tap never ends a hidden pane's press; it clicks after the release", async () => {
    const a = await measured(WRITER);
    press(a.element, "mouse", false);
    expect(a.calls()).toHaveLength(1);
    const b = await measured(FOLLOWER);
    a.view.rerender({ ...WRITER, active: false });
    a.onData.mockClear();
    blur();
    tapThenCompat(b.element, true);
    expect(a.calls()).toEqual([]);
    // While A's press is in progress, B's tap clicks nothing either: its mousedown would start a
    // press in B that only the mouse's release could end. Its copy window still opens.
    expect(b.calls()).toEqual([]);
    expect(document.activeElement).not.toBe(b.textarea);
    await b.write(osc52);
    expect(b.copies).toEqual([{ kind: "text", text: "hi" }]);
    release(document.body, "mouse", false);
    expect(a.calls()).toEqual([[RELEASE, "user"]]);
    tapThenCompat(b.element, true);
    expect(b.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
  });

  // Owner decision (round 10): a live long press's context menu may focus the terminal before its
  // release is decided. That is intended: xterm only moves its textarea under the finger and
  // focuses it. It sends no user input (no keystroke or mouse-button report), takes no writer and
  // opens no copy window (only a tap's release opens that). A program that enabled focus reports
  // is told of the focus (the writer controls below).
  it("a live long press's context menu may focus the terminal: no user input, no copy window (intended)", async () => {
    const p = await measured(FOLLOWER);
    pageFocused();
    blur();
    point(p.element, "pointerdown", "touch");
    touch(p.element, "touchstart", [[50, 50]]);
    expect(document.activeElement).not.toBe(p.textarea);
    const menu = fire(p.element, "contextmenu", true, { button: 2 });
    expect(menu.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(p.textarea);
    await p.write(osc52);
    expect(p.calls()).toEqual([]);
    expect(p.copies).toEqual([]);
  });

  /**
   * The writer, in a program that enabled focus reports (DECSET 1004). The menu still focuses the
   * terminal; the only bytes it may cause are xterm's focus report, a `reply`: no `user` data
   * (which would take typing) and no copy window.
   */
  async function focusReportingWriter() {
    const p = await measured(WRITER);
    await p.write("\x1b[?1004h");
    pageFocused();
    blur();
    p.onData.mockClear();
    expect(document.activeElement).not.toBe(p.textarea);
    return p;
  }

  it("R10-1 (writer, focus reports on): a live long press's context menu focuses; only the focus report goes out, as a reply", async () => {
    const p = await focusReportingWriter();
    point(p.element, "pointerdown", "touch");
    touch(p.element, "touchstart", [[50, 50]]);
    const menu = fire(p.element, "contextmenu", true, { button: 2 });
    expect(menu.defaultPrevented).toBe(false);
    // The focus itself is kept: the menu is not suppressed.
    expect(document.activeElement).toBe(p.textarea);
    expect(p.calls()).toEqual([["\x1b[I", "reply"]]);
    await p.write(osc52);
    expect(p.copies).toEqual([]);
    expect(p.calls().filter(([, origin]) => origin !== "reply")).toEqual([]);
  });

  it("R10-1 (writer, focus reports on): an orphan plain context menu (residual c) focuses; only the focus report goes out, as a reply", async () => {
    const p = await focusReportingWriter();
    // No live touch or tap on this pane, and no sourceCapabilities or pointer type (WebKit, Firefox).
    const menu = fire(p.element, "contextmenu", null, { button: 2 });
    expect(menu.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(p.textarea);
    expect(p.calls()).toEqual([["\x1b[I", "reply"]]);
    await p.write(osc52);
    expect(p.copies).toEqual([]);
    expect(p.calls().filter(([, origin]) => origin !== "reply")).toEqual([]);
  });

  it("A-KEYBOARD: a keyboard's context menu after a touch is no touch's", async () => {
    const p = await measured(FOLLOWER);
    tapThenCompat(p.element, true);
    const menuKey = new KeyboardEvent("keydown", {
      key: "ContextMenu",
      code: "ContextMenu",
      keyCode: 93,
      bubbles: true,
      cancelable: true,
    });
    p.textarea.dispatchEvent(menuKey);
    expect(menuKey.defaultPrevented).toBe(false);
    // Long after the tap, and after another touch elsewhere: still the keyboard's.
    touch(document.body, "touchstart", [[1, 1]]);
    touch(document.body, "touchend", []);
    const menu = new PointerEvent("contextmenu", {
      pointerId: -1,
      pointerType: "",
      button: 2,
      bubbles: true,
      cancelable: true,
    });
    p.textarea.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("RESIDUAL without sourceCapabilities: a touch outside the panes ends a mouse press held in one (as before)", async () => {
    const p = await measured(WRITER);
    press(p.element, "mouse", null);
    p.onData.mockClear();
    // The tap's plain mouseup is a mouse's here: xterm's document listener takes it as the release.
    tapThenCompat(document.body, null);
    expect(p.calls()).toEqual([[RELEASE, "user"]]);
  });

  it("A-FALLBACK: no event is judged by another pointer's events (a PointerEvent click by its own type)", async () => {
    const old = await measured(FOLLOWER);
    point(old.element, "pointerdown", "touch");
    touch(old.element, "touchstart", [[50, 50]]);
    old.view.unmount();
    old.container.remove();
    const p = await measured(FOLLOWER);
    blur();
    point(p.element, "pointerup", "touch");
    // A mouse moves while the browser still holds the touch's compatibility events.
    point(document.body, "pointermove", "mouse");
    const click = new PointerEvent("click", {
      pointerType: "touch",
      pointerId: 2,
      bubbles: true,
      cancelable: true,
    });
    p.element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(p.textarea);
    expect(p.calls()).toEqual([]);
    // A mouse's own pointerdown, then a plain mousedown: a mouse's by its own data, whatever the
    // pointer events before it (R5-A-2: no announcement is borrowed, so no order is assumed).
    point(document.body, "pointerdown", "mouse");
    fire(p.element, "mousedown", null);
    fire(p.element, "mouseup", null);
    expect(p.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
  });

  it.each([
    ["mouse", false],
    ["mouse", null],
    ["pen", false],
    ["pen", null],
  ] as const)(
    "A-CHORD / B6-CHORD: a %s chord after a touch keeps all four reports (sourceCapabilities: %s)",
    async (pointerType, caps) => {
      const p = await measured(WRITER);
      tapThenCompat(p.element, caps === null ? null : true);
      p.onData.mockClear();
      press(p.element, pointerType, caps);
      // Pointer Events announce a chorded button by pointermove only; mouse events fire per button.
      const chord = (target: EventTarget, button: number, buttons: number) =>
        target.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerType,
            pointerId: 1,
            button,
            buttons,
            bubbles: true,
          }),
        );
      chord(p.element, 2, 3);
      fire(p.element, "mousedown", caps, { button: 2, buttons: 3 });
      chord(document.body, 2, 1);
      fire(document.body, "mouseup", caps, { button: 2, buttons: 1 });
      point(document.body, "pointerup", pointerType);
      fire(document.body, "mouseup", caps, { button: 0, buttons: 0 });
      expect(p.calls()).toEqual([
        [PRESS, "user"],
        ["\x1b[<2;7;4M", "user"],
        ["\x1b[<2;7;4m", "user"],
        [RELEASE, "user"],
      ]);
    },
  );

  it("B-SECURITY (writer): an outside touch after a retire and a new attach sends no release", async () => {
    const p = await measured(WRITER, DRAG_APP);
    const outside = document.body.appendChild(document.createElement("button"));
    point(outside, "pointerup", "touch");
    fire(outside, "mouseup", true);
    fire(outside, "mousemove", true);
    expect(p.calls()).toEqual([]);
    press(p.element, "mouse", false);
    expect(p.calls()).toEqual([[PRESS, "user"]]);
    act(() => p.view.result.current.retire());
    act(() => p.view.result.current.attached());
    p.onData.mockClear();
    touch(outside, "touchstart", [[50, 50]]);
    point(outside, "pointerup", "touch");
    fire(outside, "mousemove", true);
    fire(outside, "mouseup", true);
    expect(p.calls()).toEqual([]);
  });

  it("B-SECURITY (follower): an unrelated outside touch reuses neither the press nor its input arm", async () => {
    const p = await measured(FOLLOWER, DRAG_APP);
    const outside = document.body.appendChild(document.createElement("div"));
    press(p.element, "mouse", false);
    expect(p.calls()).toEqual([[PRESS, "user"]]);
    act(() => p.view.result.current.attached());
    p.onData.mockClear();
    // Past the mouse press's own copy window: only the touch could open one now.
    const later = Date.now() + 4_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => later);
    try {
      tapThenCompat(outside, true);
      await p.write(osc52);
      expect(p.copies).toEqual([]);
      expect(p.calls()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it.each([false, null] as const)(
    "keeps a desktop drag and its release outside the pane (sourceCapabilities: %s)",
    async (caps) => {
      const p = await measured(WRITER, DRAG_APP);
      press(p.element, "mouse", caps);
      point(document.body, "pointermove", "mouse");
      fire(document.body, "mousemove", caps, { buttons: 1, clientX: 58 });
      release(document.body, "mouse", caps);
      expect(p.calls()).toEqual([
        [PRESS, "user"],
        ["\x1b[<32;8;4M", "user"],
        [RELEASE, "user"],
      ]);
    },
  );

  it.each([
    ["mouse", false],
    ["pen", false],
    ["mouse", null],
    ["pen", null],
  ] as const)(
    "a %s click right after a tap acts, on the same pane and on another (sourceCapabilities: %s)",
    async (pointerType, caps) => {
      const touchCaps = caps === null ? null : true;
      const a = await measured(FOLLOWER);
      const b = await measured(FOLLOWER);
      const both: [P, P] = [a, b];
      for (const target of both) {
        blur();
        tapThenCompat(a.element, touchCaps);
        expect(a.calls()).toEqual([
          [PRESS, "user"],
          [RELEASE, "user"],
        ]);
        a.onData.mockClear();
        blur();
        press(target.element, pointerType, caps);
        release(target.element, pointerType, caps);
        expect(target.calls()).toEqual([
          [PRESS, "user"],
          [RELEASE, "user"],
        ]);
        expect(document.activeElement).toBe(target.textarea);
        a.onData.mockClear();
        b.onData.mockClear();
      }
    },
  );

  // Round 7 (R4-P-1 sibling): a tap's own mousedown makes xterm wait on the document for its
  // release, as a mouse press does. That press is the tap's: its own release ends it, and nothing
  // else a touch makes may, once the pane's interaction it belonged to has ended. Round 9 (F-FB-1):
  // its own release is its own by the press, not by its grant still being current, so it still
  // goes out after an interaction end (the app gets the release of the press it got); and a new
  // touch ends the press, whose terminal then sends nothing for that touch's release.
  const interactionEnds: Record<string, (p: P) => void | Promise<void>> = {
    "a retire and a new attach": (p) =>
      act(() => {
        p.view.result.current.retire();
        p.view.result.current.attached();
      }),
    "a retire": (p) => act(() => p.view.result.current.retire()),
    // A reset comes before the next attach's replay, which turns the mouse mode back on. (xterm's
    // reset also drops its own wait for the release; the owner's record stays until a real one.)
    "a reset": async (p) => {
      act(() => p.view.result.current.reset());
      await p.write(DRAG_APP);
    },
    "a new attach": (p) => act(() => p.view.result.current.attached()),
    "Select text": (p) => p.view.rerender({ ...WRITER, selecting: true }),
    following: (p) => p.view.rerender(FOLLOWER),
    "the tab hidden": (p) => p.view.rerender({ ...WRITER, active: false }),
    "the page hidden": () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    },
  };
  /** A tap on `p`, then its compatibility mousemove and mousedown: xterm takes the press. */
  const tapPress = (p: P) => {
    point(p.element, "pointerdown", "touch");
    touch(p.element, "touchstart", [[50, 50]]);
    point(p.element, "pointerup", "touch");
    touch(p.element, "touchend", []);
    fire(p.element, "mousemove", true);
    fire(p.element, "mousedown", true);
  };

  it.each(Object.keys(interactionEnds))(
    "A-RETIRED-TOUCH: a tap's press outlives %s; its own release ends it, and no other touch's reaches it",
    async (name) => {
      const p = await measured(WRITER, DRAG_APP);
      tapPress(p);
      expect(p.calls()).toEqual([[PRESS, "user"]]);
      await interactionEnds[name]?.(p);
      p.onData.mockClear();
      // A drag on the page: no longer the tap's (its grant ended).
      fire(document.body, "mousemove", true, { buttons: 1, clientX: 58 });
      expect(p.calls()).toEqual([]);
      // The tap's own release (late): the app gets the release of the press it got. (xterm's reset
      // already dropped its wait: nothing to send.)
      fire(p.element, "mouseup", true);
      expect(p.calls()).toEqual(name === "a reset" ? [] : [[RELEASE, "user"]]);
      p.onData.mockClear();
      // Ended: a release or drag on the page, another tap anywhere, a real release: nothing.
      fire(document.body, "mousemove", true, { buttons: 1, clientX: 58 });
      fire(document.body, "mouseup", true);
      tapThenCompat(document.body, true);
      fire(document.body, "mouseup", false);
      expect(p.calls()).toEqual([]);
      blur();
      tapThenCompat(p.element, true);
      expect(document.activeElement).toBe(p.textarea);
    },
  );

  it.each(Object.keys(interactionEnds))(
    "A-RETIRED-TOUCH: a tap's press outlives %s; another touch's release never completes it",
    async (name) => {
      const p = await measured(WRITER, DRAG_APP);
      tapPress(p);
      expect(p.calls()).toEqual([[PRESS, "user"]]);
      await interactionEnds[name]?.(p);
      p.onData.mockClear();
      // Another tap anywhere, before the tap's own release came: a new touch ends the press. Its
      // release reaches xterm's document listener, which sends nothing for it.
      tapThenCompat(document.body, true);
      fire(document.body, "mousemove", true, { buttons: 1, clientX: 58 });
      fire(document.body, "mouseup", true);
      fire(document.body, "mouseup", false);
      expect(p.calls()).toEqual([]);
      // Nothing is held back: a tap focuses and clicks again.
      blur();
      tapThenCompat(p.element, true);
      expect(document.activeElement).toBe(p.textarea);
      expect(p.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
    },
  );

  it("B6-TOUCH-PRESS: a tap's press whose release never came takes no later outside touch's release", async () => {
    const p = await measured(WRITER);
    tapPress(p);
    act(() => p.view.result.current.attached());
    p.onData.mockClear();
    point(document.body, "pointerdown", "touch");
    touch(document.body, "touchstart", [[50, 50]]);
    point(document.body, "pointerup", "touch");
    touch(document.body, "touchend", []);
    fire(document.body, "mouseup", true);
    expect(p.calls()).toEqual([]);
  });

  // Round 9, F-FB-1 (final review FB, T24-T26 in Chromium): a tap whose grant lapsed between its
  // own mousedown and mouseup left a press nothing could end: every later tap in every terminal
  // was held back until a remount, and the app saw a button held. Each case here must send the
  // press's matching release (or nothing at all) and leave the next taps working.
  it("T26: a tap whose grant runs out between its mousedown and mouseup (a janky page)", async () => {
    const a = await measured(WRITER);
    const b = await measured(WRITER);
    blur();
    point(a.element, "pointerdown", "touch");
    touch(a.element, "touchstart", [[50, 50]]);
    point(a.element, "pointerup", "touch");
    touch(a.element, "touchend", []);
    fire(a.element, "mousemove", true);
    fire(a.element, "mousedown", true);
    // A long task: the tap's window (1 s) is over before its mouseup and click are dispatched.
    const later = performance.now() + 1_500;
    const now = vi.spyOn(performance, "now").mockImplementation(() => later);
    try {
      fire(a.element, "mouseup", true);
      const click = fire(a.element, "click", true);
      expect(a.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      expect(document.activeElement).toBe(a.textarea);
      // The late click is no longer the tap's: held back, as before.
      expect(click.defaultPrevented).toBe(true);
      a.onData.mockClear();
      for (const target of [b, a]) {
        blur();
        tapThenCompat(target.element, true);
        expect(target.calls()).toEqual([
          [PRESS, "user"],
          [RELEASE, "user"],
        ]);
        expect(document.activeElement).toBe(target.textarea);
        target.onData.mockClear();
      }
    } finally {
      now.mockRestore();
    }
  });

  it("T24: a tap whose mouseup the browser re-aims at another terminal", async () => {
    const a = await measured(WRITER);
    const b = await measured(WRITER);
    blur();
    point(a.element, "pointerdown", "touch");
    touch(a.element, "touchstart", [[50, 50]]);
    point(a.element, "pointerup", "touch");
    touch(a.element, "touchend", []);
    fire(a.element, "mousemove", true);
    fire(a.element, "mousedown", true);
    fire(b.element, "mouseup", true);
    fire(document.body, "click", true);
    expect(a.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
    expect(b.calls()).toEqual([]);
    a.onData.mockClear();
    for (const target of [b, a]) {
      blur();
      tapThenCompat(target.element, true);
      expect(target.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      expect(document.activeElement).toBe(target.textarea);
      target.onData.mockClear();
    }
  });

  it("T25: a new attach inside the tap's own mousedown", async () => {
    const a = await measured(WRITER);
    const b = await measured(WRITER);
    blur();
    const attach = () => a.view.result.current.attached();
    a.element.addEventListener("mousedown", attach);
    point(a.element, "pointerdown", "touch");
    touch(a.element, "touchstart", [[50, 50]]);
    point(a.element, "pointerup", "touch");
    touch(a.element, "touchend", []);
    fire(a.element, "mousemove", true);
    fire(a.element, "mousedown", true);
    a.element.removeEventListener("mousedown", attach);
    fire(a.element, "mouseup", true);
    const click = fire(a.element, "click", true);
    expect(a.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
    expect(click.defaultPrevented).toBe(true);
    a.onData.mockClear();
    for (const target of [b, a]) {
      blur();
      tapThenCompat(target.element, true);
      expect(target.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      expect(document.activeElement).toBe(target.textarea);
      target.onData.mockClear();
    }
  });

  it("a tap's press is ended by its own release, also one outside the pane, and a drag of its own acts", async () => {
    const p = await measured(WRITER, DRAG_APP);
    tapPress(p);
    fire(document.body, "mousemove", true, { buttons: 1, clientX: 58 });
    fire(document.body, "mouseup", true);
    expect(p.calls()).toEqual([
      [PRESS, "user"],
      ["\x1b[<32;8;4M", "user"],
      [RELEASE, "user"],
    ]);
    p.onData.mockClear();
    // Ended: the next tap clicks as usual, here and with nothing held back on the page.
    blur();
    tapThenCompat(p.element, true);
    expect(p.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
    expect(document.activeElement).toBe(p.textarea);
  });

  // Round 9 (F-FB-1): before, this press held back every terminal tap until a real mouse release
  // or a remount (on a touch-only phone, a reload). Now the next touch ends it.
  it("a tap's press whose release never came holds back nothing once the next touch starts", async () => {
    const a = await measured(WRITER);
    const b = await measured(WRITER);
    tapPress(a);
    // A reset, then the next attach's replay turning the mouse mode back on.
    act(() => a.view.result.current.reset());
    await a.write(MOUSE_APP);
    a.onData.mockClear();
    blur();
    for (const target of [a, b]) {
      tapThenCompat(target.element, true);
      expect(target.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      expect(document.activeElement).toBe(target.textarea);
      target.onData.mockClear();
      blur();
    }
    const button = document.body.appendChild(document.createElement("button"));
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    tapThenCompat(button, true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(a.calls()).toEqual([]);
  });

  it("a double tap clicks twice and its dblclick acts", async () => {
    const p = await measured(FOLLOWER);
    blur();
    tapThenCompat(p.element, true);
    tapThenCompat(p.element, true);
    expect(fire(p.element, "dblclick", true).defaultPrevented).toBe(false);
    expect(p.calls()).toEqual([
      [PRESS, "user"],
      [RELEASE, "user"],
      [PRESS, "user"],
      [RELEASE, "user"],
    ]);
    expect(document.activeElement).toBe(p.textarea);
  });

  it("leaves the page's own buttons clickable by touch, also while a press is in progress", async () => {
    const p = await measured(WRITER);
    const button = document.body.appendChild(document.createElement("button"));
    const got: string[] = [];
    for (const type of ["mousemove", "mousedown", "mouseup", "click"])
      button.addEventListener(type, () => got.push(type));
    const events = tapThenCompat(button, true);
    expect(got).toEqual(["mousemove", "mousedown", "mouseup", "click"]);
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false, false]);
    press(p.element, "mouse", false);
    got.length = 0;
    tapThenCompat(button, true);
    // Its press and click still act; its mouseup and mousemove would be the press's end and drag.
    expect(got).toEqual(["mousedown", "click"]);
    expect(p.calls()).toEqual([[PRESS, "user"]]);
  });

  it("is one owner for two StrictMode panes, gone with the last; a disposed pane's press holds nothing", async () => {
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const owners = () => {
      const count = (spy: typeof add | typeof remove) =>
        spy.mock.calls.filter(
          ([type, , options], index) =>
            spy.mock.contexts[index] === document && type === "mousedown" && options === true,
        ).length;
      return count(add) - count(remove);
    };
    // xterm leaves its document listeners behind when disposed mid-press; they throw (and send
    // nothing) on a later mouseup or mousemove. Recorded here, and removed at the end.
    const leftovers: [string, EventListenerOrEventListenerObject][] = [];
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(String(event.message));
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      const a = await measured(WRITER, MOUSE_APP, { strict: true });
      const b = await measured(FOLLOWER, MOUSE_APP, { strict: true });
      expect(owners()).toBe(1);
      const before = add.mock.calls.length;
      press(a.element, "mouse", false);
      add.mock.calls.slice(before).forEach(([type, listener], index) => {
        if (add.mock.contexts[before + index] === document && listener && type.startsWith("mouse"))
          leftovers.push([type, listener]);
      });
      expect(leftovers.map(([type]) => type)).toEqual(["mouseup"]);
      expect(a.calls()).toEqual([[PRESS, "user"]]);
      a.onData.mockClear();
      a.view.unmount();
      a.container.remove();
      expect(owners()).toBe(1);
      // The disposed terminal's press neither sends a release nor holds back the other pane's tap.
      blur();
      tapThenCompat(b.element, true);
      expect(a.calls()).toEqual([]);
      expect(b.calls()).toEqual([
        [PRESS, "user"],
        [RELEASE, "user"],
      ]);
      b.view.unmount();
      b.container.remove();
      expect(owners()).toBe(0);
      expect(errors.every((message) => message.includes("dimensions"))).toBe(true);
    } finally {
      for (const [type, listener] of leftovers) document.removeEventListener(type, listener);
      window.removeEventListener("error", onError);
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
