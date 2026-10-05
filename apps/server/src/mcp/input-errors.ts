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
 *     `unrecognized_keys` (would echo input key names), `custom`
 *     (author-written, may interpolate the value) and unknown codes get a
 *     fixed text;
 *   - `unknownKeyCount` and `suggestions` for `unrecognized_keys` only.
 *     Suggestions are nearest names the tool already declares. Caller-chosen
 *     key text never leaves;
 *   - at most {@link MAX_ISSUES} issues; nothing else from the issue
 *     (`input`, `received`, `values`, `errors`, ...) is read.
 */

import { redactSecrets } from "./redaction";

export interface McpValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
  /** Count of unrecognized keys. Caller names are never included. */
  unknownKeyCount?: number;
  /** Nearest declared property names. Absent when none are close. */
  suggestions?: string[];
}

export const MAX_UNKNOWN_KEY_SUGGESTIONS = 5;
const SUGGESTION_MAX_DISTANCE = 3;
/** Unrecognized keys considered for suggestions. Extra keys still count. */
const MAX_UNKNOWN_KEYS_PROBED = 32;
/** Global request budget, independent of future tool-schema size. */
const MAX_SUGGESTION_COMPARISONS = 256;

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

function editDistance(left: string, right: string): number {
  const m = left.length;
  const n = right.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) row[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const next = row[j]!;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + cost);
      previous = next;
    }
  }
  return row[n]!;
}

function unknownKeyCount(keys: unknown): number | undefined {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  return keys.length;
}

/**
 * Nearest advertised property names for unrecognized keys. The caller key is
 * used only as a distance probe and never copied into the result.
 */
function suggestDeclaredNames(
  keys: unknown,
  knownKeys: ReadonlySet<string>,
  budget: { remaining: number },
): string[] | undefined {
  if (!Array.isArray(keys) || knownKeys.size === 0) return undefined;
  const ranked = new Map<string, number>();
  let probed = 0;
  for (const key of keys) {
    if (probed >= MAX_UNKNOWN_KEYS_PROBED) break;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_SEGMENT_LENGTH) continue;
    if (!IDENTIFIER_SEGMENT.test(key)) continue;
    probed += 1;
    for (const known of knownKeys) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      if (known.length > MAX_SEGMENT_LENGTH) continue;
      if (Math.abs(key.length - known.length) > SUGGESTION_MAX_DISTANCE) continue;
      const distance = editDistance(key, known);
      if (distance > SUGGESTION_MAX_DISTANCE) continue;
      const previous = ranked.get(known);
      if (previous === undefined || distance < previous) ranked.set(known, distance);
    }
  }
  if (ranked.size === 0) return undefined;
  return [...ranked.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_UNKNOWN_KEY_SUGGESTIONS)
    .map(([name]) => name);
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
  const suggestionBudget = { remaining: MAX_SUGGESTION_COMPARISONS };
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    if (issue === null || typeof issue !== "object") continue;
    const code = sanitizeCode(Reflect.get(issue, "code"));
    const rawKeys = code === "unrecognized_keys" ? Reflect.get(issue, "keys") : undefined;
    const count = code === "unrecognized_keys" ? unknownKeyCount(rawKeys) : undefined;
    const suggestions =
      code === "unrecognized_keys"
        ? suggestDeclaredNames(rawKeys, knownKeys, suggestionBudget)
        : undefined;
    result.push({
      path: sanitizePath(Reflect.get(issue, "path"), knownKeys),
      code,
      message: sanitizeMessage(code, Reflect.get(issue, "message")),
      ...(count === undefined ? {} : { unknownKeyCount: count }),
      ...(suggestions === undefined ? {} : { suggestions }),
    });
  }
  // Defense in depth: wsmp_ credential shapes that slipped into a path key.
  return result.length === 0 ? null : (redactSecrets(result) as McpValidationIssue[]);
}

/**
 * Failing caller argument paths, never suggested replacement names.
 * `"?"` (a segment that is not a declared field)
 * drops that path. Order follows the issues.
 */
export function fieldsFromValidationIssues(issues: readonly McpValidationIssue[]): string[] {
  const fields: string[] = [];
  const add = (name: string): void => {
    if (name === "?" || name.length === 0 || fields.includes(name)) return;
    fields.push(name);
  };
  for (const issue of issues) {
    if (issue.path.length === 0 || issue.path.includes("?")) continue;
    add(issue.path.map((segment) => String(segment)).join("."));
  }
  return fields;
}

const MAX_DECLARED_FIELD_LENGTH = MAX_PATH_SEGMENTS * (MAX_SEGMENT_LENGTH + 1);
const INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

/**
 * A dotted path whose every identifier segment is a property the tool
 * advertises (`advanced.contextMargin`). Numeric segments are nested indexes
 * (`rules.0.threshold`) and cannot lead the path.
 */
function isDeclaredFieldPath(item: string, knownKeys: ReadonlySet<string>): boolean {
  if (item.length > MAX_DECLARED_FIELD_LENGTH) return false;
  const segments = item.split(".");
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) return false;
  return segments.every((segment, index) => {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return false;
    if (INDEX_SEGMENT.test(segment)) return index > 0;
    return IDENTIFIER_SEGMENT.test(segment) && knownKeys.has(segment);
  });
}

/**
 * Procedure-authored `data.fields` (#200). Only names the tool's own
 * advertised schema declares are returned, so a handler cannot echo an
 * arbitrary caller string through this channel. Nested keys may be dotted.
 */
export function sanitizeDeclaredFields(
  data: unknown,
  knownKeys: ReadonlySet<string>,
): string[] | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  if (!Object.hasOwn(data, "fields")) return null;
  const raw: unknown = Reflect.get(data, "fields");
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const fields: string[] = [];
  for (const item of raw) {
    if (fields.length >= MAX_ISSUES) break;
    if (typeof item !== "string" || item.length === 0) continue;
    if (!isDeclaredFieldPath(item, knownKeys)) continue;
    if (!fields.includes(item)) fields.push(item);
  }
  return fields.length === 0 ? null : fields;
}

/**
 * Static procedure message for an argument-shaped BAD_REQUEST. Control
 * characters are rejected; length is capped; credential shapes are redacted.
 * Returns null when there is no usable message.
 */
/** Invisible format characters (bidi overrides, zero-width marks, BOM). */
const FORMAT_CHARACTER = /\p{Cf}/u;
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return FORMAT_CHARACTER.test(value);
}

export function sanitizeArgumentMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (trimmed.length === 0 || hasControlCharacter(trimmed)) return null;
  const capped =
    trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}...` : trimmed;
  const redacted = redactSecrets(capped);
  return typeof redacted === "string" ? redacted : null;
}

/** Human/agent-readable one-liner: `path: message; path: message`. */
export function formatValidationIssues(issues: readonly McpValidationIssue[]): string {
  return issues
    .map((issue) => {
      const base = issue.path.join(".");
      const where = base.length > 0 ? base : "(input)";
      if (issue.code !== "unrecognized_keys") return `${where}: ${issue.message}`;
      const count =
        issue.unknownKeyCount != null && issue.unknownKeyCount > 0
          ? ` (${issue.unknownKeyCount})`
          : "";
      const hint =
        issue.suggestions != null && issue.suggestions.length > 0
          ? `; try ${issue.suggestions.join(", ")}`
          : "";
      return `${where}: ${issue.message}${count}${hint}`;
    })
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
