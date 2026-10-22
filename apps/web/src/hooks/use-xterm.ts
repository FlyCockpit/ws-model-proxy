import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";
import {
  CopyOutGate,
  clipboardTypesIncludeImage,
  createReplayAwareWriter,
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
  type TerminalInputOrigin,
  type TerminalSize,
  TerminalUserInputGate,
  terminalDataOrigin,
} from "@/lib/terminal-writer";

type XtermHandlers = {
  /**
   * Input for the PTY: text (UTF-8), or raw bytes for xterm's binary mouse reports. `origin`
   * tells the session hook's send-time gateway what it is (a reply never claims the writer).
   */
  onData: (data: string | Uint8Array, origin: Exclude<TerminalInputOrigin, "typed">) => void;
  onImage?: (file: File) => Promise<TerminalImageAttachment>;
  onImagePaste?: (attachment: TerminalImageAttachment, data: string) => Promise<boolean>;
  onImageError?: (error: unknown) => void;
  /** This pane's own fitted size changed. A follower reports it without resizing xterm. */
  onResize: (size: TerminalSize) => void;
  /** The box has no measurable size (hidden or zero-size): a size from before must not be sent. */
  onSizeUnavailable?: () => void;
  /** A program asked to copy text (OSC 52) while copy-out was allowed. */
  onCopy?: (copy: Osc52Copy) => void;
  /**
   * The session input goes to now (any value compared by identity), or null when none. An image
   * paste only pastes into the session it started in: a reattach meanwhile cancels it.
   */
  currentSession?: () => unknown;
};

type XtermOptions = XtermHandlers & {
  /** Render at this PTY size (someone else is typing), or null to fit the box. */
  follow: TerminalSize | null;
  /** What Shift+Enter and Ctrl+Enter send. */
  shiftEnter: TerminalShiftEnterMode;
  /** Select text mode: input is paused, including image pastes that finish uploading meanwhile. */
  selecting: boolean;
  /**
   * The pane is the visible tab. A hidden pane never fits or reports a size, and it drops any
   * gesture authorization it had.
   */
  active: boolean;
};

/** Option+click selects text on a Mac even in a mouse-reporting app (no report is sent). */
const MAC_PLATFORM = /Mac|iPhone|iPad|iPod/;

/** A key that only modifies others: pressing it alone is not input. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

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
  const activeRef = useLatestRef(options.active);
  const termRef = useRef<Terminal | null>(null);
  const writerRef = useRef<ReturnType<typeof createReplayAwareWriter> | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [gate] = useState(() => new CopyOutGate());
  const [inputGate] = useState(() => new TerminalUserInputGate());
  const ownSizeRef = useRef<TerminalSize | null>(null);
  /**
   * No size reported since this xterm opened, or the box was reported unmeasurable: the next
   * measured size is reported even if xterm already has it (a writer fitted at xterm's default
   * size would otherwise never tell the session hook it is measurable, and could not take over
   * again later).
   */
  const sizeUnavailableRef = useRef(true);
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

  /**
   * Fit own box, or record own size and show the PTY size while following. Returns whether the
   * box could be measured: only then is a size reported.
   */
  const layout = useCallback((): boolean => {
    const fit = fitRef.current;
    if (!fit) return false;
    const follow = followRef.current;
    // A hidden tab, or a workspace hidden on other pages, has no real box: measuring it would
    // resize the PTY for everyone, and FitAddon would turn a zero-size box into 2x1. It still
    // shows a follower's output at the PTY size, so text written while hidden wraps correctly.
    const element = termRef.current?.element;
    const box = element?.parentElement;
    const measurable =
      activeRef.current &&
      !!element &&
      !!box &&
      !element.closest("[hidden]") &&
      box.clientWidth > 0 &&
      box.clientHeight > 0;
    if (!measurable) {
      sizeUnavailableRef.current = true;
      handlersRef.current.onSizeUnavailable?.();
      if (follow && queuedSizesRef.current === 0) resizeQuietly(follow);
      return false;
    }
    const proposed = fit.proposeDimensions();
    // Never below the floor: a smaller box clips the terminal instead.
    const own =
      proposed && proposed.cols > 0 && proposed.rows > 0
        ? floorTerminalSize({ cols: proposed.cols, rows: proposed.rows })
        : null;
    const wasUnavailable = sizeUnavailableRef.current && own !== null;
    if (wasUnavailable) sizeUnavailableRef.current = false;
    if (!follow) {
      const term = termRef.current;
      if (term && own && (term.cols !== own.cols || term.rows !== own.rows))
        term.resize(own.cols, own.rows);
      else if (term && own && wasUnavailable) handlersRef.current.onResize(own);
      return own !== null;
    }
    if (own && (wasUnavailable || !sameSize(own, ownSizeRef.current))) {
      ownSizeRef.current = own;
      handlersRef.current.onResize(own);
    }
    if (queuedSizesRef.current === 0) resizeQuietly(follow);
    return own !== null;
  }, [activeRef, followRef, handlersRef, resizeQuietly]);

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
    sizeUnavailableRef.current = true;
    // A new xterm starts with no authorization: gestures made in the old one do not carry over.
    gate.clearReplay();
    gate.disarm();
    inputGate.disarm();
    const writer = createReplayAwareWriter(term, gate);
    writerRef.current = writer;
    type ImagePaste = {
      attachment: TerminalImageAttachment;
      sent: Promise<boolean> | null;
    };
    let imagePaste: ImagePaste | null = null;
    /**
     * Set while a modified F3 keydown is being handled: xterm emits the key's data synchronously
     * in that dispatch, and its `ESC [ 1 ; m R` is then the key, not a cursor report.
     */
    let modifiedF3 = false;
    let modifiedF3Timer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Everything xterm emits goes out through here with its origin. A follower sends only real
     * input (never a reply, and only right after a real gesture); the session hook's gateway
     * applies the rest at send time.
     */
    const forward = (data: string | Uint8Array, text: string) => {
      const origin = terminalDataOrigin(text, modifiedF3);
      if (origin === "user") modifiedF3 = false;
      if (followRef.current !== null) {
        if (origin === "reply" || !inputGate.armed(performance.now())) return;
      }
      if (imagePaste && typeof data === "string")
        imagePaste.sent =
          handlersRef.current.onImagePaste?.(imagePaste.attachment, data) ?? Promise.resolve(false);
      else handlersRef.current.onData(data, origin);
    };
    const disposeCopyOut = wireTerminalCopyOut(
      term,
      gate,
      (data) => forward(data, data),
      (copy) => handlersRef.current.onCopy?.(copy),
    );
    // Mouse reports in the X10/normal encodings (no SGR) arrive as a binary string: one byte per
    // character, sent as those bytes rather than UTF-8.
    const binarySub = term.onBinary((data) => {
      forward(
        Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff),
        data,
      );
    });
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
    // A modifier pressed alone sends nothing, so it must not let other data through.
    const armKey = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key)) return;
      armInput();
      if (
        event.key === "F3" &&
        (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
      ) {
        modifiedF3 = true;
        // Only for this keydown's own data.
        if (modifiedF3Timer) clearTimeout(modifiedF3Timer);
        modifiedF3Timer = setTimeout(() => {
          modifiedF3Timer = null;
          modifiedF3 = false;
        }, 0);
      }
    };
    // Text from an input event alone (some mobile keyboards and dictation send no keydown or
    // composition) is still typing.
    const armTextInput = () => {
      armInput();
      gate.armFromUserGesture();
    };
    // A click claims the writer only in a mouse-reporting app. The wheel never does, and neither
    // does a Mac Option+click, which selects text instead of sending a report.
    const armClick = (event: MouseEvent) => {
      if (term.modes.mouseTrackingMode === "none") return;
      if (event.altKey && MAC_PLATFORM.test(navigator.platform)) return;
      armInput();
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
      // The session this paste belongs to. A reattach meanwhile is another session: nothing from
      // this paste (its path or the clipboard-text fallback) goes into it.
      const session = handlersRef.current.currentSession?.() ?? null;
      const sameSession = () => (handlersRef.current.currentSession?.() ?? null) === session;
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
            if (!sameSession()) throw new Error("failed");
            // The person moved to another tab while this uploaded: a hidden pane types nothing.
            if (!activeRef.current) throw new Error("hidden");
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
          sameSession() &&
          activeRef.current &&
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
    container.addEventListener("keydown", armKey, true);
    container.addEventListener("compositionstart", armInput, true);
    container.addEventListener("compositionupdate", armInput, true);
    container.addEventListener("compositionend", armInput, true);
    container.addEventListener("beforeinput", armTextInput, true);
    container.addEventListener("input", armTextInput, true);
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
      container.removeEventListener("keydown", armKey, true);
      container.removeEventListener("compositionstart", armInput, true);
      container.removeEventListener("compositionupdate", armInput, true);
      container.removeEventListener("compositionend", armInput, true);
      container.removeEventListener("beforeinput", armTextInput, true);
      container.removeEventListener("input", armTextInput, true);
      container.removeEventListener("mousedown", armClick, true);
      container.removeEventListener("pointerdown", armCopy, true);
      container.removeEventListener("pointerup", armCopy, true);
      term.textarea?.removeEventListener("paste", onPaste, true);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      if (modifiedF3Timer) clearTimeout(modifiedF3Timer);
      disposeCopyOut();
      binarySub.dispose();
      writer.dispose();
      if (writerRef.current === writer) writerRef.current = null;
      resizeSub.dispose();
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
  }, [
    activeRef,
    container,
    followRef,
    gate,
    handlersRef,
    inputGate,
    layout,
    selectingRef,
    shiftEnterRef,
  ]);

  // Becoming the visible tab lays out again (its box may have changed while hidden); hiding drops
  // any gesture authorization, so nothing typed or clicked before counts later.
  const { active } = options;
  useEffect(() => {
    if (!container) return;
    if (active) {
      // The writer reports its size again: a resize skipped while hidden must still reach the
      // PTY (the session hook sends it only if it differs from the last one sent). Only a
      // measured box has a size to report.
      const term = termRef.current;
      if (layout() && term && !followRef.current)
        handlersRef.current.onResize({ cols: term.cols, rows: term.rows });
    } else {
      gate.disarm();
      inputGate.disarm();
    }
  }, [active, container, followRef, gate, handlersRef, inputGate, layout]);

  const followCols = options.follow?.cols ?? null;
  const followRows = options.follow?.rows ?? null;
  // Entering or leaving follow mode, or a new PTY size: lay out again. Leaving follow mode
  // (taking over) fits the box only once the output already queued is parsed: that output was
  // written at the PTY size it follows, and fitting first would draw it at the new size.
  useEffect(() => {
    if (!container || (followCols === null) !== (followRows === null)) return;
    const term = termRef.current;
    if (followCols === null && term) {
      term.write("", () => {
        if (termRef.current === term) layout();
      });
      return;
    }
    layout();
  }, [container, followCols, followRows, layout]);

  const write = useCallback((data: Uint8Array, replay = false) => {
    writerRef.current?.write(data, replay);
  }, []);
  const reset = useCallback(() => {
    // A reset comes before a scrollback replay (a new attach): no gesture from before it counts,
    // and the screen resets in output order (see createReplayAwareWriter).
    gate.disarm();
    inputGate.disarm();
    writerRef.current?.reset();
  }, [gate, inputGate]);
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
