import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "./canonical.js";
import { CanonicalStreamParser, CanonicalStreamRenderer } from "./streams.js";

const encode = (value: string) => new TextEncoder().encode(value);
const responseEnvelope = (status: "in_progress" | "failed") => ({
  id: "r",
  object: "response",
  created_at: 0,
  status,
  error: status === "failed" ? { code: "server_error", message: "failed" } : null,
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

async function chatFixtureEvents(): Promise<CanonicalEvent[]> {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/generated-conformance/openai-chat-sse.json", import.meta.url),
      "utf8",
    ),
  ) as { events: Array<{ data: unknown }> };
  const parser = new CanonicalStreamParser("openai-chat");
  const events = fixture.events.flatMap(({ data }) =>
    parser.push(encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)),
  );
  events.push(...parser.finish());
  return events;
}

describe("cross-protocol streaming conformance", () => {
  it.each([
    ["nonempty output", { output: [{}] }],
    ["nonarray output", { output: "bad" }],
    ["nonnull usage", { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }],
    ["nonnull incomplete details", { incomplete_details: { reason: "max_output_tokens" } }],
    ["nonstring error type", { error: { code: "bad", message: "bad", type: 1 } }],
    ["invalid error param", { error: { code: "bad", message: "bad", param: 1 } }],
  ] as const)("rejects failed Responses with %s", (_name, mutation) => {
    const parser = new CanonicalStreamParser("openai-responses");
    parser.push(
      encode(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: responseEnvelope("in_progress"),
        })}\n\n`,
      ),
    );
    expect(() =>
      parser.push(
        encode(
          `event: response.failed\ndata: ${JSON.stringify({
            type: "response.failed",
            sequence_number: 1,
            response: { ...responseEnvelope("failed"), ...mutation },
          })}\n\n`,
        ),
      ),
    ).toThrow();
  });

  it("pipes a bounded large Chat wire stream incrementally into Responses", () => {
    const source = new CanonicalStreamParser("openai-chat", {
      maxEventBytes: 512,
      maxAggregateBytes: 2048,
    });
    const renderer = new CanonicalStreamRenderer("openai-responses", {
      maxAggregateBytes: 2048,
    });
    const target = new CanonicalStreamParser("openai-responses", {
      maxEventBytes: 2048,
      maxAggregateBytes: 2048,
    });
    const targetEvents: CanonicalEvent[] = [];
    let sourceDone = false;
    const pipe = (wire: string) => {
      for (const canonical of source.push(encode(wire)))
        for (const rendered of renderer.push(canonical))
          targetEvents.push(...target.push(rendered));
    };
    pipe(
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    );
    for (let index = 0; index < 20; index++) {
      pipe(
        `data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"${"x".repeat(50)}"},"finish_reason":null}]}\n\n`,
      );
      if (index === 0) {
        expect(sourceDone).toBe(false);
        expect(targetEvents.some((event) => event.type === "text_delta")).toBe(true);
      }
    }
    pipe(
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    pipe("data: [DONE]\n\n");
    sourceDone = true;
    for (const canonical of source.finish())
      for (const rendered of renderer.push(canonical)) targetEvents.push(...target.push(rendered));
    renderer.finish();
    targetEvents.push(...target.finish());
    expect(sourceDone).toBe(true);
    expect(targetEvents.at(-1)).toEqual({ type: "complete" });
  });

  it("closes actual partial Chat tool wire through Responses with stable identity", () => {
    const source = new CanonicalStreamParser("openai-chat");
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const target = new CanonicalStreamParser("openai-responses");
    const targetEvents: CanonicalEvent[] = [];
    for (const wire of [
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"lookup","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ])
      for (const canonical of source.push(encode(wire)))
        for (const rendered of renderer.push(canonical))
          targetEvents.push(...target.push(rendered));
    source.finish();
    renderer.finish();
    targetEvents.push(...target.finish());
    expect(targetEvents).toContainEqual(
      expect.objectContaining({
        type: "tool_arguments_delta",
        id: "call",
        name: "lookup",
      }),
    );
    expect(targetEvents).toContainEqual({ type: "item_complete", index: 0 });
  });

  it("explicitly rejects actual Chat refusal wire targeting Anthropic", () => {
    const source = new CanonicalStreamParser("openai-chat");
    const canonical = source.push(
      encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"refusal":"no"},"finish_reason":null}]}\n\n',
      ),
    );
    const renderer = new CanonicalStreamRenderer("anthropic-messages");
    expect(() => canonical.flatMap((event) => renderer.push(event))).toThrow("initial usage");
  });

  it("pins an independent literal golden for the complete empty Responses wire", () => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const actual = [
      ...renderer.push({ type: "message_start", id: "r", model: "gpt" }),
      ...renderer.push({ type: "stop", reason: "stop" }),
      ...renderer.push({ type: "complete" }),
    ].map((chunk) => new TextDecoder().decode(chunk));
    renderer.finish();
    expect(actual).toEqual([
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","created_at":0,"status":"in_progress","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt","output":[],"parallel_tool_calls":false,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"none","tools":[],"top_p":null,"truncation":"disabled","usage":null,"metadata":{}}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"id":"r","object":"response","created_at":0,"status":"completed","error":null,"model":"gpt","output":[],"incomplete_details":null,"instructions":null,"max_output_tokens":null,"parallel_tool_calls":false,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"none","tools":[],"top_p":null,"truncation":"disabled","metadata":{},"usage":null}}\n\n',
    ]);
  });

  it("incrementally closes Chat through Responses before source DONE", async () => {
    const canonical = await chatFixtureEvents();
    const renderer = new CanonicalStreamRenderer("openai-responses", {
      maxAggregateBytes: 64,
    });
    const parser = new CanonicalStreamParser("openai-responses", { maxAggregateBytes: 64 });
    let observedTextBeforeComplete = false;
    const reparsed: CanonicalEvent[] = [];
    for (const event of canonical) {
      for (const chunk of renderer.push(event)) reparsed.push(...parser.push(chunk));
      if (event.type !== "complete" && reparsed.some((item) => item.type === "text_delta"))
        observedTextBeforeComplete = true;
    }
    renderer.finish();
    reparsed.push(...parser.finish());
    expect(observedTextBeforeComplete).toBe(true);
    expect(reparsed.at(-1)).toEqual({ type: "complete" });
  });

  it("rejects Chat to Anthropic streaming because initial usage is unavailable", async () => {
    const start = (await chatFixtureEvents())[0];
    expect(start).toMatchObject({ type: "message_start" });
    expect(() => new CanonicalStreamRenderer("anthropic-messages").push(start!)).toThrow(
      "initial usage",
    );
  });

  it.each([
    {
      name: "empty text",
      events: [
        { type: "item_start", index: 0, id: "empty", itemType: "text" },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
    {
      name: "refusal",
      events: [
        { type: "item_start", index: 0, id: "refusal", itemType: "refusal" },
        { type: "refusal_delta", index: 0, delta: "no" },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
    {
      name: "tool",
      events: [
        { type: "item_start", index: 0, id: "call", itemType: "tool_call" },
        {
          type: "tool_arguments_delta",
          index: 0,
          id: "call",
          name: "lookup",
          delta: "{}",
        },
        { type: "item_complete", index: 0 },
      ] satisfies CanonicalEvent[],
    },
  ])("incrementally closes $name through Responses", ({ name, events }) => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    const parser = new CanonicalStreamParser("openai-responses");
    const canonical: CanonicalEvent[] = [
      { type: "message_start", id: "m", model: "model" },
      ...events,
      { type: "stop", reason: name === "tool" ? "tool" : "stop" },
      { type: "complete" },
    ];
    const reparsed = canonical.flatMap((event) =>
      renderer.push(event).flatMap((chunk) => parser.push(chunk)),
    );
    renderer.finish();
    reparsed.push(...parser.finish());
    expect(reparsed.filter((event) => event.type === "item_complete")).toHaveLength(1);
    expect(reparsed.at(-1)).toEqual({ type: "complete" });
  });

  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "rejects an error after stop for %s",
    (surface) => {
      const renderer = new CanonicalStreamRenderer(surface);
      renderer.push({
        type: "message_start",
        id: "m",
        model: "model",
        ...(surface === "anthropic-messages" ? { usage: { inputTokens: 0, outputTokens: 0 } } : {}),
      });
      renderer.push({ type: "stop", reason: "stop" });
      expect(() =>
        renderer.push({ type: "error", error: { code: "bad", message: "bad" } }),
      ).toThrow("stop barrier");
    },
  );

  it.each([
    {},
    { inputTokens: 1 },
    { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ])("rejects incomplete or unsafe canonical usage %#", (usage) => {
    const renderer = new CanonicalStreamRenderer("openai-responses");
    renderer.push({ type: "message_start", id: "m", model: "model" });
    expect(() => renderer.push({ type: "usage", usage })).toThrow("safe integer");
  });
});
