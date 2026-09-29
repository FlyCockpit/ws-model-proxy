/**
 * Sanitized validation issues for MCP tool errors (#117).
 *
 * oRPC validates a procedure's input and throws `BAD_REQUEST` whose
 * `data.issues` are the zod issues. An agent needs the failing FIELD to fix
 * its call, but the issues sit next to secrets the agent sent (tokens,
 * provider keys, command text), and zod messages and paths can echo input.
 * `sanitizeValidationIssues` is the ONE place issues become tool output:
 *
 *   - `code`: an allowlisted zod issue code, else `"invalid"`;
 *   - `path`: at most {@link MAX_PATH_SEGMENTS} segments, each a number or a
 *     string that the tool's OWN advertised schema declares as a property
 *     name (and is identifier-shaped, at most {@link MAX_SEGMENT_LENGTH}
 *     chars). Anything else (record keys the caller invented, symbols)
 *     becomes `"?"`, so no caller-chosen text can ride in a path;
 *   - `message`: the zod message ONLY for codes whose message is built from
 *     the schema and the input's TYPE (never its value), capped in length;
 *     `unrecognized_keys` (echoes input key names), `custom` (author-written,
 *     may interpolate the value) and unknown codes get a fixed text;
 *   - at most {@link MAX_ISSUES} issues; nothing else from the issue
 *     (`input`, `received`, `values`, `errors`, ...) is read.
 */

import { redactSecrets } from "./redaction";

export interface McpValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export const MAX_ISSUES = 20;
export const MAX_PATH_SEGMENTS = 8;
export const MAX_SEGMENT_LENGTH = 64;
export const MAX_MESSAGE_LENGTH = 200;

const IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Codes whose zod message never embeds an input VALUE (schema + type only). */
const MESSAGE_SAFE_CODES: ReadonlySet<string> = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "invalid_value",
  "invalid_union",
  "invalid_key",
  "invalid_element",
]);

const FIXED_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unrecognized_keys: "Unrecognized field",
  custom: "Invalid value",
  invalid: "Invalid value",
});

function sanitizeSegment(segment: unknown, knownKeys: ReadonlySet<string>): string | number {
  const key: unknown =
    segment !== null && typeof segment === "object" && "key" in segment
      ? (segment as { key: unknown }).key
      : segment;
  if (typeof key === "number" && Number.isSafeInteger(key) && key >= 0) return key;
  if (
    typeof key === "string" &&
    key.length <= MAX_SEGMENT_LENGTH &&
    IDENTIFIER_SEGMENT.test(key) &&
    knownKeys.has(key)
  ) {
    return key;
  }
  return "?";
}

function sanitizePath(path: unknown, knownKeys: ReadonlySet<string>): (string | number)[] {
  if (!Array.isArray(path)) return [];
  return path.slice(0, MAX_PATH_SEGMENTS).map((segment) => sanitizeSegment(segment, knownKeys));
}

function sanitizeMessage(code: string, message: unknown): string {
  if (MESSAGE_SAFE_CODES.has(code) && typeof message === "string" && message.length > 0) {
    return message.length > MAX_MESSAGE_LENGTH
      ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...`
      : message;
  }
  return FIXED_MESSAGES[code] ?? FIXED_MESSAGES.invalid ?? "Invalid value";
}

function sanitizeCode(code: unknown): string {
  return typeof code === "string" &&
    (MESSAGE_SAFE_CODES.has(code) || Object.hasOwn(FIXED_MESSAGES, code))
    ? code
    : "invalid";
}

/**
 * The sanitized issues of a BAD_REQUEST `data` payload, or `null` when it
 * carries no usable issue list (the caller then keeps the plain error).
 */
export function sanitizeValidationIssues(
  data: unknown,
  knownKeys: ReadonlySet<string>,
): McpValidationIssue[] | null {
  if (data === null || typeof data !== "object" || !Object.hasOwn(data, "issues")) return null;
  const issues: unknown = Reflect.get(data, "issues");
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const result: McpValidationIssue[] = [];
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    if (issue === null || typeof issue !== "object") continue;
    const code = sanitizeCode(Reflect.get(issue, "code"));
    result.push({
      path: sanitizePath(Reflect.get(issue, "path"), knownKeys),
      code,
      message: sanitizeMessage(code, Reflect.get(issue, "message")),
    });
  }
  // Defense in depth: wsmp_ credential shapes that slipped into a path key.
  return result.length === 0 ? null : (redactSecrets(result) as McpValidationIssue[]);
}

/** Human/agent-readable one-liner: `path: message; path: message`. */
export function formatValidationIssues(issues: readonly McpValidationIssue[]): string {
  return issues
    .map(
      (issue) => `${issue.path.length === 0 ? "(input)" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

/**
 * Every property name the advertised JSON Schema declares, at any depth: the
 * only string path segments allowed to reach the client.
 */
export function collectSchemaPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 64) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value !== null && typeof value === "object") {
        for (const name of Object.keys(value)) names.add(name);
      }
      visit(value, depth + 1);
    }
  };
  visit(schema, 0);
  return names;
}
