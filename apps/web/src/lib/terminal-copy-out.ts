export const TERMINAL_COPY_OUT_WINDOW_MS = 3_000;

/** Decoded OSC 52 text above this size is dropped, not copied. */
export const TERMINAL_COPY_OUT_MAX_BYTES = 1024 * 1024;

/** Base64 can only grow the text by 4/3; anything longer is over the cap before decoding. */
const MAX_ENCODED_LENGTH = Math.ceil(TERMINAL_COPY_OUT_MAX_BYTES / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** OSC 52 copy-out is allowed only while the document is focused and input is fresh. */
export function terminalCopyOutAllowed(
  hasFocus: boolean,
  lastInputAtMs: number,
  nowMs: number,
): boolean {
  if (!hasFocus) return false;
  if (!Number.isFinite(lastInputAtMs) || lastInputAtMs <= 0) return false;
  const elapsed = nowMs - lastInputAtMs;
  return elapsed >= 0 && elapsed <= TERMINAL_COPY_OUT_WINDOW_MS;
}

export type Osc52Copy = { kind: "text"; text: string } | { kind: "too_large" };

/**
 * An OSC 52 payload (`<selection>;<base64>`) as text to copy, or null to ignore it: a clipboard
 * read (`?`), an empty payload (clear), or anything that is not valid base64 UTF-8.
 */
export function decodeOsc52Text(payload: string): Osc52Copy | null {
  const separator = payload.indexOf(";");
  const encoded = (separator === -1 ? payload : payload.slice(separator + 1)).replace(/\s+/g, "");
  // A read request must never be answered: it would hand the clipboard to the remote program.
  if (encoded.length === 0 || encoded === "?") return null;
  // Some programs leave off the `=` padding; a remainder of 1 is never valid base64.
  if (encoded.length % 4 === 1 || !BASE64.test(encoded)) return null;
  if (encoded.length > MAX_ENCODED_LENGTH) return { kind: "too_large" };
  try {
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    if (binary.length > TERMINAL_COPY_OUT_MAX_BYTES) return { kind: "too_large" };
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length === 0 ? null : { kind: "text", text };
  } catch {
    return null;
  }
}

export function clipboardTypesIncludeImage(types: readonly string[]): boolean {
  return types.some((type) => type.startsWith("image/"));
}

/**
 * OSC 52 arms only from a real keydown, paste, or pointer press in the pane, never from terminal
 * data. Mouse arming is what lets tmux mouse-drag copy and agents' highlight-to-copy through.
 */
export class CopyOutGate {
  lastInputAtMs = 0;
  /** Replay chunks written to xterm and not yet parsed. Copy-out stays closed while any is. */
  private replayChunks = 0;

  armFromUserGesture(nowMs = Date.now()): void {
    this.lastInputAtMs = nowMs;
  }

  /** Close the gate, so a scrollback replay cannot repeat an old copy. */
  disarm(): void {
    this.lastInputAtMs = 0;
  }

  /**
   * A scrollback replay chunk was written; `endReplayChunk` runs once xterm has parsed it. A
   * gesture during the replay must not let an old copy in it through.
   */
  beginReplayChunk(): void {
    this.replayChunks += 1;
  }

  endReplayChunk(): void {
    this.replayChunks = Math.max(0, this.replayChunks - 1);
  }

  /** A new xterm has none of the old one's replay queued. */
  clearReplay(): void {
    this.replayChunks = 0;
  }

  /** Remote output, including cursor-position replies, must not arm copy-out. */
  noteRemoteData(_data: string): void {}

  allowed(hasFocus: boolean, nowMs = Date.now()): boolean {
    if (this.replayChunks > 0) return false;
    return terminalCopyOutAllowed(hasFocus, this.lastInputAtMs, nowMs);
  }
}

type CopyOutTerminal = {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  parser: { registerOscHandler: (id: number, handler: (data: string) => boolean) => void };
  textarea: EventTarget | null | undefined;
};

/**
 * Wire OSC 52 to `onCopy` (only while the gate is open) and forward typed data to `emit`.
 * `onCopy` decides what reaches the clipboard (the person's copy setting).
 */
export function wireTerminalCopyOut(
  term: CopyOutTerminal,
  gate: CopyOutGate,
  emit: (data: string) => void,
  onCopy: (copy: Osc52Copy) => void = () => {},
): () => void {
  const dataSub = term.onData((data) => {
    gate.noteRemoteData(data);
    emit(data);
  });
  term.parser.registerOscHandler(52, (data) => {
    if (!gate.allowed(typeof document !== "undefined" && document.hasFocus())) return true;
    const copy = decodeOsc52Text(data);
    if (copy !== null) onCopy(copy);
    return true;
  });
  const textarea = term.textarea;
  const onKeyDown = () => gate.armFromUserGesture();
  textarea?.addEventListener("keydown", onKeyDown);
  return () => {
    textarea?.removeEventListener("keydown", onKeyDown);
    dataSub.dispose();
  };
}
