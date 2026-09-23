export const TERMINAL_COPY_OUT_WINDOW_MS = 3_000;

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

export function decodeOsc52Text(payload: string): string | null {
  const separator = payload.indexOf(";");
  const encoded = (separator === -1 ? payload : payload.slice(separator + 1)).replace(/\s+/g, "");
  if (encoded.length === 0) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function clipboardTypesIncludeImage(types: readonly string[]): boolean {
  return types.some((type) => type.startsWith("image/"));
}

/** OSC 52 arms only from a real keydown or paste, never from terminal data. */
export class CopyOutGate {
  lastInputAtMs = 0;

  armFromUserGesture(nowMs = Date.now()): void {
    this.lastInputAtMs = nowMs;
  }

  /** Remote output, including cursor-position replies, must not arm copy-out. */
  noteRemoteData(_data: string): void {}

  allowed(hasFocus: boolean, nowMs = Date.now()): boolean {
    return terminalCopyOutAllowed(hasFocus, this.lastInputAtMs, nowMs);
  }
}

type CopyOutTerminal = {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  parser: { registerOscHandler: (id: number, handler: (data: string) => boolean) => void };
  textarea: EventTarget | null | undefined;
};

export function wireTerminalCopyOut(
  term: CopyOutTerminal,
  gate: CopyOutGate,
  emit: (data: string) => void,
): () => void {
  const dataSub = term.onData((data) => {
    gate.noteRemoteData(data);
    emit(data);
  });
  term.parser.registerOscHandler(52, (data) => {
    if (!gate.allowed(typeof document !== "undefined" && document.hasFocus())) return true;
    const text = decodeOsc52Text(data);
    if (text !== null && typeof navigator !== "undefined") void navigator.clipboard.writeText(text);
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
