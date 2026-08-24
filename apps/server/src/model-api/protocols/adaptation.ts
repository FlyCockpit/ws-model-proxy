import {
  parseAnthropicMessagesRequest,
  renderAnthropicMessagesRequest,
} from "./anthropic-messages.js";
import type { CanonicalRequest, ProtocolSurface } from "./canonical.js";
import { parseProtocolResponse, renderProtocolResponse } from "./nonstream.js";
import { parseOpenAiChatRequest, renderOpenAiChatRequest } from "./openai-chat.js";
import { parseOpenAiResponsesRequest, renderOpenAiResponsesRequest } from "./openai-responses.js";
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
}: {
  request: CanonicalRequest;
  target: ProtocolSurface;
  model: string;
  allowLossyDeveloperRoleCollapse?: boolean;
}): Record<string, unknown> {
  if (target === "openai-chat") return renderOpenAiChatRequest(request, model);
  if (target === "openai-responses") return renderOpenAiResponsesRequest(request, model);
  return renderAnthropicMessagesRequest(request, model, {
    allowLossyInstructionRoleCollapse: allowLossyDeveloperRoleCollapse,
  });
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
}: {
  source: ProtocolSurface;
  target: ProtocolSurface;
  signal?: AbortSignal;
  maxEventBytes?: number;
  maxAggregateBytes?: number;
}): TransformStream<Uint8Array, Uint8Array> {
  const parser = new CanonicalStreamParser(source, { signal, maxEventBytes, maxAggregateBytes });
  const renderer = new CanonicalStreamRenderer(target, { signal, maxAggregateBytes });
  return new TransformStream({
    transform(chunk, controller) {
      for (const event of parser.push(chunk))
        for (const output of renderer.push(event)) controller.enqueue(output);
    },
    flush(controller) {
      for (const event of parser.finish())
        for (const output of renderer.push(event)) controller.enqueue(output);
      renderer.finish();
    },
  });
}
