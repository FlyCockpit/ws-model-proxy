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
  recoverProtocolErrors = false,
  onProtocolError,
}: {
  source: ProtocolSurface;
  target: ProtocolSurface;
  signal?: AbortSignal;
  maxEventBytes?: number;
  maxAggregateBytes?: number;
  recoverProtocolErrors?: boolean;
  onProtocolError?: (error: unknown) => void;
}): TransformStream<Uint8Array, Uint8Array> {
  const parser = new CanonicalStreamParser(source, { signal, maxEventBytes, maxAggregateBytes });
  const renderer = new CanonicalStreamRenderer(target, { signal, maxAggregateBytes });
  let failed = false;
  let hasOutput = false;
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
          for (const output of renderer.push(event)) {
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
          for (const output of renderer.push(event)) {
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
