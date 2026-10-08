import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));

import {
  attachmentModalitiesFor,
  chatRequest,
  readTestError,
  streamTestChat,
  summarizeEmbeddings,
  TestRequestError,
} from "./test-relay";

const IMAGE = {
  id: "a1",
  name: "cat.png",
  modality: "image" as const,
  dataUrl: "data:image/png;base64,AAAA",
  sizeBytes: 3,
};

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Test page requests", () => {
  it("offers audio and video attachments on Chat Completions only", () => {
    const target = { capabilities: ["VISION_INPUT", "AUDIO_INPUT", "VIDEO_INPUT"] as const };
    expect(
      attachmentModalitiesFor(
        { capabilities: [...target.capabilities] },
        "OPENAI_CHAT_COMPLETIONS",
      ),
    ).toEqual({
      image: true,
      audio: true,
      video: true,
    });
    expect(
      attachmentModalitiesFor({ capabilities: [...target.capabilities] }, "ANTHROPIC_MESSAGES"),
    ).toEqual({
      image: true,
      audio: false,
      video: false,
    });
  });

  it("shapes each API's request, history and images", () => {
    const turns = [
      { role: "user" as const, content: "look", attachments: [IMAGE] },
      { role: "assistant" as const, content: "a cat" },
      { role: "user" as const, content: "sure?" },
    ];
    const base = { model: "me/chat", turns, system: " Be brief. ", maxTokens: 512 };
    const chat = chatRequest({ ...base, surface: "OPENAI_CHAT_COMPLETIONS", reasoning: {} });
    expect(chat.path).toBe("/chat/completions");
    expect(chat.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: IMAGE.dataUrl } },
        ],
      },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "sure?" },
    ]);
    const responses = chatRequest({
      ...base,
      surface: "OPENAI_RESPONSES",
      reasoning: { reasoning: { effort: "low" } },
    });
    expect(responses.body).toMatchObject({
      instructions: "Be brief.",
      store: false,
      stream: true,
      reasoning: { effort: "low" },
    });
    expect((responses.body.input as unknown[])[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: IMAGE.dataUrl },
      ],
    });
    expect((responses.body.input as unknown[])[1]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "a cat" }],
    });
    const messages = chatRequest({
      ...base,
      surface: "ANTHROPIC_MESSAGES",
      reasoning: { thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 3072 },
    });
    expect(messages.headers).toEqual({ "anthropic-version": "2023-06-01" });
    // The thinking budget needs more room than the chosen max tokens.
    expect(messages.body.max_tokens).toBe(3072);
    expect((messages.body.messages as Array<{ content: unknown[] }>)[0]?.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("sends wav and mp3 as input_audio and other audio as an audio_url", () => {
    const audio = (mime: string) => ({
      ...IMAGE,
      modality: "audio" as const,
      dataUrl: `data:${mime};base64,UklG`,
    });
    const parts = (mime: string) =>
      (
        chatRequest({
          surface: "OPENAI_CHAT_COMPLETIONS",
          model: "m",
          turns: [{ role: "user", content: "", attachments: [audio(mime)] }],
          system: "",
          reasoning: {},
          maxTokens: 1,
        }).body.messages as Array<{ content: unknown[] }>
      )[0]?.content;
    expect(parts("audio/wav")).toEqual([
      { type: "input_audio", input_audio: { data: "UklG", format: "wav" } },
    ]);
    expect(parts("audio/ogg")).toEqual([
      { type: "audio_url", audio_url: { url: "data:audio/ogg;base64,UklG" } },
    ]);
  });

  it("streams a Responses answer with its reasoning summary and token count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          'event: response.reasoning_summary_text.delta\ndata: {"delta":"plan"}\n\n' +
            'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n' +
            'event: response.completed\ndata: {"response":{"usage":{"output_tokens":4}}}\n\n',
        ),
      ),
    );
    const deltas: Array<{ content: string; thinking: string }> = [];
    const metrics = await streamTestChat({
      surface: "OPENAI_RESPONSES",
      request: chatRequest({
        surface: "OPENAI_RESPONSES",
        model: "m",
        turns: [{ role: "user", content: "hi" }],
        system: "",
        reasoning: {},
        maxTokens: 1,
      }),
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
      emptyMessage: "empty",
    });
    expect(deltas).toEqual([
      { content: "", thinking: "plan" },
      { content: "Hi", thinking: "" },
    ]);
    expect(metrics.outputTokens).toBe(4);
  });

  it("turns an error event mid-stream into a request error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Busy"}}\n\n',
        ),
      ),
    );
    await expect(
      streamTestChat({
        surface: "ANTHROPIC_MESSAGES",
        request: chatRequest({
          surface: "ANTHROPIC_MESSAGES",
          model: "m",
          turns: [{ role: "user", content: "hi" }],
          system: "",
          reasoning: {},
          maxTokens: 1,
        }),
        signal: new AbortController().signal,
        onDelta: () => undefined,
        emptyMessage: "empty",
      }),
    ).rejects.toMatchObject({ message: "Busy", code: "overloaded_error" });
  });

  it("reads OpenAI, Anthropic and plain-text error answers", async () => {
    const openAi = await readTestError(
      new Response(
        JSON.stringify({ error: { message: "No.", code: "model_not_found", upstream_error: "x" } }),
        { status: 404 },
      ),
    );
    expect(openAi).toBeInstanceOf(TestRequestError);
    expect(openAi).toMatchObject({
      message: "No.",
      status: 404,
      code: "model_not_found",
      upstream: "x",
    });
    const anthropic = await readTestError(
      new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "Down." } }),
        {
          status: 500,
        },
      ),
    );
    expect(anthropic).toMatchObject({ message: "Down.", code: "api_error", upstream: null });
    const plain = await readTestError(new Response("Bad gateway", { status: 502 }));
    expect(plain).toMatchObject({ message: "Bad gateway", status: 502, code: null });
  });

  it("summarizes vectors without keeping them", () => {
    const summary = summarizeEmbeddings(
      {
        data: [
          { index: 0, embedding: [3, 4] },
          { index: 1, embedding: [4, 3] },
        ],
        usage: { prompt_tokens: 2 },
      },
      12,
    );
    expect(summary.vectors[0]).toEqual({
      index: 0,
      dimensions: 2,
      norm: 5,
      min: 3,
      max: 4,
      head: [3, 4],
    });
    expect(summary.similarity).toBeCloseTo(24 / 25);
    expect(summary.promptTokens).toBe(2);
  });
});
