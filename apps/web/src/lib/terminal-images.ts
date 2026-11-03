/** Encrypted terminal extensions, mirrored by the CLI's terminal_images module. */
export const TERMINAL_IMAGE_CAPABILITIES = 0x10;
export const TERMINAL_IMAGE_CHUNK = 0x11;
export const TERMINAL_IMAGE_REPLY = 0x12;
export const TERMINAL_IMAGE_PASTE = 0x13;
export const TERMINAL_IMAGE_CANCEL = 0x14;
export const TERMINAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const TERMINAL_IMAGE_CHUNK_BYTES = 64 * 1024;
export const TERMINAL_IMAGE_ACK_TIMEOUT_MS = 15_000;

export type TerminalImageAttachment = {
  id: string;
  text: string;
  /** Release an offer that never reached the terminal's input path. */
  cancel: () => void;
};

export function encodeTerminalImageControl(
  tag: typeof TERMINAL_IMAGE_PASTE | typeof TERMINAL_IMAGE_CANCEL,
  id: string,
  text = "",
): Uint8Array {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid");
  const data = new TextEncoder().encode(text);
  if (
    (tag === TERMINAL_IMAGE_CANCEL && data.length > 0) ||
    (tag === TERMINAL_IMAGE_PASTE && (data.length < 1 || data.length > 16 * 1024))
  )
    throw new Error("invalid");
  const bytes = new Uint8Array(17 + data.length);
  bytes[0] = tag;
  for (let index = 0; index < 16; index += 1)
    bytes[1 + index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
  bytes.set(data, 17);
  return bytes;
}

export type TerminalImageReply = {
  id: string;
  received: number;
  path?: string;
  /** With `path` from a Windows node: the text to paste, already quoted for the terminal's shell. */
  paste?: string;
  error?: string;
};

/** An absolute POSIX path, or (only with node-quoted paste text) a Windows drive path. */
const POSIX_PATH = /^\/[\x20-\x7e]+$/;
const WINDOWS_PATH = /^[A-Za-z]:\\[\x20-\x7e]+$/;
/** Room for the bracketed-paste markers inside the node's 16 KiB paste limit. */
const TERMINAL_IMAGE_PASTE_TEXT_MAX = 16 * 1024 - 12;

/** Printable ASCII ending in the space every paste carries. */
const PASTE_TEXT = /^[\x20-\x7e]+ $/;

export type TerminalImageMessage =
  | { kind: "imageCapabilities" }
  | { kind: "imageReply"; reply: TerminalImageReply };

const formats = ["image/png", "image/jpeg", "image/webp"];

export function terminalImageFormat(mime: string): number {
  const format = formats.indexOf(mime);
  if (format < 0) throw new Error("unsupported");
  return format;
}

/** tag | random id (16 bytes) | total u32be | offset u32be | format u8 | bytes */
export function encodeTerminalImageChunk(input: {
  id: string;
  total: number;
  offset: number;
  format: number;
  data: Uint8Array;
}): Uint8Array {
  if (
    !/^[a-f0-9]{32}$/.test(input.id) ||
    !Number.isInteger(input.total) ||
    input.total < 1 ||
    input.total > TERMINAL_IMAGE_MAX_BYTES ||
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    input.offset + input.data.length > input.total ||
    input.data.length < 1 ||
    input.data.length > TERMINAL_IMAGE_CHUNK_BYTES ||
    !Number.isInteger(input.format) ||
    !formats[input.format]
  ) {
    throw new Error("invalid");
  }
  const out = new Uint8Array(26 + input.data.length);
  out[0] = TERMINAL_IMAGE_CHUNK;
  for (let index = 0; index < 16; index += 1) {
    out[1 + index] = Number.parseInt(input.id.slice(index * 2, index * 2 + 2), 16);
  }
  const view = new DataView(out.buffer);
  view.setUint32(17, input.total, false);
  view.setUint32(21, input.offset, false);
  out[25] = input.format;
  out.set(input.data, 26);
  return out;
}

export function decodeTerminalImageMessage(bytes: Uint8Array): TerminalImageMessage | null {
  if (bytes[0] === TERMINAL_IMAGE_CAPABILITIES && bytes.length === 1) {
    return { kind: "imageCapabilities" };
  }
  if (bytes[0] !== TERMINAL_IMAGE_REPLY) return null;
  if (bytes.length > 8192) throw new Error("invalid image reply");
  const reply: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(1)),
  );
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("id" in reply) ||
    typeof reply.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(reply.id) ||
    !("received" in reply) ||
    typeof reply.received !== "number" ||
    !Number.isInteger(reply.received) ||
    reply.received < 0 ||
    reply.received > TERMINAL_IMAGE_MAX_BYTES ||
    ("path" in reply &&
      (typeof reply.path !== "string" ||
        !(POSIX_PATH.test(reply.path) || ("paste" in reply && WINDOWS_PATH.test(reply.path))))) ||
    ("paste" in reply &&
      (!("path" in reply) ||
        typeof reply.paste !== "string" ||
        reply.paste.length > TERMINAL_IMAGE_PASTE_TEXT_MAX ||
        !PASTE_TEXT.test(reply.paste))) ||
    ("error" in reply && (typeof reply.error !== "string" || reply.error.length > 64)) ||
    ("path" in reply && "error" in reply)
  ) {
    throw new Error("invalid image reply");
  }
  return {
    kind: "imageReply",
    reply: {
      id: reply.id,
      received: reply.received,
      ...("path" in reply ? { path: String(reply.path) } : {}),
      ...("paste" in reply ? { paste: String(reply.paste) } : {}),
      ...("error" in reply ? { error: String(reply.error) } : {}),
    },
  };
}

/**
 * Printable ASCII only: pasted controls or non-ASCII bytes can drive shell editors. A Windows
 * node quotes the path for its terminal's shell (PowerShell, cmd, WSL) and sends the text, which
 * is pasted as is; otherwise the path is quoted for `sh` here.
 */
export function terminalImagePasteText(path: string, paste?: string): string {
  if (paste !== undefined) {
    if (!PASTE_TEXT.test(paste) || paste.length > TERMINAL_IMAGE_PASTE_TEXT_MAX) {
      throw new Error("invalid");
    }
    return paste;
  }
  if (!POSIX_PATH.test(path)) throw new Error("invalid");
  return /^[A-Za-z0-9_./-]+$/.test(path) ? `${path} ` : `'${path.replaceAll("'", "'\\''")}' `;
}

/**
 * One upload's offer to the node, from the first chunk to its paste:
 * - `uploading`: chunks are going out; if it stops before the end, it is cancelled.
 * - `offered`: the node saved the image and the caller holds its paste text.
 * - `cancelled`: a cancel was sent (once): nothing more is said about this id.
 */
type TerminalImageOffer = "uploading" | "offered" | "cancelled";

/** Where the upload in progress is in its stop-and-wait loop. */
type TerminalImageUploadStep =
  | { kind: "sending" }
  | { kind: "awaitingAck"; received: number; settle: (result: TerminalImageReply | Error) => void }
  /** Its attach ended (`abort`): it stops at its next check and never returns a paste. */
  | { kind: "aborted" };

type TerminalImageUpload = { id: string; step: TerminalImageUploadStep };

/**
 * The viewer's image transfer:
 * - `unsupported`: the CLI has not announced image support (an older CLI); nothing is sent.
 * - `idle`: supported, no upload in progress.
 * - `uploading`: one upload in progress (stop-and-wait: one chunk out at a time).
 */
export type TerminalImageTransferState =
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "uploading"; upload: TerminalImageUpload };

/** One stop-and-wait upload per attached viewer, with no automatic replay of writes. */
export class TerminalImageTransfer {
  private state: TerminalImageTransferState = { kind: "unsupported" };

  /** The CLI announced image support on this attach. */
  markSupported(): void {
    if (this.state.kind === "unsupported") this.state = { kind: "idle" };
  }

  /** The attach ended: the upload in progress (if any) fails at once and returns no paste. */
  abort(): void {
    if (this.state.kind !== "uploading") return;
    const upload = this.state.upload;
    const step = upload.step;
    upload.step = { kind: "aborted" };
    if (step.kind === "awaitingAck") step.settle(new Error("unavailable"));
  }

  receive(reply: TerminalImageReply): void {
    if (this.state.kind !== "uploading") return;
    const step = this.state.upload.step;
    if (step.kind !== "awaitingAck" || this.state.upload.id !== reply.id) return;
    if (reply.error) step.settle(new Error(reply.error));
    else if (reply.received !== step.received) step.settle(new Error("invalid"));
    else step.settle(reply);
  }

  async upload(
    file: File,
    send: (plaintext: Uint8Array) => void,
    isCurrent: () => boolean,
    progress: (percent: number) => void,
  ): Promise<TerminalImageAttachment> {
    if (this.state.kind === "unsupported") throw new Error("update");
    if (this.state.kind === "uploading") throw new Error("busy");
    if (file.size < 1 || file.size > TERMINAL_IMAGE_MAX_BYTES) throw new Error("too_large");
    const format = terminalImageFormat(file.type);
    const random = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const upload: TerminalImageUpload = { id, step: { kind: "sending" } };
    this.state = { kind: "uploading", upload };
    let offer: TerminalImageOffer = "uploading";
    const cancel = () => {
      if (offer === "cancelled" || !isCurrent()) return;
      offer = "cancelled";
      // IDs isolate this offer from later uploads, even if disposal is late.
      try {
        send(encodeTerminalImageControl(TERMINAL_IMAGE_CANCEL, id));
      } catch {
        /* Detach or offer expiry also cleans it up. */
      }
    };
    const stopped = () => upload.step.kind === "aborted" || !isCurrent();
    try {
      for (let offset = 0; offset < file.size; offset += TERMINAL_IMAGE_CHUNK_BYTES) {
        if (stopped()) throw new Error("unavailable");
        const data = new Uint8Array(
          await file.slice(offset, offset + TERMINAL_IMAGE_CHUNK_BYTES).arrayBuffer(),
        );
        if (stopped()) throw new Error("unavailable");
        const received = offset + data.length;
        const reply = await new Promise<TerminalImageReply>((resolve, reject) => {
          const timer = setTimeout(
            () => settle(new Error("timeout")),
            TERMINAL_IMAGE_ACK_TIMEOUT_MS,
          );
          const settle = (result: TerminalImageReply | Error) => {
            clearTimeout(timer);
            if (upload.step.kind === "awaitingAck" && upload.step.settle === settle) {
              upload.step = { kind: "sending" };
            }
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
          upload.step = { kind: "awaitingAck", received, settle };
          try {
            send(encodeTerminalImageChunk({ id, total: file.size, offset, format, data }));
          } catch {
            settle(new Error("unavailable"));
          }
        });
        if (stopped()) throw new Error("unavailable");
        progress(Math.round((received / file.size) * 100));
        if (received === file.size) {
          if (!reply.path) throw new Error("invalid");
          const text = terminalImagePasteText(reply.path, reply.paste);
          offer = "offered";
          return { id, text, cancel };
        }
        if (reply.path) throw new Error("invalid");
        // Leave room for keystrokes under the relay's input frame rate limit.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("invalid");
    } finally {
      if (this.state.kind === "uploading" && this.state.upload === upload) {
        this.state = { kind: "idle" };
      }
      if (offer === "uploading") cancel();
    }
  }
}
