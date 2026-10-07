/**
 * A short, secret-redacted excerpt of a local runtime's error answer (HTTP 4xx/5xx), so a failed
 * request is diagnosable from the request log and MCP (`model_test`, `requests_list`) without
 * reading node logs. Taken from the relay executor's bounded response prefix; never the request.
 *
 * Structured errors keep only their messages: OpenAI-style `error.message`, FastAPI/pydantic
 * `detail[]` as `loc: msg` (the `input` they echo, which can be prompt text, is dropped), and a
 * plain `detail`/`message`/`error` string. Anything else is the body text. The result is one line,
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

/** The excerpt of an error body's text, or null when it is empty. */
export function upstreamErrorExcerptFromText(text: string): string | null {
  let message: string | null = null;
  const trimmed = text.trimStart();
  try {
    message = structuredMessage(JSON.parse(text));
  } catch {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // JSON cut off at the read window: only a message field, never the echoed input.
      const found = MESSAGE_FIELD.exec(trimmed)?.[1];
      message = found ? found.replace(/\\(.)/g, "$1") : "(unreadable JSON error body)";
    }
  }
  const line = oneLine(redact(message ?? text));
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
