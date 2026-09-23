import { useCallback, useEffect, useRef, useState } from "react";

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
  onDisconnect?: () => void;
};

function terminalSocketUrl(): string {
  const url = new URL(SOCKET_PATH, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export function useTerminalSocket(
  enabled: boolean,
  handlers: TerminalSocketHandlers,
): {
  status: TerminalSocketStatus;
  send: (message: TerminalClientMessage) => void;
  sendFrame: (frame: ArrayBuffer) => void;
} {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalSocketStatus>("closed");

  const transmit = useCallback((data: string | ArrayBuffer) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
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
      const ws = new WebSocket(terminalSocketUrl());
      ws.binaryType = "arraybuffer";
      socket = ws;
      socketRef.current = ws;
      ws.onopen = () => {
        if (disposed || socket !== ws) return;
        attempt = 0;
        setStatus("open");
        ws.send(JSON.stringify({ type: "list" }));
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
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        setStatus("closed");
        handlersRef.current.onDisconnect?.();
        timer = window.setTimeout(connect, reconnectDelayMs(attempt));
        attempt += 1;
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      socketRef.current = null;
      // Closing the page detaches. Do not send close for each terminal.
      socket?.close();
    };
  }, [enabled]);

  const send = useCallback(
    (message: TerminalClientMessage) => {
      transmit(JSON.stringify(message));
    },
    [transmit],
  );
  const sendFrame = useCallback(
    (frame: ArrayBuffer) => {
      transmit(frame);
    },
    [transmit],
  );

  return { status, send, sendFrame };
}
