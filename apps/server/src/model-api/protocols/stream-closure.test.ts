import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./canonical.js";
import {
  CanonicalStreamParser,
  CanonicalStreamRenderer,
  createCanonicalSseTransform,
} from "./streams.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const wire = (event: string, sequence: number, fields: Record<string, unknown>) =>
  encode(
    `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: sequence, ...fields })}\n\n`,
  );
const responseStart = (id: string) => ({
  id,
  object: "response",
  created_at: 0,
  status: "in_progress",
  error: null,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: null,
  model: "gpt",
  output: [],
  parallel_tool_calls: false,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: false,
  temperature: null,
  text: { format: { type: "text" } },
  tool_choice: "none",
  tools: [],
  top_p: null,
  truncation: "disabled",
  metadata: {},
  usage: null,
});

describe("cycle 21 streaming closure", () => {
  it("renders exact contiguous Responses sequence/index/output/tool/usage wire state", () => {
    const events: CanonicalEvent[] = [
      { type: "message_start", id: "r", model: "gpt" },
      { type: "item_start", index: 4, id: "text", itemType: "text" },
      { type: "text_delta", index: 4, delta: "hello" },
      { type: "item_complete", index: 4 },
      { type: "item_start", index: 9, id: "call", itemType: "tool_call" },
      { type: "tool_arguments_delta", index: 9, id: "call", name: "lookup", delta: "{}" },
      { type: "item_complete", index: 9 },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
      { type: "stop", reason: "tool" },
      { type: "complete" },
    ];
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const payloads = events.flatMap((event) => renderer.push(event)).map(decode);
    renderer.finish();
    const parsed = payloads.map((payload) =>
      JSON.parse(payload.match(/data: (.*)\n\n/s)?.[1] ?? "{}"),
    );
    expect(payloads).toEqual(
      parsed.map((payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
    expect(parsed.map((payload) => payload.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(parsed.map((payload) => payload.sequence_number)).toEqual(
      parsed.map((_, index) => index),
    );
    expect(
      parsed
        .filter((payload) => payload.output_index !== undefined)
        .map((payload) => payload.output_index),
    ).toEqual(expect.arrayContaining([0, 1]));
    const terminal = parsed.at(-1).response;
    expect(terminal.output).toHaveLength(2);
    expect(terminal.output[1]).toMatchObject({
      type: "function_call",
      call_id: "call",
      name: "lookup",
      arguments: "{}",
    });
    expect(terminal.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  });

  it("renders valid Anthropic initial usage and one combined usage/stop delta", () => {
    const renderer = new CanonicalStreamRenderer("anthropic-messages");
    const output = [
      ...renderer.push({
        type: "message_start",
        id: "m",
        usage: { inputTokens: 7, outputTokens: 0 },
      }),
      ...renderer.push({ type: "usage", usage: { inputTokens: 7, outputTokens: 4 } }),
      ...renderer.push({ type: "stop", reason: "stop" }),
      ...renderer.push({ type: "complete" }),
    ].map(decode);
    renderer.finish();
    expect(output[0]).toContain('"usage":{"input_tokens":7,"output_tokens":0}');
    expect(output.filter((entry) => entry.includes("event: message_delta"))).toHaveLength(1);
    expect(output.join("\n")).toContain(
      '"delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}',
    );
  });

  it("uses the Responses streaming error shape and sequence number", () => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const data = decode(
      renderer.push({
        type: "error",
        error: { code: "rate_limit_exceeded", message: "slow", parameter: "input" },
      })[0]!,
    );
    expect(data).toContain(
      'data: {"type":"error","sequence_number":0,"code":"rate_limit_exceeded","message":"slow","param":"input"}',
    );
  });

  it.each([
    ["openai-chat", "content_filter", true],
    ["openai-responses", "content_filter", false],
    ["anthropic-messages", "content_filter", false],
    ["openai-chat", "unknown", false],
    ["openai-responses", "length", true],
    ["anthropic-messages", "tool", true],
  ] as const)("applies the safe %s stop mapping for %s", (surface, reason, supported) => {
    const renderer = new CanonicalStreamRenderer(surface);
    renderer.push({
      type: "message_start",
      id: "m",
      model: "model",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const render = () => renderer.push({ type: "stop", reason });
    if (supported) expect(render).not.toThrow();
    else expect(render).toThrow("safely representable");
  });

  it("requires Responses sequences and rejects done-tool identity changes", () => {
    expect(() =>
      new CanonicalStreamParser("openai-responses").push(
        encode(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","status":"in_progress","output":[]}}\n\n',
        ),
      ),
    ).toThrow("sequence_number");

    const parser = new CanonicalStreamParser("openai-responses");
    parser.push(
      wire("response.created", 0, {
        response: responseStart("r"),
      }),
    );
    parser.push(
      wire("response.output_item.added", 1, {
        output_index: 0,
        item: {
          id: "item",
          type: "function_call",
          status: "in_progress",
          call_id: "call",
          name: "lookup",
          arguments: "",
        },
      }),
    );
    parser.push(
      wire("response.function_call_arguments.delta", 2, {
        output_index: 0,
        item_id: "item",
        delta: "{}",
      }),
    );
    parser.push(
      wire("response.function_call_arguments.done", 3, {
        output_index: 0,
        item_id: "item",
        arguments: "{}",
      }),
    );
    expect(() =>
      parser.push(
        wire("response.output_item.done", 4, {
          output_index: 0,
          item: {
            id: "item",
            type: "function_call",
            status: "completed",
            call_id: "different",
            name: "lookup",
            arguments: "{}",
          },
        }),
      ),
    ).toThrow("identity");
  });

  it("enforces stop barriers, chunk identity, and aggregate parser/renderer bounds", () => {
    const anthropic = new CanonicalStreamParser("anthropic-messages");
    anthropic.push(
      encode(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"c","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      ),
    );
    anthropic.push(
      encode(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      ),
    );
    expect(() => anthropic.push(encode('event: ping\ndata: {"type":"ping"}\n\n'))).toThrow(
      "stop barrier",
    );

    const chat = new CanonicalStreamParser("openai-chat");
    chat.push(
      encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"generated-attacker","type":"function","function":{"name":"f","arguments":"{"}}]},"finish_reason":null}]}\n\n',
      ),
    );
    expect(() =>
      chat.push(
        encode(
          'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"two","function":{"name":"f","arguments":"}"}}]},"finish_reason":null}]}\n\n',
        ),
      ),
    ).toThrow("changed IDs");

    const boundedParser = new CanonicalStreamParser("openai-chat", {
      maxAggregateBytes: 3,
    });
    expect(() =>
      boundedParser.push(
        encode(
          'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"four"},"finish_reason":null}]}\n\n',
        ),
      ),
    ).toThrow("Accumulated");
    const boundedRenderer = new CanonicalStreamRenderer("openai-chat", {
      maxAggregateBytes: 3,
    });
    boundedRenderer.push({ type: "message_start", id: "c", model: "m" });
    boundedRenderer.push({ type: "item_start", index: 0, id: "t", itemType: "text" });
    expect(() => boundedRenderer.push({ type: "text_delta", index: 0, delta: "four" })).toThrow(
      "Accumulated",
    );
  });

  it("aborts a writer while readable backpressure is blocking progress", async () => {
    const controller = new AbortController();
    const transform = createCanonicalSseTransform("openai-chat", {
      signal: controller.signal,
      highWaterMarkBytes: 1,
    });
    const writer = transform.writable.getWriter();
    const blocked = writer.write({ type: "message_start", id: "m" });
    controller.abort();
    await expect(blocked).rejects.toThrow("cancelled");
  });
});
