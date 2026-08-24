import { ADAPTER_VERSION, type CanonicalMessage, type CanonicalRequest } from "./canonical.js";
import { invalid, unsupported } from "./errors.js";
import {
  object,
  parseImageUrl,
  parseOpenAiToolChoice,
  parseTools,
  rejectUnknown,
  sampling,
  string,
  texts,
} from "./parse-utils.js";

const ROOT_KEYS = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "store",
  "previous_response_id",
  "include",
  "reasoning",
  "truncation",
  "background",
  "service_tier",
  "parallel_tool_calls",
  "text",
  "metadata",
] as const;

export function parseOpenAiResponsesRequest(input: unknown): CanonicalRequest {
  const body = object(input);
  rejectUnknown(body, ROOT_KEYS, "body");
  for (const key of [
    "previous_response_id",
    "include",
    "reasoning",
    "background",
    "service_tier",
    "metadata",
    "text",
  ] as const) {
    if (body[key] !== undefined) unsupported(key);
  }
  if (body.store === true) unsupported("store", "persisted Responses state is native-only");
  if (body.truncation !== undefined && body.truncation !== "disabled") unsupported("truncation");
  if (body.parallel_tool_calls === true) unsupported("parallel_tool_calls");
  const instructions: CanonicalRequest["instructions"] =
    body.instructions === undefined
      ? []
      : [
          {
            role: "developer",
            content: texts(body.instructions, "instructions"),
            boundary: { sourceIndex: -1 },
          },
        ];
  const messages: CanonicalMessage[] = [];
  const rawInput = body.input;
  if (typeof rawInput === "string")
    messages.push({
      role: "user",
      content: [{ type: "text", text: rawInput }],
      boundary: { sourceIndex: 0 },
    });
  else if (Array.isArray(rawInput)) {
    rawInput.forEach((entry, sourceIndex) => {
      const item = object(entry, `input[${sourceIndex}]`);
      if ((item.type === undefined || item.type === "message") && item.role !== undefined) {
        rejectUnknown(item, ["type", "id", "role", "content", "status"], `input[${sourceIndex}]`);
        if (item.id !== undefined || item.status !== undefined)
          unsupported(`input[${sourceIndex}]`, "persisted item references are native-only");
        if (item.role === "system" || item.role === "developer") {
          instructions.push({
            role: item.role,
            content: responseInstructionText(item.content, `input[${sourceIndex}].content`),
            boundary: { sourceIndex },
          });
          return;
        }
        if (item.role !== "user" && item.role !== "assistant")
          invalid(`input[${sourceIndex}].role`, "is unsupported");
        const parsedContent = responseText(item.content, `input[${sourceIndex}].content`);
        if (item.role === "assistant" && parsedContent.some((part) => part.type === "image"))
          unsupported(
            `input[${sourceIndex}].content`,
            "assistant images are not in the common subset",
          );
        messages.push({
          role: item.role,
          content: parsedContent,
          boundary: { sourceIndex },
        });
        return;
      }
      if (item.type === "function_call") {
        rejectUnknown(item, ["type", "call_id", "name", "arguments"], `input[${sourceIndex}]`);
        messages.push({
          role: "assistant",
          boundary: { sourceIndex },
          content: [
            {
              type: "tool_call",
              id: string(item.call_id, `input[${sourceIndex}].call_id`),
              name: string(item.name, `input[${sourceIndex}].name`),
              arguments: string(item.arguments, `input[${sourceIndex}].arguments`),
            },
          ],
        });
        return;
      }
      if (item.type === "function_call_output") {
        rejectUnknown(item, ["type", "call_id", "output"], `input[${sourceIndex}]`);
        messages.push({
          role: "user",
          boundary: { sourceIndex },
          content: [
            {
              type: "tool_result",
              toolCallId: string(item.call_id, `input[${sourceIndex}].call_id`),
              content: texts(item.output, `input[${sourceIndex}].output`),
            },
          ],
        });
        return;
      }
      unsupported(`input[${sourceIndex}].type`);
    });
  } else invalid("input", "must be text or an item array");
  return {
    adapterVersion: ADAPTER_VERSION,
    source: "openai-responses",
    model: string(body.model, "model"),
    instructions,
    messages,
    tools: parseTools(body.tools, "tools", "openai-responses"),
    toolChoice: parseOpenAiToolChoice(body.tool_choice),
    parallelToolCalls: "single",
    stream: body.stream === true,
    sampling: sampling(body, "max_output_tokens"),
    limitations: instructions.some((item) => item.role === "developer")
      ? ["anthropic_instruction_authority_collapse"]
      : [],
  };
}

function responseInstructionText(value: unknown, parameter: string) {
  if (typeof value === "string") return [{ type: "text" as const, text: value }];
  if (!Array.isArray(value)) invalid(parameter, "must be text or an array");
  return value.map((entry, index) => {
    const block = object(entry, `${parameter}[${index}]`);
    rejectUnknown(block, ["type", "text"], `${parameter}[${index}]`);
    if (block.type !== "input_text" && block.type !== "output_text")
      unsupported(`${parameter}[${index}].type`);
    return {
      type: "text" as const,
      text: string(block.text, `${parameter}[${index}].text`),
    };
  });
}

export function renderOpenAiResponsesRequest(
  request: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  if (request.sampling.stop?.length)
    unsupported("stop", "OpenAI Responses has no lossless stop-sequence control");
  const input: Record<string, unknown>[] = request.instructions.map((instruction) => ({
    type: "message",
    role: instruction.role,
    content: instruction.content.map((part) => ({ type: "input_text", text: part.text })),
  }));
  for (const message of request.messages) {
    const content: Record<string, unknown>[] = [];
    const flushContent = () => {
      if (content.length)
        input.push({ type: "message", role: message.role, content: content.splice(0) });
    };
    for (const part of message.content) {
      if (part.type === "text")
        content.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: part.text,
        });
      else if (part.type === "image") {
        const imageUrl =
          part.source.kind === "url"
            ? part.source.url
            : `data:${part.source.mediaType};base64,${part.source.data}`;
        content.push({ type: "input_image", image_url: imageUrl });
      } else if (part.type === "tool_call") {
        flushContent();
        input.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: part.arguments,
        });
      } else {
        flushContent();
        input.push({
          type: "function_call_output",
          call_id: part.toolCallId,
          output: part.content.map((item) => item.text).join("\n"),
        });
      }
    }
    flushContent();
  }
  return {
    model,
    input,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchema,
          })),
        }
      : {}),
    ...(request.tools.length ? { parallel_tool_calls: false } : {}),
    ...(request.toolChoice
      ? {
          tool_choice:
            request.toolChoice.type === "tool"
              ? { type: "function", name: request.toolChoice.name }
              : request.toolChoice.type,
        }
      : {}),
    stream: request.stream,
    store: false,
    ...(request.sampling.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.sampling.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling.maxOutputTokens !== undefined
      ? { max_output_tokens: request.sampling.maxOutputTokens }
      : {}),
  };
}

function responseText(value: unknown, parameter: string) {
  if (typeof value === "string") return [{ type: "text" as const, text: value }];
  if (!Array.isArray(value)) invalid(parameter, "must be text or an array");
  return value.map((entry, index) => {
    const block = object(entry, `${parameter}[${index}]`);
    if (block.type === "input_text" || block.type === "output_text") {
      rejectUnknown(block, ["type", "text"], `${parameter}[${index}]`);
      return {
        type: "text" as const,
        text: string(block.text, `${parameter}[${index}].text`),
      };
    }
    if (block.type === "input_image") {
      rejectUnknown(block, ["type", "image_url", "detail"], `${parameter}[${index}]`);
      return {
        type: "image" as const,
        source: parseImageUrl(block.image_url, `${parameter}[${index}].image_url`, block.detail),
      };
    }
    return unsupported(`${parameter}[${index}].type`);
  });
}
