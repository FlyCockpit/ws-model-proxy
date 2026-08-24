import {
  ADAPTER_VERSION,
  type CanonicalContent,
  type CanonicalMessage,
  type CanonicalRequest,
} from "./canonical.js";
import { invalid, unsupported } from "./errors.js";
import {
  object,
  parseOpenAiToolChoice,
  parseTools,
  rejectUnknown,
  sampling,
  string,
  texts,
} from "./parse-utils.js";

const ROOT_KEYS = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "temperature",
  "top_p",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "user",
  "seed",
  "stream_options",
] as const;

function content(value: unknown, parameter: string): CanonicalContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) invalid(parameter, "must be text or an array");
  return value.map((entry, index) => {
    const block = object(entry, `${parameter}[${index}]`);
    if (block.type === "text") {
      rejectUnknown(block, ["type", "text"], `${parameter}[${index}]`);
      return { type: "text", text: string(block.text, `${parameter}[${index}].text`) };
    }
    if (block.type === "image_url") {
      rejectUnknown(block, ["type", "image_url"], `${parameter}[${index}]`);
      const image = object(block.image_url, `${parameter}[${index}].image_url`);
      rejectUnknown(image, ["url", "detail"], `${parameter}[${index}].image_url`);
      const url = string(image.url, `${parameter}[${index}].image_url.url`);
      if (!url.startsWith("https://") && !url.startsWith("data:image/"))
        unsupported(`${parameter}[${index}].image_url.url`);
      if (url.startsWith("data:"))
        unsupported(
          `${parameter}[${index}].image_url.url`,
          "inline OpenAI image URLs require a lossless media decoder",
        );
      const detail = image.detail;
      if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high")
        invalid(`${parameter}[${index}].image_url.detail`, "is invalid");
      return { type: "image", source: { kind: "url", url, ...(detail ? { detail } : {}) } };
    }
    return unsupported(`${parameter}[${index}].type`);
  });
}

export function parseOpenAiChatRequest(input: unknown): CanonicalRequest {
  const body = object(input);
  rejectUnknown(body, ROOT_KEYS, "body");
  if (body.n !== undefined && body.n !== 1)
    unsupported("n", "multiple candidates are not safely adaptable");
  if (body.seed !== undefined) unsupported("seed");
  if (body.user !== undefined)
    unsupported("user", "provider-side persisted identifiers are not adaptable");
  if (body.stream_options !== undefined) unsupported("stream_options");
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    invalid("max_tokens", "conflicts with max_completion_tokens");
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) invalid("messages", "must be an array");
  const instructions: CanonicalRequest["instructions"] = [];
  const messages: CanonicalMessage[] = [];
  rawMessages.forEach((entry, sourceIndex) => {
    const message = object(entry, `messages[${sourceIndex}]`);
    rejectUnknown(
      message,
      ["role", "content", "name", "tool_calls", "tool_call_id", "refusal"],
      `messages[${sourceIndex}]`,
    );
    if (message.name !== undefined || message.refusal !== undefined)
      unsupported(`messages[${sourceIndex}]`);
    const boundary = { sourceIndex };
    if (message.role === "system" || message.role === "developer") {
      if (message.tool_calls !== undefined || message.tool_call_id !== undefined)
        unsupported(`messages[${sourceIndex}]`);
      instructions.push({
        role: message.role,
        content: texts(message.content, `messages[${sourceIndex}].content`),
        boundary,
      });
      return;
    }
    if (message.role === "tool") {
      rejectUnknown(message, ["role", "content", "tool_call_id"], `messages[${sourceIndex}]`);
      messages.push({
        role: "user",
        boundary,
        content: [
          {
            type: "tool_result",
            toolCallId: string(message.tool_call_id, `messages[${sourceIndex}].tool_call_id`),
            content: texts(message.content, `messages[${sourceIndex}].content`),
          },
        ],
      });
      return;
    }
    if (message.role !== "user" && message.role !== "assistant")
      invalid(`messages[${sourceIndex}].role`, "is unsupported");
    const parts: CanonicalMessage["content"] =
      message.content == null ? [] : content(message.content, `messages[${sourceIndex}].content`);
    if (message.tool_call_id !== undefined) unsupported(`messages[${sourceIndex}].tool_call_id`);
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
        invalid(`messages[${sourceIndex}].tool_calls`, "is invalid");
      for (const [toolIndex, rawCall] of message.tool_calls.entries()) {
        const call = object(rawCall, `messages[${sourceIndex}].tool_calls[${toolIndex}]`);
        rejectUnknown(
          call,
          ["id", "type", "function"],
          `messages[${sourceIndex}].tool_calls[${toolIndex}]`,
        );
        if (call.type !== "function")
          unsupported(`messages[${sourceIndex}].tool_calls[${toolIndex}].type`);
        const fn = object(
          call.function,
          `messages[${sourceIndex}].tool_calls[${toolIndex}].function`,
        );
        rejectUnknown(
          fn,
          ["name", "arguments"],
          `messages[${sourceIndex}].tool_calls[${toolIndex}].function`,
        );
        parts.push({
          type: "tool_call",
          id: string(call.id, "tool_call.id"),
          name: string(fn.name, "tool_call.function.name"),
          arguments: string(fn.arguments, "tool_call.function.arguments"),
        });
      }
    }
    messages.push({ role: message.role, content: parts, boundary });
  });
  const chatSampling = sampling(
    { ...body, max_tokens: body.max_completion_tokens ?? body.max_tokens },
    "max_tokens",
  );
  return {
    adapterVersion: ADAPTER_VERSION,
    source: "openai-chat",
    model: string(body.model, "model"),
    instructions,
    messages,
    tools: parseTools(body.tools, "tools", "openai-chat"),
    toolChoice: parseOpenAiToolChoice(body.tool_choice),
    stream: body.stream === true,
    sampling: chatSampling,
    limitations: [],
  };
}

export function renderOpenAiChatRequest(
  request: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = request.instructions.map((instruction) => ({
    role: instruction.role,
    content: instruction.content.length === 1 ? instruction.content[0]?.text : instruction.content,
  }));
  for (const message of request.messages) {
    const contentParts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (part.type === "text") contentParts.push({ type: "text", text: part.text });
      else if (part.type === "image") {
        const url =
          part.source.kind === "url"
            ? part.source.url
            : `data:${part.source.mediaType};base64,${part.source.data}`;
        contentParts.push({
          type: "image_url",
          image_url: {
            url,
            ...(part.source.kind === "url" && part.source.detail
              ? { detail: part.source.detail }
              : {}),
          },
        });
      } else if (part.type === "tool_call")
        toolCalls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: part.arguments },
        });
      else
        messages.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: part.content.map((item) => item.text).join("\n"),
        });
    }
    if (contentParts.length || toolCalls.length)
      messages.push({
        role: message.role,
        content: contentParts.length ? contentParts : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
  }
  return {
    model,
    messages,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
    ...(request.toolChoice
      ? {
          tool_choice:
            request.toolChoice.type === "tool"
              ? { type: "function", function: { name: request.toolChoice.name } }
              : request.toolChoice.type,
        }
      : {}),
    stream: request.stream,
    ...(request.sampling.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling.stop ? { stop: request.sampling.stop } : {}),
    ...(request.sampling.maxOutputTokens !== undefined
      ? { max_completion_tokens: request.sampling.maxOutputTokens }
      : {}),
    n: 1,
  };
}
