/**
 * A short, secret-redacted excerpt of a local runtime's error answer (HTTP 4xx/5xx), so a failed
 * request is diagnosable from the request log and MCP (`model_test`, `requests_list`) without
 * reading node logs. Taken from the relay executor's bounded response prefix; never the request.
 *
 * Structured errors keep only their messages: OpenAI-style `error.message`, FastAPI/pydantic
 * `detail[]` as `loc: msg` (the `input` they echo, which can be prompt text, is dropped), and a
 * plain `detail`/`message`/`error` string; other JSON is a fixed placeholder, and plain text is the
 * body text. Anything that quotes the request (`input=…`) is cut. The result is one line,
 * control characters removed, product credentials, bearer values and JWTs redacted, and at most
 * `UPSTREAM_ERROR_EXCERPT_CHARS` characters.
 */
import type { ResponseUsageSample } from "./response-usage-sample.js";

export const UPSTREAM_ERROR_EXCERPT_CHARS = 300;
/** Bytes of the response prefix read for an excerpt. */
const EXCERPT_SOURCE_BYTES = 8 * 1024;

/**
 * Credentials an engine may echo back ("Incorrect API key provided: sk-…"): product credentials
 * (every `wsmp_<kind>_` prefix), provider-style secret keys, bearer/DPoP values and JWTs. Kept
 * here (not mcp/redaction.ts) so the relay hot path does not load the server env.
 */
const CREDENTIALS = [
  /\bwsmp_[a-z]+_[A-Za-z0-9_.-]{12,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

function redact(text: string): string {
  return CREDENTIALS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

const MESSAGE_FIELD = /"(?:message|msg|detail|error)"\s*:\s*"((?:[^"\\]|\\.){1,2000})"/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pydanticDetail(detail: unknown[]): string | null {
  const parts = detail.flatMap((item) => {
    const entry = record(item);
    if (!entry || typeof entry.msg !== "string") return [];
    const loc = Array.isArray(entry.loc)
      ? entry.loc.filter((part) => typeof part === "string" || typeof part === "number").join(".")
      : "";
    return [loc ? `${loc}: ${entry.msg}` : entry.msg];
  });
  return parts.length ? parts.join("; ") : null;
}

/** The message(s) of a parsed JSON error body, or null when it has none we know. */
function structuredMessage(parsed: unknown): string | null {
  const body = record(parsed);
  if (!body) return null;
  const error = body.error;
  const errorRecord = record(error);
  if (errorRecord && typeof errorRecord.message === "string") {
    const extra = typeof errorRecord.param === "string" ? ` (param: ${errorRecord.param})` : "";
    return `${errorRecord.message}${extra}`;
  }
  if (typeof error === "string") return error;
  if (Array.isArray(body.detail)) return pydanticDetail(body.detail);
  if (typeof body.detail === "string") return body.detail;
  if (typeof body.message === "string") return body.message;
  return null;
}

function oneLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function clip(text: string): string {
  const chars = [...text];
  return chars.length > UPSTREAM_ERROR_EXCERPT_CHARS
    ? `${chars.slice(0, UPSTREAM_ERROR_EXCERPT_CHARS - 1).join("")}…`
    : text;
}

/**
 * Validation messages that quote the request (vLLM/pydantic `input=`, `'input': …`,
 * `input_value=`): everything from the quote on is dropped, since it can be prompt text.
 */
const ECHOED_INPUT =
  /(?:\binput_value\s*=|\binput\s*=|['"]input['"]\s*:|\binput\s*:\s*['"{[]).*$/is;

function withoutEchoedInput(text: string): string {
  return text.replace(ECHOED_INPUT, "[input omitted]");
}

/** The excerpt of an error body's text, or null when it is empty. */
export function upstreamErrorExcerptFromText(text: string): string | null {
  let message: string | null = null;
  const trimmed = text.trimStart();
  try {
    // JSON without a message we know is never stored raw: its fields can echo the request.
    message = structuredMessage(JSON.parse(text)) ?? "(unrecognized JSON error body)";
  } catch {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // JSON cut off at the read window: only a message field, never the echoed input.
      const found = MESSAGE_FIELD.exec(trimmed)?.[1];
      message = found ? found.replace(/\\(.)/g, "$1") : "(unreadable JSON error body)";
    }
  }
  const line = oneLine(redact(withoutEchoedInput(message ?? text)));
  return line ? clip(line) : null;
}

/** The excerpt of an error answer's retained prefix, or null. */
export function upstreamErrorExcerpt(
  sample: ResponseUsageSample | null | undefined,
): string | null {
  if (!sample || sample.prefix.length === 0) return null;
  const bytes = new Uint8Array(Math.min(EXCERPT_SOURCE_BYTES, sample.totalBytes));
  let offset = 0;
  for (const chunk of sample.prefix) {
    if (offset >= bytes.byteLength) break;
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return upstreamErrorExcerptFromText(
    new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, offset)),
  );
}

/** How long a failover waits for a failed answer's first bytes before moving on. */
export const ERROR_BODY_WAIT_MS = 1_000;

/**
 * The excerpt of an error answer read from its body: at most `EXCERPT_SOURCE_BYTES`, waiting at
 * most `waitMs` (a failover never stalls on a slow error body). The caller cancels the rest.
 */
export async function readUpstreamErrorExcerpt(
  body: ReadableStream<Uint8Array> | null,
  waitMs = ERROR_BODY_WAIT_MS,
): Promise<string | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  try {
    while (total < EXCERPT_SOURCE_BYTES) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === "timeout" || result.done) break;
      if (result.value) {
        chunks.push(result.value);
        total += result.value.byteLength;
      }
    }
  } catch {
    // An errored body: whatever arrived is the excerpt.
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return upstreamErrorExcerptFromText(
    new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, EXCERPT_SOURCE_BYTES)),
  );
}
