import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import {
  CopyOutGate,
  clipboardTypesIncludeImage,
  type Osc52Copy,
  wireTerminalCopyOut,
} from "@/lib/terminal-copy-out";
import { clipboardPrefersText } from "@/lib/terminal-image-clipboard";
import type { TerminalImageAttachment } from "@/lib/terminal-images";
import { newlineSequence } from "@/lib/terminal-keys";
import type { TerminalShiftEnterMode } from "@/lib/terminal-settings";
import { TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "@/lib/terminal-theme";
import {
  floorTerminalSize,
  sameSize,
  shouldForwardTerminalData,
  type TerminalSize,
  TerminalUserInputGate,
} from "@/lib/terminal-writer";

type XtermHandlers = {
  onData: (data: string) => void;
  onImage?: (file: File) => Promise<TerminalImageAttachment>;
  onImagePaste?: (attachment: TerminalImageAttachment, data: string) => Promise<boolean>;
  onImageError?: (error: unknown) => void;
  /** This pane's own fitted size changed. A follower reports it without resizing xterm. */
  onResize: (size: TerminalSize) => void;
  /** A program asked to copy text (OSC 52) while copy-out was allowed. */
  onCopy?: (copy: Osc52Copy) => void;
};

type XtermOptions = XtermHandlers & {
  /** Render at this PTY size (someone else is typing), or null to fit the box. */
  follow: TerminalSize | null;
  /** What Shift+Enter and Ctrl+Enter send. */
  shiftEnter: TerminalShiftEnterMode;
  /** Select text mode: input is paused, including image pastes that finish uploading meanwhile. */
  selecting: boolean;
};

export function useXterm(options: XtermOptions): {
  containerRef: RefCallback<HTMLDivElement>;
  /**
   * The element xterm is open in, or null before the pane mounts. Effects
   * declared after this hook see a live xterm whenever this is non-null, and a
   * new value means a new xterm instance.
   */
  host: HTMLDivElement | null;
  /** Write output. `replay` marks scrollback replay, whose OSC 52 copies are never honored. */
  write: (data: Uint8Array, replay?: boolean) => void;
  reset: () => void;
  focus: () => void;
  /**
   * Apply a PTY size change in output order, while following: after the data
   * written before it is parsed, and before the data written after it.
   */
  followResize: (size: TerminalSize) => void;
  /** The scrollback and screen as plain text, for Select text mode. */
  snapshot: () => string;
} {
  const handlersRef = useLatestRef<XtermHandlers>(options);
  const followRef = useLatestRef(options.follow);
  const shiftEnterRef = useLatestRef(options.shiftEnter);
  const selectingRef = useLatestRef(options.selecting);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [gate] = useState(() => new CopyOutGate());
  const [inputGate] = useState(() => new TerminalUserInputGate());
  const ownSizeRef = useRef<TerminalSize | null>(null);
  /** Set while this hook resizes xterm itself, so onResize does not echo it. */
  const suppressResizeRef = useRef(false);
  /**
   * PTY size events written into xterm's output queue but not yet reached by
   * its parser. While any is queued the size is left to them, so output
   * written before a size change still renders at the old size.
   */
  const queuedSizesRef = useRef(0);
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
    // The dashboard hides the workspace (display: none) on other pages. Its
    // box then has no size, and fitting it would resize the PTY for everyone.
    if (termRef.current?.element?.closest("[hidden]")) return;
    const follow = followRef.current;
    const proposed = fit.proposeDimensions();
    // Never below the floor: a smaller box clips the terminal instead.
    const own =
      proposed && proposed.cols > 0 && proposed.rows > 0
        ? floorTerminalSize({ cols: proposed.cols, rows: proposed.rows })
        : null;
    if (!follow) {
      const term = termRef.current;
      if (term && own && (term.cols !== own.cols || term.rows !== own.rows))
        term.resize(own.cols, own.rows);
      return;
    }
    if (own && !sameSize(own, ownSizeRef.current)) {
      ownSizeRef.current = own;
      handlersRef.current.onResize(own);
    }
    if (queuedSizesRef.current === 0) resizeQuietly(follow);
  }, [followRef, handlersRef, resizeQuietly]);

  useEffect(() => {
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      // Option+drag selects text on a Mac even while tmux or an app has the mouse.
      macOptionClickForcesSelection: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    queuedSizesRef.current = 0;
    gate.clearReplay();
    type ImagePaste = {
      attachment: TerminalImageAttachment;
      sent: Promise<boolean> | null;
    };
    let imagePaste: ImagePaste | null = null;
    const disposeCopyOut = wireTerminalCopyOut(
      term,
      gate,
      (data) => {
        const forward = shouldForwardTerminalData({
          following: followRef.current !== null,
          userInput: inputGate.armed(performance.now()),
          data,
        });
        if (forward) {
          if (imagePaste)
            imagePaste.sent =
              handlersRef.current.onImagePaste?.(imagePaste.attachment, data) ??
              Promise.resolve(false);
          else handlersRef.current.onData(data);
        }
      },
      (copy) => handlersRef.current.onCopy?.(copy),
    );
    // Shift+Enter / Ctrl+Enter: send the newline sequence instead of xterm's CR. Handled on
    // keydown (preventDefault also stops the keypress) and swallowed on keypress and keyup.
    term.attachCustomKeyEventHandler((event) => {
      const sequence = newlineSequence(shiftEnterRef.current, event);
      if (sequence === null) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        term.input(sequence, true);
      }
      return false;
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
    // Any press in the pane opens the copy window: tmux and agents copy on mouse release.
    const armCopy = () => gate.armFromUserGesture();
    let disposed = false;
    let uploading = false;
    const pasteImages = async (files: File[], fallbackText = "") => {
      if (uploading) {
        handlersRef.current.onImageError?.(new Error("busy"));
        return;
      }
      uploading = true;
      let pastedImages = 0;
      try {
        for (const file of files) {
          const upload = handlersRef.current.onImage;
          if (!upload) throw new Error("unavailable");
          const attachment = await upload(file);
          const paste: ImagePaste = { attachment, sent: null };
          let forwarded = false;
          try {
            if (disposed || termRef.current !== term) return;
            // Select text started while this uploaded: `inert` pauses only new input, so drop
            // the paste here rather than type a path behind the frozen copy.
            if (selectingRef.current) throw new Error("selecting");
            // The transfer can outlive the user-input gate. Arm it again so a
            // follower's deliberate path paste can claim the writer normally.
            armInput();
            imagePaste = paste;
            term.paste(attachment.text);
            // xterm emits onData synchronously. Clear the context before
            // awaiting encryption, so subsequent keystrokes stay ordinary input.
            imagePaste = null;
            forwarded = (await paste.sent) ?? false;
            if (!forwarded) throw new Error("unavailable");
          } finally {
            imagePaste = null;
            if (!forwarded) attachment.cancel();
          }
          pastedImages += 1;
        }
      } catch (error) {
        if (disposed || termRef.current !== term) return;
        if (
          pastedImages === 0 &&
          fallbackText.length > 0 &&
          !selectingRef.current &&
          error instanceof Error &&
          (error.message === "update" || error.message === "unavailable")
        ) {
          armInput();
          term.paste(fallbackText);
        } else handlersRef.current.onImageError?.(error);
      } finally {
        uploading = false;
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      gate.armFromUserGesture();
      armInput();
      const types = event.clipboardData ? Array.from(event.clipboardData.types) : [];
      const text = event.clipboardData?.getData("text/plain") ?? "";
      // Browsers commonly report an image clipboard as just "Files".
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (files.length === 0 && !clipboardTypesIncludeImage(types)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Office-style apps include a rendered image alongside copied cells or
      // slides. Preserve the user's text when this is a rich-text clipboard.
      if (clipboardPrefersText(types, text, event.clipboardData?.getData("text/html") ?? "")) {
        term.paste(text);
        return;
      }
      if (files.length > 0) {
        void pasteImages(files, text);
        return;
      }
      if (text.length > 0) term.paste(text);
      else handlersRef.current.onImageError?.(new Error("unsupported"));
    };
    const onDragOver = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (files.some((file) => !file.type.startsWith("image/"))) {
        handlersRef.current.onImageError?.(new Error("unsupported"));
        return;
      }
      term.focus();
      void pasteImages(files);
    };
    container.addEventListener("keydown", armInput, true);
    container.addEventListener("compositionstart", armInput, true);
    container.addEventListener("compositionupdate", armInput, true);
    container.addEventListener("compositionend", armInput, true);
    container.addEventListener("mousedown", armClick, true);
    container.addEventListener("pointerdown", armCopy, true);
    container.addEventListener("pointerup", armCopy, true);
    term.textarea?.addEventListener("paste", onPaste, true);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    const observer = new ResizeObserver(() => {
      layout();
    });
    observer.observe(container);
    layout();
    return () => {
      disposed = true;
      observer.disconnect();
      container.removeEventListener("keydown", armInput, true);
      container.removeEventListener("compositionstart", armInput, true);
      container.removeEventListener("compositionupdate", armInput, true);
      container.removeEventListener("compositionend", armInput, true);
      container.removeEventListener("mousedown", armClick, true);
      container.removeEventListener("pointerdown", armCopy, true);
      container.removeEventListener("pointerup", armCopy, true);
      term.textarea?.removeEventListener("paste", onPaste, true);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      disposeCopyOut();
      resizeSub.dispose();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
  }, [container, followRef, gate, handlersRef, inputGate, layout, selectingRef, shiftEnterRef]);

  const followCols = options.follow?.cols ?? null;
  const followRows = options.follow?.rows ?? null;
  // Entering or leaving follow mode, or a new PTY size: lay out again. Leaving
  // follow mode fits the box; the fitted size then goes to the CLI.
  useEffect(() => {
    if (!container || (followCols === null) !== (followRows === null)) return;
    layout();
  }, [container, followCols, followRows, layout]);

  const write = useCallback(
    (data: Uint8Array, replay = false) => {
      const term = termRef.current;
      if (!term) return;
      if (!replay) {
        term.write(data);
        return;
      }
      // xterm parses writes in order and calls back right after this chunk, so the gate is
      // closed for exactly the replayed bytes.
      gate.beginReplayChunk();
      term.write(data, () => {
        if (termRef.current === term) gate.endReplayChunk();
      });
    },
    [gate],
  );
  const reset = useCallback(() => {
    // A reset comes before a scrollback replay: an old copy in it must not fire again.
    gate.disarm();
    termRef.current?.reset();
  }, [gate]);
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);
  const followResize = useCallback(
    (size: TerminalSize) => {
      const term = termRef.current;
      if (!term) return;
      // xterm parses writes asynchronously. Resize once everything written so
      // far is parsed, and before anything written after this is.
      queuedSizesRef.current += 1;
      term.write("", () => {
        if (termRef.current !== term) return;
        queuedSizesRef.current -= 1;
        if (followRef.current) resizeQuietly(size);
      });
    },
    [followRef, resizeQuietly],
  );

  const snapshot = useCallback(() => {
    const buffer = termRef.current?.buffer.active;
    if (!buffer) return "";
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (!line) continue;
      // A wrapped row continues the previous line: join it back into one.
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }, []);

  return {
    containerRef: setContainer,
    host: container,
    write,
    reset,
    focus,
    followResize,
    snapshot,
  };
}
