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
  return value.map((entry, index) => {
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
  if (choice.disable_parallel_tool_use === false)
    unsupported("tool_choice.disable_parallel_tool_use", "parallel calls are not safely adaptable");
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
    result.stop = values as string[];
  }
  return result;
}
