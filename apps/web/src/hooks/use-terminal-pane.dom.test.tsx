// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";

type Written = string | { resize: [number, number] } | "reset";

type FakeTerminal = { log: Written[]; focused: number; parse: () => void };

const xterm = vi.hoisted(() => ({ instances: [] as FakeTerminal[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: "none" };
    textarea = null;
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
  return { ...actual, wireTerminalCopyOut: () => () => undefined };
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

describe("useTerminalPane", () => {
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

    act(() => result.current(document.createElement("div")));
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
    act(() => result.current(document.createElement("div")));
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
    act(() => result.current(document.createElement("div")));
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
      act(() => result.current(container));
      workspace.remove();
      return sendResize;
    };
    // Hidden (another dashboard page shows): a 0x0 box must not resize the PTY.
    expect(render(true)).not.toHaveBeenCalled();
    expect(render(false)).toHaveBeenCalledWith("local_1", 80, 24);
  });
});
