import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import {
  CopyOutGate,
  clipboardTypesIncludeImage,
  wireTerminalCopyOut,
} from "@/lib/terminal-copy-out";
import {
  sameSize,
  shouldForwardTerminalData,
  type TerminalSize,
  TerminalUserInputGate,
} from "@/lib/terminal-writer";

type XtermHandlers = {
  onData: (data: string) => void;
  /** This pane's own fitted size changed. A follower reports it without resizing xterm. */
  onResize: (size: TerminalSize) => void;
};

type XtermOptions = XtermHandlers & {
  /** Render at this PTY size (someone else is typing), or null to fit the box. */
  follow: TerminalSize | null;
};

function readTheme(element: HTMLElement): { foreground: string; background: string } {
  // The pane around the scroll box carries the terminal colors. The box itself
  // shades the area a smaller PTY leaves unused.
  const style = getComputedStyle(element.parentElement ?? element);
  return {
    foreground: style.color || "#e7e7e7",
    background: style.backgroundColor || "#101113",
  };
}

export function useXterm(options: XtermOptions): {
  containerRef: RefCallback<HTMLDivElement>;
  write: (data: Uint8Array) => void;
  reset: () => void;
  focus: () => void;
  /** Apply a PTY size change in output order, while following. */
  followResize: (size: TerminalSize) => void;
} {
  const handlersRef = useLatestRef<XtermHandlers>(options);
  const followRef = useLatestRef(options.follow);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [gate] = useState(() => new CopyOutGate());
  const [inputGate] = useState(() => new TerminalUserInputGate());
  const ownSizeRef = useRef<TerminalSize | null>(null);
  /** Set while this hook resizes xterm itself, so onResize does not echo it. */
  const suppressResizeRef = useRef(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const resizeQuietly = useCallback((size: TerminalSize) => {
    const term = termRef.current;
    if (!term || (term.cols === size.cols && term.rows === size.rows)) return;
    suppressResizeRef.current = true;
    try {
      term.resize(size.cols, size.rows);
    } finally {
      suppressResizeRef.current = false;
    }
  }, []);

  /** Fit own box, or record own size and show the PTY size while following. */
  const layout = useCallback(() => {
    const fit = fitRef.current;
    if (!fit) return;
    const follow = followRef.current;
    if (!follow) {
      fit.fit();
      return;
    }
    const proposed = fit.proposeDimensions();
    if (proposed && proposed.cols > 0 && proposed.rows > 0) {
      const own = { cols: proposed.cols, rows: proposed.rows };
      if (!sameSize(own, ownSizeRef.current)) {
        ownSizeRef.current = own;
        handlersRef.current.onResize(own);
      }
    }
    resizeQuietly(follow);
  }, [followRef, handlersRef, resizeQuietly]);

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
    fitRef.current = fit;
    const disposeCopyOut = wireTerminalCopyOut(term, gate, (data) => {
      const forward = shouldForwardTerminalData({
        following: followRef.current !== null,
        userInput: inputGate.armed(performance.now()),
        data,
      });
      if (forward) handlersRef.current.onData(data);
    });
    const resizeSub = term.onResize((size) => {
      if (suppressResizeRef.current || size.cols < 1 || size.rows < 1) return;
      ownSizeRef.current = { cols: size.cols, rows: size.rows };
      handlersRef.current.onResize(size);
    });
    const armInput = () => inputGate.arm(performance.now());
    // A click claims the writer only in a mouse-reporting app. The wheel never does.
    const armClick = () => {
      if (term.modes.mouseTrackingMode !== "none") armInput();
    };
    const onPaste = (event: ClipboardEvent) => {
      gate.armFromUserGesture();
      armInput();
      const types = event.clipboardData ? Array.from(event.clipboardData.types) : [];
      if (!clipboardTypesIncludeImage(types)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length > 0) term.paste(text);
    };
    container.addEventListener("keydown", armInput, true);
    container.addEventListener("compositionstart", armInput, true);
    container.addEventListener("compositionupdate", armInput, true);
    container.addEventListener("compositionend", armInput, true);
    container.addEventListener("mousedown", armClick, true);
    term.textarea?.addEventListener("paste", onPaste, true);
    const observer = new ResizeObserver(() => {
      layout();
    });
    observer.observe(container);
    layout();
    return () => {
      observer.disconnect();
      container.removeEventListener("keydown", armInput, true);
      container.removeEventListener("compositionstart", armInput, true);
      container.removeEventListener("compositionupdate", armInput, true);
      container.removeEventListener("compositionend", armInput, true);
      container.removeEventListener("mousedown", armClick, true);
      term.textarea?.removeEventListener("paste", onPaste, true);
      disposeCopyOut();
      resizeSub.dispose();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
  }, [container, followRef, gate, handlersRef, inputGate, layout]);

  const followCols = options.follow?.cols ?? null;
  const followRows = options.follow?.rows ?? null;
  // Entering or leaving follow mode, or a new PTY size: lay out again.
  useEffect(() => {
    if (!container) return;
    if (followCols === null || followRows === null) {
      // Leaving follow mode fits the box; the fitted size then goes to the CLI.
      fitRef.current?.fit();
      return;
    }
    layout();
  }, [container, followCols, followRows, layout]);

  const write = useCallback((data: Uint8Array) => {
    termRef.current?.write(data);
  }, []);
  const reset = useCallback(() => {
    termRef.current?.reset();
  }, []);
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);
  const followResize = useCallback(
    (size: TerminalSize) => {
      if (followRef.current) resizeQuietly(size);
    },
    [followRef, resizeQuietly],
  );

  return { containerRef: setContainer, write, reset, focus, followResize };
}
