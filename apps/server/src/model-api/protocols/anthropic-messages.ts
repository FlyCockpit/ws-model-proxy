import { ADAPTER_VERSION, type CanonicalMessage, type CanonicalRequest } from "./canonical.js";
import { invalid, unsupported } from "./errors.js";
import {
  boolean,
  object,
  parseAnthropicToolChoice,
  parseTools,
  rejectUnknown,
  sampling,
  string,
  texts,
  validateBase64,
  validateToolChoice,
} from "./parse-utils.js";

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"] as const);

function blocks(value: unknown, parameter: string): CanonicalMessage["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) invalid(parameter, "must be text or an array");
  return value.map((entry, index) => {
    const block = object(entry, `${parameter}[${index}]`);
    if (block.type === "text") {
      rejectUnknown(block, ["type", "text"], `${parameter}[${index}]`);
      return { type: "text", text: string(block.text, `${parameter}[${index}].text`) };
    }
    if (block.type === "image") {
      rejectUnknown(block, ["type", "source"], `${parameter}[${index}]`);
      const source = object(block.source, `${parameter}[${index}].source`);
      rejectUnknown(source, ["type", "media_type", "data"], `${parameter}[${index}].source`);
      if (source.type !== "base64" || !MEDIA_TYPES.has(source.media_type as never))
        unsupported(`${parameter}[${index}].source`);
      return {
        type: "image",
        source: {
          kind: "base64",
          mediaType: source.media_type as "image/jpeg",
          data: validateBase64(source.data, `${parameter}[${index}].source.data`),
        },
      };
    }
    if (block.type === "tool_use") {
      rejectUnknown(block, ["type", "id", "name", "input"], `${parameter}[${index}]`);
      return {
        type: "tool_call",
        id: string(block.id, `${parameter}[${index}].id`),
        name: string(block.name, `${parameter}[${index}].name`),
        arguments: JSON.stringify(object(block.input, `${parameter}[${index}].input`)),
      };
    }
    if (block.type === "tool_result") {
      rejectUnknown(
        block,
        ["type", "tool_use_id", "content", "is_error"],
        `${parameter}[${index}]`,
      );
      if (block.is_error !== undefined && typeof block.is_error !== "boolean")
        invalid(`${parameter}[${index}].is_error`, "must be a boolean");
      if (Array.isArray(block.content) && block.content.length > 1)
        unsupported(
          `${parameter}[${index}].content`,
          "multiple tool-result blocks cannot be losslessly adapted",
        );
      return {
        type: "tool_result",
        toolCallId: string(block.tool_use_id, `${parameter}[${index}].tool_use_id`),
        content: texts(block.content ?? "", `${parameter}[${index}].content`),
        ...(block.is_error === true ? { isError: true } : {}),
      };
    }
    return unsupported(`${parameter}[${index}].type`);
  });
}

export function parseAnthropicMessagesRequest(input: unknown): CanonicalRequest {
  const body = object(input);
  rejectUnknown(
    body,
    [
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "stream",
      "temperature",
      "top_p",
      "stop_sequences",
      "max_tokens",
    ],
    "body",
  );
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) invalid("messages", "must be an array");
  if (body.max_tokens === undefined) invalid("max_tokens", "is required for Anthropic Messages");
  const messages = rawMessages.map((entry, sourceIndex): CanonicalMessage => {
    const message = object(entry, `messages[${sourceIndex}]`);
    rejectUnknown(message, ["role", "content"], `messages[${sourceIndex}]`);
    if (message.role !== "user" && message.role !== "assistant")
      invalid(`messages[${sourceIndex}].role`, "is unsupported");
    const parsedContent = blocks(message.content, `messages[${sourceIndex}].content`);
    if (message.role === "user" && parsedContent.some((part) => part.type === "tool_call"))
      unsupported(
        `messages[${sourceIndex}].content`,
        "tool_use blocks must have the assistant role",
      );
    if (
      message.role === "assistant" &&
      parsedContent.some((part) => part.type === "tool_result" || part.type === "image")
    )
      unsupported(
        `messages[${sourceIndex}].content`,
        "tool results and input images must have the user role",
      );
    return {
      role: message.role,
      content: parsedContent,
      boundary: { sourceIndex },
    };
  });
  const tools = parseTools(body.tools, "tools", "anthropic");
  if (tools.length && body.tool_choice === undefined)
    invalid("tool_choice", "must explicitly disable parallel tool use when tools are adapted");
  const toolChoice = parseAnthropicToolChoice(body.tool_choice);
  validateToolChoice(toolChoice, tools);
  validateMessageToolIds(messages);
  return {
    adapterVersion: ADAPTER_VERSION,
    source: "anthropic-messages",
    model: string(body.model, "model"),
    instructions:
      body.system === undefined
        ? []
        : [
            {
              role: "system",
              content: texts(body.system, "system"),
              boundary: { sourceIndex: -1 },
            },
          ],
    messages,
    tools,
    toolChoice,
    parallelToolCalls: "single",
    stream: boolean(body.stream, "stream"),
    sampling: sampling(body, "max_tokens"),
    limitations: [],
  };
}

function validateMessageToolIds(messages: readonly CanonicalMessage[]) {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") {
        if (calls.has(part.id)) invalid("messages.tool_use.id", "must be unique");
        calls.add(part.id);
      } else if (part.type === "tool_result") {
        if (results.has(part.toolCallId))
          invalid("messages.tool_result.tool_use_id", "must be unique");
        if (!calls.has(part.toolCallId))
          invalid("messages.tool_result.tool_use_id", "references an unknown tool use");
        results.add(part.toolCallId);
      }
    }
  }
}

export function renderAnthropicMessagesRequest(
  request: CanonicalRequest,
  model: string,
  options: { allowLossyInstructionRoleCollapse?: boolean } = {},
): Record<string, unknown> {
  const roles = new Set(request.instructions.map((item) => item.role));
  if (roles.has("developer") && !options.allowLossyInstructionRoleCollapse) {
    unsupported(
      "instructions",
      "mix system and developer roles; enable lossy instruction-role collapse explicitly",
    );
  }
  const system = request.instructions.flatMap((instruction) =>
    instruction.content.map((part) => ({ type: "text", text: part.text })),
  );
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) => {
      if (part.type === "text") return part;
      if (part.type === "image") {
        if (part.source.kind !== "base64")
          unsupported("messages.image", "remote images are not safely representable by Anthropic");
        return {
          type: "image",
          source: { type: "base64", media_type: part.source.mediaType, data: part.source.data },
        };
      }
      if (part.type === "tool_call")
        return {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: parseArguments(part.arguments, part.id),
        };
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      };
    }),
  }));
  return {
    model,
    messages,
    ...(system.length ? { system } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    ...(request.tools.length || request.toolChoice
      ? {
          tool_choice:
            request.toolChoice?.type === "tool"
              ? { type: "tool", name: request.toolChoice.name, disable_parallel_tool_use: true }
              : {
                  type:
                    request.toolChoice?.type === "required"
                      ? "any"
                      : (request.toolChoice?.type ?? "auto"),
                  disable_parallel_tool_use: true,
                },
        }
      : {}),
    stream: request.stream,
    ...(request.sampling.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling.stop ? { stop_sequences: request.sampling.stop } : {}),
    max_tokens: request.sampling.maxOutputTokens ?? 1024,
  };
}

function parseArguments(value: string, id: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value), `tool_call[${id}].arguments`);
  } catch {
    invalid(`tool_call[${id}].arguments`, "must be a complete JSON object");
  }
}
