// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  TERMINAL_BROWSER_JSON_BUDGET,
  TERMINAL_BROWSER_JSON_WINDOW_MS,
} from "@ws-model-proxy/config/terminal-socket-policy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryCliPinStore } from "@/lib/terminal-cli-identity";

import { useTerminalSessions } from "./use-terminal-sessions";

// The real socket hook and the real sessions hook together: the End session
// intent has to survive the socket's paced queue being dropped on close.
vi.mock("@/hooks/use-terminal-crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-terminal-crypto")>()),
  useTerminalIdentity: () => ({ ready: true, publicKey: () => null, sign: async () => null }),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const TERMINAL_ID = "dGVybWluYWwtaWQtMDAwMQ";

function listing(terminals: "running" | "gone") {
  return {
    type: "terminals",
    clis: [],
    terminals:
      terminals === "gone"
        ? []
        : [
            {
              terminalId: TERMINAL_ID,
              cliDeviceId: "cli",
              origin: "agent",
              cols: 80,
              rows: 24,
              viewerCount: 0,
              attachedHere: false,
              writerHere: false,
              viewerAttached: false,
              supervised: {
                commandId: "Y29tbWFuZC1pZC0wMDAwMQ",
                status: "running",
                command: "sleep 600",
                requester: "agent",
                shareOutput: false,
              },
            },
          ],
  };
}

function closesSent() {
  return FakeWebSocket.instances
    .flatMap((socket) => socket.sent.map((entry) => JSON.parse(entry)))
    .filter((entry) => entry.type === "close" && entry.terminalId === TERMINAL_ID);
}

/** End session on a running agent terminal while the socket's rate budget is spent. */
function endSessionBehindTheBudget() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("crypto", webcrypto);
  const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
  const first = FakeWebSocket.instances[0];
  if (!first) throw new Error("no socket");
  act(() => first.open());
  act(() => first.receive(listing("running")));
  const localId = view.result.current.tabs[0]?.localId ?? "";
  // Spend the rest of the window's budget on lists (the socket's own list took one).
  act(() => {
    for (let index = 1; index < TERMINAL_BROWSER_JSON_BUDGET; index += 1) {
      void view.result.current.refreshClis();
    }
  });
  expect(first.sent).toHaveLength(TERMINAL_BROWSER_JSON_BUDGET);
  act(() => view.result.current.endSession(localId));
  return { view, first, localId };
}

afterEach(() => {
  cleanup();
  FakeWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("End session across a dropped socket (real socket and sessions hooks)", () => {
  it("does not show the session ended while its close only waits in the socket's queue", () => {
    const { view, first, localId } = endSessionBehindTheBudget();
    // Queued, not sent: the tab stays, marked as ending.
    expect(closesSent()).toHaveLength(0);
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ localId, ending: "pending" }),
    ]);
    // The socket closes before the rate window opens: the queued close is lost.
    act(() => first.close());
    act(() => vi.advanceTimersByTime(20_000));
    const second = FakeWebSocket.instances.at(-1);
    if (!second || second === first) throw new Error("no new socket");
    act(() => second.open());
    act(() => second.receive(listing("running")));
    act(() => vi.advanceTimersByTime(2 * TERMINAL_BROWSER_JSON_WINDOW_MS));
    // The relay still runs it, so the close goes out again, once.
    expect(closesSent()).toHaveLength(1);
    expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
    const [close] = closesSent();
    act(() =>
      second.receive({ type: "closed", terminalId: TERMINAL_ID, requestId: close.requestId }),
    );
    expect(view.result.current.tabs).toEqual([]);
  });

  it("removes the tab without another close when the next socket's list shows it ended", () => {
    const { view, first } = endSessionBehindTheBudget();
    act(() => first.close());
    act(() => vi.advanceTimersByTime(20_000));
    const second = FakeWebSocket.instances.at(-1);
    if (!second || second === first) throw new Error("no new socket");
    act(() => second.open());
    act(() => second.receive(listing("gone")));
    act(() => vi.advanceTimersByTime(2 * TERMINAL_BROWSER_JSON_WINDOW_MS));
    expect(closesSent()).toHaveLength(0);
    expect(view.result.current.tabs).toEqual([]);
  });

  it("sends a queued close first once the window opens on the same socket", () => {
    const { view, first, localId } = endSessionBehindTheBudget();
    act(() => void view.result.current.refreshClis());
    act(() => vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS));
    const after = first.sent.slice(TERMINAL_BROWSER_JSON_BUDGET).map((entry) => JSON.parse(entry));
    expect(after.map((entry) => entry.type)).toEqual(["close", "list"]);
    expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
  });
});
