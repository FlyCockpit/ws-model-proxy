/**
 * The command-output text an MCP agent sees, shared by the server (headless
 * exec and shared supervised output) and the browser (the supervised-command
 * output review dialog shows exactly this text before anything is sent).
 *
 * Pure and dependency-free so both the Node server and the browser bundle use
 * the same bytes-to-text rules.
 */

/**
 * Per-stream view the model sees. `totalBytes` is the full stream count.
 * `text` is lossy UTF-8 of the retained head and tail, with credential
 * substrings removed. Other secrets are not redacted.
 */
export type CliStreamText = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

/** Retained bytes of one output stream: the first bytes and the last bytes. */
export type BoundedByteView = {
  head: Uint8Array;
  tail: Uint8Array;
  totalBytes: number;
};

/** First bytes retained per stream (the runtime cap). */
export const CLI_STREAM_HEAD_MAX_BYTES = 8192;
/** Last bytes retained per stream once the stream is truncated (the runtime cap). */
export const CLI_STREAM_TAIL_MAX_BYTES = 40960;

/**
 * Marker between the retained head and tail when bytes in the middle were
 * dropped. Kept short so the wrapped tool result stays inside the MCP cap.
 */
export const CLI_OUTPUT_ELLIPSIS = "\n…\n";

/**
 * Product credential prefixes removed from command output. Must equal the
 * values of `PRODUCT_CREDENTIAL_PREFIXES` in `@ws-model-proxy/db/forwarder-security`
 * (a server test pins that); duplicated here because that module is Node-only.
 */
export const CLI_OUTPUT_CREDENTIAL_PREFIXES: readonly string[] = [
  "wsmp_model_",
  "wsmp_cli_",
  "wsmp_device_",
  "wsmp_mcp_",
];

/** Same marker the key/prefix redactor uses, so the two layers read alike. */
const REDACTED = "[redacted]";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CREDENTIAL_SUBSTRING = new RegExp(
  `(?:${CLI_OUTPUT_CREDENTIAL_PREFIXES.map(escapeRegex).join("|")})[A-Za-z0-9_-]+`,
  "g",
);

/** Replace credential substrings anywhere in the text, not only whole values. */
export function redactCredentialSubstrings(text: string): string {
  const replaced = text.replace(CREDENTIAL_SUBSTRING, REDACTED);
  return neutralizeLeadingPrefixes(replaced);
}

/**
 * A leftover prefix with no credential body does not match the substring
 * regex, but the downstream whole-value redactor would blank the entire
 * field if the text still starts with one. Peel those leading prefixes so
 * the rest of the output survives.
 */
function neutralizeLeadingPrefixes(text: string): string {
  let next = text;
  for (let guard = 0; guard < CLI_OUTPUT_CREDENTIAL_PREFIXES.length; guard += 1) {
    const prefix = CLI_OUTPUT_CREDENTIAL_PREFIXES.find((candidate) => next.startsWith(candidate));
    if (prefix === undefined) return next;
    next = `${REDACTED}${next.slice(prefix.length)}`;
  }
  return next;
}

function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Drop C0/C1 controls except tab, LF, and CR. */
function stripDisallowedControls(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += text[index] ?? "";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += text[index] ?? "";
  }
  return out;
}

function stripTerminalSequences(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x1b) {
      out += text[index] ?? "";
      continue;
    }
    const next = text[index + 1];
    if (next === "[") {
      index += 2;
      while (index < text.length && (text.charCodeAt(index) ?? 0) < 0x40) index += 1;
      continue;
    }
    if (next === "]") {
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index) ?? 0;
        if (code === 0x07) break;
        if (code === 0x1b && text[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (next) index += 1;
  }
  return out;
}

function dropLeadingTokenRun(text: string): string {
  return text.replace(/^[A-Za-z0-9_-]+/, "");
}

function cleanDecoded(bytes: Uint8Array, options?: { dropLeadingToken?: boolean }): string {
  return cleanText(decodeLossy(bytes), options);
}

/**
 * The text rules applied to decoded output: terminal sequences and control
 * characters removed, then credential substrings redacted. Also applied to
 * reviewed text a person submits, so it gets the same treatment.
 */
export function cleanText(text: string, options?: { dropLeadingToken?: boolean }): string {
  let cleaned = stripDisallowedControls(stripTerminalSequences(text));
  if (options?.dropLeadingToken) cleaned = dropLeadingTokenRun(cleaned);
  return redactCredentialSubstrings(cleaned);
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (tail.length === 0) return head;
  if (head.length === 0) return tail;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/**
 * Head is the first retained bytes and tail the last. The runtime keeps a
 * tail that still overlaps the head until the stream is longer than both
 * caps, so a covered stream (`totalBytes <= head + tail`) is head plus the
 * non-overlapping suffix of tail — not a blind concatenation. A longer
 * stream has a gap: lossy-utf8(head) + ellipsis + lossy-utf8(tail).
 */
export function formatBoundedStream(stream: BoundedByteView): CliStreamText {
  const truncated = stream.totalBytes > stream.head.length + stream.tail.length;
  if (truncated) {
    return {
      text: `${cleanDecoded(stream.head)}${CLI_OUTPUT_ELLIPSIS}${cleanDecoded(stream.tail, { dropLeadingToken: true })}`,
      truncated: true,
      totalBytes: stream.totalBytes,
    };
  }
  const overlap = Math.max(0, stream.head.length + stream.tail.length - stream.totalBytes);
  const tailSuffix =
    overlap >= stream.tail.length ? new Uint8Array() : stream.tail.subarray(overlap);
  return {
    text: cleanDecoded(concatBytes(stream.head, tailSuffix)),
    truncated: false,
    totalBytes: stream.totalBytes,
  };
}
