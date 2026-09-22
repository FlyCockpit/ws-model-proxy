import { describe, expect, it } from "vitest";
import {
  adaptNonstreamResponse,
  createProtocolAdaptationTransform,
  parseCanonicalRequest,
  renderCanonicalRequest,
} from "./adaptation.js";
import { CanonicalStreamParser } from "./streams.js";

const vendorMessage = {
  annotations: [] as unknown[],
  audio: null,
  content: "pong",
  function_call: null,
  reasoning: "hidden",
  refusal: null,
  role: "assistant",
};

const vendorChoice = {
  index: 0,
  message: vendorMessage,
  finish_reason: "stop" as const,
  logprobs: null,
};

const vendorChatCompletion = {
  id: "c",
  object: "chat.completion",
  created: 0,
  model: "gpt",
  choices: [vendorChoice],
  usage: {
    prompt_tokens: 19,
    completion_tokens: 32,
    total_tokens: 51,
    prompt_tokens_details: null,
  },
};

describe("protocol adaptation orchestration", () => {
  it("parses once and renders the requested model without mutating canonical state", () => {
    const canonical = parseCanonicalRequest("openai-chat", {
      model: "pool",
      messages: [{ role: "user", content: "hello" }],
    });
    const before = structuredClone(canonical);
    expect(
      renderCanonicalRequest({ request: canonical, target: "openai-responses", model: "up" }),
    ).toMatchObject({ model: "up", input: [{ role: "user" }] });
    expect(canonical).toEqual(before);
  });

  it("renders nonstream responses into the requested envelope", () => {
    const result = adaptNonstreamResponse({
      source: "openai-chat",
      target: "openai-responses",
      status: 200,
      body: {
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "gpt",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toMatchObject({ object: "response", status: "completed" });
  });

  it("adapts a Chat Completions body that carries ignorable vendor fields", () => {
    for (const target of ["openai-responses", "anthropic-messages"] as const) {
      const result = adaptNonstreamResponse({
        source: "openai-chat",
        target,
        status: 200,
        body: vendorChatCompletion,
      });
      expect(result.ok, target).toBe(true);
      if (result.ok) {
        expect(JSON.stringify(result.body)).toContain("pong");
        expect(JSON.stringify(result.body)).not.toContain("hidden");
      }
    }
  });

  it("accepts prompt token details only in the cached-token shape", () => {
    const withDetails = (prompt_tokens_details: unknown) =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          usage: { ...vendorChatCompletion.usage, prompt_tokens_details },
        },
      });
    expect(withDetails({ cached_tokens: 4 }).ok).toBe(true);
    expect(() => withDetails({ cached_tokens: 4, audio_tokens: 0 })).toThrow(/audio_tokens/u);
  });

  it("still rejects a present non-null Chat Completions field outside the ignorable set", () => {
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, audio: { id: "clip" } },
            },
          ],
        },
      }),
    ).toThrow(/audio/u);
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "openai-responses",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, extra_vendor_field: true },
            },
          ],
        },
      }),
    ).toThrow(/extra_vendor_field/u);
  });

  it("rejects reasoning text when it is the only visible answer", () => {
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "anthropic-messages",
        status: 200,
        body: {
          ...vendorChatCompletion,
          choices: [
            {
              ...vendorChoice,
              message: { ...vendorMessage, content: null },
            },
          ],
        },
      }),
    ).toThrow(/only visible text/u);
  });

  it("drops stream reasoning deltas when later content holds the answer", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const encode = (value: unknown) =>
      new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      encode({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const events = [
      ...parser.push(chunk({ role: "assistant", reasoning: "hidden", audio: null })),
      ...parser.push(chunk({ content: "pong" })),
      ...parser.push(
        encode({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 32,
            total_tokens: 51,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ),
      ...parser.push(new TextEncoder().encode("data: [DONE]\n\n")),
    ];
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      expect.objectContaining({ delta: "pong" }),
    ]);
    expect(events.some((event) => event.type === "reasoning_delta")).toBe(false);
  });

  it("rejects a chat stream whose only text is reasoning", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const encode = (value: unknown) =>
      new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    parser.push(
      encode({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt",
        choices: [{ index: 0, delta: { reasoning: "hidden" }, finish_reason: null }],
      }),
    );
    parser.push(
      encode({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
    expect(() => parser.push(new TextEncoder().encode("data: [DONE]\n\n"))).toThrow(
      /only visible text/u,
    );
  });

  it("streams through the bounded parser and renderer state machines", async () => {
    const transform = createProtocolAdaptationTransform({
      source: "openai-chat",
      target: "openai-responses",
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const chunks: string[] = [];
    const consume = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        chunks.push(new TextDecoder().decode(result.value));
      }
    })();
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      ),
    );
    expect(chunks.join("")).toContain("response.created");
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    await writer.close();
    await consume;
    expect(chunks.join("")).toContain("response.completed");
  });
});
