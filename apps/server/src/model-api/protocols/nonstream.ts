import type {
  CanonicalProtocolError,
  CanonicalResponse,
  ParsedProtocolResponse,
  ProtocolResponseMetadata,
  ProtocolSurface,
} from "./canonical.js";
import { AdapterError, invalid, unsupported } from "./errors.js";
import { object, rejectUnknown, string } from "./parse-utils.js";

export function parseProtocolResponse({
  surface,
  body,
  status,
  headers = new Headers(),
}: {
  surface: ProtocolSurface;
  body: unknown;
  status: number;
  headers?: Headers;
}): ParsedProtocolResponse {
  const metadata = responseMetadata(status, headers, surface);
  if (status < 200 || status >= 300)
    return { ok: false, metadata, error: parseError(surface, body, metadata) };
  return {
    ok: true,
    metadata,
    response:
      surface === "openai-chat"
        ? parseChatSuccess(body)
        : surface === "openai-responses"
          ? parseResponsesSuccess(body)
          : parseAnthropicSuccess(body),
  };
}

export function responseMetadata(
  status: number,
  headers: Headers,
  surface?: ProtocolSurface,
): ProtocolResponseMetadata {
  const safe = (name: string) => headers.get(name)?.slice(0, 512) || undefined;
  const anthropic = surface === "anthropic-messages";
  return {
    status,
    requestId: anthropic ? safe("request-id") : safe("x-request-id"),
    retryAfter: safe("retry-after"),
    retryLimit: anthropic
      ? safe("anthropic-ratelimit-requests-limit")
      : safe("x-ratelimit-limit-requests"),
    retryRemaining: anthropic
      ? safe("anthropic-ratelimit-requests-remaining")
      : safe("x-ratelimit-remaining-requests"),
    retryReset: anthropic
      ? safe("anthropic-ratelimit-requests-reset")
      : safe("x-ratelimit-reset-requests"),
  };
}

function parseChatSuccess(value: unknown): CanonicalResponse {
  const body = object(value);
  rejectUnknown(
    body,
    ["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"],
    "response",
  );
  if (body.object !== "chat.completion") invalid("response.object", "must be chat.completion");
  if (!Array.isArray(body.choices) || body.choices.length !== 1)
    unsupported("response.choices", "must contain exactly one candidate");
  const choice = object(body.choices[0], "response.choices[0]");
  rejectUnknown(choice, ["index", "message", "finish_reason", "logprobs"], "response.choices[0]");
  if (choice.index !== 0) invalid("response.choices[0].index", "must be zero");
  if (choice.logprobs !== undefined && choice.logprobs !== null)
    unsupported("response.choices[0].logprobs");
  const message = object(choice.message, "response.choices[0].message");
  rejectUnknown(
    message,
    ["role", "content", "refusal", "tool_calls"],
    "response.choices[0].message",
  );
  if (message.role !== "assistant")
    invalid("response.choices[0].message.role", "must be assistant");
  const items: CanonicalResponse["items"] = [];
  if (typeof message.content === "string" && message.content)
    items.push({ type: "text", text: message.content });
  else if (message.content != null)
    invalid("response.choices[0].message.content", "must be text or null");
  if (message.refusal !== undefined && message.refusal !== null) {
    const refusal = string(message.refusal, "response.choices[0].message.refusal");
    if (items.length)
      unsupported(
        "response.choices[0].message",
        "mixed text and refusal order is not representable",
      );
    items.push({ type: "refusal", text: refusal });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls))
      invalid("response.choices[0].message.tool_calls", "must be an array");
    const callIds = new Set<string>();
    for (const [index, raw] of message.tool_calls.entries()) {
      if (index > 0)
        unsupported("response.choices[0].message.tool_calls", "must contain at most one call");
      const call = object(raw, `response.choices[0].message.tool_calls[${index}]`);
      rejectUnknown(
        call,
        ["id", "type", "function"],
        `response.choices[0].message.tool_calls[${index}]`,
      );
      if (call.type !== "function")
        unsupported(`response.choices[0].message.tool_calls[${index}].type`);
      const fn = object(call.function, `response.choices[0].message.tool_calls[${index}].function`);
      rejectUnknown(
        fn,
        ["name", "arguments"],
        `response.choices[0].message.tool_calls[${index}].function`,
      );
      const id = string(call.id, `response.choices[0].message.tool_calls[${index}].id`);
      if (callIds.has(id))
        invalid(`response.choices[0].message.tool_calls[${index}].id`, "must be unique");
      callIds.add(id);
      items.push({
        type: "tool_call",
        id,
        name: string(fn.name, "tool_call.name"),
        arguments: completeArguments(fn.arguments, "tool_call.arguments"),
      });
    }
  }
  return {
    id: string(body.id, "response.id"),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    items,
    usage: parseUsage(body.usage),
    stopReason: stopReason(choice.finish_reason),
  };
}

function parseResponsesSuccess(value: unknown): CanonicalResponse {
  const body = object(value);
  rejectUnknown(
    body,
    [
      "id",
      "object",
      "created_at",
      "status",
      "model",
      "output",
      "usage",
      "error",
      "incomplete_details",
      "parallel_tool_calls",
      "tool_choice",
      "tools",
      "temperature",
      "top_p",
      "max_output_tokens",
    ],
    "response",
  );
  if (body.object !== "response") invalid("response.object", "must be response");
  if (body.status !== "completed")
    unsupported("response.status", "must be completed for non-stream adaptation");
  if (body.error != null || body.incomplete_details != null)
    unsupported("response", "contains incomplete or error state");
  if (!Array.isArray(body.output)) invalid("response.output", "must be an array");
  const items: CanonicalResponse["items"] = [];
  const callIds = new Set<string>();
  for (const [index, raw] of body.output.entries()) {
    const item = object(raw, `response.output[${index}]`);
    if (item.type === "message") {
      rejectUnknown(item, ["id", "type", "status", "role", "content"], `response.output[${index}]`);
      if (item.role !== "assistant" || item.status !== "completed")
        invalid(`response.output[${index}]`, "must be a completed assistant message");
      if (!Array.isArray(item.content))
        invalid(`response.output[${index}].content`, "must be an array");
      for (const [contentIndex, rawContent] of item.content.entries()) {
        const content = object(rawContent, `response.output[${index}].content[${contentIndex}]`);
        if (content.type === "output_text") {
          rejectUnknown(
            content,
            ["type", "text", "annotations", "logprobs"],
            `response.output[${index}].content[${contentIndex}]`,
          );
          if (!Array.isArray(content.annotations))
            invalid(
              `response.output[${index}].content[${contentIndex}].annotations`,
              "must be an array",
            );
          if (content.annotations.length)
            unsupported(
              `response.output[${index}].content[${contentIndex}].annotations`,
              "citations are not safely adaptable",
            );
          if (content.logprobs !== undefined && !Array.isArray(content.logprobs))
            invalid(
              `response.output[${index}].content[${contentIndex}].logprobs`,
              "must be an array",
            );
          if (Array.isArray(content.logprobs) && content.logprobs.length)
            unsupported(`response.output[${index}].content[${contentIndex}].logprobs`);
          items.push({ type: "text", text: string(content.text, "output_text.text") });
        } else if (content.type === "refusal") {
          rejectUnknown(
            content,
            ["type", "refusal"],
            `response.output[${index}].content[${contentIndex}]`,
          );
          items.push({ type: "refusal", text: string(content.refusal, "refusal.refusal") });
        } else unsupported(`response.output[${index}].content[${contentIndex}].type`);
      }
    } else if (item.type === "function_call") {
      if (callIds.size > 0) unsupported("response.output", "must contain at most one tool call");
      rejectUnknown(
        item,
        ["id", "type", "status", "call_id", "name", "arguments"],
        `response.output[${index}]`,
      );
      if (item.status !== "completed")
        invalid(`response.output[${index}].status`, "must be completed");
      const id = string(item.call_id, `response.output[${index}].call_id`);
      if (callIds.has(id)) invalid(`response.output[${index}].call_id`, "must be unique");
      callIds.add(id);
      items.push({
        type: "tool_call",
        id,
        name: string(item.name, "function_call.name"),
        arguments: completeArguments(item.arguments, "function_call.arguments"),
      });
    } else unsupported(`response.output[${index}].type`);
  }
  return {
    id: string(body.id, "response.id"),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    items,
    usage: parseUsage(body.usage),
    stopReason: items.some((item) => item.type === "tool_call") ? "tool" : "stop",
  };
}

function parseAnthropicSuccess(value: unknown): CanonicalResponse {
  const body = object(value);
  rejectUnknown(
    body,
    ["id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"],
    "response",
  );
  if (body.type !== "message" || body.role !== "assistant")
    invalid("response", "must be an Anthropic assistant message");
  if (!Array.isArray(body.content)) invalid("response.content", "must be an array");
  const callIds = new Set<string>();
  const items: CanonicalResponse["items"] = body.content.map((raw, index) => {
    const block = object(raw, `response.content[${index}]`);
    if (block.type === "text") {
      rejectUnknown(block, ["type", "text", "citations"], `response.content[${index}]`);
      if (block.citations !== undefined) {
        if (!Array.isArray(block.citations))
          invalid(`response.content[${index}].citations`, "must be an array");
        if (block.citations.length) unsupported(`response.content[${index}].citations`);
      }
      return { type: "text", text: string(block.text, `response.content[${index}].text`) };
    }
    if (block.type === "tool_use") {
      if (callIds.size > 0) unsupported("response.content", "must contain at most one tool use");
      rejectUnknown(block, ["type", "id", "name", "input"], `response.content[${index}]`);
      const id = string(block.id, `response.content[${index}].id`);
      if (callIds.has(id)) invalid(`response.content[${index}].id`, "must be unique");
      callIds.add(id);
      return {
        type: "tool_call",
        id,
        name: string(block.name, "tool_use.name"),
        arguments: JSON.stringify(object(block.input, "tool_use.input")),
      };
    }
    return unsupported(`response.content[${index}].type`);
  });
  const reason = stopReason(body.stop_reason);
  if (reason === "content_filter")
    unsupported("response.stop_reason", "is not safely representable across protocols");
  const hasCalls = items.some((item) => item.type === "tool_call");
  if ((reason === "tool") !== hasCalls)
    invalid("response.stop_reason", "does not match tool-use content");
  if (body.stop_sequence !== null && body.stop_sequence !== undefined) {
    if (typeof body.stop_sequence !== "string")
      invalid("response.stop_sequence", "must be text or null");
    if (body.stop_reason !== "stop_sequence")
      invalid("response.stop_sequence", "requires stop_reason stop_sequence");
  }
  return {
    id: string(body.id, "response.id"),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    items,
    usage: parseUsage(body.usage),
    stopReason: reason,
  };
}

function parseUsage(value: unknown) {
  if (value == null) return undefined;
  const usage = object(value, "usage");
  const allowed = [
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens_details",
    "output_tokens_details",
  ];
  rejectUnknown(usage, allowed, "usage");
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (input !== undefined && (typeof input !== "number" || !Number.isInteger(input) || input < 0))
    invalid("usage.input_tokens", "is invalid");
  if (
    output !== undefined &&
    (typeof output !== "number" || !Number.isInteger(output) || output < 0)
  )
    invalid("usage.output_tokens", "is invalid");
  if (typeof input !== "number" || typeof output !== "number")
    invalid("usage", "must include both input and output token counts");
  if (
    usage.total_tokens !== undefined &&
    (!Number.isInteger(usage.total_tokens) || usage.total_tokens !== input + output)
  )
    invalid("usage.total_tokens", "must equal input plus output tokens");
  for (const key of ["input_tokens_details", "output_tokens_details"] as const) {
    if (usage[key] === undefined) continue;
    const details = object(usage[key], `usage.${key}`);
    rejectUnknown(
      details,
      key === "input_tokens_details" ? ["cached_tokens"] : ["reasoning_tokens"],
      `usage.${key}`,
    );
    for (const [name, count] of Object.entries(details))
      if (!Number.isInteger(count) || (count as number) < 0)
        invalid(`usage.${key}.${name}`, "must be a non-negative integer");
  }
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
  };
}

function completeArguments(value: unknown, parameter: string): string {
  const raw = string(value, parameter);
  try {
    object(JSON.parse(raw), parameter);
  } catch {
    invalid(parameter, "must be a complete JSON object");
  }
  return raw;
}

function stopReason(value: unknown): CanonicalResponse["stopReason"] {
  if (value === "stop" || value === "stop_sequence" || value === "end_turn") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "tool_use") return "tool";
  if (value === "content_filter") return "content_filter";
  return unsupported("response.stop_reason", "is not safely adaptable");
}

function parseError(
  surface: ProtocolSurface,
  value: unknown,
  metadata: ProtocolResponseMetadata,
): CanonicalProtocolError {
  const body = object(value, "error_response");
  let error: Record<string, unknown>;
  let bodyRequestId: string | undefined;
  if (surface === "anthropic-messages") {
    rejectUnknown(body, ["type", "error", "request_id"], "error_response");
    if (body.type !== "error") invalid("error_response.type", "must be error");
    error = object(body.error, "error_response.error");
    rejectUnknown(error, ["type", "message"], "error_response.error");
    if (body.request_id !== undefined)
      bodyRequestId = string(body.request_id, "error_response.request_id");
  } else {
    rejectUnknown(body, ["error"], "error_response");
    error = object(body.error, "error_response.error");
    rejectUnknown(error, ["message", "type", "param", "code"], "error_response.error");
  }
  return {
    code:
      typeof error.code === "string"
        ? error.code
        : typeof error.type === "string"
          ? error.type
          : "upstream_error",
    message: string(error.message, "error_response.error.message").slice(0, 1000),
    ...(typeof error.param === "string" ? { parameter: error.param } : {}),
    upstreamStatus: metadata.status,
    ...((bodyRequestId ?? metadata.requestId)
      ? { requestId: bodyRequestId ?? metadata.requestId }
      : {}),
    ...(metadata.retryAfter ? { retryAfter: metadata.retryAfter } : {}),
    ...(metadata.retryLimit ? { retryLimit: metadata.retryLimit } : {}),
    ...(metadata.retryRemaining ? { retryRemaining: metadata.retryRemaining } : {}),
    ...(metadata.retryReset ? { retryReset: metadata.retryReset } : {}),
  };
}

export function renderProtocolResponse(
  surface: ProtocolSurface,
  response: CanonicalResponse,
): Record<string, unknown> {
  if (surface === "openai-chat") return renderChat(response);
  if (surface === "openai-responses") return renderResponses(response);
  return renderAnthropic(response);
}

function renderChat(response: CanonicalResponse) {
  const hasCalls = response.items.some((item) => item.type === "tool_call");
  const hasContent = response.items.some((item) => item.type !== "tool_call");
  if (hasCalls && hasContent)
    unsupported("response.items", "mixed content and tool calls have no lossless ordering in Chat");
  const text = response.items
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  const refusal = response.items
    .filter((item) => item.type === "refusal")
    .map((item) => item.text)
    .join("");
  const calls = response.items.filter((item) => item.type === "tool_call");
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model ?? "adapted",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(refusal ? { refusal } : {}),
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: response.stopReason === "tool" ? "tool_calls" : response.stopReason,
      },
    ],
    ...(response.usage
      ? {
          usage: {
            prompt_tokens: response.usage.inputTokens ?? 0,
            completion_tokens: response.usage.outputTokens ?? 0,
            total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
          },
        }
      : {}),
  };
}

function renderResponses(response: CanonicalResponse) {
  const output: Record<string, unknown>[] = [];
  let messageIndex = 0;
  let content: Record<string, unknown>[] = [];
  const flush = () => {
    if (!content.length) return;
    output.push({
      id: `${response.id}-message-${messageIndex++}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content,
    });
    content = [];
  };
  for (const item of response.items) {
    if (item.type === "text")
      content.push({ type: "output_text", text: item.text, annotations: [] });
    else if (item.type === "refusal") content.push({ type: "refusal", refusal: item.text });
    else {
      flush();
      output.push({
        id: `${response.id}-${item.id}`,
        type: "function_call",
        status: "completed",
        call_id: item.id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }
  flush();
  return {
    id: response.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: response.model ?? "adapted",
    output,
    ...(response.usage
      ? {
          usage: {
            input_tokens: response.usage.inputTokens ?? 0,
            output_tokens: response.usage.outputTokens ?? 0,
            total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
          },
        }
      : {}),
  };
}

function renderAnthropic(response: CanonicalResponse) {
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model ?? "adapted",
    content: response.items.map((item) =>
      item.type === "text"
        ? item
        : item.type === "tool_call"
          ? { type: "tool_use", id: item.id, name: item.name, input: JSON.parse(item.arguments) }
          : unsupported("response.refusal", "Anthropic has no lossless refusal block"),
    ),
    stop_reason:
      response.stopReason === "tool"
        ? "tool_use"
        : response.stopReason === "length"
          ? "max_tokens"
          : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
    },
  };
}

export function renderProtocolError(
  surface: ProtocolSurface,
  error: CanonicalProtocolError,
): Record<string, unknown> {
  if (surface === "anthropic-messages")
    return {
      type: "error",
      error: { type: anthropicErrorType(error.code, error.upstreamStatus), message: error.message },
      ...(error.requestId ? { request_id: error.requestId } : {}),
    };
  const openAiType = openAiErrorType(error.code, error.upstreamStatus);
  return {
    error: {
      message: error.message,
      type: openAiType,
      param: error.parameter ?? null,
      code: error.code,
    },
  };
}

function anthropicErrorType(code: string, status?: number): string {
  if (code === "authentication_error" || status === 401) return "authentication_error";
  if (code === "permission_error" || status === 403) return "permission_error";
  if (code === "not_found_error" || status === 404) return "not_found_error";
  if (code === "request_too_large" || status === 413) return "request_too_large";
  if (code === "rate_limit_error" || status === 429) return "rate_limit_error";
  if (code === "overloaded_error" || status === 529) return "overloaded_error";
  if (status !== undefined && status >= 500) return "api_error";
  return "invalid_request_error";
}

function openAiErrorType(code: string, status?: number): string {
  if (code === "authentication_error" || status === 401) return "authentication_error";
  if (code === "permission_error" || status === 403) return "permission_error";
  if (code === "invalid_request_error" || status === 400) return "invalid_request_error";
  if (code === "rate_limit_error" || status === 429) return "rate_limit_error";
  if (status !== undefined && status >= 500) return "server_error";
  return code;
}

export function renderProtocolErrorMetadata(
  surfaceOrError: ProtocolSurface | CanonicalProtocolError,
  maybeError?: CanonicalProtocolError,
): {
  status: number;
  headers: Headers;
} {
  const surface = typeof surfaceOrError === "string" ? surfaceOrError : "openai-responses";
  const error = typeof surfaceOrError === "string" ? maybeError : surfaceOrError;
  if (!error) throw new AdapterError("invalid_error", "Canonical error metadata is required.");
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (error.requestId)
    headers.set(surface === "anthropic-messages" ? "request-id" : "x-request-id", error.requestId);
  if (error.retryAfter) headers.set("retry-after", error.retryAfter);
  const retryHeaders =
    surface === "anthropic-messages"
      ? {
          limit: "anthropic-ratelimit-requests-limit",
          remaining: "anthropic-ratelimit-requests-remaining",
          reset: "anthropic-ratelimit-requests-reset",
        }
      : {
          limit: "x-ratelimit-limit-requests",
          remaining: "x-ratelimit-remaining-requests",
          reset: "x-ratelimit-reset-requests",
        };
  if (error.retryLimit) headers.set(retryHeaders.limit, error.retryLimit);
  if (error.retryRemaining) headers.set(retryHeaders.remaining, error.retryRemaining);
  if (error.retryReset) headers.set(retryHeaders.reset, error.retryReset);
  return {
    status:
      error.upstreamStatus && error.upstreamStatus >= 400 && error.upstreamStatus <= 599
        ? error.upstreamStatus
        : 502,
    headers,
  };
}
