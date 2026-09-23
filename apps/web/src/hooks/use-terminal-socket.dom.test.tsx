// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTerminalSocket } from "./use-terminal-socket";

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

function SocketProbe({ onDisconnect }: { onDisconnect?: () => void }) {
  const socket = useTerminalSocket(true, {
    onMessage: () => undefined,
    onSealed: () => undefined,
    onDisconnect,
  });
  return (
    <button type="button" onClick={() => socket.send({ type: "close", terminalId: "old-term" })}>
      send
    </button>
  );
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
    const view = render(<SocketProbe onDisconnect={disconnected} />);
    const first = MockWebSocket.instances[0];
    first?.open();
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
    expect(next?.sent.filter((entry) => String(entry).includes("old-term"))).toEqual([]);
    expect(next?.sent).toContain(JSON.stringify({ type: "list" }));
    expect(sentBeforeClose).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
