import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { env } from "@ws-model-proxy/env/web";

import type { AttachmentModalities, AttachmentModality } from "@/lib/image-attachments";
import {
  anthropicEventDeltas,
  completionDeltas,
  responsesEventDeltas,
  streamErrorMessage,
  streamedOutputTokens,
  type TestTranscript,
} from "@/lib/test-reasoning";

/**
 * The Test page's requests: the `/v1` request APIs behind the dashboard session
 * (`/api/internal/chat-test/*`, source TEST), streamed where the API streams.
 */

export type TestTarget = Awaited<
  ReturnType<AppRouterClient["models"]["testTargets"]>
>["targets"][number];
export type TestSurface = TestTarget["surfaces"][number];
export type TestKind = "chat" | "embeddings" | "transcription";

const KIND_FOR_TYPE: Record<TestTarget["type"], TestKind> = {
  LLM: "chat",
  EMBEDDINGS: "embeddings",
  TRANSCRIPTION: "transcription",
};

/** A target's test kind follows from what it serves. */
export function testKindOf(target: Pick<TestTarget, "type">): TestKind {
  return KIND_FOR_TYPE[target.type];
}

/**
 * What a chat turn may attach on this target and API: images with vision; audio and video only
 * on Chat Completions (the other APIs take images only).
 */
export function attachmentModalitiesFor(
  target: Pick<TestTarget, "capabilities">,
  surface: TestSurface,
): AttachmentModalities {
  const caps = new Set(target.capabilities);
  const chat = surface === "OPENAI_CHAT_COMPLETIONS";
  return {
    image: caps.has("VISION_INPUT"),
    audio: chat && caps.has("AUDIO_INPUT"),
    video: chat && caps.has("VIDEO_INPUT"),
  };
}

const TEST_BASE = "/api/internal/chat-test";

function testUrl(path: string): string {
  return `${env.VITE_SERVER_URL}${TEST_BASE}${path}`;
}

/** A failed Test request: HTTP status, the server's message and code, and the runtime's own. */
export class TestRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  /** The runtime's own error (redacted excerpt), when the server had one. */
  readonly upstream: string | null;

  constructor(input: {
    message: string;
    status?: number | null;
    code?: string | null;
    upstream?: string | null;
  }) {
    super(input.message);
    this.name = "TestRequestError";
    this.status = input.status ?? null;
    this.code = input.code ?? null;
    this.upstream = input.upstream ?? null;
  }
}

/** What the Test page shows of a failed request. */
export type TestErrorInfo = {
  message: string;
  status: number | null;
  code: string | null;
  upstream: string | null;
};

/** Any thrown value as the Test page's error notice input. */
export function testErrorOf(error: unknown): TestErrorInfo {
  if (error instanceof TestRequestError) {
    return {
      message: error.message,
      status: error.status,
      code: error.code,
      upstream: error.upstream,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    status: null,
    code: null,
    upstream: null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Characters of a non-JSON error body shown as is. */
const RAW_ERROR_CHARS = 300;

/** Reads an error answer (OpenAI or Anthropic shape, or plain text). */
export async function readTestError(response: Response): Promise<TestRequestError> {
  const raw = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const error = record(record(parsed)?.error);
  const message =
    str(error?.message) ??
    str(record(parsed)?.message) ??
    str(record(parsed)?.detail) ??
    (raw.trim().slice(0, RAW_ERROR_CHARS) || response.statusText || `HTTP ${response.status}`);
  return new TestRequestError({
    message,
    status: response.status,
    code: str(error?.code) ?? str(error?.type),
    upstream: str(error?.upstream_error),
  });
}

// ── Chat ──

export type TestAttachment = {
  id: string;
  name: string;
  modality: AttachmentModality;
  /** `data:` URL (inline; the Test page does not use the media store). */
  dataUrl: string;
  sizeBytes: number;
};

export type TestChatTurn = {
  role: "user" | "assistant";
  content: string;
  attachments?: TestAttachment[];
};

export type ChatMetrics = {
  ttftMs?: number;
  totalMs: number;
  outputTokens?: number;
  tokensPerSecond?: number;
};

function dataUrlParts(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(dataUrl);
  return { mediaType: match?.[1] ?? "application/octet-stream", data: match?.[2] ?? "" };
}

function chatCompletionsMessages(turns: TestChatTurn[], system: string) {
  const messages = turns.map((turn) => {
    if (!turn.attachments?.length) return { role: turn.role, content: turn.content };
    return {
      role: turn.role,
      content: [
        ...(turn.content ? [{ type: "text", text: turn.content }] : []),
        ...turn.attachments.map((attachment) =>
          attachment.modality === "image"
            ? { type: "image_url", image_url: { url: attachment.dataUrl } }
            : attachment.modality === "audio"
              ? { type: "input_audio_url", input_audio: { url: attachment.dataUrl } }
              : { type: "video_url", video_url: { url: attachment.dataUrl } },
        ),
      ],
    };
  });
  return system ? [{ role: "system", content: system }, ...messages] : messages;
}

function responsesInput(turns: TestChatTurn[]) {
  return turns.map((turn) => ({
    role: turn.role,
    content: [
      ...(turn.content
        ? [{ type: turn.role === "assistant" ? "output_text" : "input_text", text: turn.content }]
        : []),
      ...(turn.attachments ?? [])
        .filter((attachment) => attachment.modality === "image")
        .map((attachment) => ({ type: "input_image", image_url: attachment.dataUrl })),
    ],
  }));
}

function anthropicMessages(turns: TestChatTurn[]) {
  return turns.map((turn) => ({
    role: turn.role,
    content: [
      ...(turn.content ? [{ type: "text", text: turn.content }] : []),
      ...(turn.attachments ?? [])
        .filter((attachment) => attachment.modality === "image")
        .map((attachment) => {
          const { mediaType, data } = dataUrlParts(attachment.dataUrl);
          return { type: "image", source: { type: "base64", media_type: mediaType, data } };
        }),
    ],
  }));
}

/** The request path and body for one chat turn on one API. */
export function chatRequest({
  surface,
  model,
  turns,
  system,
  reasoning,
  maxTokens,
}: {
  surface: TestSurface;
  model: string;
  turns: TestChatTurn[];
  system: string;
  /** Already encoded for the surface (`encodeReasoning`). */
  reasoning: Record<string, unknown>;
  maxTokens: number;
}): { path: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const trimmed = system.trim();
  if (surface === "OPENAI_RESPONSES") {
    return {
      path: "/responses",
      headers: {},
      body: {
        model,
        input: responsesInput(turns),
        ...(trimmed ? { instructions: trimmed } : {}),
        stream: true,
        store: false,
        ...reasoning,
      },
    };
  }
  if (surface === "ANTHROPIC_MESSAGES") {
    const reasoningMax = typeof reasoning.max_tokens === "number" ? reasoning.max_tokens : 0;
    return {
      path: "/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model,
        messages: anthropicMessages(turns),
        ...(trimmed ? { system: trimmed } : {}),
        stream: true,
        ...reasoning,
        // Messages requires max_tokens; a thinking budget needs room above it.
        max_tokens: Math.max(maxTokens, reasoningMax),
      },
    };
  }
  return {
    path: "/chat/completions",
    headers: {},
    body: {
      model,
      messages: chatCompletionsMessages(turns, trimmed),
      stream: true,
      stream_options: { include_usage: true },
      ...reasoning,
    },
  };
}

/** Splits an SSE buffer into complete events; the remainder is returned. */
function takeEvents(buffer: string): {
  events: Array<{ type: string; data: string }>;
  rest: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  return {
    events: chunks.map((chunk) => {
      const lines = chunk.split("\n");
      return {
        type:
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "",
        data: lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim(),
      };
    }),
    rest,
  };
}

function deltasFor(surface: TestSurface, type: string, value: unknown): TestTranscript {
  if (surface === "OPENAI_RESPONSES") {
    const eventType = type || String(record(value)?.type ?? "");
    return responsesEventDeltas(eventType, value);
  }
  if (surface === "ANTHROPIC_MESSAGES") {
    const eventType = type || String(record(value)?.type ?? "");
    return anthropicEventDeltas(eventType, value);
  }
  return completionDeltas(value);
}

/**
 * Sends one chat turn and streams the answer: `onDelta` gets visible text and reasoning as they
 * arrive. Throws a `TestRequestError` for an error answer or an error event.
 */
export async function streamTestChat({
  surface,
  request,
  signal,
  onDelta,
  emptyMessage,
}: {
  surface: TestSurface;
  request: ReturnType<typeof chatRequest>;
  signal: AbortSignal;
  onDelta: (delta: TestTranscript) => void;
  /** The message for a successful answer with no text at all. */
  emptyMessage: string;
}): Promise<ChatMetrics> {
  const startedAt = performance.now();
  const response = await fetch(testUrl(request.path), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...request.headers },
    body: JSON.stringify(request.body),
    signal,
  });
  if (!response.ok) throw await readTestError(response);
  if (!response.body) throw new TestRequestError({ message: emptyMessage });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | undefined;
  let outputTokens: number | undefined;
  let received = false;
  const handle = ({ type, data }: { type: string; data: string }) => {
    if (!data || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    const eventType = type || String(record(value)?.type ?? "");
    const failure = streamErrorMessage(eventType, value);
    if (failure) {
      const error = record(record(value)?.error);
      throw new TestRequestError({
        message: failure,
        code: str(error?.code) ?? str(error?.type),
        upstream: str(error?.upstream_error),
      });
    }
    outputTokens = streamedOutputTokens(eventType, value) ?? outputTokens;
    const delta = deltasFor(surface, type, value);
    if (delta.content || delta.thinking) {
      firstTokenAt ??= performance.now();
      received = true;
      onDelta(delta);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = takeEvents(buffer);
      buffer = rest;
      for (const event of events) handle(event);
    }
    buffer += decoder.decode();
    for (const event of takeEvents(`${buffer}\n\n`).events) handle(event);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!received) throw new TestRequestError({ message: emptyMessage });
  const finishedAt = performance.now();
  const ttftMs = firstTokenAt === undefined ? undefined : firstTokenAt - startedAt;
  const decodeSeconds = firstTokenAt === undefined ? 0 : (finishedAt - firstTokenAt) / 1000;
  return {
    ttftMs,
    totalMs: finishedAt - startedAt,
    outputTokens,
    tokensPerSecond:
      outputTokens !== undefined && decodeSeconds > 0 ? outputTokens / decodeSeconds : undefined,
  };
}

// ── Embeddings ──

export type EmbeddingSummary = {
  vectors: Array<{
    index: number;
    dimensions: number;
    norm: number;
    min: number;
    max: number;
    /** The first values, for a glance. */
    head: number[];
  }>;
  /** Cosine similarity of the first two inputs, when there are two or more. */
  similarity: number | null;
  promptTokens: number | null;
  latencyMs: number;
};

const HEAD_VALUES = 8;

function cosine(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let at = 0; at < left.length; at += 1) {
    const a = left[at] ?? 0;
    const b = right[at] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : null;
}

/** A short summary of an embeddings answer (never the whole vectors). */
export function summarizeEmbeddings(payload: unknown, latencyMs: number): EmbeddingSummary {
  const root = record(payload);
  const rows = Array.isArray(root?.data) ? root.data : [];
  const vectors = rows.flatMap((row, position) => {
    const entry = record(row);
    const embedding = entry?.embedding;
    if (!Array.isArray(embedding)) return [];
    const values = embedding.filter((value): value is number => typeof value === "number");
    return [
      {
        index: typeof entry?.index === "number" ? entry.index : position,
        values,
      },
    ];
  });
  const usage = record(root?.usage);
  return {
    vectors: vectors.map(({ index, values }) => ({
      index,
      dimensions: values.length,
      norm: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)),
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      head: values.slice(0, HEAD_VALUES),
    })),
    similarity:
      vectors.length >= 2 && vectors[0] && vectors[1]
        ? cosine(vectors[0].values, vectors[1].values)
        : null,
    promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    latencyMs,
  };
}

export async function sendTestEmbeddings({
  model,
  inputs,
  signal,
}: {
  model: string;
  inputs: string[];
  signal?: AbortSignal;
}): Promise<EmbeddingSummary> {
  const startedAt = performance.now();
  const response = await fetch(testUrl("/embeddings"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
    signal,
  });
  if (!response.ok) throw await readTestError(response);
  const payload: unknown = await response.json();
  return summarizeEmbeddings(payload, performance.now() - startedAt);
}

// ── Transcription ──

export type TranscriptionResult = { text: string; latencyMs: number };

export async function sendTestTranscription({
  model,
  file,
  language,
  signal,
}: {
  model: string;
  file: File;
  language?: string;
  signal?: AbortSignal;
}): Promise<TranscriptionResult> {
  const startedAt = performance.now();
  const form = new FormData();
  form.set("model", model);
  form.set("file", file, file.name);
  form.set("response_format", "json");
  if (language) form.set("language", language);
  const response = await fetch(testUrl("/audio/transcriptions"), {
    method: "POST",
    credentials: "include",
    body: form,
    signal,
  });
  if (!response.ok) throw await readTestError(response);
  const raw = await response.text();
  let text = raw;
  try {
    text = str(record(JSON.parse(raw))?.text) ?? "";
  } catch {
    // A plain-text answer is the transcript.
  }
  return { text, latencyMs: performance.now() - startedAt };
}
