import {
  CLI_OUTPUT_ELLIPSIS,
  type CliStreamText,
  formatBoundedStream,
  type BoundedByteView as SharedBoundedByteView,
} from "@ws-model-proxy/config/cli-command-output";

export {
  CLI_OUTPUT_CREDENTIAL_PREFIXES,
  CLI_OUTPUT_ELLIPSIS,
  CLI_STREAM_HEAD_MAX_BYTES,
  CLI_STREAM_TAIL_MAX_BYTES,
  type CliStreamText,
  cleanText,
  formatBoundedStream,
  redactCredentialSubstrings,
} from "@ws-model-proxy/config/cli-command-output";

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

type BoundedByteView = SharedBoundedByteView;

/**
 * Byte budget of the envelope `runManifestTool` actually emits
 * (`MCP_TOOL_OUTPUT_MAX_BYTES` minus the SDK headroom). The formatter keeps
 * the wrapped result under this even when lossy UTF-8 expands the bytes.
 */
export const CLI_COMMAND_WRAPPED_OUTPUT_BUDGET = 256 * 1024 - 1024;

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

/** The supervised-command snapshot fields the presenter reads. */
export type PresentableSupervisedSnapshot = {
  commandId: string;
  status: string;
  exitCode: number | null;
  signal: string | null;
  rejectionReason: string | null;
  waitDeadline: number | null;
  started: boolean | null;
  output: { mode: "shared" | "reviewed" | "redacted" | "private"; edited: boolean } | null;
  shared: BoundedByteView | null;
  reviewedText: string | null;
};

/**
 * Model-facing record of a supervised command. While a person still has to
 * act it carries only the status (and the deadline of that wait). Once the
 * command exited it carries the exit status and `output.mode`: `shared` (the
 * capture as the CLI sent it), `reviewed` (text a person approved, possibly
 * edited — not a raw transcript), `redacted` (withheld), or `private`
 * (output was never requested). Unreviewed output never appears here. A
 * request that ended without exiting says whether its command had `started`
 * (`null`: not known yet, or never, if the CLI disconnected first).
 */
export function presentSupervisedCommand(snapshot: PresentableSupervisedSnapshot): unknown {
  const base = {
    commandId: snapshot.commandId,
    kind: "supervised" as const,
    status: snapshot.status,
  };
  if (
    snapshot.status === "awaiting_user" ||
    snapshot.status === "running" ||
    snapshot.status === "awaiting_output_review"
  ) {
    return {
      ...base,
      ...(snapshot.waitDeadline !== null
        ? { waitingUntil: new Date(snapshot.waitDeadline).toISOString() }
        : {}),
    };
  }
  if (snapshot.status !== "exited" || snapshot.output === null) {
    return {
      ...base,
      started: snapshot.started,
      ...(snapshot.rejectionReason ? { rejectionReason: snapshot.rejectionReason } : {}),
    };
  }
  const output = { mode: snapshot.output.mode, edited: snapshot.output.edited };
  let stdout: CliStreamText | undefined;
  if (snapshot.output.mode === "shared" && snapshot.shared !== null) {
    stdout = formatBoundedStream(snapshot.shared);
  } else if (snapshot.output.mode === "reviewed") {
    const text = snapshot.reviewedText ?? "";
    stdout = { text, truncated: false, totalBytes: new TextEncoder().encode(text).byteLength };
  }
  const record = {
    ...base,
    exitCode: snapshot.exitCode,
    processSignal: snapshot.signal,
    timedOut: false,
    output,
    ...(stdout !== undefined ? { stdout } : {}),
  };
  return stdout === undefined ? record : { ...record, ...fitWrappedOutput(record) };
}
