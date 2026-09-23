import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

import {
  CopyOutGate,
  clipboardTypesIncludeImage,
  wireTerminalCopyOut,
} from "@/lib/terminal-copy-out";

type XtermHandlers = {
  onData: (data: string) => void;
  onResize: (size: { cols: number; rows: number }) => void;
};

function readTheme(element: HTMLElement): { foreground: string; background: string } {
  const style = getComputedStyle(element);
  return {
    foreground: style.color || "#e7e7e7",
    background: style.backgroundColor || "#101113",
  };
}

export function useXterm(handlers: XtermHandlers): {
  containerRef: RefCallback<HTMLDivElement>;
  write: (data: Uint8Array) => void;
  reset: () => void;
  focus: () => void;
} {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const termRef = useRef<Terminal | null>(null);
  const gateRef = useRef(new CopyOutGate());
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      scrollback: 5000,
      theme: readTheme(container),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;
    const disposeCopyOut = wireTerminalCopyOut(term, gateRef.current, (data) => {
      handlersRef.current.onData(data);
    });
    const resizeSub = term.onResize((size) => {
      if (size.cols < 1 || size.rows < 1) return;
      handlersRef.current.onResize(size);
    });
    const onPaste = (event: ClipboardEvent) => {
      gateRef.current.armFromUserGesture();
      const types = event.clipboardData ? Array.from(event.clipboardData.types) : [];
      if (!clipboardTypesIncludeImage(types)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length > 0) term.paste(text);
    };
    term.textarea?.addEventListener("paste", onPaste, true);
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(container);
    fit.fit();
    return () => {
      observer.disconnect();
      term.textarea?.removeEventListener("paste", onPaste, true);
      disposeCopyOut();
      resizeSub.dispose();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
    };
  }, [container]);

  const write = useCallback((data: Uint8Array) => {
    termRef.current?.write(data);
  }, []);
  const reset = useCallback(() => {
    termRef.current?.reset();
  }, []);
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  return { containerRef: setContainer, write, reset, focus };
}
