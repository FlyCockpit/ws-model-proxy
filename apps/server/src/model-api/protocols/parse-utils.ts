import type {
  CanonicalText,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalUsage,
  ProtocolSurface,
} from "./canonical.js";
import { AdapterError, invalid, unsupported } from "./errors.js";

export function object(value: unknown, parameter = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(parameter, "must be an object");
  return value as Record<string, unknown>;
}

export function string(value: unknown, parameter: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(parameter, "must be a non-empty string");
  return value;
}

export function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
) {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown)
    unsupported(`${path}.${unknown}`, "has unknown semantics and is not safely adaptable");
}

const MAX_LOGGED_FIELDS = 10;
const MAX_LOGGED_FIELD_CHARS = 64;

/**
 * Drop envelope keys that are not allowlisted. Log names only, and only when
 * one was ignored. Names come from upstream, so the log holds at most
 * MAX_LOGGED_FIELDS names of MAX_LOGGED_FIELD_CHARS each plus an omitted count.
 */
export function ignoreUnknownEnvelopeFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  seen?: Set<string>,
) {
  const set = new Set(allowed);
  const fields = Object.keys(value)
    .filter((key) => !set.has(key))
    .map((key) => key.slice(0, MAX_LOGGED_FIELD_CHARS));
  const fresh = [...new Set(fields)].filter((field) => {
    if (!seen) return true;
    const key = `${path}\0${field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  const logged = fresh.slice(0, MAX_LOGGED_FIELDS);
  const omitted = fresh.length - logged.length;
  console.debug("[model-api] ignored upstream envelope fields", {
    path,
    fields: logged,
    ...(omitted > 0 ? { omitted } : {}),
  });
}

const chatEnvelopeNullFields = [
  "prompt_logprobs",
  "prompt_token_ids",
  "prompt_text",
  "kv_transfer_params",
  "ec_transfer_params",
  "metrics",
] as const;

const chatChoiceNullFields = ["token_ids", "routed_experts"] as const;

function acceptNullOnly(value: Record<string, unknown>, path: string, fields: readonly string[]) {
  for (const field of fields) if (value[field] != null) unsupported(`${path}.${field}`);
}

/**
 * Chat envelope fields that carry no cross-protocol answer. Null means absent.
 * Unknown keys are ignored.
 */
export function acceptChatEnvelopeExtras(
  body: Record<string, unknown>,
  path: string,
  mode: "final" | "chunk",
  seen?: Set<string>,
) {
  ignoreUnknownEnvelopeFields(
    body,
    [
      "id",
      "object",
      "created",
      "model",
      "choices",
      "usage",
      "system_fingerprint",
      ...(mode === "final" ? (["service_tier"] as const) : []),
      ...chatEnvelopeNullFields,
    ],
    path,
    seen,
  );
  acceptNullOnly(body, path, chatEnvelopeNullFields);
}

/**
 * `stop_reason` on a chat choice is an internal token id, not a protocol stop
 * reason, so any value is ignored. `token_ids` and `routed_experts` are absent
 * only when null. Other unknown choice keys are ignored.
 */
export function acceptChatChoiceExtras(
  choice: Record<string, unknown>,
  path: string,
  contentKey: "message" | "delta",
  seen?: Set<string>,
) {
  ignoreUnknownEnvelopeFields(
    choice,
    ["index", contentKey, "finish_reason", "logprobs", "stop_reason", ...chatChoiceNullFields],
    path,
    seen,
  );
  acceptNullOnly(choice, path, chatChoiceNullFields);
}

const chatMessageFields = [
  "role",
  "content",
  "refusal",
  "tool_calls",
  "annotations",
  "audio",
  "function_call",
  "reasoning",
  "reasoning_content",
] as const;

// Null audio, a null function_call, and empty annotations are absence.
// `reasoning` and `reasoning_content` are omitted. A final message or completed
// stream whose only visible text is either field still fails.
export function acceptChatMessageExtras(
  message: Record<string, unknown>,
  path: string,
  mode: "final" | "delta",
): { droppedReasoningText: boolean } {
  rejectUnknown(message, chatMessageFields, path);
  if (message.audio !== undefined && message.audio !== null) unsupported(`${path}.audio`);
  if (message.function_call !== undefined && message.function_call !== null)
    unsupported(`${path}.function_call`);
  if (message.annotations !== undefined && message.annotations !== null) {
    if (!Array.isArray(message.annotations))
      invalid(`${path}.annotations`, "must be an array or null");
    if (message.annotations.length)
      unsupported(`${path}.annotations`, "citations are not safely adaptable");
  }
  const dropped: Array<"reasoning" | "reasoning_content"> = [];
  for (const field of ["reasoning", "reasoning_content"] as const) {
    const reasoning = message[field];
    if (reasoning === undefined || reasoning === null || reasoning === "") continue;
    if (typeof reasoning !== "string") invalid(`${path}.${field}`, "must be text or null");
    dropped.push(field);
  }
  const droppedField = dropped[0];
  if (mode === "final" && droppedField) {
    const hasContent = typeof message.content === "string" && message.content.length > 0;
    const hasRefusal = typeof message.refusal === "string" && message.refusal.length > 0;
    const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasRefusal && !hasTools)
      unsupported(`${path}.${droppedField}`, "is the only visible text");
  }
  return { droppedReasoningText: droppedField !== undefined };
}

type UsageFields = {
  input: string;
  output: string;
  total?: string;
  /**
   * Input counts the surface reports outside `input` (Anthropic cache read and
   * write). Canonical input adds them so it always means every input token
   * processed, as OpenAI `prompt_tokens` and Responses `input_tokens` do.
   */
  inputParts: readonly string[];
  /** Known counts the protocol allows to be null. Null means absent. */
  nullable: readonly string[];
  /** Known detail objects (null means absent) and the counts validated inside. */
  details: Readonly<Record<string, readonly string[]>>;
};

const usageFields: Record<ProtocolSurface, UsageFields> = {
  "openai-chat": {
    input: "prompt_tokens",
    output: "completion_tokens",
    total: "total_tokens",
    inputParts: [],
    nullable: [],
    details: {
      prompt_tokens_details: ["cached_tokens", "audio_tokens"],
      completion_tokens_details: [
        "reasoning_tokens",
        "audio_tokens",
        "accepted_prediction_tokens",
        "rejected_prediction_tokens",
      ],
    },
  },
  "openai-responses": {
    input: "input_tokens",
    output: "output_tokens",
    total: "total_tokens",
    inputParts: [],
    nullable: [],
    details: {
      input_tokens_details: ["cached_tokens"],
      output_tokens_details: ["reasoning_tokens"],
    },
  },
  "anthropic-messages": {
    // Anthropic `input_tokens` excludes cache reads and writes.
    input: "input_tokens",
    output: "output_tokens",
    inputParts: ["cache_creation_input_tokens", "cache_read_input_tokens"],
    // Streamed `message_delta` usage may carry null input and cache counts.
    nullable: ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"],
    details: { cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] },
  },
};

function usageCount(
  source: Record<string, unknown>,
  key: string,
  path: string,
  nullable: boolean,
): number | undefined {
  const value = source[key];
  if (value === undefined || (value === null && nullable)) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterError(
      "invalid_usage",
      `${path}.${key} must be a non-negative integer.`,
      `${path}.${key}`,
    );
  return value;
}

function usageObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AdapterError("invalid_usage", `${path} must be an object.`, path);
  return value as Record<string, unknown>;
}

/** Validated counts from one usage object. Undefined means absent or null. */
export type ProtocolUsageCounts = {
  input?: number;
  output?: number;
  /** The surface's separately reported input counts, by field name. */
  inputParts: Record<string, number | undefined>;
};

/**
 * Validates one usage object. Known counts use the surface's fixed names and
 * must be non-negative safe integers. `total_tokens` is type-checked but not
 * reconciled: vendors differ on whether it counts reasoning, and it is never
 * carried canonically. Unknown keys, at the top level or inside a known detail
 * object, are ignored: they carry no answer text. `required` names which of
 * input and output must be present.
 */
export function parseProtocolUsageCounts(
  value: unknown,
  surface: ProtocolSurface,
  path: string,
  required: "both" | "any",
): ProtocolUsageCounts | undefined {
  if (value === undefined || value === null) return undefined;
  const fields = usageFields[surface];
  const usage = usageObject(value, path);
  const nullable = new Set(fields.nullable);
  const input = usageCount(usage, fields.input, path, nullable.has(fields.input));
  const output = usageCount(usage, fields.output, path, nullable.has(fields.output));
  const inputParts: Record<string, number | undefined> = {};
  for (const key of fields.inputParts)
    inputParts[key] = usageCount(usage, key, path, nullable.has(key));
  if (fields.total) usageCount(usage, fields.total, path, false);
  for (const [key, counts] of Object.entries(fields.details)) {
    if (usage[key] === undefined || usage[key] === null) continue;
    const details = usageObject(usage[key], `${path}.${key}`);
    for (const count of counts) usageCount(details, count, `${path}.${key}`, false);
  }
  if (
    (required === "both" && (input === undefined || output === undefined)) ||
    (input === undefined && output === undefined)
  )
    throw new AdapterError("invalid_usage", `${path} is missing required token counts.`, path);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    inputParts,
  };
}

/**
 * Canonical usage from validated counts: input is every input token processed
 * (the surface's input plus its separate input parts; an absent part is 0).
 * Undefined input stays undefined.
 */
export function canonicalUsageFromCounts(
  counts: ProtocolUsageCounts,
  path: string,
): CanonicalUsage {
  const input =
    counts.input === undefined
      ? undefined
      : Object.values(counts.inputParts).reduce<number>(
          (sum, part) => sum + (part ?? 0),
          counts.input,
        );
  if (
    (input !== undefined && !Number.isSafeInteger(input)) ||
    (input !== undefined &&
      counts.output !== undefined &&
      !Number.isSafeInteger(input + counts.output))
  )
    throw new AdapterError("invalid_usage", `${path} token counts overflow.`, path);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(counts.output !== undefined ? { outputTokens: counts.output } : {}),
  };
}

/** The shared usage parser for one self-contained usage object. */
export function parseProtocolUsage(
  value: unknown,
  surface: ProtocolSurface,
  path: string,
  required: "both" | "any",
): CanonicalUsage | undefined {
  const counts = parseProtocolUsageCounts(value, surface, path, required);
  return counts ? canonicalUsageFromCounts(counts, path) : undefined;
}

export function texts(value: unknown, parameter: string): CanonicalText[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) invalid(parameter, "must be text or an array of text blocks");
  return value.map((entry, index) => {
    const block = object(entry, `${parameter}[${index}]`);
    rejectUnknown(block, ["type", "text"], `${parameter}[${index}]`);
    if (block.type !== "text") unsupported(`${parameter}[${index}].type`);
    return { type: "text", text: string(block.text, `${parameter}[${index}].text`) };
  });
}

export function parseTools(
  value: unknown,
  parameter: string,
  shape: "openai-chat" | "openai-responses" | "anthropic",
): CanonicalTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(parameter, "must be an array");
  const tools = value.map((entry, index) => {
    let tool = object(entry, `${parameter}[${index}]`);
    if (shape === "openai-chat") {
      rejectUnknown(tool, ["type", "function"], `${parameter}[${index}]`);
      if (tool.type !== "function")
        unsupported(`${parameter}[${index}].type`, "must be a client-defined function");
      tool = object(tool.function, `${parameter}[${index}].function`);
    } else if (shape === "openai-responses") {
      rejectUnknown(
        tool,
        ["type", "name", "description", "parameters", "strict"],
        `${parameter}[${index}]`,
      );
      if (tool.type !== "function")
        unsupported(`${parameter}[${index}].type`, "must be a client-defined function");
    }
    rejectUnknown(
      tool,
      [
        ...(shape === "openai-responses" ? ["type"] : []),
        "name",
        "description",
        "parameters",
        "input_schema",
        "strict",
      ],
      `${parameter}[${index}]`,
    );
    if (tool.strict !== undefined && typeof tool.strict !== "boolean")
      invalid(`${parameter}[${index}].strict`, "must be a boolean");
    if (tool.strict === true)
      unsupported(`${parameter}[${index}].strict`, "structured output is not safely adaptable");
    if (tool.description !== undefined && typeof tool.description !== "string")
      invalid(`${parameter}[${index}].description`, "must be text");
    const schema = object(
      tool.parameters ?? tool.input_schema,
      `${parameter}[${index}].input_schema`,
    );
    return {
      name: string(tool.name, `${parameter}[${index}].name`),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: schema,
    };
  });
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (names.has(tool.name)) invalid(`${parameter}[${index}].name`, "must be unique");
    names.add(tool.name);
  }
  return tools;
}

export function validateToolChoice(
  choice: CanonicalToolChoice | undefined,
  tools: readonly CanonicalTool[],
) {
  if (!choice) return;
  if (tools.length === 0 && choice.type !== "none")
    invalid("tool_choice", "requires at least one declared tool");
  if (choice.type === "tool" && !tools.some((tool) => tool.name === choice.name))
    invalid("tool_choice", `references undeclared tool ${choice.name}`);
}

export function boolean(value: unknown, parameter: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") invalid(parameter, "must be a boolean");
  return value;
}

export function parseOpenAiToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none" || value === "required") return { type: value };
  const choice = object(value, "tool_choice");
  rejectUnknown(choice, ["type", "function"], "tool_choice");
  if (choice.type !== "function") unsupported("tool_choice.type");
  const fn = object(choice.function, "tool_choice.function");
  rejectUnknown(fn, ["name"], "tool_choice.function");
  return { type: "tool", name: string(fn.name, "tool_choice.function.name") };
}

export function parseAnthropicToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined) return undefined;
  const choice = object(value, "tool_choice");
  rejectUnknown(choice, ["type", "name", "disable_parallel_tool_use"], "tool_choice");
  if (choice.disable_parallel_tool_use !== true)
    unsupported(
      "tool_choice.disable_parallel_tool_use",
      "must be true to opt into safe single-call adaptation",
    );
  if (choice.type !== "tool" && choice.name !== undefined)
    invalid("tool_choice.name", "is only valid for a named tool choice");
  if (choice.type === "auto" || choice.type === "none" || choice.type === "any")
    return { type: choice.type === "any" ? "required" : choice.type };
  if (choice.type === "tool")
    return { type: "tool", name: string(choice.name, "tool_choice.name") };
  invalid("tool_choice.type", "is invalid");
}

export function sampling(
  body: Record<string, unknown>,
  maxKey: "max_tokens" | "max_output_tokens",
) {
  const result: { temperature?: number; topP?: number; stop?: string[]; maxOutputTokens?: number } =
    {};
  for (const [input, output] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
  ] as const) {
    if (body[input] !== undefined) {
      if (typeof body[input] !== "number" || !Number.isFinite(body[input]))
        invalid(input, "must be finite");
      if ((body[input] as number) < 0 || (body[input] as number) > 1)
        invalid(input, "must be within the cross-protocol range 0 through 1");
      result[output] = body[input];
    }
  }
  if (body[maxKey] !== undefined) {
    if (!Number.isInteger(body[maxKey]) || (body[maxKey] as number) <= 0)
      invalid(maxKey, "must be a positive integer");
    result.maxOutputTokens = body[maxKey] as number;
  }
  const rawStop = body.stop ?? body.stop_sequences;
  if (rawStop !== undefined) {
    const values = typeof rawStop === "string" ? [rawStop] : rawStop;
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string"))
      invalid("stop", "must contain strings");
    if (values.length === 0 || values.length > 4)
      invalid("stop", "must contain between 1 and 4 strings");
    if (values.some((item) => item.length === 0 || new TextEncoder().encode(item).byteLength > 256))
      invalid("stop", "must contain non-empty strings no larger than 256 bytes");
    result.stop = values as string[];
  }
  return result;
}

const SAFE_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function parseImageUrl(value: unknown, parameter: string, detail?: unknown) {
  const url = string(value, parameter);
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high")
    invalid(`${parameter}.detail`, "is invalid");
  if (url.startsWith("https://"))
    return { kind: "url" as const, url, ...(detail ? { detail: detail as "auto" } : {}) };
  if (detail !== undefined)
    unsupported(`${parameter}.detail`, "cannot be preserved for base64 images");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || !SAFE_IMAGE_MIME.has(match[1] ?? ""))
    unsupported(parameter, "must be HTTPS or base64 JPEG, PNG, GIF, or WebP");
  const data = match[2] ?? "";
  if (data.length === 0 || data.length % 4 !== 0) invalid(parameter, "contains invalid base64");
  return { kind: "base64" as const, mediaType: match[1] as "image/jpeg", data };
}

export function validateBase64(value: unknown, parameter: string): string {
  const data = string(value, parameter);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    invalid(parameter, "must be valid base64");
  return data;
}
