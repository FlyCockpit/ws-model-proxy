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
    proposeDimensions() {
      return { cols: 80, rows: 24 };
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
  const subscribeOutput = vi.fn(
    (
      _localId: string,
      next: (event: TerminalOutputEvent) => void,
      _reset?: () => void,
      onRetire?: () => void,
    ) => {
      listener = next;
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
  return { subscribeOutput, emit, retireSession };
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
});
