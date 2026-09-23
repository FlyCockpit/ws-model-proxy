import { type RefCallback, useEffect } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import { useXterm } from "@/hooks/use-xterm";
import type { TerminalSize } from "@/lib/terminal-writer";

type TerminalPaneHandlers = {
  localId: string;
  active: boolean;
  /** The PTY size to show while someone else is typing, or null to fit. */
  follow: TerminalSize | null;
  sendInput: (localId: string, data: string) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
  ) => () => void;
};

export function useTerminalPane(handlers: TerminalPaneHandlers): RefCallback<HTMLDivElement> {
  const handlersRef = useLatestRef(handlers);
  const xterm = useXterm({
    follow: handlers.follow,
    onData: (data) => handlersRef.current.sendInput(handlersRef.current.localId, data),
    onResize: (size) =>
      handlersRef.current.sendResize(handlersRef.current.localId, size.cols, size.rows),
  });
  const xtermRef = useLatestRef(xterm);
  const { localId, active } = handlers;
  const { host } = xterm;

  // Subscribe only once xterm exists. Until then the session hook keeps the
  // output (data and PTY sizes, in order) and hands it over on subscribe.
  // useXterm's own effects run first, so xterm is open when this one runs.
  useEffect(() => {
    if (!host) return;
    return handlersRef.current.subscribeOutput(
      localId,
      (event) => {
        if (event.kind === "data") xtermRef.current.write(event.data);
        else xtermRef.current.followResize({ cols: event.cols, rows: event.rows });
      },
      () => xtermRef.current.reset(),
    );
  }, [localId, host, handlersRef, xtermRef]);

  // Focus once the pane is active and xterm exists (a new host is a new xterm).
  const { focus } = xterm;
  useEffect(() => {
    if (active && host) focus();
  }, [active, host, focus]);

  return xterm.containerRef;
}
