import { type RefCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import { useXterm } from "@/hooks/use-xterm";
import type { Osc52Copy } from "@/lib/terminal-copy-out";
import type { TerminalImageAttachment } from "@/lib/terminal-images";
import {
  DEFAULT_TERMINAL_SHIFT_ENTER_MODE,
  type TerminalShiftEnterMode,
} from "@/lib/terminal-settings";
import type { TerminalInputOrigin, TerminalSize } from "@/lib/terminal-writer";

type TerminalPaneHandlers = {
  localId: string;
  active: boolean;
  /** The PTY size to show while someone else is typing, or null to fit. */
  follow: TerminalSize | null;
  sendInput: (localId: string, data: string | Uint8Array, origin?: TerminalInputOrigin) => void;
  onImage?: (file: File) => Promise<TerminalImageAttachment>;
  pasteImage?: (localId: string, id: string, data: string) => Promise<boolean>;
  onImageError?: (error: unknown) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  /** The box has no measurable size now (see the session hook's `sizeUnavailable`). */
  sizeUnavailable?: (localId: string) => void;
  onCopy?: (copy: Osc52Copy) => void;
  shiftEnter?: TerminalShiftEnterMode;
  /** Select text mode: a frozen plain-text copy of the terminal covers it. */
  selecting?: boolean;
  /** The session this tab's input goes to now (see useXterm `currentSession`). */
  currentSession?: (localId: string) => unknown;
  /** A new attach is about to replay the screen: anything tied to the old one is dropped. */
  onReset?: () => void;
  /**
   * Bumped when the person points at a tab (even the active one): the active pane takes focus,
   * wherever focus was. Keyboard tab navigation does not bump it, so focus stays on the tabs.
   */
  focusRequest?: number;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
    retire?: () => void,
  ) => () => void;
};

export function useTerminalPane(handlers: TerminalPaneHandlers): {
  containerRef: RefCallback<HTMLDivElement>;
  /** The text shown while selecting, or null when not selecting. */
  selectionText: string | null;
  /** Put keyboard focus in the terminal (after a bar over it closes). */
  focusTerminal: () => void;
} {
  const handlersRef = useLatestRef(handlers);
  const xterm = useXterm({
    follow: handlers.follow,
    shiftEnter: handlers.shiftEnter ?? DEFAULT_TERMINAL_SHIFT_ENTER_MODE,
    selecting: handlers.selecting ?? false,
    active: handlers.active,
    onCopy: (copy) => handlersRef.current.onCopy?.(copy),
    currentSession: () => handlersRef.current.currentSession?.(handlersRef.current.localId) ?? null,
    onData: (data, origin) =>
      handlersRef.current.sendInput(handlersRef.current.localId, data, origin),
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
    onSizeUnavailable: () => handlersRef.current.sizeUnavailable?.(handlersRef.current.localId),
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
    // The newest attach whose output this pane has shown. Output from an older one (buffered
    // before a reattach, or decrypted after its session ended) is stale: the new attach's replay
    // already holds the screen, and none of it may copy.
    let latestAttach: number | null = null;
    // Whether the pane has retired the latest attach (its output arrived marked `retired`).
    let latestRetired = false;
    return handlersRef.current.subscribeOutput(
      localId,
      (event) => {
        if (latestAttach !== null && event.attach < latestAttach) return;
        if (latestAttach !== event.attach) {
          latestAttach = event.attach;
          latestRetired = false;
          // An ended attach's output never reopens copy-out.
          if (!event.retired) xtermRef.current.attached();
        }
        if (event.retired && !latestRetired) {
          latestRetired = true;
          xtermRef.current.retire();
        }
        if (event.kind === "data") xtermRef.current.write(event.data, event.replay);
        else xtermRef.current.followResize({ cols: event.cols, rows: event.rows });
      },
      () => {
        handlersRef.current.onReset?.();
        xtermRef.current.reset();
      },
      // The session ended: what the pane holds for it is retired now, not at the next output.
      () => {
        handlersRef.current.onReset?.();
        xtermRef.current.retire();
      },
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
  // Select text ends. Not while the person is moving through the tabs with the keyboard: focus
  // stays on the tab list there.
  const { focus } = xterm;
  useEffect(() => {
    if (!active || !host || selecting) return;
    if (document.activeElement?.closest('[role="tablist"]')) return;
    focus();
  }, [active, host, focus, selecting]);
  // A pointer activation asks for focus explicitly: the request is handled once.
  const focusRequest = handlers.focusRequest ?? 0;
  const handledFocusRef = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRef.current) return;
    handledFocusRef.current = focusRequest;
    if (active && host && !selecting) focus();
  }, [active, focus, focusRequest, host, selecting]);

  return { containerRef: xterm.containerRef, selectionText, focusTerminal: focus };
}
