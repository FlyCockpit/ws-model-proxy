/**
 * What an engine's 400 says it rejected, for reactive learning. Pure. Understands the common
 * shapes: pydantic v1/v2 (vLLM, SGLang, FastAPI 422 `detail`, and the rendered text form),
 * serde (TGI, Rust servers), Go `encoding/json` (Ollama), llama.cpp, OpenAI and Anthropic
 * error messages. A located field is resolved against the request body so the result is a
 * field path (`messages[].cache_control`) of a key the request really has.
 */

export type EngineRejection =
  | { kind: "field"; path: string }
  /** The engine asks for another spelling (`Use 'max_completion_tokens' instead`). */
  | { kind: "replace"; path: string; with: string }
  | { kind: "role"; value: string }
  | { kind: "header"; name: string };

const MAX_SCAN_BYTES = 16 * 1024;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every human-readable message an error body carries (bounded). */
function messagesOf(text: string): { messages: string[]; detail: unknown[] } {
  const messages: string[] = [];
  const detail: unknown[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { messages: [text], detail };
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || messages.length > 16) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    if (Array.isArray(value.detail)) detail.push(...value.detail);
    for (const key of ["message", "error", "detail", "msg"]) visit(value[key], depth + 1);
    if (
      typeof value.param === "string" &&
      /unknown|unrecognized|unsupported/i.test(String(value.code ?? value.message ?? ""))
    )
      messages.push(`Unknown parameter: '${value.param}'`);
  };
  visit(parsed, 0);
  return { messages, detail };
}

/**
 * Resolves a location (`["body", "messages", 0, "user", "cache_control"]`) against the request:
 * integer segments descend arrays, keys the object has descend it, anything else (union tags
 * such as `user` or `ChatCompletionUserMessageParam`) is skipped. Null unless the last segment
 * is a key the request really has.
 */
export function resolveLocation(
  location: ReadonlyArray<string | number>,
  body: unknown,
): string | null {
  const segments = location[0] === "body" ? location.slice(1) : location;
  let current: unknown = body;
  const path: string[] = [];
  let lastMatched = false;
  for (const segment of segments) {
    lastMatched = false;
    if (Array.isArray(current)) {
      const index =
        typeof segment === "number" ? segment : /^\d+$/.test(segment) ? Number(segment) : null;
      if (index === null || index >= current.length) continue;
      path[path.length - 1] = `${path.at(-1)}[]`;
      current = current[index];
      continue;
    }
    if (isObject(current) && typeof segment === "string" && Object.hasOwn(current, segment)) {
      path.push(segment);
      current = current[segment];
      lastMatched = true;
    }
  }
  return lastMatched && path.length > 0 ? path.join(".") : null;
}

/** The unique path of a key named `name` in the request (top level first), or null. */
function findKey(name: string, body: unknown): string | null {
  if (isObject(body) && Object.hasOwn(body, name)) return name;
  const found = new Set<string>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 6 || found.size > 1) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key === name) found.add(childPath);
      visit(child, childPath, depth + 1);
    }
  };
  visit(body, "", 0);
  return found.size === 1 ? [...found][0]! : null;
}

const EXTRA = /extra (?:inputs|fields) (?:are )?not permitted|extra_forbidden/i;

function fromDetail(detail: unknown[], body: unknown): EngineRejection | null {
  for (const entry of detail) {
    if (!isObject(entry) || !Array.isArray(entry.loc)) continue;
    const kind = `${entry.type ?? ""} ${entry.msg ?? ""}`;
    if (!EXTRA.test(kind)) continue;
    const loc = entry.loc.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    const path = resolveLocation(loc, body);
    if (path) return { kind: "field", path };
  }
  return null;
}

/** Pydantic tuples rendered in a message: `'loc': ('body', 'stream_options')`. */
function fromPydanticRepr(message: string, body: unknown): EngineRejection | null {
  const pattern = /'loc':\s*\(([^)]*)\)[^}]*?'msg':\s*'([^']*)'/g;
  for (const match of message.matchAll(pattern)) {
    if (!EXTRA.test(match[2] ?? "") && !EXTRA.test(match[0])) continue;
    const loc = [...(match[1] ?? "").matchAll(/'([^']*)'|(\d+)/g)].map((part) =>
      part[1] !== undefined ? part[1] : Number(part[2]),
    );
    const path = resolveLocation(loc, body);
    if (path) return { kind: "field", path };
  }
  return null;
}

/**
 * Pydantic's text form: `1 validation error for ChatCompletionRequest\nmessages.0.user.foo\n
 * Extra inputs are not permitted [type=extra_forbidden, ...]`, and Anthropic's
 * `messages.0.content.0.foo: Extra inputs are not permitted`.
 */
function fromPydanticText(message: string, body: unknown): EngineRejection | null {
  const lines = message.split(/\r?\n|\\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const inline = /^([A-Za-z0-9_.\-[\]]+):\s*(.*)$/.exec(line);
    if (inline && EXTRA.test(inline[2] ?? "")) {
      const path = resolveLocation(inline[1]!.split("."), body);
      if (path) return { kind: "field", path };
    }
    const next = lines[index + 1]?.trim() ?? "";
    if (/^[A-Za-z0-9_.-]+$/.test(line) && EXTRA.test(next)) {
      const path = resolveLocation(line.split("."), body);
      if (path) return { kind: "field", path };
    }
  }
  return null;
}

const NAMED_FIELD_PATTERNS: RegExp[] = [
  // serde (TGI and Rust servers): unknown field `foo`, expected one of ...
  /unknown field `([^`]+)`/i,
  // Go encoding/json (Ollama with DisallowUnknownFields): json: unknown field "foo"
  /unknown field "([^"]+)"/i,
  // OpenAI: Unrecognized request argument supplied: foo / Unknown parameter: 'foo'.
  /unrecognized request arguments? supplied:\s*([A-Za-z0-9_.[\]-]+)/i,
  /unknown parameter:?\s*'([^']+)'/i,
  /unsupported param(?:eter)?:?\s*'?([A-Za-z0-9_.[\]-]+)'?/i,
  // llama.cpp and friends: "foo" is not supported / Unsupported param: foo
  /(?:param(?:eter)?|field)\s+'?`?"?([A-Za-z0-9_.-]+)'?`?"?\s+is not (?:supported|allowed|permitted)/i,
];

function fromNamedField(message: string, body: unknown): EngineRejection | null {
  const replacement =
    /'([A-Za-z0-9_.-]+)'[^.]*not supported[^.]*\.\s*Use '([A-Za-z0-9_.-]+)' instead/i.exec(message);
  if (replacement) {
    const path = findKey(replacement[1]!, body);
    if (path) return { kind: "replace", path, with: replacement[2]! };
  }
  for (const pattern of NAMED_FIELD_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const name = match[1]!.replace(/\[\d+\]/g, "");
    const path = name.includes(".") ? resolveLocation(name.split("."), body) : findKey(name, body);
    if (path) return { kind: "field", path };
  }
  return null;
}

function fromRole(message: string, body: unknown): EngineRejection | null {
  const patterns = [
    /(?:unexpected|invalid|unsupported|unknown) (?:message )?role:?\s*'?"?`?([a-z_]+)/i,
    /input tag '([a-z_]+)' found using 'role'/i,
    /role '?"?([a-z_]+)'?"? is not (?:supported|allowed)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const value = match[1]!.toLowerCase();
    const messages = isObject(body) ? (body.messages ?? body.input) : undefined;
    if (
      Array.isArray(messages) &&
      messages.some((entry) => isObject(entry) && entry.role === value)
    )
      return { kind: "role", value };
  }
  return null;
}

function fromHeader(message: string, headers: Headers): EngineRejection | null {
  const match =
    /for the `?([a-z0-9-]+)`? header|header `?([a-z0-9-]+)`? (?:is )?(?:not supported|invalid|unexpected)/i.exec(
      message,
    );
  const name = (match?.[1] ?? match?.[2])?.toLowerCase();
  return name && headers.has(name) ? { kind: "header", name } : null;
}

/**
 * The field, role or header a 4xx error body names, resolved against the request that caused
 * it. Null when it names nothing the request has (then nothing is learned or retried).
 */
export function parseEngineRejection(input: {
  status: number;
  bodyText: string;
  requestBody: unknown;
  requestHeaders: Headers;
}): EngineRejection | null {
  if (input.status !== 400 && input.status !== 422) return null;
  const text = input.bodyText.slice(0, MAX_SCAN_BYTES);
  const { messages, detail } = messagesOf(text);
  const fromList = fromDetail(detail, input.requestBody);
  if (fromList) return fromList;
  for (const message of messages) {
    const found =
      fromPydanticRepr(message, input.requestBody) ??
      fromPydanticText(message, input.requestBody) ??
      fromHeader(message, input.requestHeaders) ??
      fromRole(message, input.requestBody) ??
      fromNamedField(message, input.requestBody);
    if (found) return found;
  }
  return null;
}

/** A short, printable excerpt of an upstream error body for the caller (never stored). */
export function upstreamErrorExcerpt(bodyText: string, maxChars = 300): string {
  let printable = "";
  for (const char of bodyText) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    if (!control) printable += char;
    else if (!printable.endsWith(" ")) printable += " ";
  }
  printable = printable.trim();
  return printable.length > maxChars ? `${printable.slice(0, maxChars)}…` : printable;
}
