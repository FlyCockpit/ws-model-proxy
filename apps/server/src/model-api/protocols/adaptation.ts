import {
  parseAnthropicMessagesRequest,
  renderAnthropicMessagesRequest,
} from "./anthropic-messages.js";
import type { CanonicalEvent, CanonicalRequest, ProtocolSurface } from "./canonical.js";
import { parseProtocolResponse, renderProtocolResponse } from "./nonstream.js";
import { parseOpenAiChatRequest, renderOpenAiChatRequest } from "./openai-chat.js";
import { parseOpenAiResponsesRequest, renderOpenAiResponsesRequest } from "./openai-responses.js";
import type { ReasoningRenderControl } from "./request-controls.js";
import { CanonicalStreamParser, CanonicalStreamRenderer } from "./streams.js";

export function parseCanonicalRequest(surface: ProtocolSurface, body: unknown): CanonicalRequest {
  if (surface === "openai-chat") return parseOpenAiChatRequest(body);
  if (surface === "openai-responses") return parseOpenAiResponsesRequest(body);
  return parseAnthropicMessagesRequest(body);
}

export function renderCanonicalRequest({
  request,
  target,
  model,
  allowLossyDeveloperRoleCollapse = false,
  acceptsTopK = false,
  reasoning,
}: {
  request: CanonicalRequest;
  target: ProtocolSurface;
  model: string;
  allowLossyDeveloperRoleCollapse?: boolean;
  /** Chat targets that accept a top-level `top_k`. Default rejects. */
  acceptsTopK?: boolean;
  reasoning?: ReasoningRenderControl;
}): Record<string, unknown> {
  if (target === "openai-chat")
    return renderOpenAiChatRequest(request, model, { acceptsTopK, reasoning });
  if (target === "openai-responses")
    return renderOpenAiResponsesRequest(request, model, { reasoning });
  return renderAnthropicMessagesRequest(request, model, {
    allowLossyInstructionRoleCollapse: allowLossyDeveloperRoleCollapse,
    reasoning,
  });
}

// Image URLs and base64 are omitted: an accepted underestimate.
export function estimateInputTokens(request: CanonicalRequest): number {
  const parts: string[] = [];
  for (const instruction of request.instructions)
    for (const part of instruction.content) parts.push(part.text);
  for (const message of request.messages)
    for (const part of message.content) if (part.type === "text") parts.push(part.text);
  for (const message of request.messages)
    for (const part of message.content)
      if (part.type === "tool_call") parts.push(part.name, part.arguments);
  for (const message of request.messages)
    for (const part of message.content)
      if (part.type === "tool_result")
        for (const partText of part.content) parts.push(partText.text);
  for (const tool of request.tools) {
    parts.push(tool.name);
    if (tool.description !== undefined) parts.push(tool.description);
    parts.push(JSON.stringify(tool.inputSchema));
  }
  if (request.toolChoice?.type === "tool") parts.push(request.toolChoice.name);
  const bytes = new TextEncoder().encode(parts.join("\n")).byteLength;
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function withAnthropicInitialUsage(
  event: CanonicalEvent,
  target: ProtocolSurface,
  request: CanonicalRequest | undefined,
): CanonicalEvent {
  if (
    target !== "anthropic-messages" ||
    event.type !== "message_start" ||
    event.usage?.inputTokens !== undefined ||
    !request
  )
    return event;
  return {
    ...event,
    usage: { inputTokens: estimateInputTokens(request), outputTokens: 0 },
  };
}

export function adaptNonstreamResponse({
  source,
  target,
  body,
  status,
  headers,
}: {
  source: ProtocolSurface;
  target: ProtocolSurface;
  body: unknown;
  status: number;
  headers?: Headers;
}) {
  const parsed = parseProtocolResponse({ surface: source, body, status, headers });
  return parsed.ok
    ? {
        ok: true as const,
        metadata: parsed.metadata,
        body: renderProtocolResponse(target, parsed.response),
      }
    : { ok: false as const, metadata: parsed.metadata, error: parsed.error };
}

export function createProtocolAdaptationTransform({
  source,
  target,
  signal,
  maxEventBytes,
  maxAggregateBytes,
  recoverProtocolErrors = false,
  onProtocolError,
  request,
}: {
  source: ProtocolSurface;
  target: ProtocolSurface;
  signal?: AbortSignal;
  maxEventBytes?: number;
  maxAggregateBytes?: number;
  recoverProtocolErrors?: boolean;
  onProtocolError?: (error: unknown) => void;
  request?: CanonicalRequest;
}): TransformStream<Uint8Array, Uint8Array> {
  const parser = new CanonicalStreamParser(source, { signal, maxEventBytes, maxAggregateBytes });
  const renderer = new CanonicalStreamRenderer(target, { signal, maxAggregateBytes });
  let failed = false;
  let hasOutput = false;
  let observedUsage: { inputTokens?: number; outputTokens?: number } = {};
  const mergeUsage = (usage: { inputTokens?: number; outputTokens?: number }) => {
    if (usage.inputTokens !== undefined) observedUsage.inputTokens = usage.inputTokens;
    if (usage.outputTokens !== undefined) observedUsage.outputTokens = usage.outputTokens;
  };
  const withCumulativeUsage = (event: CanonicalEvent): CanonicalEvent => {
    if (event.type === "usage") {
      mergeUsage(event.usage);
      return { ...event, usage: observedUsage };
    }
    if (event.type === "message_start" && event.usage) {
      mergeUsage(event.usage);
      return { ...event, usage: observedUsage };
    }
    return event;
  };
  const prepare = (event: CanonicalEvent) =>
    withAnthropicInitialUsage(withCumulativeUsage(event), target, request);
  const recover = (error: unknown, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!recoverProtocolErrors || !hasOutput) throw error;
    failed = true;
    onProtocolError?.(error);
    try {
      for (const output of renderer.push({
        type: "error",
        error: {
          code: "protocol_error",
          message: "The upstream stream violated the adapted protocol.",
          upstreamStatus: 502,
        },
      }))
        controller.enqueue(output);
    } catch {
      // A target stop barrier is already observable; never append a second terminal.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (failed) return;
      try {
        for (const event of parser.push(chunk))
          for (const output of renderer.push(prepare(event))) {
            hasOutput = true;
            controller.enqueue(output);
          }
      } catch (error) {
        recover(error, controller);
      }
    },
    flush(controller) {
      if (failed) return;
      try {
        for (const event of parser.finish())
          for (const output of renderer.push(prepare(event))) {
            hasOutput = true;
            controller.enqueue(output);
          }
        renderer.finish();
      } catch (error) {
        recover(error, controller);
      }
    },
  });
}
