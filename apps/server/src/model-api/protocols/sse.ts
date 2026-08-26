import { AdapterError } from "./errors.js";

export type SseRecord = { event?: string; data: string; id?: string };

/** Incremental SSE decoder: arbitrary byte boundaries, LF/CRLF, comments and multiline data. */
export class SseDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxBufferBytes: number;
  #buffer = "";
  #finished = false;

  constructor({ maxBufferBytes = 1024 * 1024 }: { maxBufferBytes?: number } = {}) {
    this.#maxBufferBytes = maxBufferBytes;
  }

  push(chunk: Uint8Array): SseRecord[] {
    if (this.#finished) throw new AdapterError("stream_closed", "SSE decoder is already closed.");
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw new AdapterError("invalid_utf8", "SSE stream was not valid UTF-8.");
    }
    const records = this.#drain(false);
    this.#guard();
    return records;
  }

  finish(): SseRecord[] {
    if (this.#finished) return [];
    this.#finished = true;
    try {
      this.#buffer += this.#decoder.decode();
    } catch {
      throw new AdapterError("invalid_utf8", "SSE stream was not valid UTF-8.");
    }
    const records = this.#drain(true);
    this.#guard();
    return records;
  }

  #guard() {
    if (new TextEncoder().encode(this.#buffer).byteLength > this.#maxBufferBytes) {
      throw new AdapterError("stream_buffer_exceeded", "SSE event exceeded the bounded buffer.");
    }
  }

  #drain(final: boolean): SseRecord[] {
    const records: SseRecord[] = [];
    while (true) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.#buffer);
      if (!match) break;
      const raw = this.#buffer
        .slice(0, match.index)
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n");
      if (new TextEncoder().encode(raw).byteLength > this.#maxBufferBytes)
        throw new AdapterError("stream_buffer_exceeded", "SSE event exceeded the bounded buffer.");
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const record = parseRecord(raw);
      if (record) records.push(record);
    }
    if (final && this.#buffer.length > 0) {
      throw new AdapterError("truncated_stream", "SSE stream ended inside an event.");
    }
    return records;
  }
}

function parseRecord(raw: string): SseRecord | null {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field !== "id")
      throw new AdapterError("unsupported_sse_field", `Unsupported SSE field: ${field}.`);
  }
  return data.length === 0 ? null : { event, data: data.join("\n"), id };
}
