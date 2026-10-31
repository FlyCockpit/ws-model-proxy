// @vitest-environment jsdom

/**
 * xterm 6.0.0 on Linux moves its textarea under a middle click (`auxclick`, button 1) and focuses
 * it. xterm reads the platform once, when its bundle loads, so the pinned browser bundle is run
 * in a VM realm over this jsdom window with a Linux `navigator.platform`, under the real useXterm
 * hook and the real document owner of a touch's mouse events (reviewer B's B7-AUX, R7-B-1).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";

import { act, cleanup, renderHook } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.doUnmock("@xterm/xterm");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function linuxPane() {
  vi.resetModules();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/144.0");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
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
  const module: { exports: { Terminal?: typeof Terminal } } = { exports: {} };
  const realm = createContext({
    window,
    self: window,
    document,
    navigator,
    module,
    exports: module.exports,
    console,
    performance,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    HTMLElement,
    Element,
    HTMLCanvasElement,
    requestAnimationFrame,
    cancelAnimationFrame,
  });
  const bundle = createRequire(import.meta.url).resolve("@xterm/xterm");
  runInContext(readFileSync(bundle, "utf8"), realm, { filename: bundle });
  const LinuxTerminal = module.exports.Terminal;
  if (!LinuxTerminal) throw new Error("no xterm bundle");
  vi.doMock("@xterm/xterm", () => ({ Terminal: LinuxTerminal }));
  const { useXterm } = await import("./use-xterm");
  const onData = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const view = renderHook(() =>
    useXterm({
      active: true,
      selecting: false,
      follow: { cols: 80, rows: 24 },
      shiftEnter: "off",
      onResize() {},
      onData,
      onCopy() {},
    }),
  );
  act(() => view.result.current.containerRef(container));
  const textarea = container.querySelector("textarea");
  const element = container.querySelector(".xterm");
  if (!textarea || !element) throw new Error("xterm not open");
  /** A middle click as an engine makes it; `caps` is Chromium's `firesTouchEvents`, null none. */
  const middle = (caps: boolean | null, init: { pointerType?: string } = {}) => {
    const shape = { bubbles: true, cancelable: true, button: 1, clientX: 50, clientY: 60 };
    const event =
      init.pointerType === undefined
        ? new MouseEvent("auxclick", shape)
        : new PointerEvent("auxclick", { ...shape, pointerType: init.pointerType });
    if (caps !== null)
      Object.defineProperty(event, "sourceCapabilities", { value: { firesTouchEvents: caps } });
    element.dispatchEvent(event);
    return event;
  };
  return { textarea, onData, middle };
}

describe("Linux middle click (auxclick) in a pane without a tap", () => {
  it.each([
    ["Chromium (sourceCapabilities)", true, undefined],
    ["WebKit or Firefox (PointerEvent pointerType)", null, "touch"],
  ] as const)(
    "B7-AUX: a touch's, by %s, focuses nothing and moves nothing",
    async (_engine, caps, pointerType) => {
      const pane = await linuxPane();
      const left = pane.textarea.style.left;
      const event = pane.middle(caps, { pointerType });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(pane.textarea);
      expect(pane.textarea.style.left).toBe(left);
      expect(pane.onData).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a mouse's, by sourceCapabilities", false, undefined],
    ["a mouse's PointerEvent", null, "mouse"],
    ["a plain one (no capabilities, no pointer type)", null, undefined],
  ] as const)(
    "%s still moves the textarea under it and focuses it",
    async (_kind, caps, pointerType) => {
      const pane = await linuxPane();
      pane.middle(caps, { pointerType });
      expect(document.activeElement).toBe(pane.textarea);
      // clientX 50 less the screen's left (0 in jsdom) less 10.
      expect(pane.textarea.style.left).toBe("40px");
      expect(pane.onData).not.toHaveBeenCalled();
    },
  );
});
