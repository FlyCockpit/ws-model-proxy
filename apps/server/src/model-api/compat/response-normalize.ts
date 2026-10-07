/**
 * Response normalization toward what the caller's protocol expects, for natively forwarded
 * Chat Completions and Anthropic Messages answers (adapted answers are rendered by the adapter
 * and are already standard). Pure functions plus a lenient SSE transform: an event that is not
 * JSON (`[DONE]`, comments, unknown fields) passes through byte for byte.
 */
import type { ReasoningFieldMode } from "@ws-model-proxy/api/lib/request-compat";

export type NormalizeOptions = {
  reasoningField: ReasoningFieldMode;
  stripNonStandard: boolean;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Chat Completions ──

const CHAT_FINISH: Record<string, string> = {
  stop: "stop",
  eos: "stop",
  eos_token: "stop",
  end_turn: "stop",
  stop_sequence: "stop",
  length: "length",
  max_tokens: "length",
  max_length: "length",
  model_length: "length",
  tool_calls: "tool_calls",
  tool_use: "tool_calls",
  function_call: "function_call",
  content_filter: "content_filter",
};

const CHAT_TOP = new Set([
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "system_fingerprint",
  "service_tier",
]);
const CHAT_CHOICE = new Set(["index", "message", "delta", "finish_reason", "logprobs"]);
const CHAT_MESSAGE = new Set([
  "role",
  "content",
  "refusal",
  "tool_calls",
  "function_call",
  "audio",
  "annotations",
  "reasoning",
  "reasoning_content",
]);
const CHAT_USAGE = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
]);

function keepOnly(value: Json, allowed: ReadonlySet<string>): boolean {
  let changed = false;
  for (const key of Object.keys(value))
    if (!allowed.has(key)) {
      delete value[key];
      changed = true;
    }
  return changed;
}

function reshapeReasoning(message: Json, mode: ReasoningFieldMode): boolean {
  if (mode === "auto") return false;
  const text =
    typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string"
        ? message.reasoning
        : undefined;
  const had = "reasoning_content" in message || "reasoning" in message;
  if (!had) return false;
  delete message.reasoning_content;
  delete message.reasoning;
  if (mode !== "strip" && text !== undefined) message[mode] = text;
  return true;
}

/** Normalizes one Chat Completions body or stream chunk in place; true when it changed. */
export function normalizeChatObject(body: Json, options: NormalizeOptions): boolean {
  let changed = false;
  if (options.stripNonStandard) changed = keepOnly(body, CHAT_TOP) || changed;
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!isObject(choice)) continue;
      if (typeof choice.finish_reason === "string") {
        const mapped = CHAT_FINISH[choice.finish_reason] ?? "stop";
        if (mapped !== choice.finish_reason) {
          choice.finish_reason = mapped;
          changed = true;
        }
      }
      if (options.stripNonStandard) changed = keepOnly(choice, CHAT_CHOICE) || changed;
      for (const key of ["message", "delta"]) {
        const message = choice[key];
        if (!isObject(message)) continue;
        changed = reshapeReasoning(message, options.reasoningField) || changed;
        if (options.stripNonStandard) changed = keepOnly(message, CHAT_MESSAGE) || changed;
      }
    }
  }
  if (options.stripNonStandard && isObject(body.usage))
    changed = keepOnly(body.usage, CHAT_USAGE) || changed;
  return changed;
}

// ── Anthropic Messages ──

const ANTHROPIC_STOP = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
]);
const ANTHROPIC_STOP_ALIASES: Record<string, string> = {
  stop: "end_turn",
  eos: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};
const ANTHROPIC_TOP = new Set([
  "id",
  "type",
  "role",
  "content",
  "model",
  "stop_reason",
  "stop_sequence",
  "usage",
  "container",
]);

function normalizeStopReason(holder: Json): boolean {
  const reason = holder.stop_reason;
  if (typeof reason !== "string" || ANTHROPIC_STOP.has(reason)) return false;
  holder.stop_reason = ANTHROPIC_STOP_ALIASES[reason] ?? "end_turn";
  return true;
}

/** A thinking block must carry a string signature for strict SDKs. */
function normalizeThinkingBlock(block: unknown): boolean {
  if (!isObject(block) || (block.type !== "thinking" && block.type !== "redacted_thinking"))
    return false;
  if (block.type === "thinking" && typeof block.signature !== "string") {
    block.signature = "";
    return true;
  }
  return false;
}

export type UsageEstimate = { inputTokens: number };

/** Normalizes one Messages body in place; true when it changed. */
export function normalizeMessagesObject(
  body: Json,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
): boolean {
  let changed = normalizeStopReason(body);
  if (Array.isArray(body.content))
    for (const block of body.content) changed = normalizeThinkingBlock(block) || changed;
  if (body.type === "message" && !isObject(body.usage) && estimate) {
    body.usage = { input_tokens: estimate.inputTokens, output_tokens: 0 };
    changed = true;
  }
  if (options.stripNonStandard && body.type === "message")
    changed = keepOnly(body, ANTHROPIC_TOP) || changed;
  return changed;
}

/** Normalizes one Messages stream event in place; true when it changed. */
export function normalizeMessagesEvent(
  event: Json,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
): boolean {
  let changed = false;
  if (event.type === "message_start" && isObject(event.message))
    changed = normalizeMessagesObject(event.message, options, estimate);
  if (event.type === "message_delta" && isObject(event.delta)) {
    changed = normalizeStopReason(event.delta) || changed;
    if (!isObject(event.usage)) {
      event.usage = { output_tokens: 0 };
      changed = true;
    }
  }
  if (event.type === "content_block_start")
    changed = normalizeThinkingBlock(event.content_block) || changed;
  return changed;
}

// ── Transforms ──

export type NormalizedSurface = "openai-chat" | "anthropic-messages";

function normalizeJson(
  surface: NormalizedSurface,
  value: unknown,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
  stream: boolean,
): boolean {
  if (!isObject(value)) return false;
  if (surface === "openai-chat") return normalizeChatObject(value, options);
  return stream
    ? normalizeMessagesEvent(value, options, estimate)
    : normalizeMessagesObject(value, options, estimate);
}

/** One SSE event block (without its blank-line terminator), normalized when it is JSON. */
export function normalizeSseEvent(
  block: string,
  surface: NormalizedSurface,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
): string {
  const lines = block.split("\n");
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length !== 1) return block;
  const data = dataLines[0]!.slice(5).trimStart();
  if (!data.startsWith("{")) return block;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return block;
  }
  if (!normalizeJson(surface, parsed, options, estimate, true)) return block;
  return lines
    .map((line) => (line.startsWith("data:") ? `data: ${JSON.stringify(parsed)}` : line))
    .join("\n");
}

const MAX_EVENT_BUFFER = 4 * 1024 * 1024;

/**
 * An SSE transform normalizing each JSON event. Bytes are re-emitted unchanged unless an event
 * changed; an oversized or undecodable buffer switches the rest of the stream to pass-through.
 */
export function createSseNormalizer(
  surface: NormalizedSurface,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  let buffer = "";
  let passThrough = false;
  const flushEvents = (controller: TransformStreamDefaultController<Uint8Array>) => {
    // Events end with a blank line; CRLF streams are normalized to LF in the events we touch.
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) return;
      const block = buffer.slice(0, match.index).replaceAll("\r\n", "\n");
      const terminator = match[0];
      buffer = buffer.slice(match.index + terminator.length);
      controller.enqueue(
        encoder.encode(`${normalizeSseEvent(block, surface, options, estimate)}${terminator}`),
      );
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (passThrough) {
        controller.enqueue(chunk);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      flushEvents(controller);
      if (buffer.length > MAX_EVENT_BUFFER) {
        passThrough = true;
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
    },
    flush(controller) {
      if (passThrough) return;
      buffer += decoder.decode();
      flushEvents(controller);
      if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
    },
  });
}

/** A whole JSON body, normalized (the input bytes when it is not a JSON object or unchanged). */
export function normalizeJsonBody(
  bytes: Uint8Array,
  surface: NormalizedSurface,
  options: NormalizeOptions,
  estimate: UsageEstimate | null,
): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return bytes;
  }
  if (!normalizeJson(surface, parsed, options, estimate, false)) return bytes;
  return new TextEncoder().encode(JSON.stringify(parsed));
}
