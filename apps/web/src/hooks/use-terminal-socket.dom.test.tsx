// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import {
  TERMINAL_BROWSER_JSON_BUDGET,
  TERMINAL_BROWSER_JSON_LIMIT,
  TERMINAL_BROWSER_JSON_WINDOW_MS,
} from "@ws-model-proxy/config/terminal-socket-policy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalClientMessage } from "@/lib/terminal-protocol";

import { type TerminalSendResult, useTerminalSocket } from "./use-terminal-socket";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  sent: Array<string | ArrayBuffer> = [];
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

function SocketProbe({ onOpen, onDisconnect }: { onOpen?: () => void; onDisconnect?: () => void }) {
  const socket = useTerminalSocket(true, {
    onMessage: () => undefined,
    onSealed: () => undefined,
    onOpen,
    onDisconnect,
  });
  return (
    <button
      type="button"
      onClick={() => socket.send({ type: "close", terminalId: "old-term", requestId: "close_1" })}
    >
      send
    </button>
  );
}

function BurstProbe({ count }: { count: number }) {
  const socket = useTerminalSocket(true, {
    onMessage: () => undefined,
    onSealed: () => undefined,
  });
  return (
    <button
      type="button"
      onClick={() => {
        for (let index = 0; index < count; index += 1) {
          socket.send({ type: "close", terminalId: `term-${index}`, requestId: `close_${index}` });
        }
      }}
    >
      burst
    </button>
  );
}

/** Exposes `send` so a test can drive it and read what it reports. */
function SendProbe({
  onReady,
}: {
  onReady: (send: (message: TerminalClientMessage) => TerminalSendResult) => void;
}) {
  const socket = useTerminalSocket(true, {
    onMessage: () => undefined,
    onSealed: () => undefined,
  });
  onReady(socket.send);
  return null;
}

function renderSend() {
  let send: ((message: TerminalClientMessage) => TerminalSendResult) | null = null;
  render(
    <SendProbe
      onReady={(value) => {
        send = value;
      }}
    />,
  );
  const socket = MockWebSocket.instances[0];
  if (!socket) throw new Error("no socket");
  socket.open();
  const texts = () =>
    socket.sent.map((entry) => JSON.parse(String(entry)) as TerminalClientMessage);
  return {
    socket,
    texts,
    send: (message: TerminalClientMessage) => {
      if (!send) throw new Error("not rendered");
      return send(message);
    },
  };
}

afterEach(() => {
  cleanup();
  MockWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("useTerminalSocket", () => {
  it("lists on open and does not send close when the page unmounts", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const view = render(<SocketProbe />);
    const socket = MockWebSocket.instances[0];
    expect(socket?.url).toContain("/api/dashboard/terminal/ws");
    socket?.open();
    await waitFor(() => {
      expect(socket?.sent).toContain(JSON.stringify({ type: "list" }));
    });
    view.unmount();
    const closeMessages = (socket?.sent ?? []).filter(
      (entry) => typeof entry === "string" && entry.includes('"type":"close"'),
    );
    expect(closeMessages).toEqual([]);
    expect(socket?.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("drops the outbound queue on close and does not replay it after reconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const disconnected = vi.fn();
    const opened = vi.fn();
    const view = render(<SocketProbe onOpen={opened} onDisconnect={disconnected} />);
    const first = MockWebSocket.instances[0];
    first?.open();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(first?.sent).toContain(JSON.stringify({ type: "list" }));
    view.getByRole("button", { name: "send" }).click();
    expect(first?.sent.some((entry) => String(entry).includes("old-term"))).toBe(true);
    const sentBeforeClose = first?.sent.length ?? 0;
    first?.close();
    expect(disconnected).toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    const next = MockWebSocket.instances.at(-1);
    expect(next).toBeTruthy();
    expect(next).not.toBe(first);
    next?.open();
    // Each new socket tells the sessions hook, so it can drop stale handshakes.
    expect(opened).toHaveBeenCalledTimes(2);
    expect(next?.sent.filter((entry) => String(entry).includes("old-term"))).toEqual([]);
    expect(next?.sent).toContain(JSON.stringify({ type: "list" }));
    expect(sentBeforeClose).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("paces JSON frames under the relay's limit, in order, and drops the rest on close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    expect(TERMINAL_BROWSER_JSON_BUDGET).toBeLessThan(TERMINAL_BROWSER_JSON_LIMIT);
    // A reconnect with 12 tabs: a list, then an attach and an auth per tab.
    const view = render(<BurstProbe count={24} />);
    const socket = MockWebSocket.instances[0];
    socket?.open();
    view.getByRole("button", { name: "burst" }).click();
    const sentTexts = () => (socket?.sent ?? []).map(String);
    expect(sentTexts()).toHaveLength(TERMINAL_BROWSER_JSON_BUDGET);
    vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS - 1);
    expect(sentTexts()).toHaveLength(TERMINAL_BROWSER_JSON_BUDGET);
    vi.advanceTimersByTime(1);
    expect(sentTexts()).toHaveLength(25);
    expect(sentTexts().slice(1)).toEqual(
      Array.from({ length: 24 }, (_, index) =>
        JSON.stringify({ type: "close", terminalId: `term-${index}`, requestId: `close_${index}` }),
      ),
    );
    // Frames still waiting when the socket closes are dropped with it.
    view.getByRole("button", { name: "burst" }).click();
    const before = sentTexts().length;
    socket?.close();
    vi.advanceTimersByTime(3 * TERMINAL_BROWSER_JSON_WINDOW_MS);
    expect(sentTexts().length).toBe(before);
    vi.useRealTimers();
  });

  it("reports sent, queued and closed, and sends intents ahead of waiting redoable frames", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { socket, texts, send } = renderSend();
    // The socket's own list took one slot of the budget.
    for (let index = 1; index < TERMINAL_BROWSER_JSON_BUDGET; index += 1) {
      expect(send({ type: "list" })).toBe("sent");
    }
    expect(send({ type: "list" })).toBe("queued");
    expect(send({ type: "close", terminalId: "t-1", requestId: "close_1" })).toBe("queued");
    expect(send({ type: "decline", terminalId: "t-2", requestId: "decline_1" })).toBe("queued");
    vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS);
    expect(
      texts()
        .slice(TERMINAL_BROWSER_JSON_BUDGET)
        .map((entry) => entry.type),
    ).toEqual(["close", "decline", "list"]);
    socket.close();
    expect(send({ type: "close", terminalId: "t-1", requestId: "close_2" })).toBe("closed");
    vi.useRealTimers();
  });

  it("bounds the redoable queue and refuses past it, while intents still queue", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { texts, send } = renderSend();
    const results: TerminalSendResult[] = [];
    for (let index = 0; index < 400; index += 1) results.push(send({ type: "list" }));
    const full = results.indexOf("full");
    // Budget minus the socket's own list sent, then the bounded queue.
    expect(full).toBe(TERMINAL_BROWSER_JSON_BUDGET - 1 + 256);
    expect(results.slice(full).every((result) => result === "full")).toBe(true);
    expect(send({ type: "close", terminalId: "t-1", requestId: "close_1" })).toBe("queued");
    vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS);
    // The close leaves first in the next window.
    expect(texts()[TERMINAL_BROWSER_JSON_BUDGET]).toMatchObject({ type: "close" });
    vi.useRealTimers();
  });

  it("paces on the monotonic clock, so a wall clock stepped back does not stall the queue", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { texts, send } = renderSend();
    for (let index = 0; index < TERMINAL_BROWSER_JSON_BUDGET + 2; index += 1)
      send({ type: "list" });
    expect(texts()).toHaveLength(TERMINAL_BROWSER_JSON_BUDGET);
    // An hour back on the wall clock (NTP step, manual change).
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS);
    expect(texts()).toHaveLength(TERMINAL_BROWSER_JSON_BUDGET + 3);
    vi.useRealTimers();
  });
});
