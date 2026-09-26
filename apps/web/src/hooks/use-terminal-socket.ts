import {
  TERMINAL_BROWSER_JSON_BUDGET,
  TERMINAL_BROWSER_JSON_WINDOW_MS,
} from "@ws-model-proxy/config/terminal-socket-policy";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import {
  decodeSealedFrame,
  parseTerminalServerMessage,
  type SealedTerminalFrame,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "@/lib/terminal-protocol";

export type TerminalSocketStatus = "connecting" | "open" | "closed";

const SOCKET_PATH = "/api/dashboard/terminal/ws";
export type TerminalSocketHandlers = {
  onMessage: (message: TerminalServerMessage) => void;
  onSealed: (frame: SealedTerminalFrame) => void;
  /** A new socket opened. Anything begun on an earlier socket is obsolete. */
  onOpen?: () => void;
  onDisconnect?: () => void;
};

function terminalSocketUrl(): string {
  const url = new URL(SOCKET_PATH, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function openTerminalSocket(): WebSocket {
  const ws = new WebSocket(terminalSocketUrl());
  ws.binaryType = "arraybuffer";
  return ws;
}

/**
 * What `send` did with a JSON frame. `sent` and `queued` mean this socket
 * took it; neither is an answer from the relay. A queued frame is dropped if
 * the socket closes first, so a caller that must know the frame took effect
 * waits for the relay's answer to it (and sends it again after a reconnect).
 * `closed`: no open socket took it. `full`: the socket is open but its queue
 * is at its bound; nothing was queued.
 */
export type TerminalSendResult = "sent" | "queued" | "closed" | "full";

/** The socket took the frame (it left, or waits its turn in the outbox). */
export function sendTaken(result: TerminalSendResult): boolean {
  return result === "sent" || result === "queued";
}

/**
 * JSON frames the browser can safely redo (a list, an open, attach, or auth
 * the reconnect or backoff starts again) wait at most this many at once.
 */
const OUTBOX_REDO_LIMIT = 256;
/**
 * User intents (close, decline, detach) at most this many. There is at most
 * one close per terminal and one Decline per tab out at a time, and a detach
 * needs a click per tab, so this is a safety bound, not a working limit.
 */
const OUTBOX_INTENT_LIMIT = 1024;

/** Frames that carry a person's decision; they leave ahead of redoable ones. */
function isIntent(message: TerminalClientMessage): boolean {
  return message.type === "close" || message.type === "decline" || message.type === "detach";
}

/**
 * FIFO with O(1) dequeue: a head index, compacted once half the array is
 * spent. `shifted` counts every frame taken out, so a frame's position tells
 * whether it has left.
 */
type Fifo = { items: string[]; head: number; shifted: number };

function newFifo(): Fifo {
  return { items: [], head: 0, shifted: 0 };
}

function fifoSize(queue: Fifo): number {
  return queue.items.length - queue.head;
}

function fifoShift(queue: Fifo): string | undefined {
  if (queue.head >= queue.items.length) return undefined;
  const item = queue.items[queue.head];
  queue.head += 1;
  queue.shifted += 1;
  if (queue.head === queue.items.length) {
    queue.items = [];
    queue.head = 0;
  } else if (queue.head >= 64 && queue.head * 2 >= queue.items.length) {
    queue.items = queue.items.slice(queue.head);
    queue.head = 0;
  }
  return item;
}

/**
 * One socket's JSON frames, paced to the relay's rate limit: at most
 * `TERMINAL_BROWSER_JSON_BUDGET` per window leave; the rest wait here and go
 * out as the window allows, intents first, each queue in order. Dropped with
 * the socket. The window runs on the monotonic clock, so a wall-clock step
 * cannot stall it.
 */
type Outbox = {
  socket: WebSocket;
  /** `performance.now()` of each frame sent in the current window, oldest first. */
  sentAt: number[];
  intents: Fifo;
  redo: Fifo;
  timer: ReturnType<typeof setTimeout> | null;
};

function newOutbox(socket: WebSocket): Outbox {
  return {
    socket,
    sentAt: [],
    intents: newFifo(),
    redo: newFifo(),
    timer: null,
  };
}

function clearOutbox(outbox: Outbox) {
  outbox.intents = newFifo();
  outbox.redo = newFifo();
}

function drainOutbox(outbox: Outbox) {
  if (outbox.timer !== null) return;
  if (outbox.socket.readyState !== WebSocket.OPEN) {
    clearOutbox(outbox);
    return;
  }
  const now = performance.now();
  // At most BUDGET stamps are kept, so this is a bounded scan.
  while (
    outbox.sentAt.length > 0 &&
    now - (outbox.sentAt[0] ?? now) >= TERMINAL_BROWSER_JSON_WINDOW_MS
  ) {
    outbox.sentAt.shift();
  }
  while (outbox.sentAt.length < TERMINAL_BROWSER_JSON_BUDGET) {
    const text = fifoShift(outbox.intents) ?? fifoShift(outbox.redo);
    if (text === undefined) break;
    outbox.socket.send(text);
    outbox.sentAt.push(now);
  }
  const oldest = outbox.sentAt[0];
  const waiting = fifoSize(outbox.intents) + fifoSize(outbox.redo);
  if (waiting === 0 || oldest === undefined) return;
  outbox.timer = setTimeout(
    () => {
      outbox.timer = null;
      drainOutbox(outbox);
    },
    Math.max(1, oldest + TERMINAL_BROWSER_JSON_WINDOW_MS - now),
  );
}

/** Queue one frame (or refuse it at the queue's bound) and send what the budget allows. */
function enqueue(outbox: Outbox, text: string, intent: boolean): TerminalSendResult {
  const queue = intent ? outbox.intents : outbox.redo;
  if (fifoSize(queue) >= (intent ? OUTBOX_INTENT_LIMIT : OUTBOX_REDO_LIMIT)) return "full";
  const position = queue.shifted + fifoSize(queue);
  queue.items.push(text);
  drainOutbox(outbox);
  // The drain may replace the queue (socket closed); only this one's count says it left.
  const current = intent ? outbox.intents : outbox.redo;
  if (current !== queue) return "closed";
  return queue.shifted > position ? "sent" : "queued";
}

function closeOutbox(outbox: Outbox | null) {
  if (!outbox) return;
  if (outbox.timer !== null) clearTimeout(outbox.timer);
  outbox.timer = null;
  clearOutbox(outbox);
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/**
 * A socket that stayed open this long resets the reconnect backoff when it
 * closes. Opening alone does not: a relay that accepts and then closes at
 * once (a refused admission, a close right after a reconnect burst) would
 * otherwise be retried every half second forever.
 */
const RECONNECT_STABLE_MS = TERMINAL_BROWSER_JSON_WINDOW_MS;

export function useTerminalSocket(
  enabled: boolean,
  handlers: TerminalSocketHandlers,
): {
  status: TerminalSocketStatus;
  /**
   * `sent` / `queued`: this socket took the message; it leaves now, or after
   * the frames ahead of it once the rate budget allows (a close, Decline or
   * detach goes ahead of lists, opens, attaches and auths). Neither is the
   * relay's answer: frames still waiting when the socket closes are dropped.
   * `closed` / `full`: nothing was kept (no open socket, or the queue is at
   * its bound). See `TerminalSendResult`.
   */
  send: (message: TerminalClientMessage) => TerminalSendResult;
  sendFrame: (frame: ArrayBuffer) => void;
} {
  const handlersRef = useLatestRef(handlers);
  const socketRef = useRef<WebSocket | null>(null);
  const outboxRef = useRef<Outbox | null>(null);
  const [status, setStatus] = useState<TerminalSocketStatus>("closed");

  const send = useCallback((message: TerminalClientMessage): TerminalSendResult => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return "closed";
    const outbox = outboxRef.current;
    if (!outbox || outbox.socket !== socket) return "closed";
    return enqueue(outbox, JSON.stringify(message), isIntent(message));
  }, []);

  const sendFrame = useCallback((frame: ArrayBuffer) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Sealed frames have their own per-terminal budget on the relay.
    socket.send(frame);
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let disposed = false;
    let attempt = 0;
    let timer = 0;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      // The effect cleanup closes the current socket (`socket`) and clears
      // the reconnect timer.
      const ws = openTerminalSocket();
      socket = ws;
      socketRef.current = ws;
      closeOutbox(outboxRef.current);
      const outbox = newOutbox(ws);
      outboxRef.current = outbox;
      let openedAt: number | null = null;
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        openedAt = performance.now();
        setStatus("open");
        handlersRef.current.onOpen?.();
        enqueue(outbox, JSON.stringify({ type: "list" }), false);
      };
      ws.onmessage = (event) => {
        if (disposed || socket !== ws) return;
        if (typeof event.data === "string") {
          try {
            const message = parseTerminalServerMessage(JSON.parse(event.data));
            if (message) handlersRef.current.onMessage(message);
          } catch {
            // Ignore a text frame that is not JSON.
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          try {
            handlersRef.current.onSealed(decodeSealedFrame(event.data));
          } catch {
            // A bad sealed frame drops that frame only.
          }
        }
      };
      ws.onclose = () => {
        closeOutbox(outbox);
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        setStatus("closed");
        handlersRef.current.onDisconnect?.();
        if (openedAt !== null && performance.now() - openedAt >= RECONNECT_STABLE_MS) attempt = 0;
        timer = window.setTimeout(connect, reconnectDelayMs(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      socketRef.current = null;
      closeOutbox(outboxRef.current);
      outboxRef.current = null;
      // Closing the page detaches. Do not send close for each terminal.
      socket?.close();
    };
  }, [enabled, handlersRef]);

  return { status, send, sendFrame };
}
