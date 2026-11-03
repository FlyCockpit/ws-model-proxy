import {
  TERMINAL_BROWSER_JSON_BUDGET,
  TERMINAL_BROWSER_JSON_WINDOW_MS,
} from "@ws-model-proxy/config/terminal-socket-policy";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import { INITIAL_RECONNECT_BACKOFF, planReconnect } from "@/lib/reconnect-backoff";
import {
  decodeSealedFrame,
  parseTerminalServerMessage,
  type SealedTerminalFrame,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "@/lib/terminal-protocol";

/**
 * `unauthorized`: the relay closed the socket with 4401 (the session ended,
 * two-factor became mandatory, or the account is being deleted). Final:
 * no reconnect is attempted; only a reload (and sign-in) recovers.
 */
export type TerminalSocketStatus = "connecting" | "open" | "closed" | "unauthorized";

/** The relay's close code for a session it no longer accepts. */
export const TERMINAL_UNAUTHORIZED_CLOSE_CODE = 4401;

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
 * User intents (close, detach) at most this many. There is at most one close
 * per terminal out at a time, and a detach needs a click per tab, so this is a
 * safety bound, not a working limit.
 */
const OUTBOX_INTENT_LIMIT = 1024;

/** Frames that carry a person's decision; they leave ahead of redoable ones. */
function isIntent(message: TerminalClientMessage): boolean {
  return message.type === "close" || message.type === "detach";
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

/**
 * A socket that stayed open this long resets the reconnect backoff when it
 * closes (see `lib/reconnect-backoff.ts`): one the relay closes right after
 * accepting it keeps backing off.
 */
const RECONNECT_STABLE_MS = TERMINAL_BROWSER_JSON_WINDOW_MS;

/**
 * The socket's lifecycle inside the hook. `status` is derived from it
 * (`terminalSocketStatus`); `send` and `sendFrame` only use an `open` one.
 * - `idle`: disabled, or cleaned up.
 * - `connecting`: `socket` is opening; `outbox` is its (still unused) queue.
 * - `open`: `socket` is open since `openedAt` (monotonic) and drains `outbox`.
 * - `waiting`: the socket closed; the reconnect `timer` is armed.
 * - `unauthorized`: closed with 4401. Final: no reconnect.
 */
type TerminalConnection =
  | { kind: "idle" }
  | { kind: "connecting"; socket: WebSocket; outbox: Outbox }
  | { kind: "open"; socket: WebSocket; outbox: Outbox; openedAt: number }
  | { kind: "waiting"; timer: number }
  | { kind: "unauthorized" };

/** The status a connection shows; null keeps the previous one (`idle`). */
function terminalSocketStatus(connection: TerminalConnection): TerminalSocketStatus | null {
  switch (connection.kind) {
    case "idle":
      return null;
    case "connecting":
      return "connecting";
    case "open":
      return "open";
    case "waiting":
      return "closed";
    case "unauthorized":
      return "unauthorized";
  }
}

/** The socket a connection owns, if any: its events count only while it does. */
function connectionSocket(connection: TerminalConnection): WebSocket | null {
  return connection.kind === "connecting" || connection.kind === "open" ? connection.socket : null;
}

export function useTerminalSocket(
  enabled: boolean,
  handlers: TerminalSocketHandlers,
): {
  status: TerminalSocketStatus;
  /**
   * `sent` / `queued`: this socket took the message; it leaves now, or after
   * the frames ahead of it once the rate budget allows (a close or detach
   * goes ahead of lists, opens, attaches and auths). Neither is the
   * relay's answer: frames still waiting when the socket closes are dropped.
   * `closed` / `full`: nothing was kept (no open socket, or the queue is at
   * its bound). See `TerminalSendResult`.
   */
  send: (message: TerminalClientMessage) => TerminalSendResult;
  /** True once an open socket accepts the frame; relay processing is not confirmed. */
  sendFrame: (frame: ArrayBuffer) => boolean;
} {
  const handlersRef = useLatestRef(handlers);
  const connectionRef = useRef<TerminalConnection>({ kind: "idle" });
  const [status, setStatus] = useState<TerminalSocketStatus>("closed");

  const send = useCallback((message: TerminalClientMessage): TerminalSendResult => {
    const connection = connectionRef.current;
    if (connection.kind !== "open") return "closed";
    // A socket that is closing (its close event not yet here) drops the frame:
    // the drain sees it and empties the queue, and that reports `closed`.
    return enqueue(connection.outbox, JSON.stringify(message), isIntent(message));
  }, []);

  const sendFrame = useCallback((frame: ArrayBuffer) => {
    const connection = connectionRef.current;
    if (connection.kind !== "open" || connection.socket.readyState !== WebSocket.OPEN) return false;
    // Sealed frames have their own per-terminal budget on the relay.
    connection.socket.send(frame);
    return true;
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let backoff = INITIAL_RECONNECT_BACKOFF;

    const moveTo = (next: TerminalConnection) => {
      connectionRef.current = next;
      const nextStatus = terminalSocketStatus(next);
      if (nextStatus !== null) setStatus(nextStatus);
    };

    const connect = () => {
      const ws = openTerminalSocket();
      const outbox = newOutbox(ws);
      moveTo({ kind: "connecting", socket: ws, outbox });
      const owns = () => connectionSocket(connectionRef.current) === ws;
      ws.onopen = () => {
        const connection = connectionRef.current;
        if (connection.kind !== "connecting" || connection.socket !== ws) return;
        moveTo({ kind: "open", socket: ws, outbox, openedAt: performance.now() });
        handlersRef.current.onOpen?.();
        enqueue(outbox, JSON.stringify({ type: "list" }), false);
      };
      ws.onmessage = (event) => {
        if (!owns()) return;
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
      ws.onclose = (event) => {
        closeOutbox(outbox);
        const connection = connectionRef.current;
        // The cleanup (or a newer socket) took over: nothing to report.
        if (connectionSocket(connection) !== ws) return;
        if (event.code === TERMINAL_UNAUTHORIZED_CLOSE_CODE) {
          // Retrying cannot succeed with this session; stop here.
          moveTo({ kind: "unauthorized" });
          handlersRef.current.onDisconnect?.();
          return;
        }
        const plan = planReconnect(
          backoff,
          connection.kind === "open" ? performance.now() - connection.openedAt : null,
          RECONNECT_STABLE_MS,
        );
        backoff = plan.backoff;
        moveTo({ kind: "waiting", timer: window.setTimeout(connect, plan.delayMs) });
        handlersRef.current.onDisconnect?.();
      };
    };

    connect();
    return () => {
      const connection = connectionRef.current;
      connectionRef.current = { kind: "idle" };
      if (connection.kind === "waiting") window.clearTimeout(connection.timer);
      if (connection.kind === "connecting" || connection.kind === "open") {
        closeOutbox(connection.outbox);
        // Closing the page detaches. Do not send close for each terminal.
        connection.socket.close();
      }
    };
  }, [enabled, handlersRef]);

  return { status, send, sendFrame };
}
