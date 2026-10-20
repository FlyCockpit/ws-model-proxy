// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
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
    wireTerminalCopyOut: (term: FakeTerminal, _gate: unknown, emit: (data: string) => void) => {
      term.emit = emit;
      return () => {
        term.emit = null;
      };
    },
  };
});

import { useTerminalPane } from "./use-terminal-pane";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  xterm.instances.length = 0;
});

/** Output for one tab, held until a listener subscribes (as the session hook does). */
function outputSource() {
  let listener: ((event: TerminalOutputEvent) => void) | null = null;
  const queued: TerminalOutputEvent[] = [];
  const subscribeOutput = vi.fn((_localId: string, next: (event: TerminalOutputEvent) => void) => {
    listener = next;
    for (const event of queued.splice(0)) next(event);
    return () => {
      if (listener === next) listener = null;
    };
  });
  const emit = (event: TerminalOutputEvent) => {
    if (listener) listener(event);
    else queued.push(event);
  };
  return { subscribeOutput, emit };
}

const data = (text: string): TerminalOutputEvent => ({
  kind: "data",
  data: new TextEncoder().encode(text),
});

const attachment = (text: string): TerminalImageAttachment => ({
  id: "0".repeat(32),
  text,
  cancel: vi.fn(),
});

describe("useTerminalPane", () => {
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
      source.emit({ kind: "size", cols: 120, rows: 40 });
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
      source.emit({ kind: "size", cols: 120, rows: 40 });
      source.emit(data("new "));
      source.emit({ kind: "size", cols: 90, rows: 20 });
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
    expect(sendInput.mock.calls).toEqual([["local_1", expected]]);
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
});
