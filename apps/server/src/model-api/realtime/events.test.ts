import { describe, expect, it } from "vitest";
import {
  audioSeconds,
  committedEvents,
  errorEvent,
  parseRealtimeClientEvent,
  REALTIME_APPEND_BASE64_MAX_BYTES,
  REALTIME_TEXT_FRAME_MAX_BYTES,
  realtimeId,
  sessionCreatedEvent,
  transcriptionCompletedEvents,
} from "./events.js";

function parse(event: unknown) {
  return parseRealtimeClientEvent(JSON.stringify(event));
}

function update(session: unknown, extra: Record<string, unknown> = {}) {
  return parse({ type: "session.update", session, ...extra });
}

describe("realtime client event parsing", () => {
  it("reads a GA transcription session.update", () => {
    expect(
      update(
        {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "whisper", language: "en", prompt: "names" },
              turn_detection: null,
              noise_reduction: null,
            },
          },
          include: [],
        },
        { event_id: "evt_1" },
      ),
    ).toEqual({
      ok: true,
      event: {
        type: "session.update",
        eventId: "evt_1",
        patch: { model: "whisper", language: "en", prompt: "names" },
      },
    });
    expect(update({ type: "transcription" })).toEqual({
      ok: true,
      event: { type: "session.update", patch: {} },
    });
  });

  it.each([
    [{ type: "realtime" }, "unsupported_parameter", "session.type"],
    [{}, "unsupported_parameter", "session.type"],
    [{ type: "transcription", voice: "x" }, "unknown_parameter", "session.voice"],
    [
      { type: "transcription", audio: { input: { turn_detection: { type: "server_vad" } } } },
      "unsupported_parameter",
      "session.audio.input.turn_detection",
    ],
    [
      { type: "transcription", audio: { input: { noise_reduction: { type: "near_field" } } } },
      "unsupported_parameter",
      "session.audio.input.noise_reduction",
    ],
    [
      { type: "transcription", audio: { input: { format: { type: "audio/pcmu" } } } },
      "unsupported_parameter",
      "session.audio.input.format.type",
    ],
    [
      { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 16000 } } } },
      "unsupported_parameter",
      "session.audio.input.format.rate",
    ],
    [
      { type: "transcription", include: ["item.input_audio_transcription.logprobs"] },
      "unsupported_parameter",
      "session.include",
    ],
    [{ type: "transcription", audio: { output: {} } }, "unknown_parameter", "session.audio.output"],
    [
      { type: "transcription", audio: { input: { transcription: { model: "" } } } },
      "invalid_value",
      "session.audio.input.transcription.model",
    ],
    [
      { type: "transcription", audio: { input: { transcription: { language: "en us" } } } },
      "invalid_value",
      "session.audio.input.transcription.language",
    ],
    [
      { type: "transcription", audio: { input: { transcription: { prompt: "x".repeat(4097) } } } },
      "invalid_value",
      "session.audio.input.transcription.prompt",
    ],
    [
      { type: "transcription", audio: { input: { transcription: { delay: "low" } } } },
      "unknown_parameter",
      "session.audio.input.transcription.delay",
    ],
  ])("refuses %j with %s at %s", (session, code, param) => {
    expect(update(session, { event_id: "e1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "invalid_request_error", code, param, eventId: "e1" }),
    });
  });

  it("decodes appends to whole samples only", () => {
    const pcm = Buffer.from([1, 2, 3, 4]).toString("base64");
    const parsed = parse({ type: "input_audio_buffer.append", audio: pcm });
    expect(
      parsed.ok && parsed.event.type === "input_audio_buffer.append" && [...parsed.event.audio],
    ).toEqual([1, 2, 3, 4]);
    for (const audio of ["", Buffer.from([1, 2, 3]).toString("base64"), "not base64!", 5]) {
      expect(parse({ type: "input_audio_buffer.append", audio })).toMatchObject({
        ok: false,
        error: { param: "audio" },
      });
    }
    expect(
      parse({
        type: "input_audio_buffer.append",
        audio: "A".repeat(REALTIME_APPEND_BASE64_MAX_BYTES + 4),
      }),
    ).toMatchObject({ ok: false });
  });

  it("reads commit and clear and refuses extra fields", () => {
    expect(parse({ type: "input_audio_buffer.commit" })).toEqual({
      ok: true,
      event: { type: "input_audio_buffer.commit" },
    });
    expect(parse({ type: "input_audio_buffer.clear", event_id: "c" })).toEqual({
      ok: true,
      event: { type: "input_audio_buffer.clear", eventId: "c" },
    });
    expect(parse({ type: "input_audio_buffer.commit", item_id: "x" })).toMatchObject({
      ok: false,
      error: { code: "unknown_parameter", param: "item_id" },
    });
  });

  it("refuses unknown, unsupported, malformed, oversized and deep events", () => {
    expect(parse({ type: "response.create" })).toMatchObject({
      error: { code: "unsupported_event" },
    });
    expect(parse({ type: "nope" })).toMatchObject({ error: { code: "unknown_event" } });
    expect(parseRealtimeClientEvent("{")).toMatchObject({ error: { code: "invalid_json" } });
    expect(parseRealtimeClientEvent("[]")).toMatchObject({ error: { code: "invalid_event" } });
    expect(parseRealtimeClientEvent("x".repeat(REALTIME_TEXT_FRAME_MAX_BYTES + 1))).toMatchObject({
      error: { code: "event_too_large" },
    });
    let deep: unknown = {};
    for (let index = 0; index < 40; index += 1) deep = { a: deep };
    expect(update(deep)).toMatchObject({ error: { code: "invalid_event" } });
    expect(parse({ type: "input_audio_buffer.commit", event_id: "x".repeat(129) })).toMatchObject({
      error: { code: "invalid_value", param: "event_id" },
    });
    expect(parse({ type: "input_audio_buffer.commit", event_id: 7 })).toMatchObject({
      error: { param: "event_id" },
    });
  });
});

describe("realtime server events", () => {
  it("mints prefixed base62 ids", () => {
    expect(realtimeId("item")).toMatch(/^item_[0-9A-Za-z]{22}$/);
    expect(realtimeId("event")).not.toBe(realtimeId("event"));
  });

  it("describes the session with the server defaults", () => {
    expect(sessionCreatedEvent({ id: "sess_1", model: null }).session).toEqual({
      type: "transcription",
      object: "realtime.transcription_session",
      id: "sess_1",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: null },
          turn_detection: null,
          noise_reduction: null,
        },
      },
      include: [],
    });
  });

  it("builds committed, completed and error events", () => {
    const [committed, added] = committedEvents("item_b", "item_a");
    expect(committed).toMatchObject({
      type: "input_audio_buffer.committed",
      item_id: "item_b",
      previous_item_id: "item_a",
    });
    expect(added).toMatchObject({ type: "conversation.item.added", item: { id: "item_b" } });
    const [completed, done] = transcriptionCompletedEvents("item_b", "item_a", "hi", 72_000);
    expect(completed).toMatchObject({
      transcript: "hi",
      content_index: 0,
      usage: { type: "duration", seconds: 1.5 },
    });
    expect(done).toMatchObject({
      type: "conversation.item.done",
      item: { content: [{ type: "input_audio", transcript: "hi" }] },
    });
    expect(audioSeconds(48_000 + 239)).toBe(1);
    expect(audioSeconds(48_000 + 241)).toBe(1.01);
    expect(errorEvent({ type: "server_error", code: "x", message: "m" }).error).toEqual({
      type: "server_error",
      code: "x",
      message: "m",
      param: null,
      event_id: null,
    });
  });
});
