// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";

type Written = string | { resize: [number, number] } | "reset";

const xterm = vi.hoisted(() => ({ instances: [] as { log: Written[] }[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: "none" };
    textarea = null;
    log: Written[] = [];
    constructor() {
      xterm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    onResize() {
      return { dispose() {} };
    }
    write(data: Uint8Array) {
      this.log.push(new TextDecoder().decode(data));
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.log.push({ resize: [cols, rows] });
    }
    reset() {
      this.log.push("reset");
    }
    focus() {}
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
    expect(term?.log.filter((entry) => entry !== "reset")).toEqual([
      { resize: [100, 30] },
      "before ",
      "during ",
      { resize: [120, 40] },
      "mount",
    ]);
    act(() => source.emit(data("!")));
    expect(term?.log.at(-1)).toBe("!");
  });
});
