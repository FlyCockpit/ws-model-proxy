import { randomBytes } from "node:crypto";
import { sttConfigSchema } from "../../relay/stt-protocol.js";
import { requestJsonDepthExceeded } from "../request-json-depth.js";

/**
 * Event codecs for `/v1/realtime?intent=transcription`: the OpenAI Realtime
 * GA transcription subset (design §2). Parsing is strict and reports OpenAI
 * style errors (`invalid_request_error`, a code, the offending `param`, and
 * the client's `event_id`). Nothing here logs; event text never leaves the
 * returned values.
 */

/** OpenAI allows 15 MiB; ours fits the shared WebSocket `maxPayload`. */
export const REALTIME_APPEND_BASE64_MAX_BYTES = 512 * 1024;
/** A text frame: one maximal append plus its JSON envelope. */
export const REALTIME_TEXT_FRAME_MAX_BYTES = REALTIME_APPEND_BASE64_MAX_BYTES + 4 * 1024;
export const REALTIME_EVENT_ID_MAX_LENGTH = 128;
export const REALTIME_MODEL_MAX_BYTES = 256;
const REALTIME_JSON_MAX_DEPTH = 16;
/** 24 kHz s16le mono. */
export const REALTIME_PCM_RATE = 24_000;
export const REALTIME_PCM_BYTES_PER_SECOND = 48_000;

export type RealtimeErrorType = "invalid_request_error" | "server_error";

export type RealtimeError = {
  type: RealtimeErrorType;
  code: string;
  message: string;
  param?: string;
  eventId?: string;
};

export type RealtimeSessionPatch = {
  model?: string;
  language?: string;
  prompt?: string;
};

export type RealtimeClientEvent =
  | { type: "session.update"; eventId?: string; patch: RealtimeSessionPatch }
  | { type: "input_audio_buffer.append"; eventId?: string; audio: Uint8Array }
  | { type: "input_audio_buffer.commit"; eventId?: string }
  | { type: "input_audio_buffer.clear"; eventId?: string };

export type RealtimeParseResult =
  | { ok: true; event: RealtimeClientEvent }
  | { ok: false; error: RealtimeError };

/** Client events of the full Realtime API this subset does not serve. */
const UNSUPPORTED_EVENTS = new Set([
  "transcription_session.update",
  "response.create",
  "response.cancel",
  "conversation.item.create",
  "conversation.item.retrieve",
  "conversation.item.truncate",
  "conversation.item.delete",
  "output_audio_buffer.clear",
]);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `<prefix>_<22 base62>`, unbiased. */
export function realtimeId(prefix: "event" | "item" | "sess"): string {
  let out = "";
  while (out.length < 22) {
    for (const byte of randomBytes(32)) {
      if (byte >= 248) continue; // 248 = 62 * 4
      out += BASE62[byte % 62];
      if (out.length === 22) break;
    }
  }
  return `${prefix}_${out}`;
}

const encoder = new TextEncoder();
function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ParseFailure extends Error {
  constructor(readonly detail: Omit<RealtimeError, "eventId" | "type">) {
    super(detail.message);
  }
}

function invalid(code: string, message: string, param?: string): never {
  throw new ParseFailure({ code, message, ...(param ? { param } : {}) });
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      const param = `${path}${key}`.slice(0, 200);
      invalid("unknown_parameter", `Unknown parameter: '${param}'.`, param);
    }
  }
}

function unsupported(param: string, message: string): never {
  invalid("unsupported_parameter", message, param);
}

function parseSessionPatch(session: unknown): RealtimeSessionPatch {
  if (!isRecord(session)) invalid("invalid_type", "'session' must be an object.", "session");
  onlyKeys(session, ["type", "audio", "include"], "session.");
  if (session.type !== "transcription") {
    unsupported(
      "session.type",
      "Only transcription sessions are supported here (type 'transcription').",
    );
  }
  if (session.include !== undefined && session.include !== null) {
    if (!Array.isArray(session.include)) {
      invalid("invalid_type", "'session.include' must be an array.", "session.include");
    }
    if (session.include.length > 0) {
      unsupported("session.include", "Log probabilities are not supported.");
    }
  }
  const patch: RealtimeSessionPatch = {};
  if (session.audio === undefined) return patch;
  if (!isRecord(session.audio)) {
    invalid("invalid_type", "'session.audio' must be an object.", "session.audio");
  }
  onlyKeys(session.audio, ["input"], "session.audio.");
  const input = session.audio.input;
  if (input === undefined) return patch;
  if (!isRecord(input)) {
    invalid("invalid_type", "'session.audio.input' must be an object.", "session.audio.input");
  }
  onlyKeys(
    input,
    ["format", "transcription", "turn_detection", "noise_reduction"],
    "session.audio.input.",
  );
  if (input.format !== undefined) {
    const format = input.format;
    if (!isRecord(format)) {
      invalid("invalid_type", "'format' must be an object.", "session.audio.input.format");
    }
    onlyKeys(format, ["type", "rate"], "session.audio.input.format.");
    if (format.type !== "audio/pcm") {
      unsupported(
        "session.audio.input.format.type",
        "Only 'audio/pcm' (24 kHz, 16-bit, mono) input is supported.",
      );
    }
    if (format.rate !== undefined && format.rate !== REALTIME_PCM_RATE) {
      unsupported("session.audio.input.format.rate", "Only a 24000 Hz input rate is supported.");
    }
  }
  if (input.turn_detection !== undefined && input.turn_detection !== null) {
    unsupported(
      "session.audio.input.turn_detection",
      "Voice activity detection is not supported; set turn_detection to null and commit turns.",
    );
  }
  if (input.noise_reduction !== undefined && input.noise_reduction !== null) {
    unsupported("session.audio.input.noise_reduction", "Noise reduction is not supported.");
  }
  if (input.transcription !== undefined) {
    const transcription = input.transcription;
    const path = "session.audio.input.transcription";
    if (!isRecord(transcription))
      invalid("invalid_type", "'transcription' must be an object.", path);
    onlyKeys(transcription, ["model", "language", "prompt"], `${path}.`);
    if (transcription.model !== undefined) {
      const model = transcription.model;
      if (
        typeof model !== "string" ||
        model.length === 0 ||
        !model.isWellFormed() ||
        utf8Bytes(model) > REALTIME_MODEL_MAX_BYTES ||
        model.includes("\0")
      ) {
        invalid("invalid_value", "'model' must be a model name.", `${path}.model`);
      }
      patch.model = model;
    }
    if (transcription.language !== undefined) {
      const language = transcription.language;
      if (typeof language !== "string" || !sttConfigSchema.safeParse({ language }).success) {
        invalid("invalid_value", "'language' must be a language code.", `${path}.language`);
      }
      patch.language = language;
    }
    if (transcription.prompt !== undefined) {
      const prompt = transcription.prompt;
      if (typeof prompt !== "string" || !sttConfigSchema.safeParse({ prompt }).success) {
        invalid("invalid_value", "'prompt' must be text of at most 4096 bytes.", `${path}.prompt`);
      }
      patch.prompt = prompt;
    }
  }
  return patch;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function parseAudio(audio: unknown): Uint8Array {
  if (typeof audio !== "string") invalid("invalid_type", "'audio' must be base64 text.", "audio");
  if (audio.length > REALTIME_APPEND_BASE64_MAX_BYTES) {
    invalid(
      "invalid_value",
      `'audio' exceeds ${REALTIME_APPEND_BASE64_MAX_BYTES} base64 characters; send smaller appends.`,
      "audio",
    );
  }
  if (audio.length === 0 || audio.length % 4 !== 0 || !BASE64.test(audio)) {
    invalid("invalid_value", "'audio' must be non-empty base64.", "audio");
  }
  const bytes = Buffer.from(audio, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    invalid("invalid_value", "'audio' must hold whole 16-bit samples.", "audio");
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** One text frame from the client. */
export function parseRealtimeClientEvent(text: string): RealtimeParseResult {
  if (
    text.length > REALTIME_TEXT_FRAME_MAX_BYTES ||
    utf8Bytes(text) > REALTIME_TEXT_FRAME_MAX_BYTES
  ) {
    return {
      ok: false,
      error: {
        type: "invalid_request_error",
        code: "event_too_large",
        message: `Events are limited to ${REALTIME_TEXT_FRAME_MAX_BYTES} bytes.`,
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        type: "invalid_request_error",
        code: "invalid_json",
        message: "The event is not valid JSON.",
      },
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: {
        type: "invalid_request_error",
        code: "invalid_event",
        message: "An event must be a JSON object.",
      },
    };
  }
  const rawEventId = value.event_id;
  const eventId =
    typeof rawEventId === "string" &&
    rawEventId.length > 0 &&
    rawEventId.length <= REALTIME_EVENT_ID_MAX_LENGTH &&
    rawEventId.isWellFormed()
      ? rawEventId
      : undefined;
  const fail = (detail: Omit<RealtimeError, "eventId" | "type">): RealtimeParseResult => ({
    ok: false,
    error: { type: "invalid_request_error", ...detail, ...(eventId ? { eventId } : {}) },
  });
  if (requestJsonDepthExceeded(value, REALTIME_JSON_MAX_DEPTH)) {
    return fail({ code: "invalid_event", message: "The event is nested too deeply." });
  }
  if (rawEventId !== undefined && eventId === undefined) {
    return fail({
      code: "invalid_value",
      message: `'event_id' must be a string of at most ${REALTIME_EVENT_ID_MAX_LENGTH} characters.`,
      param: "event_id",
    });
  }
  const type = value.type;
  if (typeof type !== "string") {
    return fail({ code: "invalid_event", message: "The event has no 'type'.", param: "type" });
  }
  const withId = eventId ? { eventId } : {};
  try {
    switch (type) {
      case "session.update":
        onlyKeys(value, ["type", "event_id", "session"], "");
        return { ok: true, event: { type, ...withId, patch: parseSessionPatch(value.session) } };
      case "input_audio_buffer.append":
        onlyKeys(value, ["type", "event_id", "audio"], "");
        return { ok: true, event: { type, ...withId, audio: parseAudio(value.audio) } };
      case "input_audio_buffer.commit":
      case "input_audio_buffer.clear":
        onlyKeys(value, ["type", "event_id"], "");
        return { ok: true, event: { type, ...withId } };
      default:
        if (UNSUPPORTED_EVENTS.has(type)) {
          return fail({
            code: "unsupported_event",
            message: "Transcription sessions do not support this event.",
            param: "type",
          });
        }
        return fail({ code: "unknown_event", message: "Unknown event type.", param: "type" });
    }
  } catch (error) {
    if (error instanceof ParseFailure) return fail(error.detail);
    throw error;
  }
}

// ---- server events ----

export type RealtimeSessionView = {
  id: string;
  model: string | null;
  language?: string;
  prompt?: string;
};

function sessionObject(view: RealtimeSessionView) {
  return {
    type: "transcription",
    object: "realtime.transcription_session",
    id: view.id,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: REALTIME_PCM_RATE },
        transcription: {
          model: view.model,
          ...(view.language !== undefined ? { language: view.language } : {}),
          ...(view.prompt !== undefined ? { prompt: view.prompt } : {}),
        },
        turn_detection: null,
        noise_reduction: null,
      },
    },
    include: [],
  };
}

export function sessionCreatedEvent(view: RealtimeSessionView) {
  return { type: "session.created", event_id: realtimeId("event"), session: sessionObject(view) };
}

export function sessionUpdatedEvent(view: RealtimeSessionView) {
  return { type: "session.updated", event_id: realtimeId("event"), session: sessionObject(view) };
}

function userAudioItem(
  itemId: string,
  status: "in_progress" | "completed",
  transcript: string | null,
) {
  return {
    id: itemId,
    object: "realtime.item",
    type: "message",
    status,
    role: "user",
    content: [{ type: "input_audio", transcript }],
  };
}

/** `input_audio_buffer.committed` then `conversation.item.added`. */
export function committedEvents(itemId: string, previousItemId: string | null) {
  return [
    {
      type: "input_audio_buffer.committed",
      event_id: realtimeId("event"),
      previous_item_id: previousItemId,
      item_id: itemId,
    },
    {
      type: "conversation.item.added",
      event_id: realtimeId("event"),
      previous_item_id: previousItemId,
      item: userAudioItem(itemId, "completed", null),
    },
  ];
}

export function clearedEvent() {
  return { type: "input_audio_buffer.cleared", event_id: realtimeId("event") };
}

export function transcriptionDeltaEvent(itemId: string, delta: string) {
  return {
    type: "conversation.item.input_audio_transcription.delta",
    event_id: realtimeId("event"),
    item_id: itemId,
    content_index: 0,
    delta,
  };
}

/** Seconds of audio, rounded to 0.01 s, from forwarded PCM bytes. */
export function audioSeconds(bytes: number): number {
  return Math.round((bytes / REALTIME_PCM_BYTES_PER_SECOND) * 100) / 100;
}

/** `...transcription.completed` then `conversation.item.done`. */
export function transcriptionCompletedEvents(
  itemId: string,
  previousItemId: string | null,
  transcript: string,
  audioBytes: number,
) {
  return [
    {
      type: "conversation.item.input_audio_transcription.completed",
      event_id: realtimeId("event"),
      item_id: itemId,
      content_index: 0,
      transcript,
      usage: { type: "duration", seconds: audioSeconds(audioBytes) },
    },
    {
      type: "conversation.item.done",
      event_id: realtimeId("event"),
      previous_item_id: previousItemId,
      item: userAudioItem(itemId, "completed", transcript),
    },
  ];
}

export function transcriptionFailedEvent(itemId: string, code: string, message: string) {
  return {
    type: "conversation.item.input_audio_transcription.failed",
    event_id: realtimeId("event"),
    item_id: itemId,
    content_index: 0,
    error: { type: "transcription_error", code, message },
  };
}

export function errorEvent(error: RealtimeError) {
  return {
    type: "error",
    event_id: realtimeId("event"),
    error: {
      type: error.type,
      code: error.code,
      message: error.message,
      param: error.param ?? null,
      event_id: error.eventId ?? null,
    },
  };
}
