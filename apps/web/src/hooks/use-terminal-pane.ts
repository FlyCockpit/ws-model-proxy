import { type RefCallback, useEffect, useLayoutEffect, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import { useXterm } from "@/hooks/use-xterm";
import type { Osc52Copy } from "@/lib/terminal-copy-out";
import type { TerminalImageAttachment } from "@/lib/terminal-images";
import {
  DEFAULT_TERMINAL_SHIFT_ENTER_MODE,
  type TerminalShiftEnterMode,
} from "@/lib/terminal-settings";
import type { TerminalSize } from "@/lib/terminal-writer";

type TerminalPaneHandlers = {
  localId: string;
  active: boolean;
  /** The PTY size to show while someone else is typing, or null to fit. */
  follow: TerminalSize | null;
  sendInput: (localId: string, data: string) => void;
  onImage?: (file: File) => Promise<TerminalImageAttachment>;
  pasteImage?: (localId: string, id: string, data: string) => Promise<boolean>;
  onImageError?: (error: unknown) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  onCopy?: (copy: Osc52Copy) => void;
  shiftEnter?: TerminalShiftEnterMode;
  /** Select text mode: a frozen plain-text copy of the terminal covers it. */
  selecting?: boolean;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
  ) => () => void;
};

export function useTerminalPane(handlers: TerminalPaneHandlers): {
  containerRef: RefCallback<HTMLDivElement>;
  /** The text shown while selecting, or null when not selecting. */
  selectionText: string | null;
} {
  const handlersRef = useLatestRef(handlers);
  const xterm = useXterm({
    follow: handlers.follow,
    shiftEnter: handlers.shiftEnter ?? DEFAULT_TERMINAL_SHIFT_ENTER_MODE,
    onCopy: (copy) => handlersRef.current.onCopy?.(copy),
    onData: (data) => handlersRef.current.sendInput(handlersRef.current.localId, data),
    onImage: (file) => {
      const upload = handlersRef.current.onImage;
      if (!upload) return Promise.reject(new Error("unavailable"));
      return upload(file);
    },
    onImageError: (error) => handlersRef.current.onImageError?.(error),
    onImagePaste: (attachment, data) =>
      handlersRef.current.pasteImage?.(handlersRef.current.localId, attachment.id, data) ??
      Promise.resolve(false),
    onResize: (size) =>
      handlersRef.current.sendResize(handlersRef.current.localId, size.cols, size.rows),
  });
  const xtermRef = useLatestRef(xterm);
  const { localId, active } = handlers;
  const selecting = handlers.selecting ?? false;
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

  // Select text: freeze the text when the mode starts, before paint so the overlay never flashes
  // empty. Output keeps reaching xterm underneath; leaving the mode shows it live again.
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const { snapshot } = xterm;
  useLayoutEffect(() => {
    setSelectionText(selecting && host ? snapshot() : null);
  }, [selecting, host, snapshot]);

  // Focus once the pane is active and xterm exists (a new host is a new xterm), and again when
  // Select text ends.
  const { focus } = xterm;
  useEffect(() => {
    if (active && host && !selecting) focus();
  }, [active, host, focus, selecting]);

  return { containerRef: xterm.containerRef, selectionText };
}
