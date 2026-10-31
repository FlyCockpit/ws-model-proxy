// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import type { CopyOutGate } from "@/lib/terminal-copy-out";
import type { TerminalImageAttachment } from "@/lib/terminal-images";

type Written = string | { resize: [number, number] } | "reset";

type FakeTerminal = {
  log: Written[];
  focused: number;
  parse: () => void;
  textarea: HTMLTextAreaElement;
  pasted: string[];
  emit: ((data: string) => void) | null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null;
  gate: CopyOutGate | null;
  binary: ((data: string) => void) | null;
  modes: { mouseTrackingMode: string };
  /** Lines scrolled in the scrollback (the normal buffer's wheel). */
  scrolled: number[];
  /** The alternate screen (no scrollback): the wheel sends arrow keys outside a mouse app. */
  alternate: boolean;
  element: HTMLElement | null;
};

const xterm = vi.hoisted(() => ({ instances: [] as FakeTerminal[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: "none" };
    textarea = document.createElement("textarea");
    pasted: string[] = [];
    emit: ((data: string) => void) | null = null;
    gate: CopyOutGate | null = null;
    /** Empty scrollback, for the Select text snapshot. */
    buffer = { active: { length: 0, getLine: () => undefined } };
    log: Written[] = [];
    focused = 0;
    /** Writes the parser has not reached yet, as xterm queues them. */
    queue: { data: string | Uint8Array; callback?: () => void }[] = [];
    constructor() {
      xterm.instances.push(this);
    }
    element: HTMLElement | null = null;
    loadAddon() {}
    open(container: HTMLElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
      // xterm's wheel listeners on its element: the custom wheel handler first, then in a mouse
      // app one SGR wheel report per event, on the alternate screen one arrow key (both
      // cancelled); otherwise left to the scrollback.
      this.element.addEventListener("wheel", (event) => {
        if (this.wheelHandler?.(event) === false) return;
        if (this.modes.mouseTrackingMode !== "none") {
          event.preventDefault();
          this.emit?.(event.deltaY < 0 ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M");
        } else if (this.alternate) {
          event.preventDefault();
          this.emit?.(event.deltaY < 0 ? "\x1b[A" : "\x1b[B");
        }
      });
    }
    alternate = false;
    wheelHandler: ((event: WheelEvent) => boolean) | null = null;
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
      this.wheelHandler = handler;
    }
    scrolled: number[] = [];
    scrollLines(amount: number) {
      this.scrolled.push(amount);
    }
    onResize() {
      return { dispose() {} };
    }
    /** xterm's binary channel (X10/normal mouse reports). */
    binary: ((data: string) => void) | null = null;
    onBinary(callback: (data: string) => void) {
      this.binary = callback;
      return { dispose() {} };
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.queue.push({ data, callback });
    }
    /** Run the parser over everything queued, as xterm does asynchronously. */
    parse() {
      for (const { data, callback } of this.queue.splice(0)) {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (text.length > 0) this.log.push(`${text}@${this.cols}x${this.rows}`);
        callback?.();
      }
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.log.push({ resize: [cols, rows] });
    }
    reset() {
      this.log.push("reset");
    }
    focus() {
      this.focused += 1;
    }
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    input(data: string) {
      this.emit?.(data);
    }
    paste(text: string) {
      this.pasted.push(text);
      this.emit?.(text);
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    /** 10x25 px cells: the default 800x600 box is 80x24. */
    proposeDimensions() {
      return { cols: Math.floor(box.width / 10), rows: Math.floor(box.height / 25) };
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/lib/terminal-copy-out", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminal-copy-out")>();
  return {
    ...actual,
    wireTerminalCopyOut: (term: FakeTerminal, gate: CopyOutGate, emit: (data: string) => void) => {
      term.emit = emit;
      term.gate = gate;
      return () => {
        term.emit = null;
      };
    },
  };
});

import { useTerminalPane } from "./use-terminal-pane";

/** The pane box's size: jsdom lays nothing out, so tests set it (0 is a hidden or empty box). */
const box = { width: 800, height: 600 };
/** ResizeObserver callbacks, so a test can fire a resize tick. */
const resizeObservers: (() => void)[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => box.width,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => box.height,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeObservers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  xterm.instances.length = 0;
  box.width = 800;
  box.height = 600;
  resizeObservers.length = 0;
});

/** Output for one tab, held until a listener subscribes (as the session hook does). */
function outputSource() {
  let listener: ((event: TerminalOutputEvent) => void) | null = null;
  const queued: TerminalOutputEvent[] = [];
  let retire: (() => void) | undefined;
  let reset: (() => void) | undefined;
  const subscribeOutput = vi.fn(
    (
      _localId: string,
      next: (event: TerminalOutputEvent) => void,
      onReset?: () => void,
      onRetire?: () => void,
    ) => {
      listener = next;
      reset = onReset;
      retire = onRetire;
      for (const event of queued.splice(0)) next(event);
      return () => {
        if (listener === next) listener = null;
      };
    },
  );
  const emit = (event: TerminalOutputEvent) => {
    if (listener) listener(event);
    else queued.push(event);
  };
  /** The session hook ending this tab's session (detach, disconnect). */
  const retireSession = () => retire?.();
  /** The session hook starting a new attach of this tab (before its replay). */
  const resetSession = () => reset?.();
  return { subscribeOutput, emit, retireSession, resetSession };
}

const data = (text: string, replay = false, attach = 1): TerminalOutputEvent => ({
  kind: "data",
  data: new TextEncoder().encode(text),
  replay,
  attach,
});

const attachment = (text: string): TerminalImageAttachment => ({
  id: "0".repeat(32),
  text,
  cancel: vi.fn(),
});

describe("useTerminalPane", () => {
  it("keeps copy-out closed until replayed output is parsed, even after a gesture", () => {
    const source = outputSource();
    const container = document.createElement("div");
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    const gate = term?.gate;
    if (!term || !gate) throw new Error("no terminal");
    act(() => source.emit(data("old screen with an OSC 52 copy", true)));
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(false);
    act(() => term.parse());
    expect(gate.allowed(true)).toBe(true);
    // Live output never closes the gate.
    act(() => source.emit(data("live")));
    expect(gate.allowed(true)).toBe(true);
  });

  it("pastes nothing, not even the fallback text, into a session that replaced the upload's", async () => {
    const source = outputSource();
    const onImageError = vi.fn();
    const sendInput = vi.fn();
    let session = { id: "first" };
    let fail: ((error: Error) => void) | undefined;
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
        currentSession: () => session,
        onImage: () =>
          new Promise<TerminalImageAttachment>((_resolve, reject) => {
            fail = reject;
          }),
        onImageError,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "image.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files", "text/plain"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "clipboard text",
      },
    });
    act(() => {
      term.textarea.dispatchEvent(event);
    });
    // A reattach replaced the session while the upload ran; the upload then fails.
    session = { id: "second" };
    await act(async () => {
      fail?.(new Error("unavailable"));
    });
    expect(term.pasted).toEqual([]);
    expect(sendInput).not.toHaveBeenCalled();
    expect(onImageError).toHaveBeenCalled();
  });

  it("drops an image paste that finishes uploading during Select text", async () => {
    const source = outputSource();
    const onImageError = vi.fn();
    const pasteImage = vi.fn(async () => true);
    let saved: ((value: TerminalImageAttachment) => void) | undefined;
    const { result, rerender } = renderHook(
      ({ selecting }: { selecting: boolean }) =>
        useTerminalPane({
          localId: "local_1",
          active: true,
          follow: null,
          selecting,
          sendInput: () => undefined,
          pasteImage,
          sendResize: () => undefined,
          subscribeOutput: source.subscribeOutput,
          onImage: () =>
            new Promise<TerminalImageAttachment>((resolve) => {
              saved = resolve;
            }),
          onImageError,
        }),
      { initialProps: { selecting: false } },
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files", "text/plain"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "accompanying text",
      },
    });
    act(() => {
      term.textarea.dispatchEvent(event);
    });
    rerender({ selecting: true });
    const offered = attachment("/tmp/wsmp-terminal-example/image.png ");
    await act(async () => {
      saved?.(offered);
    });
    expect(term.pasted).toEqual([]);
    expect(pasteImage).not.toHaveBeenCalled();
    expect(offered.cancel).toHaveBeenCalled();
    expect(onImageError).toHaveBeenCalledWith(expect.objectContaining({ message: "selecting" }));
  });

  it.each(["text/html", "text/rtf", "application/rtf"])(
    "pastes plain text from a %s clipboard without uploading its rendered image",
    (richType) => {
      const source = outputSource();
      const upload = vi.fn<(_file: File) => Promise<TerminalImageAttachment>>();
      const { result } = renderHook(() =>
        useTerminalPane({
          localId: "local_1",
          active: true,
          follow: null,
          sendInput: () => undefined,
          sendResize: () => undefined,
          subscribeOutput: source.subscribeOutput,
          onImage: upload,
        }),
      );
      act(() => result.current.containerRef(document.createElement("div")));
      const term = xterm.instances[0];
      if (!term) throw new Error("no terminal");
      const file = new File(["png"], "cells.png", { type: "image/png" });
      const event = new Event("paste", { cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types: ["Files", "text/plain", richType],
          items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
          getData: () => "Name\tValue\nExample\t42",
        },
      });
      act(() => {
        term.textarea.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(upload).not.toHaveBeenCalled();
      expect(term.pasted).toEqual(["Name\tValue\nExample\t42"]);
    },
  );

  it.each(["update", "unavailable"])("falls back to clipboard text on %s", async (reason) => {
    const source = outputSource();
    const onImageError = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
        onImage: async () => {
          throw new Error(reason);
        },
        onImageError,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "image.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files", "text/plain"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "clipboard text",
      },
    });
    await act(async () => {
      term.textarea.dispatchEvent(event);
    });
    expect(term.pasted).toEqual(["clipboard text"]);
    expect(onImageError).not.toHaveBeenCalled();
  });

  it("reports an image-only upload failure without pasting anything", async () => {
    const source = outputSource();
    const onImageError = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
        onImage: async () => {
          throw new Error("update");
        },
        onImageError,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "image.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "",
      },
    });
    await act(async () => {
      term.textarea.dispatchEvent(event);
    });
    expect(term.pasted).toEqual([]);
    expect(onImageError).toHaveBeenCalledWith(expect.objectContaining({ message: "update" }));
  });

  it("uploads a Files clipboard image before pseudopasting its path", async () => {
    const source = outputSource();
    const pasteImage = vi.fn(async () => true);
    const sendInput = vi.fn();
    let saved: ((value: TerminalImageAttachment) => void) | undefined;
    const upload = vi.fn(
      () =>
        new Promise<TerminalImageAttachment>((resolve) => {
          saved = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput,
        pasteImage,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
        onImage: upload,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "accompanying text",
      },
    });
    act(() => {
      term.textarea.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledWith(file);
    expect(term.pasted).toEqual([]);
    const offered = attachment("/tmp/wsmp-terminal-example/image.png ");
    await act(async () => {
      saved?.(offered);
    });
    expect(term.pasted).toEqual(["/tmp/wsmp-terminal-example/image.png "]);
    expect(sendInput).not.toHaveBeenCalled();
    expect(pasteImage).toHaveBeenCalledWith(
      "local_1",
      "0".repeat(32),
      "/tmp/wsmp-terminal-example/image.png ",
    );
    expect(offered.cancel).not.toHaveBeenCalled();
  });

  it("does not paste a late upload result after its terminal unmounts", async () => {
    const source = outputSource();
    let saved: ((value: TerminalImageAttachment) => void) | undefined;
    const { result, unmount } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
        onImage: () =>
          new Promise<TerminalImageAttachment>((resolve) => {
            saved = resolve;
          }),
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "",
      },
    });
    act(() => {
      term.textarea.dispatchEvent(event);
    });
    expect(saved).toBeTypeOf("function");
    unmount();
    const offered = attachment("/tmp/wsmp-terminal-example/image.png ");
    await act(async () => {
      saved?.(offered);
    });
    expect(term.pasted).toEqual([]);
    expect(offered.cancel).toHaveBeenCalledOnce();
  });

  it.each(["no data event", "forwarding blocked", "send declined", "send failed"])(
    "cancels the offer when image paste produces %s",
    async (failure) => {
      const offered = attachment("/tmp/image.png ");
      const pasteImage = vi.fn(async () => {
        if (failure === "send failed") throw new Error("unavailable");
        return false;
      });
      const onImageError = vi.fn();
      const { result } = renderHook(() =>
        useTerminalPane({
          localId: "local_1",
          active: true,
          follow: { cols: 80, rows: 24 },
          sendInput: () => undefined,
          pasteImage,
          sendResize: () => undefined,
          subscribeOutput: outputSource().subscribeOutput,
          onImage: async () => offered,
          onImageError,
        }),
      );
      act(() => result.current.containerRef(document.createElement("div")));
      const term = xterm.instances[0];
      if (!term) throw new Error("no terminal");
      if (failure === "no data event") term.emit = null;
      if (failure === "forwarding blocked") {
        const emit = term.emit;
        term.emit = () => emit?.("\x1b[I");
      }
      const file = new File(["png"], "image.png", { type: "image/png" });
      const event = new Event("paste", { cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types: ["Files"],
          items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
          getData: () => "",
        },
      });
      await act(async () => {
        term.textarea.dispatchEvent(event);
      });
      expect(offered.cancel).toHaveBeenCalledOnce();
      expect(onImageError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "unavailable" }),
      );
    },
  );

  it("writes output that arrived before and during a delayed mount once xterm exists", () => {
    const source = outputSource();
    source.emit(data("before "));
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: { cols: 100, rows: 30 },
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    // Rendered, but the container is not in the DOM yet: nothing may be drained.
    expect(xterm.instances).toHaveLength(0);
    expect(source.subscribeOutput).not.toHaveBeenCalled();
    act(() => {
      source.emit(data("during "));
      source.emit({ kind: "size", cols: 120, rows: 40, attach: 1 });
      source.emit(data("mount"));
    });
    expect(source.subscribeOutput).not.toHaveBeenCalled();

    act(() => result.current.containerRef(document.createElement("div")));
    const [term] = xterm.instances;
    act(() => term?.parse());
    expect(term?.log.filter((entry) => entry !== "reset")).toEqual([
      { resize: [100, 30] },
      "before @100x30",
      "during @100x30",
      { resize: [120, 40] },
      "mount@120x40",
    ]);
    act(() => {
      source.emit(data("!"));
      term?.parse();
    });
    expect(term?.log.at(-1)).toBe("!@120x40");
  });

  it("applies a PTY size only after the output written before it is parsed", () => {
    const source = outputSource();
    let follow = { cols: 100, rows: 30 };
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: false,
        follow,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const [term] = xterm.instances;
    if (!term) throw new Error("no xterm");
    act(() => {
      source.emit(data("old "));
      source.emit({ kind: "size", cols: 120, rows: 40, attach: 1 });
      source.emit(data("new "));
      source.emit({ kind: "size", cols: 90, rows: 20, attach: 1 });
      source.emit(data("last"));
    });
    // The session state follows the newest size before the parser gets there.
    follow = { cols: 90, rows: 20 };
    rerender();
    expect(term.log).toEqual([{ resize: [100, 30] }]);

    act(() => term.parse());
    expect(term.log).toEqual([
      { resize: [100, 30] },
      "old @100x30",
      { resize: [120, 40] },
      "new @120x40",
      { resize: [90, 20] },
      "last@90x20",
    ]);
  });

  it.each([
    ["lf", "\n"],
    ["esc-cr", "\u001b\r"],
  ] as const)("sends Shift+Enter as a newline in %s mode", (shiftEnter, expected) => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        shiftEnter,
        sendInput,
        sendResize: () => undefined,
        subscribeOutput: outputSource().subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const [term] = xterm.instances;
    if (!term?.keyHandler) throw new Error("no key handler");
    const keydown = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      cancelable: true,
    });
    expect(term.keyHandler(keydown)).toBe(false);
    expect(keydown.defaultPrevented).toBe(true);
    // The keypress and keyup of the same key are swallowed without sending again.
    expect(term.keyHandler(new KeyboardEvent("keypress", { key: "Enter", shiftKey: true }))).toBe(
      false,
    );
    expect(term.keyHandler(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(sendInput.mock.calls).toEqual([["local_1", expected, "user"]]);
  });

  it("focuses an active pane once its xterm exists", () => {
    const source = outputSource();
    let active = false;
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    active = true;
    rerender();
    act(() => result.current.containerRef(document.createElement("div")));
    const [term] = xterm.instances;
    expect(term?.focused).toBe(1);
    active = false;
    rerender();
    active = true;
    rerender();
    expect(term?.focused).toBe(2);
  });

  it("reports its own size only while the workspace is shown", () => {
    const render = (hidden: boolean) => {
      const sendResize = vi.fn();
      const { result } = renderHook(() =>
        useTerminalPane({
          localId: "local_1",
          active: !hidden,
          follow: { cols: 100, rows: 30 },
          sendInput: () => undefined,
          sendResize,
          subscribeOutput: outputSource().subscribeOutput,
        }),
      );
      const workspace = document.createElement("div");
      workspace.hidden = hidden;
      const container = document.createElement("div");
      workspace.appendChild(container);
      document.body.appendChild(workspace);
      act(() => result.current.containerRef(container));
      workspace.remove();
      return sendResize;
    };
    // Hidden (another dashboard page shows): a 0x0 box must not resize the PTY.
    expect(render(true)).not.toHaveBeenCalled();
    expect(render(false)).toHaveBeenCalledWith("local_1", 80, 24);
  });

  it("never reports a size for a zero-size box (FitAddon would make it 2x1)", () => {
    box.height = 0;
    const sendResize = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: { cols: 100, rows: 30 },
        sendInput: () => undefined,
        sendResize,
        subscribeOutput: outputSource().subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    expect(sendResize).not.toHaveBeenCalled();
  });

  it("reports its size when its tab is shown again, not while hidden", () => {
    const sendResize = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useTerminalPane({
          localId: "local_1",
          active,
          follow: null,
          sendInput: () => undefined,
          sendResize,
          subscribeOutput: outputSource().subscribeOutput,
        }),
      { initialProps: { active: false } },
    );
    act(() => result.current.containerRef(document.createElement("div")));
    expect(sendResize).not.toHaveBeenCalled();
    rerender({ active: true });
    expect(sendResize).toHaveBeenCalledWith("local_1", 80, 24);
  });

  /** A follower pane (someone else is the writer) mounted in a measurable box. */
  function follower(sendInput = vi.fn()) {
    const container = document.createElement("div");
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: { cols: 100, rows: 30 },
        sendInput,
        sendResize: () => undefined,
        subscribeOutput: outputSource().subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    return { term, container, sendInput };
  }

  it("forwards binary mouse reports as raw bytes", () => {
    const { term, container, sendInput } = follower();
    container.dispatchEvent(new Event("keydown"));
    // X10 mouse report: ESC [ M, then three bytes above 0x7f.
    act(() => term.binary?.("\x1b[M\x80\xa1\xb2"));
    expect(sendInput).toHaveBeenCalledWith(
      "local_1",
      Uint8Array.of(0x1b, 0x5b, 0x4d, 0x80, 0xa1, 0xb2),
      "user",
    );
  });

  it("takes a follower's modified F3 as a key, and a cursor report as a reply", () => {
    const { term, container, sendInput } = follower();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "F3", shiftKey: true }));
    act(() => term.emit?.("\x1b[1;2R"));
    expect(sendInput).toHaveBeenCalledWith("local_1", "\x1b[1;2R", "user");
    sendInput.mockClear();
    // A plain key, then the same bytes as a cursor report: never input.
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    act(() => term.emit?.("\x1b[1;2R"));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("takes text from an input event alone as typing", () => {
    const { term, container, sendInput } = follower();
    act(() => term.emit?.("x"));
    expect(sendInput).not.toHaveBeenCalled();
    container.dispatchEvent(new Event("input"));
    act(() => term.emit?.("x"));
    expect(sendInput).toHaveBeenCalledWith("local_1", "x", "user");
  });

  it("does not take a modifier pressed alone as input", () => {
    const { term, container, sendInput } = follower();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    act(() => term.emit?.("\x1b[<0;1;1M"));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("fits a taken-over pane only after the output queued at the old size is drawn", () => {
    const source = outputSource();
    let follow: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    act(() => term.parse());
    term.log.length = 0;
    act(() => source.emit(data("queued")));
    // This viewer takes over before xterm parsed the queued output.
    follow = null;
    rerender();
    expect(term.log).toEqual([]);
    act(() => term.parse());
    expect(term.log).toEqual(["queued@100x30", { resize: [80, 24] }]);
  });

  it("reports no size, and says so, for a writer whose box became zero-size", () => {
    const sendResize = vi.fn();
    const sizeUnavailable = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useTerminalPane({
          localId: "local_1",
          active,
          follow: null,
          sendInput: () => undefined,
          sendResize,
          sizeUnavailable,
          subscribeOutput: outputSource().subscribeOutput,
        }),
      { initialProps: { active: false } },
    );
    act(() => result.current.containerRef(document.createElement("div")));
    box.height = 0;
    rerender({ active: true });
    expect(sendResize).not.toHaveBeenCalled();
    expect(sizeUnavailable).toHaveBeenCalledWith("local_1");
  });

  it("drops an image paste that finishes uploading after its tab was hidden", async () => {
    const onImageError = vi.fn();
    const pasteImage = vi.fn(async () => true);
    let saved: ((value: TerminalImageAttachment) => void) | undefined;
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useTerminalPane({
          localId: "local_1",
          active,
          follow: null,
          sendInput: () => undefined,
          pasteImage,
          sendResize: () => undefined,
          subscribeOutput: outputSource().subscribeOutput,
          onImage: () =>
            new Promise<TerminalImageAttachment>((resolve) => {
              saved = resolve;
            }),
          onImageError,
        }),
      { initialProps: { active: true } },
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files", "text/plain"],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        getData: () => "accompanying text",
      },
    });
    act(() => {
      term.textarea.dispatchEvent(event);
    });
    rerender({ active: false });
    const offered = attachment("/tmp/wsmp-terminal-example/image.png ");
    await act(async () => {
      saved?.(offered);
    });
    expect(term.pasted).toEqual([]);
    expect(pasteImage).not.toHaveBeenCalled();
    expect(offered.cancel).toHaveBeenCalled();
    expect(onImageError).toHaveBeenCalledWith(expect.objectContaining({ message: "hidden" }));
  });

  it("reports a writer's first size even when xterm already has it", () => {
    const sendResize = vi.fn();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize,
        subscribeOutput: outputSource().subscribeOutput,
      }),
    );
    // The fake FitAddon proposes 80x24, xterm's own default: no resize event would fire.
    act(() => result.current.containerRef(document.createElement("div")));
    expect(sendResize).toHaveBeenCalledWith("local_1", 80, 24);
  });

  it("keeps applying PTY sizes queued while following after a takeover", () => {
    const source = outputSource();
    let follow: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    act(() => term.parse());
    term.log.length = 0;
    act(() => {
      source.emit(data("a"));
      source.emit({ kind: "size", cols: 120, rows: 40, attach: 1 });
      source.emit(data("b"));
    });
    follow = null;
    rerender();
    act(() => term.parse());
    expect(term.log).toEqual(["a@100x30", { resize: [120, 40] }, "b@120x40", { resize: [80, 24] }]);
  });

  it("does not refit on a resize tick while a takeover waits for queued output", () => {
    const source = outputSource();
    let follow: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    act(() => term.parse());
    term.log.length = 0;
    act(() => source.emit(data("queued")));
    follow = null;
    rerender();
    // The box changes size before xterm parsed the queued output.
    act(() => {
      for (const tick of resizeObservers) tick();
    });
    expect(term.log).toEqual([]);
    act(() => term.parse());
    expect(term.log).toEqual(["queued@100x30", { resize: [80, 24] }]);
  });

  it("retires gesture authorization as soon as its session ends", () => {
    const source = outputSource();
    const container = document.createElement("div");
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    const gate = term?.gate;
    if (!term || !gate) throw new Error("no terminal");
    act(() => term.parse());
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(true);
    act(() => source.retireSession());
    expect(gate.allowed(true)).toBe(false);
    // Still closed once xterm caught up: the gesture belonged to the ended session.
    act(() => term.parse());
    expect(gate.allowed(true)).toBe(false);
  });

  /** A pane whose follow size the test changes, with output it emits. */
  function switchable() {
    const source = outputSource();
    const state: { follow: { cols: number; rows: number } | null } = {
      follow: { cols: 100, rows: 30 },
    };
    const container = document.createElement("div");
    const { result, rerender } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: state.follow,
        sendInput: () => undefined,
        sendResize: () => undefined,
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    act(() => term.parse());
    term.log.length = 0;
    const follow = (next: { cols: number; rows: number } | null) => {
      state.follow = next;
      rerender();
    };
    return { term, source, follow, container };
  }

  it("still fits after a takeover when a size event is queued behind its barrier", () => {
    const { term, source, follow } = switchable();
    act(() => source.emit(data("a")));
    follow(null);
    // The CLI's echo of the new size arrives before xterm parsed anything.
    act(() => source.emit({ kind: "size", cols: 80, rows: 24, attach: 1 }));
    act(() => term.parse());
    expect(term.log).toEqual(["a@100x30", { resize: [80, 24] }]);
  });

  it("never lets an older takeover's fit run ahead of a newer follow period's output", () => {
    const { term, source, follow } = switchable();
    act(() => source.emit(data("a")));
    follow(null);
    follow({ cols: 100, rows: 30 });
    act(() => source.emit(data("b")));
    follow(null);
    act(() => term.parse());
    expect(term.log).toEqual(["a@100x30", "b@100x30", { resize: [80, 24] }]);
  });

  it("drops output from an attach older than one it has shown", () => {
    const { term, source } = switchable();
    act(() => source.emit(data("new", false, 2)));
    act(() => source.emit(data("stale", false, 1)));
    act(() => term.parse());
    expect(term.log).toEqual(["new@100x30"]);
  });

  it("keeps copy-out closed after its session ended until a newer attach's output arrives", () => {
    const { term, source, container } = switchable();
    const gate = term.gate;
    if (!gate) throw new Error("no gate");
    act(() => source.emit(data("live", false, 1)));
    act(() => term.parse());
    act(() => source.retireSession());
    // Output of the ended attach still arriving (a decryption that was in flight).
    act(() => source.emit(data("late", false, 1)));
    act(() => term.parse());
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(false);
    act(() => source.emit(data("replay", true, 2)));
    act(() => term.parse());
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(true);
  });

  it("never reopens copy-out for output delivered as retired, even to a pane that subscribes late", () => {
    const source = outputSource();
    // The attach ended before the pane subscribed: its buffered output arrives marked retired.
    source.emit({ ...data("late", false, 1), retired: true });
    const container = document.createElement("div");
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => {},
        sendResize: () => {},
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    if (!term?.gate) throw new Error("no xterm");
    const gate = term.gate;
    act(() => term.parse());
    expect(term.log).toEqual(["late@80x24"]);
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(false);
  });

  it("retires copy-out when live output of the shown attach starts arriving retired", () => {
    const { term, source, container } = switchable();
    const gate = term.gate;
    if (!gate) throw new Error("no gate");
    act(() => source.emit(data("live", false, 1)));
    act(() => term.parse());
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(true);
    act(() => source.emit({ ...data("late", false, 1), retired: true }));
    act(() => term.parse());
    container.dispatchEvent(new Event("pointerdown"));
    expect(gate.allowed(true)).toBe(false);
  });
});

/** Where the one finger these tests use was last (a touchend lifts it there). */
let lastFinger: { identifier: number; clientX: number; clientY: number } | null = null;

/**
 * A one-finger touch event with these fingers down (jsdom has no Touch constructor). Its
 * changedTouches are the finger it puts down, moves or lifts (where it was last).
 */
function touch(type: string, points: { x: number; y: number }[]) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  const touches = points.map((point) => ({ identifier: 0, clientX: point.x, clientY: point.y }));
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", {
    value: touches.length > 0 ? touches : lastFinger ? [lastFinger] : [],
  });
  lastFinger = touches[0] ?? null;
  return event;
}

/**
 * One finger on the pane from y0 to y1, with the pointer events a browser sends around it
 * (pointer events come first). A tap is the same with no movement.
 */
function swipe(container: HTMLElement, y0: number, y1: number) {
  container.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
  container.dispatchEvent(touch("touchstart", [{ x: 100, y: y0 }]));
  for (let step = 1; step <= 10; step += 1)
    container.dispatchEvent(touch("touchmove", [{ x: 100, y: y0 + ((y1 - y0) * step) / 10 }]));
  container.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
  const end = touch("touchend", []);
  container.dispatchEvent(end);
  return end;
}

/** The fake xterm draws no screen: a row is 16 px (the fallback height). */
const ROW = 16;
const WHEEL_DOWN = "\x1b[<65;1;1M";

describe("useTerminalPane touch scrolling", () => {
  function pane(options: { follow?: { cols: number; rows: number } | null; selecting?: boolean }) {
    const sendInput = vi.fn();
    const container = document.createElement("div");
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: options.follow ?? null,
        selecting: options.selecting ?? false,
        sendInput,
        sendResize: () => undefined,
        subscribeOutput: outputSource().subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(container));
    const term = xterm.instances[0];
    const gate = term?.gate;
    if (!term || !gate) throw new Error("no terminal");
    act(() => term.parse());
    return { term, gate, container, sendInput };
  }

  it("scrolls a mouse app with wheel reports, which open no copy window", () => {
    const { term, gate, container, sendInput } = pane({});
    term.modes.mouseTrackingMode = "vt200";
    const end = swipe(container, 300, 300 - 5 * ROW);
    // Round 9 (owner): a touch scroll is the person's own input, as a key is (it may take over).
    expect(sendInput.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ["local_1", WHEEL_DOWN, "user"]),
    );
    // A swipe is not a press: no copy window, and no click after it.
    expect(gate.allowed(true)).toBe(false);
    expect(end.defaultPrevented).toBe(true);
  });

  it("scrolls the scrollback outside a mouse app, sending nothing", () => {
    const { term, container, sendInput } = pane({});
    swipe(container, 100, 100 + 3 * ROW);
    expect(term.scrolled).toEqual([-1, -1, -1]);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("opens the copy window for a tap, when the finger lifts", () => {
    const { gate, container } = pane({});
    container.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
    );
    expect(gate.allowed(true)).toBe(false);
    const end = swipe(container, 200, 200);
    expect(gate.allowed(true)).toBe(true);
    expect(end.defaultPrevented).toBe(false);
  });

  it("still opens the copy window on a mouse press", () => {
    const { gate, container } = pane({});
    container.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }),
    );
    expect(gate.allowed(true)).toBe(true);
  });

  it("leaves a follower's swipe to the box: no wheel, no writer claim, no copy window", () => {
    const { term, gate, container, sendInput } = pane({ follow: { cols: 100, rows: 30 } });
    term.modes.mouseTrackingMode = "vt200";
    const end = swipe(container, 300, 100);
    expect(sendInput).not.toHaveBeenCalled();
    expect(term.scrolled).toEqual([]);
    expect(end.defaultPrevented).toBe(false);
    expect(gate.allowed(true)).toBe(false);
    // The swipe armed nothing: a report xterm sends now is still not this follower's input.
    act(() => term.emit?.(WHEEL_DOWN));
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not scroll during Select text", () => {
    const { term, container, sendInput } = pane({ selecting: true });
    term.modes.mouseTrackingMode = "vt200";
    swipe(container, 300, 100);
    expect(sendInput).not.toHaveBeenCalled();
    expect(term.scrolled).toEqual([]);
  });

  it("sends the alternate screen's arrow keys as the person's input", () => {
    const { term, container, sendInput } = pane({});
    term.alternate = true;
    swipe(container, 100, 100 + 2 * ROW);
    expect(sendInput.mock.calls).toEqual([
      ["local_1", "\x1b[A", "user"],
      ["local_1", "\x1b[A", "user"],
    ]);
  });

  it("sends the desktop wheel's input as wheel input, and keys after it as keys", async () => {
    const { term, container, sendInput } = pane({});
    term.modes.mouseTrackingMode = "vt200";
    const inner = term.element?.appendChild(document.createElement("div"));
    inner?.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
    expect(sendInput.mock.calls).toEqual([["local_1", WHEEL_DOWN, "wheel"]]);
    // A key right after it, in the same task, is a key.
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    act(() => term.emit?.("a"));
    // And so is data after the wheel's dispatch is over.
    await Promise.resolve();
    act(() => term.emit?.("b"));
    expect(sendInput.mock.calls.slice(1)).toEqual([
      ["local_1", "a", "user"],
      ["local_1", "b", "user"],
    ]);
  });

  it("never lets a follower's wheel through, even right after a key", () => {
    const { term, container, sendInput } = pane({ follow: { cols: 100, rows: 30 } });
    term.modes.mouseTrackingMode = "vt200";
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    term.element?.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, cancelable: true }));
    expect(sendInput).not.toHaveBeenCalled();
    // The key itself still goes out (and takes over).
    act(() => term.emit?.("a"));
    expect(sendInput.mock.calls).toEqual([["local_1", "a", "user"]]);
  });
});

/**
 * A flick's momentum, run on a controlled animation-frame queue: a gesture belongs to one
 * interaction, and whatever ends it (hidden, Select text, following, a reset, a retire, a new
 * attach) stops its queued frames for good.
 */
describe("useTerminalPane touch scrolling lifecycle", () => {
  let time = 0;
  let pending = new Map<number, FrameRequestCallback>();
  let handle = 0;
  const original = {
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
  });

  type Props = {
    active: boolean;
    selecting: boolean;
    follow: { cols: number; rows: number } | null;
  };

  function livePane() {
    time = 0;
    pending = new Map();
    handle = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      handle += 1;
      pending.set(handle, callback);
      return handle;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      pending.delete(id);
    };
    const source = outputSource();
    const sent: string[] = [];
    const container = document.createElement("div");
    const view = renderHook(
      (props: Props) =>
        useTerminalPane({
          localId: "local_1",
          ...props,
          sendInput: (_localId, input) => sent.push(String(input)),
          sendResize: () => undefined,
          subscribeOutput: source.subscribeOutput,
        }),
      { initialProps: { active: true, selecting: false, follow: null } as Props },
    );
    act(() => view.result.current.containerRef(container));
    const term = xterm.instances[0];
    if (!term) throw new Error("no terminal");
    act(() => term.parse());
    term.modes.mouseTrackingMode = "vt200";
    /** A flick up: reports during the drag, then momentum queued. */
    const flick = () => {
      container.dispatchEvent(touch("touchstart", [{ x: 100, y: 400 }]));
      for (let step = 1; step <= 5; step += 1) {
        time += 8;
        container.dispatchEvent(touch("touchmove", [{ x: 100, y: 400 - step * 20 }]));
      }
      container.dispatchEvent(touch("touchend", []));
    };
    /** Run every queued frame (as many as get queued), 16 ms apart. */
    const runFrames = () => {
      for (let count = 0; pending.size > 0 && count < 1000; count += 1) {
        const [id, callback] = [...pending.entries()][0] ?? [];
        if (id === undefined || !callback) break;
        pending.delete(id);
        time += 16;
        act(() => callback(time));
      }
    };
    /** Run the frames queued now even if they were cancelled (a browser may already have them). */
    const runQueued = (callbacks: FrameRequestCallback[]) => {
      for (const callback of callbacks) {
        time += 16;
        act(() => callback(time));
      }
    };
    return { ...view, source, sent, container, term, flick, runFrames, runQueued };
  }

  const queued = () => [...pending.values()];

  it("keeps coasting when nothing ends the interaction (the inverse)", () => {
    const { sent, flick, runFrames } = livePane();
    flick();
    const afterDrag = sent.length;
    expect(pending.size).toBe(1);
    runFrames();
    expect(sent.length).toBeGreaterThan(afterDrag + 3);
  });

  it("stops coasting for good when the tab is hidden, even if it is shown before the next frame", () => {
    const { sent, flick, rerender, runFrames, runQueued } = livePane();
    flick();
    const afterDrag = sent.length;
    const frames = queued();
    rerender({ active: false, selecting: false, follow: null });
    rerender({ active: true, selecting: false, follow: null });
    runQueued(frames);
    runFrames();
    expect(sent.length).toBe(afterDrag);
    // A new flick after it scrolls and coasts again.
    flick();
    const second = sent.length;
    expect(second).toBeGreaterThan(afterDrag);
    runFrames();
    expect(sent.length).toBeGreaterThan(second + 3);
  });

  it("stops coasting for good on Select text and on following, even when they end at once", () => {
    const { sent, flick, rerender, runQueued } = livePane();
    flick();
    let before = sent.length;
    let frames = queued();
    rerender({ active: true, selecting: true, follow: null });
    rerender({ active: true, selecting: false, follow: null });
    runQueued(frames);
    expect(sent.length).toBe(before);

    flick();
    before = sent.length;
    frames = queued();
    rerender({ active: true, selecting: false, follow: { cols: 100, rows: 30 } });
    rerender({ active: true, selecting: false, follow: null });
    runQueued(frames);
    expect(sent.length).toBe(before);
  });

  it("stops coasting when the session is retired, reset, or a new attach starts", () => {
    const { sent, flick, source, runQueued } = livePane();
    flick();
    let before = sent.length;
    let frames = queued();
    act(() => source.retireSession());
    // Output of a newer attach arrives before the old frame runs.
    act(() => source.emit(data("next", false, 2)));
    runQueued(frames);
    expect(sent.length).toBe(before);

    flick();
    before = sent.length;
    frames = queued();
    act(() => source.resetSession());
    runQueued(frames);
    expect(sent.length).toBe(before);

    flick();
    before = sent.length;
    frames = queued();
    act(() => source.emit(data("third", false, 3)));
    runQueued(frames);
    expect(sent.length).toBe(before);
  });

  it("ends a drag in progress on a retire: it scrolls no more, and its release is no click", () => {
    const { sent, container, source } = livePane();
    container.dispatchEvent(touch("touchstart", [{ x: 100, y: 400 }]));
    time += 8;
    container.dispatchEvent(touch("touchmove", [{ x: 100, y: 400 - 3 * ROW }]));
    const before = sent.length;
    expect(before).toBe(3);
    act(() => source.retireSession());
    time += 8;
    container.dispatchEvent(touch("touchmove", [{ x: 100, y: 400 - 8 * ROW }]));
    const end = touch("touchend", []);
    container.dispatchEvent(end);
    expect(sent.length).toBe(before);
    expect(pending.size).toBe(0);
    expect(end.defaultPrevented).toBe(true);
  });
});

describe("useTerminalPane sizing", () => {
  it("reports the size it measured on activation, not the one from before it was hidden", () => {
    const source = outputSource();
    const sendResize = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useTerminalPane({
          localId: "local_1",
          active,
          follow: null,
          sendInput: () => {},
          sendResize,
          subscribeOutput: source.subscribeOutput,
        }),
      { initialProps: { active: true } },
    );
    act(() => result.current.containerRef(document.createElement("div")));
    expect(sendResize).toHaveBeenLastCalledWith("local_1", 80, 24);
    rerender({ active: false });
    // The box changed while the tab was hidden.
    box.width = 1200;
    sendResize.mockClear();
    rerender({ active: true });
    expect(sendResize).toHaveBeenCalled();
    expect(sendResize).toHaveBeenLastCalledWith("local_1", 120, 24);
  });

  it("fits a writer to its box once the PTY sizes queued ahead of a resize tick are parsed", () => {
    const source = outputSource();
    const { result } = renderHook(() =>
      useTerminalPane({
        localId: "local_1",
        active: true,
        follow: null,
        sendInput: () => {},
        sendResize: () => {},
        subscribeOutput: source.subscribeOutput,
      }),
    );
    act(() => result.current.containerRef(document.createElement("div")));
    const term = xterm.instances[0];
    if (!term) throw new Error("no xterm");
    act(() => term.parse());
    // A PTY size is queued (not parsed yet) when the box grows: the tick leaves xterm's size to it.
    act(() => source.emit({ kind: "size", cols: 80, rows: 24, attach: 1 }));
    box.width = 1200;
    act(() => {
      for (const tick of resizeObservers) tick();
    });
    expect(term.log).toEqual([]);
    act(() => term.parse());
    expect(term.log).toEqual([{ resize: [120, 24] }]);
  });
});
