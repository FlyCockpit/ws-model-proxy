import { describe, expect, it } from "vitest";

import {
  initialRealtimeState,
  liveModelOptions,
  micProblem,
  pcm16Base64,
  problemMessageKey,
  REALTIME_ITEMS_MAX,
  realtimeReducer,
  realtimeSocketUrl,
} from "./realtime-transcription";

describe("realtime transcription helpers", () => {
  it("builds the same-origin Chat Test socket URL, with only the intent and model", () => {
    const url = realtimeSocketUrl("owner/asr pool", {
      href: "https://proxy.example.com/en-US/dashboard/chat-test?x=1",
      protocol: "https:",
    });
    expect(url).toBe(
      "wss://proxy.example.com/api/internal/chat-test/realtime?intent=transcription&model=owner%2Fasr+pool",
    );
    expect(realtimeSocketUrl("m", { href: "http://localhost:3001/x", protocol: "http:" })).toMatch(
      /^ws:\/\/localhost:3001\/api\/internal\/chat-test\/realtime\?/,
    );
  });

  it("offers only the models that advertise live transcription", () => {
    const visible = {
      directModels: [
        { modelId: "me/asr", upstreamModelId: "whisper", realtimeTranscription: true },
        { modelId: "me/chat", upstreamModelId: "llm", realtimeTranscription: false },
      ],
      modelPools: [
        { modelId: "team/asr", name: "Team ASR", realtimeTranscription: true },
        { modelId: "team/chat", name: "Team chat", realtimeTranscription: false },
      ],
    } as unknown as Parameters<typeof liveModelOptions>[0];
    expect(liveModelOptions(visible)).toEqual([
      { modelId: "me/asr", label: "whisper" },
      { modelId: "team/asr", label: "Team ASR" },
    ]);
    expect(liveModelOptions(undefined)).toEqual([]);
  });

  it("base64-encodes PCM, including buffers larger than one chunk", () => {
    const small = new Int16Array([1, -1]).buffer;
    expect(pcm16Base64(small)).toBe(Buffer.from(small).toString("base64"));
    const large = new Uint8Array(100_000).map((_, index) => index % 251).buffer;
    expect(pcm16Base64(large)).toBe(Buffer.from(large).toString("base64"));
  });

  it("maps microphone errors and problems to message keys", () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(micProblem(named("NotAllowedError"))).toEqual({ kind: "mic", reason: "denied" });
    expect(micProblem(named("NotFoundError"))).toEqual({ kind: "mic", reason: "missing" });
    expect(micProblem(named("AbortError"))).toEqual({ kind: "mic", reason: "failed" });
    expect(problemMessageKey({ kind: "mic", reason: "denied" })).toBe("mic.denied");
    expect(problemMessageKey({ kind: "server", code: "dashboard_session_ended" })).toBe(
      "signedOut",
    );
    expect(problemMessageKey({ kind: "server", code: "something_new" })).toBe("server");
    expect(problemMessageKey({ kind: "close", code: 1013 })).toBe("busy");
    expect(problemMessageKey({ kind: "close", code: 1006 })).toBe("connection");
  });
});

describe("realtimeReducer", () => {
  const live = realtimeReducer(realtimeReducer(initialRealtimeState, { type: "starting" }), {
    type: "event",
    event: { type: "session.created" },
  });

  it("goes live on session.created and builds items from deltas and results", () => {
    expect(live.phase).toBe("live");
    let state = realtimeReducer(live, {
      type: "event",
      event: {
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_1",
        delta: "hel",
      },
    });
    state = realtimeReducer(state, {
      type: "event",
      event: { type: "input_audio_buffer.committed", item_id: "item_1" },
    });
    state = realtimeReducer(state, {
      type: "event",
      event: {
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item_1",
        delta: "lo",
      },
    });
    expect(state.items).toEqual([{ id: "item_1", text: "hello", status: "transcribing" }]);
    state = realtimeReducer(state, {
      type: "event",
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item_1",
        transcript: "Hello.",
        usage: { type: "duration", seconds: 1.25 },
      },
    });
    state = realtimeReducer(state, {
      type: "event",
      event: { type: "conversation.item.input_audio_transcription.failed", item_id: "item_2" },
    });
    expect(state.items).toEqual([
      { id: "item_1", text: "Hello.", status: "done", seconds: 1.25 },
      { id: "item_2", text: "", status: "failed" },
    ]);
  });

  it("keeps a bounded list and ignores malformed events", () => {
    let state = live;
    for (let index = 0; index < REALTIME_ITEMS_MAX + 5; index += 1) {
      state = realtimeReducer(state, {
        type: "event",
        event: { type: "input_audio_buffer.committed", item_id: `item_${index}` },
      });
    }
    expect(state.items).toHaveLength(REALTIME_ITEMS_MAX);
    expect(state.items[0]?.id).toBe("item_5");
    expect(realtimeReducer(state, { type: "event", event: "nope" })).toBe(state);
    expect(realtimeReducer(state, { type: "event", event: { type: "unknown" } })).toBe(state);
  });

  it("keeps the server's error through the close that follows it", () => {
    const errored = realtimeReducer(live, {
      type: "event",
      event: { type: "error", error: { code: "server_busy", message: "busy" } },
    });
    const closed = realtimeReducer(errored, { type: "closed", code: 1013, requested: false });
    expect(closed).toMatchObject({
      phase: "failed",
      problem: { kind: "server", code: "server_busy" },
    });
    const bare = realtimeReducer(live, { type: "closed", code: 1006, requested: false });
    expect(bare).toMatchObject({ phase: "failed", problem: { kind: "close", code: 1006 } });
    expect(realtimeReducer(live, { type: "closed", code: 1005, requested: true }).phase).toBe(
      "stopped",
    );
    expect(realtimeReducer(live, { type: "closed", code: 1000, requested: false }).phase).toBe(
      "stopped",
    );
    expect(
      realtimeReducer(initialRealtimeState, { type: "closed", code: 1000, requested: true }),
    ).toBe(initialRealtimeState);
  });
});
