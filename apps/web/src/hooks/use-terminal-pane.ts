import { type RefCallback, useEffect, useRef } from "react";

import { useXterm } from "@/hooks/use-xterm";

type TerminalPaneHandlers = {
  localId: string;
  active: boolean;
  sendInput: (localId: string, data: string) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  subscribeOutput: (
    localId: string,
    listener: (data: Uint8Array) => void,
    reset?: () => void,
  ) => () => void;
};

export function useTerminalPane(handlers: TerminalPaneHandlers): RefCallback<HTMLDivElement> {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const xterm = useXterm({
    onData: (data) => handlersRef.current.sendInput(handlersRef.current.localId, data),
    onResize: (size) =>
      handlersRef.current.sendResize(handlersRef.current.localId, size.cols, size.rows),
  });
  const writeRef = useRef(xterm.write);
  writeRef.current = xterm.write;
  const resetRef = useRef(xterm.reset);
  resetRef.current = xterm.reset;
  const { localId, active } = handlers;

  useEffect(() => {
    return handlersRef.current.subscribeOutput(
      localId,
      (data) => writeRef.current(data),
      () => resetRef.current(),
    );
  }, [localId]);

  useEffect(() => {
    if (active) xterm.focus();
  }, [active, xterm.focus]);

  return xterm.containerRef;
}
