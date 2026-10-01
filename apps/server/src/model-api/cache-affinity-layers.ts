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
      typeof entry === "number"
    ) {
      charge(Buffer.byteLength(JSON.stringify(entry)));
      return typeof entry === "number" && !Number.isFinite(entry) ? null : entry;
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

/** A request shares this counter across validation, extraction and serialization. */
export type CanonicalWork = { steps: number };
export const MAX_CANONICAL_STEPS = 8 * MAX_CANONICAL_BYTES;
export function visitCanonical(work: CanonicalWork) {
  if (work.steps >= MAX_CANONICAL_STEPS) throw new RangeError("Affinity work limit");
  work.steps++;
}

export class CanonicalSizeError extends Error {}

/** Sorted object keys, indexed arrays, and output bounded before each append. */
export function budgetedStableJson(
  value: unknown,
  maximumBytes = MAX_CANONICAL_BYTES,
  work: CanonicalWork = { steps: 0 },
): string {
  let bytes = 0;
  const pieces: string[] = [];
  const append = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes) throw new CanonicalSizeError("Affinity canonical size limit");
    pieces.push(text);
  };
  const quoted = (text: string, emit: (part: string) => void) => {
    emit('"');
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + 4096, text.length);
      // Never split a surrogate pair: chunking must preserve JSON.stringify bytes.
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      emit(JSON.stringify(text.slice(i, end)).slice(1, -1));
      i = end;
    }
    emit('"');
  };
  const write = (entry: unknown, depth: number) => {
    visitCanonical(work);
    // Synthetic root wrappers can add four levels to an accepted depth-128 payload.
    if (depth > MAX_CANONICAL_DEPTH + 4) throw new RangeError("Affinity canonical depth limit");
    if (typeof entry === "string") {
      quoted(entry, append);
      return;
    }
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") {
      append(JSON.stringify(entry));
      return;
    }
    if (typeof entry !== "object") throw new TypeError("Non-JSON affinity value");
    if (Array.isArray(entry)) {
      append("[");
      for (let i = 0; i < entry.length; i++) {
        if (i) append(",");
        write(entry[i], depth + 1);
      }
      append("]");
      return;
    }
    // Gather only keys whose minimum encoded cost still fits, before sorting.
    const keys: string[] = [];
    let keyBytes = 2;
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      visitCanonical(work);
      quoted(key, (part) => {
        keyBytes += Buffer.byteLength(part);
        if (bytes + keyBytes > maximumBytes)
          throw new CanonicalSizeError("Affinity canonical size limit");
      });
      keyBytes += 2; // colon and at least one value byte (commas charged below)
      if (keys.length) keyBytes++;
      if (bytes + keyBytes > maximumBytes)
        throw new CanonicalSizeError("Affinity canonical size limit");
      keys.push(key);
    }
    keys.sort();
    append("{");
    for (let i = 0; i < keys.length; i++) {
      if (i) append(",");
      const key = keys[i]!;
      quoted(key, append);
      append(":");
      write((entry as Record<string, unknown>)[key], depth + 1);
    }
    append("}");
  };
  write(value, 0);
  return pieces.join("");
}

export function stableJson(value: JsonValue): string {
  return budgetedStableJson(value);
}

/** Only the leading instruction prefix can move out of the ordered wire history. */
function* orderedUnits(
  units: unknown[],
  layer: "instructions" | "conversation",
  work?: CanonicalWork,
) {
  let leading = true;
  for (const unit of units) {
    if (work) visitCanonical(work);
    leading &&= INSTRUCTION_ROLES.has(objectRole(unit) ?? "");
    if (layer === "instructions") {
      if (!leading) return;
      yield unit;
    } else if (!leading) yield unit;
  }
}

/** Raw iterators avoid copying or converting the conversation before budgeting it. */
export function rawAffinityLayers(
  surface: string | null,
  payload: Record<string, unknown>,
  work: CanonicalWork,
) {
  const chat = surface === "openai-chat";
  const responses = surface === "openai-responses";
  const units = responses ? payload.input : payload.messages;
  const consumedKeys: string[] = [];
  if (Array.isArray(units) || (responses && typeof units === "string"))
    consumedKeys.push(responses ? "input" : "messages");
  const topInstruction = responses ? "instructions" : "system";
  if (!chat && payload[topInstruction] !== undefined) consumedKeys.push(topInstruction);
  if (responses && payload.previous_response_id !== undefined)
    consumedKeys.push("previous_response_id");
  if (payload.tools !== undefined) consumedKeys.push("tools");
  if (chat && payload.functions !== undefined) consumedKeys.push("functions");
  const tools =
    chat && payload.functions !== undefined
      ? { tools: payload.tools ?? null, functions: payload.functions }
      : payload.tools;
  function* instructions() {
    if (!chat && payload[topInstruction] !== undefined) yield payload[topInstruction];
    if ((chat || responses) && Array.isArray(units)) {
      yield* orderedUnits(units, "instructions", work);
    }
  }
  function* conversation() {
    if (responses && typeof units === "string") yield units;
    if (Array.isArray(units)) {
      if (chat || responses) yield* orderedUnits(units, "conversation", work);
      else
        for (const unit of units) {
          visitCanonical(work);
          yield unit;
        }
    }
  }
  return { instructions, conversation, tools, consumedKeys };
}

export function continuationEvidence(units: Iterable<unknown>, work: CanonicalWork): boolean {
  let sawUser = false;
  for (const unit of units) {
    visitCanonical(work);
    const item = object(unit);
    if (sawUser && item) {
      if (
        CONTINUATION_ROLES.has(normalizedType(item.role) ?? "") ||
        typeMarksContinuation(normalizedType(item.type))
      )
        return true;
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          visitCanonical(work);
          if (typeMarksContinuation(normalizedType(object(block)?.type))) return true;
        }
      }
    }
    if (objectRole(unit) === "user") sawUser = true;
  }
  return false;
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
  const json = asJson(value, MAX_CANONICAL_BYTES);
  if (json !== undefined) units.push(json);
}

function extractTools(payload: Record<string, unknown>): {
  tools: JsonValue | undefined;
  consumed: boolean;
} {
  const tools = asJson(payload.tools, MAX_CANONICAL_BYTES);
  return { tools, consumed: tools !== undefined };
}

function extractChat(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  if (Array.isArray(payload.messages)) {
    consumedKeys.push("messages");
    for (const item of orderedUnits(payload.messages, "instructions"))
      pushJson(instructionUnits, item);
    for (const item of orderedUnits(payload.messages, "conversation"))
      pushJson(conversationUnits, item);
  }
  const extracted = extractTools(payload);
  const functions = asJson(payload.functions, MAX_CANONICAL_BYTES);
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
    for (const item of orderedUnits(input, "instructions")) pushJson(instructionUnits, item);
    for (const item of orderedUnits(input, "conversation")) pushJson(conversationUnits, item);
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
