export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AffinityProtocolSurface = "openai-chat" | "openai-responses" | "anthropic-messages";

export type AffinityLayers = {
  instructionUnits: JsonValue[];
  conversationUnits: JsonValue[];
  tools: JsonValue | undefined;
  consumedKeys: string[];
  isContinuation: boolean;
};

const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const CONTINUATION_ROLES = new Set(["assistant", "tool", "function"]);
const CONTINUATION_BLOCK_TYPES = new Set(["tool_use", "tool_result"]);

export function canonicalizeAffinitySurface(surface: string): AffinityProtocolSurface | null {
  if (surface === "openai-chat" || surface === "OPENAI_CHAT_COMPLETIONS") return "openai-chat";
  if (surface === "openai-responses" || surface === "OPENAI_RESPONSES") return "openai-responses";
  if (surface === "anthropic-messages" || surface === "ANTHROPIC_MESSAGES")
    return "anthropic-messages";
  return null;
}

// Request root is depth 0; each property or array entry adds one level.
export const MAX_CANONICAL_DEPTH = 128;
export const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;

/** Depth/errors reject atomically. The default byte budget bounds individual layers. */
export function asJson(value: unknown, maximumBytes = MAX_CANONICAL_BYTES): JsonValue | undefined {
  let bytes = 0;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > maximumBytes) throw new RangeError("Affinity canonical size limit");
  };
  const convert = (entry: unknown, depth: number): JsonValue | undefined => {
    if (depth > MAX_CANONICAL_DEPTH) throw new RangeError("Affinity canonical depth limit");
    if (
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "string" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      charge(Buffer.byteLength(JSON.stringify(entry)));
      return entry;
    }
    if (typeof entry !== "object") return undefined;
    charge(2);
    if (Array.isArray(entry)) {
      const result: JsonValue[] = [];
      for (const nested of entry) {
        const parsed = convert(nested, depth + 1);
        if (parsed === undefined) return undefined;
        if (result.length) charge(1);
        result.push(parsed);
      }
      return result;
    }
    const result: Record<string, JsonValue> = Object.create(null);
    let count = 0;
    for (const key of Object.keys(entry)) {
      charge(Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
      const parsed = convert((entry as Record<string, unknown>)[key], depth + 1);
      if (parsed !== undefined)
        Object.defineProperty(result, key, {
          value: parsed,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result;
  };
  try {
    return convert(value, 0);
  } catch {
    return undefined;
  }
}

/** Serialize own keys only; iterative traversal also handles synthetic layer wrappers. */
export function stableJson(value: JsonValue): string {
  const pieces: string[] = [];
  const pending: Array<{ value: JsonValue } | { text: string }> = [{ value }];
  while (pending.length) {
    const item = pending.pop()!;
    if ("text" in item) {
      pieces.push(item.text);
      continue;
    }
    const entry = item.value;
    if (entry === null || typeof entry !== "object") {
      pieces.push(JSON.stringify(entry));
      continue;
    }
    const array = Array.isArray(entry);
    const keys = Object.keys(entry).sort();
    pieces.push(array ? "[" : "{");
    pending.push({ text: array ? "]" : "}" });
    const count = array ? entry.length : keys.length;
    for (let i = count - 1; i >= 0; i--) {
      if (i < count - 1) pending.push({ text: "," });
      const key = keys[i]!;
      pending.push({ value: array ? entry[i]! : entry[key]! });
      if (!array) pending.push({ text: `${JSON.stringify(key)}:` });
    }
  }
  return pieces.join("");
}

function emptyLayers(): AffinityLayers {
  return {
    instructionUnits: [],
    conversationUnits: [],
    tools: undefined,
    consumedKeys: [],
    isContinuation: false,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedType(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function objectRole(value: unknown): string | undefined {
  return normalizedType(object(value)?.role);
}

function typeMarksContinuation(type: string | undefined): boolean {
  if (!type) return false;
  if (type === "reasoning" || CONTINUATION_BLOCK_TYPES.has(type)) return true;
  return type.endsWith("_call") || type.endsWith("_call_output");
}

function unitMarksContinuation(value: unknown): boolean {
  const item = object(value);
  if (!item) return false;
  if (CONTINUATION_ROLES.has(normalizedType(item.role) ?? "")) return true;
  if (typeMarksContinuation(normalizedType(item.type))) return true;
  if (!Array.isArray(item.content)) return false;
  return item.content.some((block) => typeMarksContinuation(normalizedType(object(block)?.type)));
}

/** Leading assistant/tool units are starter context, not conversation evidence. */
function hasContinuationEvidence(units: JsonValue[]): boolean {
  let sawUser = false;
  for (const unit of units) {
    if (sawUser && unitMarksContinuation(unit)) return true;
    if (objectRole(unit) === "user") sawUser = true;
  }
  return false;
}

function pushJson(units: JsonValue[], value: unknown) {
  const json = asJson(value, Number.POSITIVE_INFINITY);
  if (json !== undefined) units.push(json);
}

function extractTools(payload: Record<string, unknown>): {
  tools: JsonValue | undefined;
  consumed: boolean;
} {
  const tools = asJson(payload.tools, Number.POSITIVE_INFINITY);
  return { tools, consumed: tools !== undefined };
}

function extractChat(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  if (Array.isArray(payload.messages)) {
    consumedKeys.push("messages");
    for (const item of payload.messages) {
      if (INSTRUCTION_ROLES.has(objectRole(item) ?? "")) pushJson(instructionUnits, item);
      else pushJson(conversationUnits, item);
    }
  }
  const extracted = extractTools(payload);
  const functions = asJson(payload.functions, Number.POSITIVE_INFINITY);
  const tools =
    functions === undefined ? extracted.tools : { tools: extracted.tools ?? null, functions };
  if (extracted.consumed) consumedKeys.push("tools");
  if (functions !== undefined) consumedKeys.push("functions");
  return {
    instructionUnits,
    conversationUnits,
    tools,
    consumedKeys,
    isContinuation: hasContinuationEvidence(conversationUnits),
  };
}

function extractAnthropic(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  if (payload.system !== undefined) {
    consumedKeys.push("system");
    pushJson(instructionUnits, payload.system);
  }
  if (Array.isArray(payload.messages)) {
    consumedKeys.push("messages");
    for (const item of payload.messages) {
      pushJson(conversationUnits, item);
    }
  }
  const { tools, consumed } = extractTools(payload);
  if (consumed) consumedKeys.push("tools");
  return {
    instructionUnits,
    conversationUnits,
    tools,
    consumedKeys,
    isContinuation: hasContinuationEvidence(conversationUnits),
  };
}

function extractResponses(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  if (payload.instructions !== undefined) {
    consumedKeys.push("instructions");
    pushJson(instructionUnits, payload.instructions);
  }
  if (payload.previous_response_id !== undefined) consumedKeys.push("previous_response_id");
  const input = payload.input;
  if (typeof input === "string") {
    consumedKeys.push("input");
    pushJson(conversationUnits, input);
  } else if (Array.isArray(input)) {
    consumedKeys.push("input");
    for (const item of input) {
      if (INSTRUCTION_ROLES.has(objectRole(item) ?? "")) pushJson(instructionUnits, item);
      else pushJson(conversationUnits, item);
    }
  }
  const { tools, consumed } = extractTools(payload);
  if (consumed) consumedKeys.push("tools");
  return {
    instructionUnits,
    conversationUnits,
    tools,
    consumedKeys,
    isContinuation: hasContinuationEvidence(conversationUnits),
  };
}

/**
 * Tolerant Chat / Anthropic / Responses split for cache-affinity routing.
 * Unknown fields, extra keys, and non-strict payloads never throw.
 */
export function extractAffinityLayers(
  surface: string | null | undefined,
  payload: Record<string, unknown>,
): AffinityLayers {
  try {
    const canonical = typeof surface === "string" ? canonicalizeAffinitySurface(surface) : null;
    if (!canonical) return emptyLayers();
    if (canonical === "openai-chat") return extractChat(payload);
    if (canonical === "anthropic-messages") return extractAnthropic(payload);
    return extractResponses(payload);
  } catch {
    return emptyLayers();
  }
}
