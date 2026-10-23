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
  /**
   * The session ended: copy-out stays closed for anything still arriving from it (a decryption
   * in flight, output buffered for the pane) until a newer attach's output arrives.
   */
  private retired = false;

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

  retire(): void {
    this.retired = true;
    this.lastInputAtMs = 0;
  }

  /** A newer attach's output arrived: its own copies may fire again (after a fresh gesture). */
  attached(): void {
    this.retired = false;
  }

  allowed(hasFocus: boolean, nowMs = Date.now()): boolean {
    if (this.retired || this.replayChunks > 0) return false;
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

/**
 * CAN: aborts any escape sequence in progress (VT parsers, xterm included, return to ground).
 * Used only for the in-band reset before a replay, where the screen is reset anyway. Written as
 * bytes, not a string: xterm decodes byte writes with their own UTF-8 decoder, and only a byte
 * write reaches the state earlier byte writes left in it.
 */
const ABORT_SEQUENCE = Uint8Array.of(0x18);

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const OSC_INTRODUCER = 0x5d; // "]" after ESC
const C1_OSC = 0x9d; // U+009D, UTF-8 C2 9D
const C1_ST = 0x9c; // U+009C, UTF-8 C2 9C: ends an OSC like BEL
const UTF8_C1_LEAD = 0xc2;
const SEMICOLON = 0x3b;
const ZERO = 0x30;
const NINE = 0x39;

/**
 * Replay protection's scope: an OSC 52 copy that a program sent earlier must not fire again when
 * its scrollback is replayed to a joining or reattaching viewer. That is a guard against stale,
 * accidental copies, not against a hostile program: a program in the terminal can already copy
 * anything with live output after the person's next gesture, so bytes crafted to confuse this
 * tracker (an ignored control inside an OSC number, a sequence split at an unusual point) gain
 * it nothing it does not already have. The tracker therefore follows only the plain forms of an
 * OSC 52 introducer (ESC ] or C1 OSC, the number 52 with optional leading zeros). It never
 * changes the output: it only tells the writer which live bytes complete a copy the replay left
 * open, so that copy alone is suppressed while every other sequence renders as sent.
 */
export class ReplayCopyTracker {
  private state: "ground" | "escape" | "osc" = "ground";
  /** The OSC number's digits so far, without leading zeros, while it can still be 52. */
  private oscNumber: string | null = null;
  /** The number ended (at ";" or any non-digit): only 52 is a copy. */
  private oscNumberDone = false;
  private lastByte = 0;

  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.step(byte);
      this.lastByte = byte;
    }
  }

  /** Does the replay end inside an OSC that is, or may still become, an OSC 52 copy? */
  copyMayBeOpen(): boolean {
    if (this.state !== "osc") return false;
    if (this.oscNumberDone) return this.oscNumber === "52";
    return this.oscNumber !== null;
  }

  /**
   * Follows live bytes while a sequence the replay left open is still open. Returns how many
   * leading bytes reach the end of it (the byte that ends it included), or -1 when it is still
   * open after all of them.
   */
  endOfOpenSequence(bytes: Uint8Array): number {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] ?? 0;
      this.step(byte);
      this.lastByte = byte;
      if (this.state !== "osc") return index + 1;
    }
    return -1;
  }

  clear(): void {
    this.state = "ground";
    this.oscNumber = null;
    this.oscNumberDone = false;
    this.lastByte = 0;
  }

  private startOsc(): void {
    this.state = "osc";
    this.oscNumber = "";
    this.oscNumberDone = false;
  }

  private step(byte: number): void {
    if (byte === CAN || byte === SUB) {
      this.state = "ground";
      return;
    }
    if (byte === ESC) {
      // ESC ends any sequence, an OSC included, and may start the next one.
      this.state = "escape";
      return;
    }
    if (this.state === "escape") {
      if (byte === OSC_INTRODUCER) this.startOsc();
      else this.state = "ground";
      return;
    }
    if (this.state === "osc") {
      if (byte === BEL || (byte === C1_ST && this.lastByte === UTF8_C1_LEAD)) {
        this.state = "ground";
        return;
      }
      if (this.oscNumberDone || this.oscNumber === null) return;
      if (byte >= ZERO && byte <= NINE) {
        const digits = `${this.oscNumber}${String.fromCharCode(byte)}`.replace(/^0+/, "");
        this.oscNumber = "52".startsWith(digits) ? digits : null;
        return;
      }
      // ";" ends the number; any other byte makes the OSC one xterm ignores.
      this.oscNumberDone = true;
      if (byte !== SEMICOLON) this.oscNumber = null;
      return;
    }
    if (byte === C1_OSC && this.lastByte === UTF8_C1_LEAD) this.startOsc();
  }
}

type ReplayWriteTerminal = {
  write: (data: string | Uint8Array, callback?: () => void) => void;
  reset: () => void;
};

/**
 * Writes output to xterm with replay protection: a copy a program sent before this viewer's
 * replay never fires again, and no output is changed. Copy-out stays closed while replayed bytes
 * (and anything queued before a reset) are parsed, which covers copies that end inside the
 * replay. When the replay ends inside a copy, the live bytes up to the end of that sequence are
 * written as their own chunk, also with copy-out closed: nothing else can complete inside an
 * open sequence, so exactly that copy is suppressed.
 */
export function createReplayAwareWriter(term: ReplayWriteTerminal, gate: CopyOutGate) {
  const tracker = new ReplayCopyTracker();
  let afterReplay = false;
  /** Live bytes are still inside a copy the replay left open. */
  let finishingReplayCopy = false;
  let disposed = false;
  /** Close the gate until xterm has parsed everything written so far, this chunk included. */
  const writeClosed = (data: Uint8Array, then?: () => void) => {
    gate.beginReplayChunk();
    term.write(data, () => {
      if (disposed) return;
      then?.();
      gate.endReplayChunk();
    });
  };
  return {
    write(data: Uint8Array, replay = false): void {
      if (replay) {
        afterReplay = true;
        tracker.feed(data);
        // xterm parses writes in order and calls back right after this chunk.
        writeClosed(data);
        return;
      }
      if (afterReplay) {
        afterReplay = false;
        finishingReplayCopy = tracker.copyMayBeOpen();
        if (!finishingReplayCopy) tracker.clear();
      }
      if (finishingReplayCopy) {
        const end = tracker.endOfOpenSequence(data);
        if (end === -1) {
          writeClosed(data);
          return;
        }
        finishingReplayCopy = false;
        tracker.clear();
        writeClosed(data.subarray(0, end));
        if (end < data.length) term.write(data.subarray(end));
        return;
      }
      term.write(data);
    },
    /**
     * Before a replay: reset the screen in output order. xterm's own reset() runs at once, keeps
     * the parser's state and leaves earlier writes queued, so output from the previous attach
     * would still parse (and could complete a sequence) after it. Instead, abort any open
     * sequence and reset once everything queued before it has been parsed, with copy-out closed
     * throughout.
     */
    reset(): void {
      afterReplay = false;
      finishingReplayCopy = false;
      tracker.clear();
      writeClosed(ABORT_SEQUENCE, () => term.reset());
    },
    /**
     * The session ended: copy-out stays closed for anything it still sends, until a newer
     * attach's output arrives (see CopyOutGate.retire). Output is left as it is.
     */
    retire(): void {
      afterReplay = false;
      finishingReplayCopy = false;
      tracker.clear();
      gate.retire();
    },
    dispose(): void {
      disposed = true;
    },
  };
}
