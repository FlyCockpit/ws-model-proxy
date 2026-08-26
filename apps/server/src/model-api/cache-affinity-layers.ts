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

export function asJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.map(asJson);
    return values.some((entry) => entry === undefined) ? undefined : (values as JsonValue[]);
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    const parsed = asJson(nested);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
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

function pushJson(units: JsonValue[], value: unknown) {
  const json = asJson(value);
  if (json !== undefined) units.push(json);
}

function extractTools(payload: Record<string, unknown>): {
  tools: JsonValue | undefined;
  consumed: boolean;
} {
  const tools = asJson(payload.tools);
  return { tools, consumed: tools !== undefined };
}

function extractChat(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  let isContinuation = false;
  if (Array.isArray(payload.messages)) {
    consumedKeys.push("messages");
    for (const item of payload.messages) {
      if (unitMarksContinuation(item)) isContinuation = true;
      if (INSTRUCTION_ROLES.has(objectRole(item) ?? "")) pushJson(instructionUnits, item);
      else pushJson(conversationUnits, item);
    }
  }
  const { tools, consumed } = extractTools(payload);
  if (consumed) consumedKeys.push("tools");
  return { instructionUnits, conversationUnits, tools, consumedKeys, isContinuation };
}

function extractAnthropic(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  let isContinuation = false;
  if (payload.system !== undefined) {
    consumedKeys.push("system");
    pushJson(instructionUnits, payload.system);
  }
  if (Array.isArray(payload.messages)) {
    consumedKeys.push("messages");
    for (const item of payload.messages) {
      if (unitMarksContinuation(item)) isContinuation = true;
      pushJson(conversationUnits, item);
    }
  }
  const { tools, consumed } = extractTools(payload);
  if (consumed) consumedKeys.push("tools");
  return { instructionUnits, conversationUnits, tools, consumedKeys, isContinuation };
}

function extractResponses(payload: Record<string, unknown>): AffinityLayers {
  const instructionUnits: JsonValue[] = [];
  const conversationUnits: JsonValue[] = [];
  const consumedKeys: string[] = [];
  let isContinuation = false;
  if (payload.instructions !== undefined) {
    consumedKeys.push("instructions");
    pushJson(instructionUnits, payload.instructions);
  }
  const input = payload.input;
  if (typeof input === "string") {
    consumedKeys.push("input");
    pushJson(conversationUnits, input);
  } else if (Array.isArray(input)) {
    consumedKeys.push("input");
    for (const item of input) {
      if (unitMarksContinuation(item)) isContinuation = true;
      if (INSTRUCTION_ROLES.has(objectRole(item) ?? "")) pushJson(instructionUnits, item);
      else pushJson(conversationUnits, item);
    }
  }
  const { tools, consumed } = extractTools(payload);
  if (consumed) consumedKeys.push("tools");
  return { instructionUnits, conversationUnits, tools, consumedKeys, isContinuation };
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
