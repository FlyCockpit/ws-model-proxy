import { describe, expect, it, vi } from "vitest";
import {
  CanonicalStreamParser,
  parseAnthropicMessagesRequest,
  parseOpenAiChatRequest,
  renderAnthropicMessagesRequest,
  renderOpenAiResponsesRequest,
  renderProtocolResponse,
} from "./index.js";

describe("strict cross-surface rendering", () => {
  it("requires an explicit single-call policy whenever OpenAI tools are adapted", () => {
    const request = {
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    };
    expect(() => parseOpenAiChatRequest(request)).toThrow("explicitly be false");
    expect(
      parseOpenAiChatRequest({ ...request, parallel_tool_calls: false }).parallelToolCalls,
    ).toBe("single");
    expect(() =>
      parseAnthropicMessagesRequest({
        model: "m",
        max_tokens: 8,
        tools: [{ name: "lookup", input_schema: {} }],
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow("explicitly disable parallel");
  });

  it("rejects stop sequences when targeting Responses instead of silently dropping them", () => {
    const canonical = parseOpenAiChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      stop: ["END"],
    });
    expect(() => renderOpenAiResponsesRequest(canonical, "upstream")).toThrow(
      "no lossless stop-sequence",
    );
  });

  it("preserves interleaved content/tool order in Responses request rendering", () => {
    const canonical = parseAnthropicMessagesRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            { type: "tool_use", id: "call", name: "lookup", input: { q: "x" } },
            { type: "text", text: "after" },
          ],
        },
      ],
    });
    expect(renderOpenAiResponsesRequest(canonical, "upstream").input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "before" }],
      },
      { type: "function_call", call_id: "call", name: "lookup", arguments: '{"q":"x"}' },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "after" }],
      },
    ]);
  });

  it("rejects non-stream Chat rendering when block order cannot be represented", () => {
    expect(() =>
      renderProtocolResponse("openai-chat", {
        id: "r",
        items: [
          { type: "text", text: "before" },
          { type: "tool_call", id: "call", name: "lookup", arguments: "{}" },
        ],
        stopReason: "tool",
      }),
    ).toThrow("no lossless ordering");
  });

  it("forces safe single-call behavior in Anthropic even with automatic tool choice", () => {
    const canonical = parseOpenAiChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      parallel_tool_calls: false,
    });
    expect(renderAnthropicMessagesRequest(canonical, "claude")).toMatchObject({
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });

  it.each([
    ["data:image/svg+xml;base64,PHN2Zz4=", "must be HTTPS"],
    ["data:image/png;base64,%%%", "must be HTTPS"],
    ["http://example.test/private.png", "must be HTTPS"],
  ])("rejects unsafe or malformed image URL %s", (url, message) => {
    expect(() =>
      parseOpenAiChatRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      }),
    ).toThrow(message);
  });
});

const ignoredEnvelopeLog = "[model-api] ignored upstream envelope fields";

function withDebug(run: () => void) {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    run();
    return debug.mock.calls.map((call) => [...call]);
  } finally {
    debug.mockRestore();
  }
}

function expectIgnored(calls: unknown[][], path: string, fields: string[], secret: string) {
  expect(JSON.stringify(calls)).not.toContain(secret);
  expect(calls).toContainEqual([ignoredEnvelopeLog, { path, fields }]);
}

const bytes = (value: string) => new TextEncoder().encode(value);
const sse = (value: unknown) => bytes(`data: ${JSON.stringify(value)}\n\n`);
const event = (name: string, data: Record<string, unknown>) =>
  bytes(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
const responseStart = (id: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

describe("upstream reply stream envelopes", () => {
  it("adapts a llama.cpp chat stream with reasoning_content and timings", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const secret = "DO_NOT_LOG_timings_value";
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
      sse({
        id: "llama",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices,
        ...extra,
      });
    let events: ReturnType<CanonicalStreamParser["push"]> = [];
    const debug = withDebug(() => {
      events = [
        ...parser.push(
          chunk([
            {
              index: 0,
              delta: { role: "assistant", reasoning_content: "REASONING_CONTENT_HIDDEN" },
              finish_reason: null,
            },
          ]),
        ),
        ...parser.push(chunk([{ index: 0, delta: { content: "pong" }, finish_reason: null }])),
        ...parser.push(
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
            timings: { predicted_n: 1, prompt_per_second: secret },
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        ),
        ...parser.push(bytes("data: [DONE]\n\n")),
      ];
    });
    expect(events.filter((item) => item.type === "text_delta")).toEqual([
      expect.objectContaining({ delta: "pong" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("REASONING_CONTENT_HIDDEN");
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.at(-1)?.type).toBe("complete");
    expectIgnored(debug, "stream.data", ["timings"], secret);
  });

  it("rejects a completed chat stream whose only text is reasoning_content", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    parser.push(
      sse({
        id: "llama",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [
          {
            index: 0,
            delta: { reasoning: "hidden", reasoning_content: "REASONING_CONTENT_HIDDEN" },
            finish_reason: null,
          },
        ],
      }),
    );
    parser.push(
      sse({
        id: "llama",
        object: "chat.completion.chunk",
        created: 0,
        model: "local",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
    expect(() => parser.push(bytes("data: [DONE]\n\n"))).toThrow(/only visible text/u);
  });

  it("ignores an unknown chat stream choice field and logs the name only", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const secret = "DO_NOT_LOG_choice_value";
    const debug = withDebug(() => {
      const events = parser.push(
        sse({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              delta: { content: "pong" },
              finish_reason: null,
              llama_choice: secret,
            },
          ],
        }),
      );
      expect(events.some((item) => item.type === "text_delta")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(secret);
    });
    expectIgnored(debug, "choices[0]", ["llama_choice"], secret);
  });

  it("ignores unknown Responses stream envelope fields and logs names only", () => {
    const parser = new CanonicalStreamParser("openai-responses");
    const secretEvent = "DO_NOT_LOG_event_value";
    const secretResponse = "DO_NOT_LOG_response_value";
    const debug = withDebug(() => {
      const events = parser.push(
        event("response.created", {
          sequence_number: 0,
          obfuscation: secretEvent,
          response: responseStart("r", { background: secretResponse }),
        }),
      );
      expect(events).toEqual([{ type: "message_start", id: "r", model: "gpt" }]);
    });
    expectIgnored(debug, "stream.data", ["obfuscation"], secretEvent);
    expectIgnored(debug, "stream.data.response", ["background"], secretResponse);
  });

  it("ignores unknown Anthropic stream envelope fields and logs names only", () => {
    const parser = new CanonicalStreamParser("anthropic-messages");
    const secretEvent = "DO_NOT_LOG_event_value";
    const secretMessage = "DO_NOT_LOG_message_value";
    const debug = withDebug(() => {
      const events = parser.push(
        event("message_start", {
          llama_event: secretEvent,
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
            container: secretMessage,
          },
        }),
      );
      expect(events[0]).toMatchObject({ type: "message_start", id: "m" });
      expect(JSON.stringify(events)).not.toContain(secretEvent);
      expect(JSON.stringify(events)).not.toContain(secretMessage);
    });
    expectIgnored(debug, "stream.data", ["llama_event"], secretEvent);
    expectIgnored(debug, "stream.data.message", ["container"], secretMessage);
  });

  it("still rejects unknown stream tool calls, output items, and content blocks", () => {
    const chat = new CanonicalStreamParser("openai-chat");
    expect(() =>
      chat.push(
        sse({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call",
                    type: "function",
                    vendor_call: true,
                    function: { name: "lookup", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ),
    ).toThrow(/vendor_call/u);

    const responses = new CanonicalStreamParser("openai-responses");
    responses.push(event("response.created", { sequence_number: 0, response: responseStart("r") }));
    expect(() =>
      responses.push(
        event("response.output_item.added", {
          sequence_number: 1,
          output_index: 0,
          item: {
            id: "i",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
            phase: "nope",
          },
        }),
      ),
    ).toThrow(/phase/u);

    const anthropic = new CanonicalStreamParser("anthropic-messages");
    anthropic.push(
      event("message_start", {
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
    );
    expect(() =>
      anthropic.push(
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "", cache_control: { type: "ephemeral" } },
        }),
      ),
    ).toThrow(/cache_control/u);
  });

  it("still rejects non-null prompt_logprobs on a chat stream chunk", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const debug = withDebug(() => {
      expect(() =>
        parser.push(
          sse({
            id: "c",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            prompt_logprobs: [{ token: "x" }],
            choices: [{ index: 0, delta: { content: "a" }, finish_reason: null, token_ids: [1] }],
          }),
        ),
      ).toThrow(/prompt_logprobs/u);
    });
    expect(debug).toEqual([]);
  });

  it("completes a chat stream when reasoning_content is empty", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const events = [
      ...parser.push(
        sse({
          id: "c",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta: { reasoning_content: "" }, finish_reason: "stop" }],
        }),
      ),
      ...parser.push(bytes("data: [DONE]\n\n")),
    ];
    expect(events.some((item) => item.type === "text_delta")).toBe(false);
    expect(events.at(-1)?.type).toBe("complete");
  });
});
