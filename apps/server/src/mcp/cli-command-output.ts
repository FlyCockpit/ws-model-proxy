import { PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/forwarder-security";

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

export type ParsedCliCommandSnapshot = {
  commandId: string;
  status: string;
  exitCode: number | null;
  processSignal: string | number | null;
  timedOut: boolean;
  rejectionReason: string | null;
  stdout: BoundedByteView;
  stderr: BoundedByteView;
};

type BoundedByteView = {
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

/** Same marker the key/prefix redactor uses, so the two layers read alike. */
const REDACTED = "[redacted]";

/**
 * Byte budget of the envelope `runManifestTool` actually emits
 * (`MCP_TOOL_OUTPUT_MAX_BYTES` minus the SDK headroom). The formatter keeps
 * the wrapped result under this even when lossy UTF-8 expands the bytes.
 */
export const CLI_COMMAND_WRAPPED_OUTPUT_BUDGET = 256 * 1024 - 1024;

const CREDENTIAL_SUBSTRING = new RegExp(
  `(?:${Object.values(PRODUCT_CREDENTIAL_PREFIXES).map(escapeRegex).join("|")})[A-Za-z0-9_-]+`,
  "g",
);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array();
}

function readBounded(value: unknown): BoundedByteView {
  const record = asRecord(value);
  if (record === null) {
    return { head: new Uint8Array(), tail: new Uint8Array(), totalBytes: 0 };
  }
  const head = readBytes(record.head);
  const tail = readBytes(record.tail);
  const total = record.totalBytes;
  const totalBytes =
    typeof total === "number" && Number.isFinite(total)
      ? Math.max(0, Math.trunc(total))
      : head.length + tail.length;
  return { head, tail, totalBytes };
}

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
  const prefixes = Object.values(PRODUCT_CREDENTIAL_PREFIXES);
  let next = text;
  for (let guard = 0; guard < prefixes.length; guard += 1) {
    const prefix = prefixes.find((candidate) => next.startsWith(candidate));
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
  let text = stripDisallowedControls(stripTerminalSequences(decodeLossy(bytes)));
  if (options?.dropLeadingToken) text = dropLeadingTokenRun(text);
  return redactCredentialSubstrings(text);
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

export function parseCliCommandSnapshot(
  value: unknown,
  fallbackCommandId: string,
): ParsedCliCommandSnapshot | null {
  const record = asRecord(value);
  if (record === null) return null;
  const status = record.status;
  if (typeof status !== "string" || status.length === 0) return null;
  const commandId =
    typeof record.commandId === "string" && record.commandId.length > 0
      ? record.commandId
      : fallbackCommandId;
  if (commandId.length === 0) return null;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? Math.trunc(record.exitCode)
      : null;
  const signalValue = record.processSignal ?? record.signal;
  const processSignal =
    typeof signalValue === "string" ||
    (typeof signalValue === "number" && Number.isFinite(signalValue))
      ? signalValue
      : null;
  return {
    commandId,
    status,
    exitCode,
    processSignal,
    timedOut: record.timedOut === true,
    rejectionReason: typeof record.rejectionReason === "string" ? record.rejectionReason : null,
    stdout: readBounded(record.stdout),
    stderr: readBounded(record.stderr),
  };
}

type PresentedRecord = {
  commandId: string;
  status: string;
  exitCode?: number | null;
  processSignal?: string | number | null;
  timedOut?: boolean;
  rejectionReason?: string;
  stdout?: CliStreamText;
  stderr?: CliStreamText;
};

function wrappedByteLength(record: unknown): number {
  const serialized = JSON.stringify(record);
  const envelope = {
    content: [{ type: "text", text: serialized }],
    structuredContent: { result: record },
  };
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}

function clipStream(stream: CliStreamText, maxChars: number): CliStreamText {
  if (stream.text.length <= maxChars) return stream;
  if (maxChars <= CLI_OUTPUT_ELLIPSIS.length) {
    return { text: "", truncated: true, totalBytes: stream.totalBytes };
  }
  const budget = maxChars - CLI_OUTPUT_ELLIPSIS.length;
  const headChars = Math.ceil(budget / 2);
  const tailChars = Math.max(0, budget - headChars);
  const head = stream.text.slice(0, headChars);
  const tail = tailChars === 0 ? "" : stream.text.slice(stream.text.length - tailChars);
  return {
    text: `${head}${CLI_OUTPUT_ELLIPSIS}${tail}`,
    truncated: true,
    totalBytes: stream.totalBytes,
  };
}

function withStreams(record: PresentedRecord, maxChars: number): PresentedRecord {
  return {
    ...record,
    ...(record.stdout !== undefined ? { stdout: clipStream(record.stdout, maxChars) } : {}),
    ...(record.stderr !== undefined ? { stderr: clipStream(record.stderr, maxChars) } : {}),
  };
}

/**
 * Lossy UTF-8 can expand each input byte to three UTF-8 bytes, and the
 * wrapper repeats the payload in `content` and `structuredContent`. Shrink
 * the stream text until that envelope fits. `totalBytes` stays the full
 * count; shrinking sets `truncated`.
 */
function fitWrappedOutput(record: PresentedRecord): PresentedRecord {
  if (wrappedByteLength(record) <= CLI_COMMAND_WRAPPED_OUTPUT_BUDGET) return record;
  const high = Math.max(record.stdout?.text.length ?? 0, record.stderr?.text.length ?? 0);
  let lo = 0;
  let hi = high;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wrappedByteLength(withStreams(record, mid)) <= CLI_COMMAND_WRAPPED_OUTPUT_BUDGET) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return withStreams(record, best);
}

/**
 * Model-facing command record. While `status` is `running` and `progress`
 * is `false`, only the status is returned. A finished command always
 * includes the final record. Running output omits the exit code.
 */
export function presentCliCommand(
  snapshot: ParsedCliCommandSnapshot,
  progress: boolean | undefined,
): PresentedRecord {
  if (snapshot.status === "running" && progress === false) {
    return { commandId: snapshot.commandId, status: "running" };
  }
  const stdout = formatBoundedStream(snapshot.stdout);
  const stderr = formatBoundedStream(snapshot.stderr);
  if (snapshot.status === "running") {
    return fitWrappedOutput({
      commandId: snapshot.commandId,
      status: "running",
      stdout,
      stderr,
    });
  }
  return fitWrappedOutput({
    commandId: snapshot.commandId,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    processSignal: snapshot.processSignal,
    timedOut: snapshot.timedOut,
    ...(snapshot.status === "rejected" && snapshot.rejectionReason
      ? { rejectionReason: snapshot.rejectionReason }
      : {}),
    stdout,
    stderr,
  });
}
