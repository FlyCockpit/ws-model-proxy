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
  error?: string;
};

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
    ("path" in reply && (typeof reply.path !== "string" || !/^\/[\x20-\x7e]+$/.test(reply.path))) ||
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
      ...("error" in reply ? { error: String(reply.error) } : {}),
    },
  };
}

/** Printable ASCII only: pasted controls or non-ASCII bytes can drive shell editors. */
export function terminalImagePasteText(path: string): string {
  if (!/^\/[\x20-\x7e]+$/.test(path)) throw new Error("invalid");
  return /^[A-Za-z0-9_./-]+$/.test(path) ? `${path} ` : `'${path.replaceAll("'", "'\\''")}' `;
}

/** One stop-and-wait upload per attached viewer, with no automatic replay of writes. */
export class TerminalImageTransfer {
  supported = false;
  private busy = false;
  private cancelled = false;
  private pending: {
    id: string;
    received: number;
    resolve: (reply: TerminalImageReply) => void;
    reject: (error: Error) => void;
  } | null = null;

  abort(): void {
    this.cancelled = true;
    this.pending?.reject(new Error("unavailable"));
  }

  receive(reply: TerminalImageReply): void {
    const pending = this.pending;
    if (!pending || pending.id !== reply.id) return;
    if (reply.error) pending.reject(new Error(reply.error));
    else if (reply.received !== pending.received) pending.reject(new Error("invalid"));
    else pending.resolve(reply);
  }

  async upload(
    file: File,
    send: (plaintext: Uint8Array) => void,
    isCurrent: () => boolean,
    progress: (percent: number) => void,
  ): Promise<TerminalImageAttachment> {
    if (!this.supported) throw new Error("update");
    if (this.busy) throw new Error("busy");
    if (file.size < 1 || file.size > TERMINAL_IMAGE_MAX_BYTES) throw new Error("too_large");
    const format = terminalImageFormat(file.type);
    const random = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
    this.cancelled = false;
    this.busy = true;
    let completed = false;
    let cancelSent = false;
    const cancel = () => {
      if (cancelSent || !isCurrent()) return;
      cancelSent = true;
      // IDs isolate this offer from later uploads, even if disposal is late.
      try {
        send(encodeTerminalImageControl(TERMINAL_IMAGE_CANCEL, id));
      } catch {
        /* Detach or offer expiry also cleans it up. */
      }
    };
    try {
      for (let offset = 0; offset < file.size; offset += TERMINAL_IMAGE_CHUNK_BYTES) {
        if (this.cancelled || !isCurrent()) throw new Error("unavailable");
        const data = new Uint8Array(
          await file.slice(offset, offset + TERMINAL_IMAGE_CHUNK_BYTES).arrayBuffer(),
        );
        if (this.cancelled || !isCurrent()) throw new Error("unavailable");
        const received = offset + data.length;
        const reply = await new Promise<TerminalImageReply>((resolve, reject) => {
          const timer = setTimeout(
            () => finish(new Error("timeout")),
            TERMINAL_IMAGE_ACK_TIMEOUT_MS,
          );
          const finish = (result: TerminalImageReply | Error) => {
            clearTimeout(timer);
            this.pending = null;
            if (result instanceof Error) reject(result);
            else resolve(result);
          };
          this.pending = { id, received, resolve: finish, reject: finish };
          try {
            send(encodeTerminalImageChunk({ id, total: file.size, offset, format, data }));
          } catch {
            finish(new Error("unavailable"));
          }
        });
        if (this.cancelled || !isCurrent()) throw new Error("unavailable");
        progress(Math.round((received / file.size) * 100));
        if (received === file.size) {
          if (!reply.path) throw new Error("invalid");
          const text = terminalImagePasteText(reply.path);
          completed = true;
          return { id, text, cancel };
        }
        if (reply.path) throw new Error("invalid");
        // Leave room for keystrokes under the relay's input frame rate limit.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("invalid");
    } finally {
      this.busy = false;
      if (!completed) cancel();
    }
  }
}
