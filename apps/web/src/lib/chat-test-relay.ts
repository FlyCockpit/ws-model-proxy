import { env } from "@ws-model-proxy/env/web";
import type {
  ChatAttachment,
  ChatMessage,
  ChatRouteInfo,
  ChatTestRoutingMode,
  ChatTestSurface,
  ChatTimingMetrics,
  RelayChatMessage,
  RelayContentPart,
  TransformDebug,
} from "@/components/chat-test/chat-test-types";
import {
  anthropicTranscript,
  completionDeltas,
  requireChatTestOutput,
  responsesTranscript,
} from "@/lib/chat-test-reasoning";

/** A representative signed URL prevents size guards from charging uploaded
 * media as inline base64 before its short-lived URL is minted. */
export const mediaUrlPlaceholder = `https://${"x".repeat(48)}.example.com/media/${"y".repeat(36)}?exp=0000000000&sig=${"z".repeat(64)}`;

export function relayMessages(
  messages: ChatMessage[],
  throughUserMessageId: string | undefined,
  resolveMediaUrl: (mediaId: string) => string,
): RelayChatMessage[] {
  const end = throughUserMessageId
    ? messages.findIndex((message) => message.id === throughUserMessageId) + 1
    : messages.length;
  return messages.slice(0, end).flatMap<RelayChatMessage>((message) => {
    if (message.role === "assistant" && message.status !== "ready") return [];
    const attachments = message.attachments ?? [];
    const hasText = message.content.trim().length > 0;
    if (!hasText && attachments.length === 0) return [];
    if (attachments.length === 0) return [{ role: message.role, content: message.content }];
    const content: RelayContentPart[] = [];
    if (hasText) content.push({ type: "text", text: message.content });
    for (const attachment of attachments) addAttachmentPart(content, attachment, resolveMediaUrl);
    return [{ role: message.role, content }];
  });
}

function addAttachmentPart(
  content: RelayContentPart[],
  attachment: ChatAttachment,
  resolveMediaUrl: (mediaId: string) => string,
) {
  const url = attachment.kind === "data" ? attachment.dataUrl : resolveMediaUrl(attachment.mediaId);
  if (attachment.modality === "image") content.push({ type: "image_url", image_url: { url } });
  else if (attachment.modality === "audio")
    content.push({ type: "input_audio_url", input_audio: { url } });
  else content.push({ type: "video_url", video_url: { url } });
}

export function withSystemPrompt(
  messages: RelayChatMessage[],
  systemPrompt: string,
): RelayChatMessage[] {
  const content = systemPrompt.trim();
  return content ? [{ role: "system", content }, ...messages] : messages;
}

export function collectMediaIds(messages: ChatMessage[], throughUserMessageId?: string): string[] {
  const end = throughUserMessageId
    ? messages.findIndex((message) => message.id === throughUserMessageId) + 1
    : messages.length;
  const ids = new Set<string>();
  for (const message of messages.slice(0, end)) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "media") ids.add(attachment.mediaId);
    }
  }
  return [...ids];
}

export function estimateRequestBytes(model: string, messages: RelayChatMessage[]): number {
  return new Blob([JSON.stringify({ model, messages, stream: true })]).size;
}

function standardizedCompletionTokens(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("wsmp_metrics" in value)) return undefined;
  const metrics = value.wsmp_metrics;
  if (typeof metrics !== "object" || metrics === null) return undefined;
  const tokens = "completion_tokens" in metrics ? metrics.completion_tokens : undefined;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  return "tokenizer" in metrics && metrics.tokenizer === "cl100k_base" ? tokens : undefined;
}

/** Route headers set by the model API (apps/server/src/model-api/external-route.ts). */
const ROUTE_HEADER = "x-wsmp-route";
const FALLBACK_REASON_HEADER = "x-wsmp-fallback-reason";
const SERVED_MODEL_HEADER = "x-wsmp-served-model";
const FALLBACK_HEADER = "x-wsmp-fallback";
const KNOWN_ROUTES: readonly ChatRouteInfo["route"][] = ["local", "pool-fallback", "own-key"];

/**
 * Reads the route the server chose for one Chat Test response. Returns
 * undefined when the response carries no route headers (direct models, and
 * plain pool names served before any external decision).
 */
export function readChatRouteInfo(headers: Headers): ChatRouteInfo | undefined {
  const rawRoute = headers.get(ROUTE_HEADER)?.trim().toLowerCase() ?? "";
  const route = KNOWN_ROUTES.find((known) => known === rawRoute) ?? null;
  const externalUnavailable = headers.get(FALLBACK_HEADER)?.trim().toLowerCase() === "unavailable";
  if (route === null && !externalUnavailable) return undefined;
  const servedModel = headers.get(SERVED_MODEL_HEADER)?.trim() || null;
  const fallbackReason = headers.get(FALLBACK_REASON_HEADER)?.trim() || null;
  return {
    route,
    servedModel: route === "local" ? null : servedModel,
    fallbackReason: route === "local" ? null : fallbackReason,
    externalUnavailable,
  };
}

async function readErrorMessage(response: Response, fallback: string) {
  const statusPrefix = `HTTP ${response.status}`;
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (typeof error === "object" && error !== null && "message" in error) {
        return typeof error.message === "string"
          ? `${statusPrefix}: ${error.message}`
          : `${statusPrefix}: ${fallback}`;
      }
    }
    return `${statusPrefix}: ${JSON.stringify(payload).slice(0, 400)}`;
  } catch {
    return `${statusPrefix}: ${fallback}`;
  }
}

export async function streamChatCompletion({
  model,
  messages,
  routingMode,
  surface,
  reasoning,
  signal,
  onDelta,
  onThinkingDelta,
  onTransformDebug,
  onRoute,
  fallbackErrorMessage,
  anthropicMaxTokens,
}: {
  model: string;
  messages: RelayChatMessage[];
  routingMode: ChatTestRoutingMode;
  surface: ChatTestSurface;
  reasoning: Record<string, unknown>;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onTransformDebug?: (debug: TransformDebug) => void;
  /** Called once per response (including error responses) that carries route headers. */
  onRoute?: (route: ChatRouteInfo) => void;
  fallbackErrorMessage: string;
  anthropicMaxTokens: number;
}): Promise<ChatTimingMetrics> {
  const startedAt = performance.now();
  const reportRoute = (response: Response) => {
    const route = readChatRouteInfo(response.headers);
    if (route) onRoute?.(route);
  };
  if (surface !== "OPENAI_CHAT_COMPLETIONS") {
    const isResponses = surface === "OPENAI_RESPONSES";
    const body = isResponses
      ? { model, input: messages, stream: false, store: false, ...reasoning }
      : {
          model,
          messages: messages.filter((message) => message.role !== "system"),
          system: messages.find((message) => message.role === "system")?.content,
          stream: false,
          ...reasoning,
          // Reasoning encoders may carry the API minimum. The resolved UI cap is
          // written last so a larger explicit user choice reaches the wire.
          max_tokens: anthropicMaxTokens,
        };
    const response = await fetch(
      `${env.VITE_SERVER_URL}/api/internal/chat-test/${isResponses ? "responses" : "messages"}`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-wsmp-chat-test-routing-mode": routingMode,
          ...(isResponses ? {} : { "anthropic-version": "2023-06-01" }),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    reportRoute(response);
    if (!response.ok) throw new Error(await readErrorMessage(response, fallbackErrorMessage));
    const payload = (await response.json()) as Record<string, unknown>;
    const transcript = isResponses ? responsesTranscript(payload) : anthropicTranscript(payload);
    requireChatTestOutput(transcript, fallbackErrorMessage);
    if (transcript.content) onDelta(transcript.content);
    if (transcript.thinking) onThinkingDelta(transcript.thinking);
    return { ttftMs: performance.now() - startedAt };
  }
  const response = await fetch(`${env.VITE_SERVER_URL}/api/internal/chat-test/chat/completions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "x-wsmp-chat-test-routing-mode": routingMode },
    body: JSON.stringify({ model, messages, stream: true, ...reasoning }),
    signal,
  });
  reportRoute(response);
  if (!response.ok) throw new Error(await readErrorMessage(response, fallbackErrorMessage));
  if (!response.body) throw new Error(fallbackErrorMessage);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | undefined;
  let reportedSharedCompletionTokens: number | undefined;
  let content = "";
  let thinking = "";
  const processEvent = (event: string) => {
    const eventName = event
      .split("\n")
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`${fallbackErrorMessage} Invalid stream chunk.`);
    }
    if (eventName === "wsmp.transform") {
      if (parsed && typeof parsed === "object") onTransformDebug?.(parsed as TransformDebug);
      return;
    }
    const metrics = standardizedCompletionTokens(parsed);
    if (metrics !== undefined) reportedSharedCompletionTokens = metrics;
    const delta = completionDeltas(parsed);
    if (delta.content || delta.thinking) firstTokenAt ??= performance.now();
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (delta.thinking) {
      thinking += delta.thinking;
      onThinkingDelta(delta.thinking);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) processEvent(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processEvent(buffer);
  } catch (error) {
    // A malformed chunk must not strand the response body mid-stream.
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  requireChatTestOutput({ content, thinking }, fallbackErrorMessage);
  const completedAt = performance.now();
  const ttftMs = firstTokenAt === undefined ? undefined : firstTokenAt - startedAt;
  const tokensPerSecond =
    reportedSharedCompletionTokens === undefined ||
    firstTokenAt === undefined ||
    completedAt <= firstTokenAt
      ? undefined
      : reportedSharedCompletionTokens / ((completedAt - firstTokenAt) / 1000);
  return { ttftMs, completionTokens: reportedSharedCompletionTokens, tokensPerSecond };
}
