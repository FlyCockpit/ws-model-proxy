/**
 * Bounded, prompt-free retention of a relayed response's byte windows so the
 * server can parse provider token usage once at finalization.
 *
 * Streaming APIs report usage in the final event (OpenAI `usage`, Responses
 * `response.completed`), while Anthropic reports cache reads early in
 * `message_start`. Keeping a bounded prefix and a bounded tail covers both
 * without retaining whole responses. The bytes never leave process memory:
 * only parsed integer counts are persisted.
 *
 * This module is dependency-free so the relay executor can own retention for
 * every attempt (pooled, direct, no-failover, transformer, context-count).
 */

export const USAGE_SAMPLE_PREFIX_BYTES = 64 * 1024;
export const USAGE_SAMPLE_TAIL_BYTES = 1024 * 1024;

export type ResponseUsageSample = {
  /** First `USAGE_SAMPLE_PREFIX_BYTES` of the response body. */
  prefix: Uint8Array[];
  /**
   * Last `USAGE_SAMPLE_TAIL_BYTES` of the response body. When the response
   * overflowed the window, it starts at the first complete SSE event boundary.
   */
  tail: Uint8Array[];
  /** Total response-body bytes observed. */
  totalBytes: number;
};

export class ResponseUsageRecorder {
  readonly #prefix: Uint8Array[] = [];
  #prefixBytes = 0;
  readonly #tail: Uint8Array[] = [];
  #tailBytes = 0;
  #totalBytes = 0;
  readonly #prefixLimit: number;
  readonly #tailLimit: number;

  constructor({
    prefixBytes = USAGE_SAMPLE_PREFIX_BYTES,
    tailBytes = USAGE_SAMPLE_TAIL_BYTES,
  }: { prefixBytes?: number; tailBytes?: number } = {}) {
    this.#prefixLimit = prefixBytes;
    this.#tailLimit = tailBytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.#totalBytes += chunk.byteLength;
    if (this.#prefixBytes < this.#prefixLimit) {
      const slice = chunk.subarray(0, this.#prefixLimit - this.#prefixBytes);
      this.#prefix.push(slice);
      this.#prefixBytes += slice.byteLength;
    }
    this.#tail.push(chunk);
    this.#tailBytes += chunk.byteLength;
    // Amortized O(1): drop whole leading chunks that are entirely outside the
    // tail window. The final trim to the exact window happens in `sample()`.
    while (
      this.#tail.length > 1 &&
      this.#tailBytes - this.#tail[0]!.byteLength >= this.#tailLimit
    ) {
      this.#tailBytes -= this.#tail.shift()!.byteLength;
    }
  }

  sample(): ResponseUsageSample {
    const overflowed = this.#totalBytes > this.#tailLimit;
    let tail = concat(this.#tail, this.#tailBytes);
    if (tail.byteLength > this.#tailLimit) tail = tail.subarray(tail.byteLength - this.#tailLimit);
    if (overflowed) tail = alignToSseEvent(tail);
    return {
      prefix: [...this.#prefix],
      tail: tail.byteLength > 0 ? [tail] : [],
      totalBytes: this.#totalBytes,
    };
  }
}

function concat(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * A truncated window may begin mid-event. Start at the next complete SSE
 * event so a partial multi-megabyte delta cannot poison the decoder before it
 * reaches the terminal usage event (mirrors `retainProviderUsageTail`).
 */
function alignToSseEvent(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boundaries = [text.indexOf("\n\n"), text.indexOf("\r\n\r\n"), text.indexOf("\r\r")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const boundary = boundaries[0];
  if (boundary === undefined) return bytes;
  const width = text
    .subarray(boundary, boundary + 4)
    .toString()
    .startsWith("\r\n\r\n")
    ? 4
    : 2;
  return bytes.subarray(boundary + width);
}
