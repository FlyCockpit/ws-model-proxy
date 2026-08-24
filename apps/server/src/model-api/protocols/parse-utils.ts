import type { CanonicalText, CanonicalTool, CanonicalToolChoice } from "./canonical.js";
import { invalid, unsupported } from "./errors.js";

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
