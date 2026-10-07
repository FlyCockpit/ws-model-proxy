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
  /**
   * `unsupported`: the engine does not take the header at all (learned for the launch);
   * `value`: it rejected this request's value (dropped for this request only, so one caller's
   * bad value never removes the header for everyone).
   */
  | { kind: "header"; name: string; reason: "unsupported" | "value" };

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
 * A validation-union tag pydantic puts in a location (`ChatCompletionUserMessageParam`,
 * `function-after[...]`, a role-tagged variant): never a request key.
 */
function isUnionTag(segment: string): boolean {
  return (
    /^[A-Z][A-Za-z0-9]{0,127}$/.test(segment) ||
    /[[\]()-]/.test(segment) ||
    ["system", "developer", "user", "assistant", "tool", "function"].includes(segment)
  );
}

/**
 * Resolves a location (`["body", "messages", 0, "user", "cache_control"]`) against the request:
 * integer segments descend arrays and keys the object has descend it. A union tag the request
 * does not have as a key is skipped; any other missing segment (or index) fails, so an error
 * about a field the request lacks is never pinned on another one. `strict` skips nothing.
 */
export function resolveLocation(
  location: ReadonlyArray<string | number>,
  body: unknown,
  { strict = false }: { strict?: boolean } = {},
): string | null {
  const segments = location[0] === "body" ? location.slice(1) : location;
  let current: unknown = body;
  const path: string[] = [];
  let lastMatched = false;
  for (const segment of segments) {
    lastMatched = false;
    if (Array.isArray(current)) {
      const index =
        typeof segment === "number" ? segment : /^\d{1,6}$/.test(segment) ? Number(segment) : null;
      if (index === null || index >= current.length || path.length === 0) return null;
      if (!path.at(-1)!.endsWith("[]")) path[path.length - 1] = `${path.at(-1)}[]`;
      current = current[index];
      continue;
    }
    if (isObject(current) && typeof segment === "string" && Object.hasOwn(current, segment)) {
      path.push(segment);
      current = current[segment];
      lastMatched = true;
      continue;
    }
    if (strict || typeof segment !== "string" || !isUnionTag(segment)) return null;
  }
  return lastMatched && path.length > 0 ? path.join(".") : null;
}

/**
 * The unique path of a key named `name` in the request's STRUCTURE (top level first, then the
 * items of `messages`/`input`/`tools`/`system`, their content parts and tool functions), or
 * null. Caller data such as tool JSON schemas or metadata maps is never searched, so an error
 * naming a common word cannot be pinned on an unrelated nested field.
 */
function findKey(name: string, body: unknown): string | null {
  if (!isObject(body)) return null;
  if (Object.hasOwn(body, name)) return name;
  const found = new Set<string>();
  const addFrom = (holder: unknown, path: string) => {
    if (isObject(holder) && Object.hasOwn(holder, name)) found.add(`${path}.${name}`);
  };
  for (const container of ["messages", "input", "tools", "system"]) {
    const list = body[container];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      addFrom(item, `${container}[]`);
      if (!isObject(item)) continue;
      if (Array.isArray(item.content))
        for (const part of item.content) addFrom(part, `${container}[].content[]`);
      addFrom(item.function, `${container}[].function`);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

const EXTRA = /extra (?:inputs|fields) (?:are )?not permitted|extra_forbidden/i;

/**
 * Pydantic reports `extra_forbidden` once per union variant it tried; a key one variant accepts
 * may be "extra" for another. Only a path every such entry agrees on is taken.
 */
function fromDetail(detail: unknown[], body: unknown): EngineRejection | null {
  const paths = new Set<string>();
  let unresolved = false;
  for (const entry of detail) {
    if (!isObject(entry) || !Array.isArray(entry.loc)) continue;
    const kind = `${entry.type ?? ""} ${entry.msg ?? ""}`;
    if (!EXTRA.test(kind)) continue;
    const loc = entry.loc.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    const path = resolveLocation(loc, body);
    if (path) paths.add(path);
    else unresolved = true;
  }
  return paths.size === 1 && !unresolved ? { kind: "field", path: [...paths][0]! } : null;
}

/** Pydantic tuples rendered in a message: `'loc': ('body', 'stream_options')`. */
function fromPydanticRepr(message: string, body: unknown): EngineRejection | null {
  const pattern = /'loc':\s*\(([^)]{0,512})\)[^}]{0,512}?'msg':\s*'([^']{0,256})'/g;
  const entries: Json[] = [];
  for (const match of message.matchAll(pattern)) {
    if (!EXTRA.test(match[2] ?? "") && !EXTRA.test(match[0])) continue;
    const loc = [...(match[1] ?? "").matchAll(/'([^']*)'|(\d+)/g)].map((part) =>
      part[1] !== undefined ? part[1] : Number(part[2]),
    );
    entries.push({ type: "extra_forbidden", loc });
  }
  return fromDetail(entries, body);
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
    const inline = /^([A-Za-z0-9_.\-[\]]{1,256}):\s*(.*)$/.exec(line);
    if (inline && EXTRA.test(inline[2] ?? "")) {
      const path = resolveLocation(inline[1]!.split("."), body);
      if (path) return { kind: "field", path };
    }
    const next = lines[index + 1]?.trim() ?? "";
    if (/^[A-Za-z0-9_.-]{1,256}$/.test(line) && EXTRA.test(next)) {
      const path = resolveLocation(line.split("."), body);
      if (path) return { kind: "field", path };
    }
  }
  return null;
}

const NAMED_FIELD_PATTERNS: RegExp[] = [
  // serde (TGI and Rust servers): unknown field `foo`, expected one of ...
  /unknown field `([^`]{1,128})`/i,
  // Go encoding/json (Ollama with DisallowUnknownFields): json: unknown field "foo"
  /unknown field "([^"]{1,128})"/i,
  // OpenAI: Unrecognized request argument supplied: foo / Unknown parameter: 'foo'.
  /unrecognized request arguments? supplied:\s*([A-Za-z0-9_.[\]-]{1,128})/i,
  /unknown parameter:?\s*'([^']{1,128})'/i,
  /unsupported param(?:eter)?:\s*['"`]?([A-Za-z0-9_.[\]-]{1,128})/i,
  // llama.cpp and friends: "foo" is not supported / Unsupported param: foo
  /(?:param(?:eter)?|field) ['`"]?([A-Za-z0-9_.-]{1,64})['`"]? is not (?:supported|allowed|permitted)/i,
];

function fromNamedField(message: string, body: unknown): EngineRejection | null {
  // OpenAI's exact wording, with bounded names: linear in the message length.
  const replacement =
    /'([A-Za-z0-9_.-]{1,64})' is not supported with this model\. Use '([A-Za-z0-9_.-]{1,64})' instead/i.exec(
      message,
    );
  if (replacement) {
    const path = findKey(replacement[1]!, body);
    if (path) return { kind: "replace", path, with: replacement[2]! };
  }
  for (const pattern of NAMED_FIELD_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    // OpenAI-style indexes (`messages[0].foo`) become location segments.
    const name = match[1]!.replace(/\[(\d+)\]/g, ".$1");
    const path = name.includes(".")
      ? resolveLocation(name.split("."), body, { strict: true })
      : findKey(name, body);
    if (path) return { kind: "field", path };
  }
  return null;
}

function fromRole(message: string, body: unknown): EngineRejection | null {
  const patterns = [
    /(?:unexpected|invalid|unsupported|unknown) (?:message )?role:? ?['"`]?([a-z_]{1,32})/i,
    /input tag '([a-z_]{1,32})' found using 'role'/i,
    /role ['"]?([a-z_]{1,32})['"]? is not (?:supported|allowed)/i,
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
  const value = /value\(?s?\)?[^.]{0,200}? for the `?([a-z0-9-]{1,64})`? header/i.exec(message);
  const unsupported =
    /header `?([a-z0-9-]{1,64})`? (?:is )?(?:not supported|not allowed|unexpected)/i.exec(message);
  const name = (value?.[1] ?? unsupported?.[1])?.toLowerCase();
  if (!name || !headers.has(name)) return null;
  return { kind: "header", name, reason: value ? "value" : "unsupported" };
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
