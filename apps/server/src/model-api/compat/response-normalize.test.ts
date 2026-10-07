import { describe, expect, it } from "vitest";
import {
  createSseNormalizer,
  type NormalizeOptions,
  normalizeChatObject,
  normalizeJsonBody,
  normalizeMessagesEvent,
  normalizeMessagesObject,
} from "./response-normalize.js";

const auto: NormalizeOptions = { reasoningField: "auto", stripNonStandard: false };

async function run(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]) {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(source.pipeThrough(stream)).text();
}

describe("Chat Completions normalization", () => {
  it("maps finish_reason variants and leaves standard ones", () => {
    const body = {
      choices: [
        { index: 0, finish_reason: "eos" },
        { index: 1, finish_reason: "max_tokens" },
        { index: 2, finish_reason: "tool_calls" },
        { index: 3, finish_reason: null },
        { index: 4, finish_reason: "weird" },
      ],
    };
    expect(normalizeChatObject(body, auto)).toBe(true);
    expect(body.choices.map((choice) => choice.finish_reason)).toEqual([
      "stop",
      "length",
      "tool_calls",
      null,
      "weird",
    ]);
    expect(normalizeChatObject({ choices: [{ finish_reason: "stop" }] }, auto)).toBe(false);
  });

  it("renames or strips reasoning and removes non-standard fields when asked", () => {
    const body = {
      id: "c",
      prompt_logprobs: null,
      kv_transfer_params: null,
      choices: [
        {
          index: 0,
          stop_reason: 7,
          finish_reason: "stop",
          message: { role: "assistant", content: "x", reasoning_content: "r" },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        prompt_tokens_details: null,
        extra: 1,
      },
    };
    normalizeChatObject(body, { reasoningField: "reasoning", stripNonStandard: true });
    expect(body).toEqual({
      id: "c",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "x", reasoning: "r" },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        prompt_tokens_details: null,
      },
    });
    const stripped = { choices: [{ delta: { reasoning: "r", content: "" } }] };
    normalizeChatObject(stripped, { reasoningField: "strip", stripNonStandard: false });
    expect(stripped).toEqual({ choices: [{ delta: { content: "" } }] });
  });

  it("normalizes a stream event by event and passes non-JSON events through", async () => {
    const out = await run(createSseNormalizer("openai-chat", auto, null), [
      'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\nda',
      'ta: {"choices":[{"delta":{},"finish_reason":"eos"}]}\r\n\r\n: keepalive\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out).toBe(
      'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
        ": keepalive\n\ndata: [DONE]\n\n",
    );
  });

  it("keeps bytes intact across split UTF-8, CRLF and invalid UTF-8", async () => {
    const encoder = new TextEncoder();
    const event = encoder.encode('data: {"choices":[{"delta":{"content":"é"}}]}\r\n\r\n');
    const split = event.indexOf(0xc3) + 1;
    const invalid = new Uint8Array([...encoder.encode("data: "), 0xff, 0x0a, 0x0a]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(event.subarray(0, split));
        controller.enqueue(event.subarray(split));
        controller.enqueue(invalid);
        controller.close();
      },
    });
    const out = new Uint8Array(
      await new Response(
        source.pipeThrough(createSseNormalizer("openai-chat", auto, null)),
      ).arrayBuffer(),
    );
    expect([...out]).toEqual([...event, ...invalid]);
  });

  it("returns the same bytes for an unchanged or non-JSON body", () => {
    const bytes = new TextEncoder().encode('{"choices":[{"finish_reason":"stop"}]}');
    expect(normalizeJsonBody(bytes, "openai-chat", auto, null)).toBe(bytes);
    const text = new TextEncoder().encode("oops");
    expect(normalizeJsonBody(text, "openai-chat", auto, null)).toBe(text);
  });
});

describe("Anthropic Messages normalization", () => {
  it("maps stop reasons, signs thinking blocks and fills missing usage", () => {
    const body = {
      type: "message",
      stop_reason: "length",
      content: [
        { type: "thinking", thinking: "t" },
        { type: "text", text: "x" },
      ],
    };
    expect(normalizeMessagesObject(body, auto, { inputTokens: 12 })).toBe(true);
    expect(body).toEqual({
      type: "message",
      stop_reason: "max_tokens",
      content: [
        { type: "thinking", thinking: "t", signature: "" },
        { type: "text", text: "x" },
      ],
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  });

  it("normalizes stream events", () => {
    const start = { type: "message_start", message: { type: "message", content: [] } };
    normalizeMessagesEvent(start, auto, { inputTokens: 3 });
    expect(start.message).toMatchObject({ usage: { input_tokens: 3, output_tokens: 0 } });
    const delta = { type: "message_delta", delta: { stop_reason: "tool_calls" } };
    normalizeMessagesEvent(delta, auto, null);
    expect(delta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 0 },
    });
    const block = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    };
    normalizeMessagesEvent(block, auto, null);
    expect(block.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
  });
});
