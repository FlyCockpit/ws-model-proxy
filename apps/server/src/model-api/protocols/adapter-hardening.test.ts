import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { embeddedArgumentsRequest, nestedWire } from "../cache-affinity-canonical.test-fixtures.js";
import openRouterFixture from "../fixtures/openrouter-usage.json";
import {
  adaptNonstreamResponse,
  CanonicalStreamParser,
  CanonicalStreamRenderer,
  capabilityInventoryAcceptsTopK,
  createProtocolAdaptationTransform,
  executionTargetAcceptsTopK,
  executionTargetSupportsStreamUsage,
  parseAnthropicMessagesRequest,
  parseCanonicalRequest,
  parseOpenAiChatRequest,
  type ReasoningRenderControl,
  renderAnthropicMessagesRequest,
  renderCanonicalRequest,
  renderOpenAiChatRequest,
  renderOpenAiResponsesRequest,
  renderProtocolResponse,
} from "./index.js";
import { ignoreUnknownEnvelopeFields, MAX_LOGGED_FIELDS_PER_STREAM } from "./parse-utils.js";

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

  it("asks a Chat target for stream usage only when the request streams", () => {
    const canonical = (stream: boolean) =>
      parseAnthropicMessagesRequest({
        model: "m",
        max_tokens: 8,
        stream,
        messages: [{ role: "user", content: "hello" }],
      });
    expect(renderOpenAiChatRequest(canonical(true), "upstream")).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(renderOpenAiChatRequest(canonical(false), "upstream")).not.toHaveProperty(
      "stream_options",
    );
    expect(() =>
      parseOpenAiChatRequest({
        model: "m",
        stream: true,
        stream_options: { include_usage: false },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toThrow(/stream_options/u);
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

  it("caps the ignored-field log at ten truncated names plus an omitted count", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const long = `vendor_${"x".repeat(100)}`;
    const extras = Object.fromEntries(
      [long, ...Array.from({ length: 11 }, (_, index) => `vendor_${index}`)].map((key) => [
        key,
        "DO_NOT_LOG_value",
      ]),
    );
    const chunk = (content: string) =>
      sse({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        ...extras,
      });
    const debug = withDebug(() => {
      parser.push(chunk("a"));
      parser.push(chunk("b"));
    });
    expect(JSON.stringify(debug)).not.toContain("DO_NOT_LOG_value");
    expect(debug).toEqual([
      [
        ignoredEnvelopeLog,
        {
          path: "stream.data",
          fields: [
            long.slice(0, 64),
            ...Array.from({ length: 9 }, (_, index) => `vendor_${index}`),
          ],
          omitted: 2,
        },
      ],
    ]);
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

  it("requires delta on a chat stream choice unless the chunk only finishes", () => {
    const chunk = (choice: Record<string, unknown>) =>
      sse({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [choice] });
    const withoutDelta = new CanonicalStreamParser("openai-chat");
    const debug = withDebug(() => {
      expect(() =>
        withoutDelta.push(chunk({ index: 0, text: "legacy answer", finish_reason: null })),
      ).toThrow(/requires delta/u);
    });
    expect(debug).toEqual([]);
    expect(() =>
      new CanonicalStreamParser("openai-chat").push(
        chunk({ index: 0, delta: null, finish_reason: null }),
      ),
    ).toThrow(/requires delta/u);
    for (const finish of [{}, { delta: {} }]) {
      const parser = new CanonicalStreamParser("openai-chat");
      const events = [
        ...parser.push(chunk({ index: 0, delta: { content: "pong" }, finish_reason: null })),
        ...parser.push(chunk({ index: 0, finish_reason: "stop", ...finish })),
        ...parser.push(bytes("data: [DONE]\n\n")),
      ];
      expect(events.at(-1)?.type).toBe("complete");
    }
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

const chatReasoning = {
  supported: true,
  config: {
    encoding: { kind: "openai_reasoning_effort" },
    supportedLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultLevel: "high",
  },
} satisfies ReasoningRenderControl;

describe("Claude Code Anthropic request adaptation", () => {
  async function claudeCodeRequest() {
    return JSON.parse(
      await readFile(new URL("./fixtures/claude-code-messages-v1.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
  }

  it("drops cache metadata, joins tool-result text, and keeps top_k for a CLI Chat target", async () => {
    const request = await claudeCodeRequest();
    const canonical = parseAnthropicMessagesRequest(request);
    expect(canonical.sampling.topK).toBe(40);
    expect(canonical.thinking).toEqual({ type: "disabled" });
    expect(JSON.stringify(canonical)).not.toContain("cache_control");
    expect(JSON.stringify(canonical)).not.toContain("placeholder-metadata");
    const rendered = renderCanonicalRequest({
      request: canonical,
      target: "openai-chat",
      model: "cli-chat",
      acceptsTopK: executionTargetAcceptsTopK({
        capabilityInventory: { sampling: { parameters: ["top_k"] } },
      }),
    });
    expect(rendered.top_k).toBe(40);
    expect(rendered).not.toHaveProperty("reasoning_effort");
    expect(rendered).not.toHaveProperty("metadata");
    expect(rendered).not.toHaveProperty("thinking");
    const wire = JSON.stringify(rendered);
    expect(wire).not.toContain("cache_control");
    expect(wire).not.toContain("placeholder-metadata");
    expect(wire).toContain("placeholder-system");
    expect(wire).toContain("placeholder-result-a\\nplaceholder-result-b");
    expect(executionTargetAcceptsTopK({ capabilityInventory: { version: 3 } })).toBe(false);
    expect(
      executionTargetAcceptsTopK({
        capabilityInventory: { sampling: { parameters: ["top_k"] } },
      }),
    ).toBe(true);
  });

  it("rejects the same request for a hosted Chat target that has no top_k sampling extension", async () => {
    const canonical = parseAnthropicMessagesRequest(await claudeCodeRequest());
    const inventory = {
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: { source: "declared", confidence: "exact", supported: true },
      },
    };
    expect(capabilityInventoryAcceptsTopK(inventory)).toBe(false);
    expect(executionTargetAcceptsTopK({ capabilityInventory: inventory })).toBe(false);
    expect(() =>
      renderCanonicalRequest({
        request: canonical,
        target: "openai-chat",
        model: "hosted-chat",
        acceptsTopK: false,
        reasoning: { supported: true },
      }),
    ).toThrow(/top_k/u);
  });

  it("accepts top_k only when a hosted inventory already lists it on a sampling extension", () => {
    expect(
      capabilityInventoryAcceptsTopK({
        sampling: { parameters: ["temperature", "top_k"] },
      }),
    ).toBe(true);
    expect(
      capabilityInventoryAcceptsTopK({
        surfaces: { openaiChatCompletions: { sampling: { parameters: ["top_p"] } } },
      }),
    ).toBe(false);
  });

  it("fails a Responses target instead of dropping top_k", async () => {
    const canonical = parseAnthropicMessagesRequest(await claudeCodeRequest());
    expect(() =>
      renderCanonicalRequest({
        request: canonical,
        target: "openai-responses",
        model: "responses-only",
        acceptsTopK: true,
      }),
    ).toThrow(/top_k/u);
  });

  it("drops disabled thinking when reasoning is unsupported and maps enabled thinking when it is", () => {
    const base = { model: "placeholder-model", max_tokens: 64, messages: [] };
    const disabled = parseAnthropicMessagesRequest({
      ...base,
      thinking: { type: "disabled" },
    });
    expect(renderOpenAiChatRequest(disabled, "cli-chat", { acceptsTopK: true })).not.toHaveProperty(
      "reasoning_effort",
    );
    expect(
      renderOpenAiChatRequest(disabled, "cli-chat", { reasoning: chatReasoning }),
    ).toMatchObject({ reasoning_effort: "none" });
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        thinking: { type: "enabled", budget_tokens: 1024 },
      }),
    ).not.toThrow();
    const enabled = parseAnthropicMessagesRequest({
      ...base,
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(() => renderOpenAiChatRequest(enabled, "cli-chat")).toThrow(/thinking/u);
    expect(
      renderOpenAiChatRequest(enabled, "cli-chat", { reasoning: chatReasoning }),
    ).toMatchObject({ reasoning_effort: "minimal" });
    const high = parseAnthropicMessagesRequest({
      ...base,
      thinking: { type: "enabled", budget_tokens: 16384 },
    });
    expect(
      renderOpenAiChatRequest(high, "cli-chat", {
        reasoning: {
          supported: true,
          config: { encoding: { kind: "openai_reasoning_object" } },
        },
      }),
    ).toEqual(expect.objectContaining({ reasoning: { effort: "high" } }));
    const anthropic = renderAnthropicMessagesRequest(high, "claude", {
      reasoning: { supported: true },
    });
    expect(anthropic.max_tokens).toBe(64);
    expect(anthropic.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  });

  it("accepts adaptive thinking because the reasoning contract already encodes it", () => {
    const adaptive = parseAnthropicMessagesRequest({
      model: "placeholder-model",
      max_tokens: 32,
      messages: [],
      thinking: { type: "adaptive" },
    });
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
    expect(() => renderOpenAiChatRequest(adaptive, "cli-chat")).toThrow(/thinking/u);
    expect(
      renderOpenAiChatRequest(adaptive, "cli-chat", { reasoning: chatReasoning }),
    ).toMatchObject({ reasoning_effort: "high" });
    expect(() =>
      renderOpenAiChatRequest(adaptive, "cli-chat", {
        reasoning: { supported: true, config: { encoding: { kind: "openai_reasoning_effort" } } },
      }),
    ).toThrow(/thinking/u);
  });

  it("rejects invalid top_k, document blocks, URL images, and non-text tool results", () => {
    const base = { model: "placeholder-model", max_tokens: 8, messages: [] };
    expect(() => parseAnthropicMessagesRequest({ ...base, top_k: 0 })).toThrow(/top_k/u);
    expect(() => parseAnthropicMessagesRequest({ ...base, top_k: 1.5 })).toThrow(/top_k/u);
    expect(() => parseAnthropicMessagesRequest({ ...base, top_k: "40" })).toThrow(/top_k/u);
    expect(() => parseOpenAiChatRequest({ model: "m", messages: [], top_k: 40 })).toThrow(/top_k/u);
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "text", data: "placeholder" } }],
          },
        ],
      }),
    ).toThrow(/type/u);
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.test/placeholder.png" },
              },
            ],
          },
        ],
      }),
    ).toThrow(/source/u);
    expect(
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      }).messages[0]?.content[0],
    ).toMatchObject({ type: "image", source: { kind: "base64", mediaType: "image/png" } });
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call",
                content: [
                  { type: "text", text: "placeholder" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/content/u);
  });

  it("still rejects an unknown Anthropic request field", () => {
    expect(() =>
      parseAnthropicMessagesRequest({
        model: "placeholder-model",
        max_tokens: 8,
        messages: [],
        service_tier: "auto",
      }),
    ).toThrow(/service_tier/u);
  });
});

describe("adapter follow-ups (#77)", () => {
  const chatChunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    sse({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices, ...extra });
  const thrownBy = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  };

  it("rejects a delta-less finish chunk that carries legacy text", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    parser.push(chatChunk([{ index: 0, delta: { content: "po" }, finish_reason: null }]));
    expect(
      thrownBy(() => parser.push(chatChunk([{ index: 0, text: "ng", finish_reason: "stop" }]))),
    ).toMatchObject({ code: "unsupported_feature", parameter: "choices[0].text" });
  });

  it.each([
    ["legacy text beside a delta", { delta: {}, text: "answer" }, "choices[0].text"],
    [
      "a message body in a stream chunk",
      { delta: {}, message: { content: "x" } },
      "choices[0].message",
    ],
    ["choice-level tool calls", { tool_calls: [{ id: "t" }] }, "choices[0].tool_calls"],
  ])("rejects %s", (_label, choice, parameter) => {
    const parser = new CanonicalStreamParser("openai-chat");
    expect(
      thrownBy(() => parser.push(chatChunk([{ index: 0, finish_reason: "stop", ...choice }]))),
    ).toMatchObject({ parameter });
  });

  it.each([{ text: "" }, { text: null }, { message: null }, { tool_calls: [] }])(
    "still completes a finish chunk with empty content-bearing key %j",
    (extra) => {
      const parser = new CanonicalStreamParser("openai-chat");
      const events = [
        ...parser.push(chatChunk([{ index: 0, delta: { content: "pong" }, finish_reason: null }])),
        ...parser.push(chatChunk([{ index: 0, finish_reason: "stop", ...extra }])),
        ...parser.push(bytes("data: [DONE]\n\n")),
      ];
      expect(events.at(-1)?.type).toBe("complete");
    },
  );

  it.each([
    ["anthropic-messages", "event: message_stop"],
    ["openai-responses", "response.completed"],
  ] as const)(
    "adapts the documented OpenRouter terminal usage chunk to %s",
    async (target, terminal) => {
      const output = await new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes(`${openRouterFixture.stream.join("\n\n")}\n\n`));
            controller.close();
          },
        }).pipeThrough(
          createProtocolAdaptationTransform({
            source: "openai-chat",
            target,
            recoverProtocolErrors: true,
            recoverBeforeOutput: true,
            request: parseAnthropicMessagesRequest({
              model: "vendor/model",
              max_tokens: 8,
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            }),
          }),
        ),
      ).text();
      expect(output).not.toMatch(/event: (?:error|response\.failed)/u);
      expect(output).toContain(terminal);
      expect(output).toContain('"output_tokens":80');
    },
  );

  describe("after finish_reason", () => {
    const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
    const finished = () => {
      const parser = new CanonicalStreamParser("openai-chat");
      parser.push(chatChunk([{ index: 0, delta: { content: "pong" }, finish_reason: null }]));
      parser.push(chatChunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      return parser;
    };

    it.each([
      ["no delta", { index: 0, finish_reason: "stop" }],
      [
        "an empty assistant delta",
        { delta: { role: "assistant", content: "" }, finish_reason: "stop" },
      ],
      [
        "null delta fields",
        { index: 0, delta: { content: null, tool_calls: [] }, finish_reason: "stop" },
      ],
    ])("accepts one usage chunk repeating the finish with %s", (_label, choice) => {
      const parser = finished();
      const events = [
        ...parser.push(chatChunk([choice], { usage })),
        ...parser.push(bytes("data: [DONE]\n\n")),
      ];
      expect(events.map((event) => event.type)).toEqual([
        "usage",
        "item_complete",
        "stop",
        "complete",
      ]);
    });

    it.each([
      ["a different finish_reason", [{ index: 0, delta: {}, finish_reason: "length" }], usage],
      ["no finish_reason", [{ index: 0, delta: {}, finish_reason: null }], usage],
      ["content", [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }], usage],
      [
        "a tool call",
        [{ index: 0, delta: { tool_calls: [{ index: 0 }] }, finish_reason: "stop" }],
        usage,
      ],
      [
        "an unknown delta key",
        [{ index: 0, delta: { vendor: "x" }, finish_reason: "stop" }],
        usage,
      ],
      ["no usage", [{ index: 0, delta: {}, finish_reason: "stop" }], undefined],
      [
        "two choices",
        [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "stop" },
        ],
        usage,
      ],
    ])("rejects a repeated finish chunk with %s", (_label, choices, chunkUsage) => {
      const parser = finished();
      expect(
        thrownBy(() => parser.push(chatChunk(choices, chunkUsage ? { usage: chunkUsage } : {}))),
      ).toMatchObject({ code: "event_after_stop" });
    });

    it("rejects choice-level text and a second repeat", () => {
      expect(
        thrownBy(() =>
          finished().push(
            chatChunk([{ index: 0, delta: {}, text: "hidden", finish_reason: "stop" }], { usage }),
          ),
        ),
      ).toMatchObject({ parameter: "choices[0].text" });
      const parser = finished();
      parser.push(chatChunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage }));
      expect(
        thrownBy(() =>
          parser.push(chatChunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })),
        ),
      ).toMatchObject({ code: "event_after_stop" });
    });
  });

  it("rejects legacy text beside a non-stream Chat message", () => {
    expect(() =>
      adaptNonstreamResponse({
        source: "openai-chat",
        target: "anthropic-messages",
        status: 200,
        body: {
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              text: "hidden answer",
              message: { role: "assistant", content: null },
              finish_reason: "stop",
            },
          ],
        },
      }),
    ).toThrow(/choices\[0\]\.text/u);
  });

  it("caps ignored-field logging per stream at the first distinct names", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const names = Array.from({ length: 40 }, (_, index) => `vendor_${index}`);
    const debug = withDebug(() => {
      // Four fresh names per chunk, ten chunks.
      for (let chunk = 0; chunk < 10; chunk += 1)
        parser.push(
          chatChunk(
            [{ index: 0, delta: { content: "a" }, finish_reason: null }],
            Object.fromEntries(names.slice(chunk * 4, chunk * 4 + 4).map((name) => [name, 1])),
          ),
        );
    });
    const logged = debug.flatMap((call) => (call[1] as { fields: string[] }).fields);
    expect(logged).toEqual(names.slice(0, MAX_LOGGED_FIELDS_PER_STREAM));
    // Four logs of four names, then exactly one cap notice; later chunks are silent.
    expect(debug).toHaveLength(5);
    expect(debug[4]).toEqual([
      ignoredEnvelopeLog,
      { path: "stream.data", fields: [], omitted: 4, streamCapReached: 16 },
    ]);
  });

  it("keeps the per-line cap without a per-stream set", () => {
    const debug = withDebug(() => {
      ignoreUnknownEnvelopeFields(
        Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, 1])),
        [],
        "x",
      );
    });
    expect(debug).toEqual([
      [
        ignoredEnvelopeLog,
        { path: "x", fields: Array.from({ length: 10 }, (_, i) => `k${i}`), omitted: 2 },
      ],
    ]);
  });

  it("names a stable parameter for duplicate usage and a missing delta", () => {
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const parser = new CanonicalStreamParser("openai-chat");
    parser.push(
      chatChunk([{ index: 0, delta: { content: "a" }, finish_reason: "stop" }], { usage }),
    );
    expect(thrownBy(() => parser.push(chatChunk([], { usage })))).toMatchObject({
      code: "duplicate_usage",
      parameter: "usage",
    });
    expect(
      thrownBy(() =>
        new CanonicalStreamParser("openai-chat").push(
          chatChunk([{ index: 0, finish_reason: null }]),
        ),
      ),
    ).toMatchObject({ code: "invalid_stream_event", parameter: "choices[0].delta" });
    const renderer = new CanonicalStreamRenderer("openai-chat");
    renderer.push({ type: "message_start", id: "m", model: "m" });
    renderer.push({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } });
    expect(
      thrownBy(() => renderer.push({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } })),
    ).toMatchObject({ code: "duplicate_usage", parameter: "usage" });
  });

  it("adds relay and target ids (never content) to adapter rejection logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const logContext = {
        relayRequestId: "relay-1",
        poolMemberId: "member-1",
        executionTargetId: "target-1",
      };
      expect(() =>
        adaptNonstreamResponse({
          source: "openai-chat",
          target: "anthropic-messages",
          status: 200,
          body: { id: "c", choices: "DO_NOT_LOG" },
          logContext,
        }),
      ).toThrow();
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chatChunk([{ index: 0, finish_reason: null }]));
          controller.close();
        },
      }).pipeThrough(
        createProtocolAdaptationTransform({
          source: "openai-chat",
          target: "openai-responses",
          logContext: { relayRequestId: "relay-2", poolMemberId: "member-2" },
        }),
      );
      await expect(new Response(readable).text()).rejects.toThrow();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("DO_NOT_LOG");
      expect(warn.mock.calls).toEqual([
        [
          "[model-api] adapter rejected upstream reply",
          expect.objectContaining({ source: "openai-chat", ...logContext }),
        ],
        [
          "[model-api] adapter rejected upstream reply",
          {
            source: "openai-chat",
            target: "openai-responses",
            code: "invalid_stream_event",
            parameter: "choices[0].delta",
            relayRequestId: "relay-2",
            poolMemberId: "member-2",
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("ends a committed stream with a terminal error even before any output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const run = (recoverBeforeOutput: boolean) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chatChunk([{ index: 0, finish_reason: null }]));
              controller.close();
            },
          }).pipeThrough(
            createProtocolAdaptationTransform({
              source: "openai-chat",
              target: "anthropic-messages",
              recoverProtocolErrors: true,
              recoverBeforeOutput,
            }),
          ),
        ).text();
      await expect(run(false)).rejects.toThrow();
      const output = await run(true);
      expect(output).toContain("event: error");
      expect(output).toContain("violated the adapted protocol");
    } finally {
      warn.mockRestore();
    }
  });

  it("omits include_usage only for a Chat surface that declares streamUsage false", () => {
    const canonical = parseAnthropicMessagesRequest({
      model: "m",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const inventory = (streamUsage?: boolean) => ({
      version: 4 as const,
      protocol: "openai-compatible" as const,
      surfaces: {
        openaiChatCompletions: {
          source: "declared" as const,
          confidence: "exact" as const,
          streaming: true,
          operations: ["create" as const],
          ...(streamUsage === undefined ? {} : { streamUsage }),
        },
      },
    });
    expect(executionTargetSupportsStreamUsage(null)).toBe(true);
    expect(executionTargetSupportsStreamUsage(inventory())).toBe(true);
    expect(executionTargetSupportsStreamUsage(inventory(true))).toBe(true);
    expect(executionTargetSupportsStreamUsage(inventory(false))).toBe(false);
    const render = (streamUsage: boolean) =>
      renderCanonicalRequest({
        request: canonical,
        target: "openai-chat",
        model: "upstream",
        streamUsage,
      });
    expect(render(true)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(render(false)).toMatchObject({ stream: true });
    expect(render(false)).not.toHaveProperty("stream_options");
  });
});

it.each(["openai-chat", "openai-responses"] as const)(
  "R4 %s embedded expansion depth bound and native string control",
  (surface) => {
    for (const depth of [20, 256, 257, 10_000]) {
      const argumentsText = nestedWire(depth, "object");
      const request = parseCanonicalRequest(
        surface,
        embeddedArgumentsRequest(surface, argumentsText),
      );
      const render = () => renderAnthropicMessagesRequest(request, "upstream");
      if (depth <= 256) expect(() => JSON.stringify(render())).not.toThrow();
      else expect(render).toThrow("request JSON nesting exceeds 256 levels");
      // Same surface rendering keeps the string without decoding it.
      expect(
        JSON.stringify(renderCanonicalRequest({ request, target: surface, model: "m" })),
      ).toContain(JSON.stringify(argumentsText).slice(1, -1));
    }
  },
);
