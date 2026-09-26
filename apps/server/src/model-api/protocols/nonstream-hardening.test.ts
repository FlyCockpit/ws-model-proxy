import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  parseAnthropicMessagesRequest,
  parseOpenAiChatRequest,
  parseOpenAiResponsesRequest,
  parseProtocolResponse,
  renderAnthropicMessagesRequest,
  renderOpenAiChatRequest,
  renderProtocolError,
  renderProtocolErrorMetadata,
} from "./index.js";

describe("request adapter semantic validation", () => {
  it("validates scalar booleans, tool uniqueness, choices, and result references", () => {
    expect(() => parseOpenAiChatRequest({ model: "m", messages: [], stream: 1 })).toThrow(
      "stream must be a boolean",
    );
    expect(() =>
      parseOpenAiResponsesRequest({
        model: "m",
        input: "x",
        tools: [
          { type: "function", name: "same", parameters: {} },
          { type: "function", name: "same", parameters: {} },
        ],
        parallel_tool_calls: false,
      }),
    ).toThrow("must be unique");
    expect(() =>
      parseOpenAiChatRequest({ model: "m", messages: [], tool_choice: "required" }),
    ).toThrow("requires at least one declared tool");
    expect(() =>
      parseAnthropicMessagesRequest({
        model: "m",
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }],
          },
        ],
      }),
    ).toThrow("unknown tool use");
  });

  it("validates Anthropic base64 and is_error and preserves supported image detail", () => {
    const base = { model: "m", max_tokens: 1 };
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "%%%" } },
            ],
          },
        ],
      }),
    ).toThrow("valid base64");
    expect(() =>
      parseAnthropicMessagesRequest({
        ...base,
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "x", is_error: "false" }],
          },
        ],
      }),
    ).toThrow("is_error must be a boolean");
    const canonical = parseOpenAiResponsesRequest({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.test/x.png", detail: "high" },
          ],
        },
      ],
    });
    expect(renderOpenAiChatRequest(canonical, "m")).toMatchObject({
      messages: [{ content: [{ image_url: { detail: "high" } }] }],
    });
  });
});

describe("strict non-stream response parsing", () => {
  it("rejects lossy mixed Chat content and duplicate calls", () => {
    expect(() =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "c",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "text", refusal: "no" },
              finish_reason: "stop",
            },
          ],
        },
      }),
    ).toThrow("mixed text and refusal order");
  });

  it("validates Responses nested arrays and Anthropic terminal reconciliation", () => {
    expect(() =>
      parseProtocolResponse({
        surface: "openai-responses",
        status: 200,
        body: {
          id: "r",
          object: "response",
          status: "completed",
          output: [
            {
              id: "i",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "x", annotations: null }],
            },
          ],
        },
      }),
    ).toThrow("annotations must be an array");
    expect(() =>
      parseProtocolResponse({
        surface: "anthropic-messages",
        status: 200,
        body: {
          id: "m",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "c", name: "f", input: {} }],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      }),
    ).toThrow("does not match tool-use content");
  });

  it("preserves body request IDs and maps error classes by target surface", () => {
    const parsed = parseProtocolResponse({
      surface: "anthropic-messages",
      status: 503,
      headers: new Headers({
        "request-id": "header",
        "retry-after": "2",
        "anthropic-ratelimit-requests-limit": "10",
        "anthropic-ratelimit-requests-remaining": "3",
        "anthropic-ratelimit-requests-reset": "2026-08-25T12:00:00Z",
        "anthropic-ratelimit-tokens-limit": "100",
        "anthropic-ratelimit-tokens-remaining": "80",
        "anthropic-ratelimit-tokens-reset": "2026-08-25T12:01:00Z",
      }),
      body: {
        type: "error",
        request_id: "body",
        error: { type: "overloaded_error", message: "busy" },
      },
    });
    if (parsed.ok) throw new Error("expected error");
    expect(parsed.error.requestId).toBe("header");
    expect(renderProtocolError("openai-responses", parsed.error)).toMatchObject({
      error: { type: "server_error", code: "upstream_error" },
    });
    const metadata = renderProtocolErrorMetadata("anthropic-messages", parsed.error);
    expect(Object.fromEntries(metadata.headers)).toMatchObject({
      "request-id": "header",
      "retry-after": "2",
      "anthropic-ratelimit-requests-limit": "10",
      "anthropic-ratelimit-requests-remaining": "3",
      "anthropic-ratelimit-requests-reset": "2026-08-25T12:00:00Z",
      "anthropic-ratelimit-tokens-limit": "100",
      "anthropic-ratelimit-tokens-remaining": "80",
      "anthropic-ratelimit-tokens-reset": "2026-08-25T12:01:00Z",
    });
    expect(metadata.headers.has("x-request-id")).toBe(false);
    const openAiMetadata = renderProtocolErrorMetadata("openai-chat", parsed.error);
    expect(Object.fromEntries(openAiMetadata.headers)).toMatchObject({
      "x-request-id": "header",
      "retry-after": "2",
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "3",
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "80",
    });
    expect(openAiMetadata.headers.has("x-ratelimit-reset-requests")).toBe(false);
    expect(openAiMetadata.headers.has("x-ratelimit-reset-tokens")).toBe(false);
    expect(openAiMetadata.headers.has("request-id")).toBe(false);
  });

  it("never reflects provider-controlled error text, code, or parameter", () => {
    const parsed = parseProtocolResponse({
      surface: "openai-chat",
      status: 400,
      body: {
        error: {
          type: "private_type",
          code: "tenant-secret-code",
          param: "tenant-other.internal_id",
          message: "api-key-secret at http://10.0.0.7/private",
        },
      },
    });
    if (parsed.ok) throw new Error("expected error");
    expect(renderProtocolError("openai-responses", parsed.error)).toEqual({
      error: {
        message: "The provider rejected the request.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
    });
  });

  it("preserves 529 overload status semantics without reflecting provider text", () => {
    const parsed = parseProtocolResponse({
      surface: "anthropic-messages",
      status: 529,
      body: {
        type: "error",
        error: { type: "private-overload-code", message: "internal overload host 10.0.0.9" },
      },
    });
    if (parsed.ok) throw new Error("expected error");
    expect(renderProtocolError("anthropic-messages", parsed.error)).toMatchObject({
      error: { type: "overloaded_error", message: "The provider is overloaded." },
    });
  });

  it("canonicalizes empty and malformed non-success bodies", () => {
    for (const body of [null, undefined, "not-json", {}, { unexpected: "private" }]) {
      const parsed = parseProtocolResponse({
        surface: "openai-responses",
        status: 429,
        body,
      });
      if (parsed.ok) throw new Error("expected error");
      expect(parsed.error).toMatchObject({
        upstreamStatus: 429,
        code: "rate_limit_error",
        message: "The provider rate limit was exceeded.",
      });
    }
  });

  it("drops syntactically plausible but semantically invalid provider metadata", () => {
    const parsed = parseProtocolResponse({
      surface: "anthropic-messages",
      status: 529,
      headers: new Headers({
        "request-id": "safe-id",
        "retry-after": "1s",
        "anthropic-ratelimit-requests-limit": "1.5",
        "anthropic-ratelimit-requests-remaining": "-1",
        "anthropic-ratelimit-requests-reset": "9999",
        "anthropic-ratelimit-tokens-limit": "1e9",
        "anthropic-ratelimit-tokens-remaining": "01",
        "anthropic-ratelimit-tokens-reset": "https://10.0.0.1/private",
      }),
      body: null,
    });
    if (parsed.ok) throw new Error("expected error");
    const metadata = renderProtocolErrorMetadata("anthropic-messages", parsed.error);
    expect(Object.fromEntries(metadata.headers)).toEqual({
      "content-type": "application/json; charset=utf-8",
      "request-id": "safe-id",
    });

    const malformedDates = parseProtocolResponse({
      surface: "openai-chat",
      status: 429,
      headers: new Headers({
        "retry-after": "Mon, 99 Jan 2026 99:99:99 GMT",
        "x-ratelimit-reset-requests": "999999999999999999h",
      }),
      body: { error: { message: "ignored", nested: { secret: true } } },
    });
    if (malformedDates.ok) throw new Error("expected error");
    expect(
      Object.fromEntries(renderProtocolErrorMetadata("openai-chat", malformedDates.error).headers),
    ).toEqual({ "content-type": "application/json; charset=utf-8" });
  });
});

describe("adapter golden execution", () => {
  it("executes the pinned tool round-trip golden", async () => {
    const golden = JSON.parse(
      await readFile(
        new URL("./fixtures/adapter-golden/tool-roundtrip-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      canonical: { callId: string };
      openaiChat: { parallelToolCalls: boolean };
      anthropic: { disableParallelToolUse: boolean };
    };
    const canonical = parseAnthropicMessagesRequest({
      model: "claude",
      max_tokens: 8,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      tools: [{ name: "weather", input_schema: {} }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: golden.canonical.callId,
              name: "weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: golden.canonical.callId, content: "sunny" },
          ],
        },
      ],
    });
    expect(renderOpenAiChatRequest(canonical, "gpt").parallel_tool_calls).toBe(
      golden.openaiChat.parallelToolCalls,
    );
    expect(
      (renderAnthropicMessagesRequest(canonical, "claude").tool_choice as Record<string, unknown>)
        .disable_parallel_tool_use,
    ).toBe(golden.anthropic.disableParallelToolUse);
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

describe("upstream reply envelopes ignore unknown fields", () => {
  it("adapts a llama.cpp chat reply with timings and reasoning_content", () => {
    const timingsSecret = "DO_NOT_LOG_timings_value";
    const choiceSecret = "DO_NOT_LOG_choice_value";
    let items: unknown;
    const debug = withDebug(() => {
      const parsed = parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "llama",
          object: "chat.completion",
          created: 0,
          model: "local",
          timings: { predicted_n: 1, prompt_per_second: timingsSecret },
          choices: [
            {
              index: 0,
              llama_choice: choiceSecret,
              message: {
                role: "assistant",
                content: "pong",
                reasoning_content: "REASONING_CONTENT_HIDDEN",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("expected success");
      items = parsed.response.items;
    });
    expect(items).toEqual([{ type: "text", text: "pong" }]);
    expect(JSON.stringify(items)).not.toContain("REASONING_CONTENT_HIDDEN");
    expectIgnored(debug, "response", ["timings"], timingsSecret);
    expectIgnored(debug, "response.choices[0]", ["llama_choice"], choiceSecret);
  });

  it("drops both reasoning spellings when real content is present", () => {
    const debug = withDebug(() => {
      const parsed = parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "c",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "pong",
                reasoning: "hidden",
                reasoning_content: "REASONING_CONTENT_HIDDEN",
              },
              finish_reason: "stop",
            },
          ],
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("expected success");
      expect(parsed.response.items).toEqual([{ type: "text", text: "pong" }]);
    });
    expect(debug).toEqual([]);
  });

  it("treats empty or null reasoning spellings as absent", () => {
    const parsed = parseProtocolResponse({
      surface: "openai-chat",
      status: 200,
      body: {
        id: "c",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "pong",
              reasoning: "",
              reasoning_content: null,
            },
            finish_reason: "stop",
          },
        ],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected success");
    expect(parsed.response.items).toEqual([{ type: "text", text: "pong" }]);
  });

  it("rejects a final answer whose only text is reasoning_content", () => {
    const only = (message: Record<string, unknown>) =>
      expect(() =>
        parseProtocolResponse({
          surface: "openai-chat",
          status: 200,
          body: {
            id: "c",
            object: "chat.completion",
            choices: [{ index: 0, message, finish_reason: "stop" }],
          },
        }),
      ).toThrow(/only visible text/u);
    only({ role: "assistant", content: null, reasoning_content: "REASONING_CONTENT_HIDDEN" });
    only({
      role: "assistant",
      content: null,
      reasoning: "hidden",
      reasoning_content: "REASONING_CONTENT_HIDDEN",
    });
  });

  it("rejects a non-string reasoning_content value", () => {
    const body = (message: Record<string, unknown>) => ({
      id: "c",
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: "stop" }],
    });
    expect(() =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: body({ role: "assistant", content: "pong", reasoning_content: 1 }),
      }),
    ).toThrow(/\.reasoning_content must be text/u);
    expect(() =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: body({
          role: "assistant",
          content: "pong",
          reasoning: { text: "hidden" },
          reasoning_content: "REASONING_CONTENT_HIDDEN",
        }),
      }),
    ).toThrow(/\.reasoning must be text/u);
  });

  it("ignores an unknown Responses envelope field and logs the name only", () => {
    const secret = "DO_NOT_LOG_response_value";
    const debug = withDebug(() => {
      const parsed = parseProtocolResponse({
        surface: "openai-responses",
        status: 200,
        body: {
          id: "r",
          object: "response",
          status: "completed",
          background: secret,
          output: [
            {
              id: "i",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("expected success");
      expect(parsed.response.items).toEqual([{ type: "text", text: "ok" }]);
    });
    expectIgnored(debug, "response", ["background"], secret);
  });

  it("ignores an unknown Anthropic envelope field and logs the name only", () => {
    const secret = "DO_NOT_LOG_container_value";
    const debug = withDebug(() => {
      const parsed = parseProtocolResponse({
        surface: "anthropic-messages",
        status: 200,
        body: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          container: secret,
        },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("expected success");
      expect(parsed.response.items).toEqual([{ type: "text", text: "ok" }]);
    });
    expectIgnored(debug, "response", ["container"], secret);
  });

  it("still rejects unknown message, tool-call, and function fields", () => {
    const chat = (message: Record<string, unknown>) =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "c",
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: "stop" }],
        },
      });
    const debug = withDebug(() => {
      expect(() => chat({ role: "assistant", content: "pong", extra_vendor_field: true })).toThrow(
        /extra_vendor_field/u,
      );
      expect(() =>
        chat({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              vendor_call: true,
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        }),
      ).toThrow(/vendor_call/u);
      expect(() =>
        chat({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "lookup", arguments: "{}", vendor_fn: true },
            },
          ],
        }),
      ).toThrow(/vendor_fn/u);
    });
    expect(debug).toEqual([]);
  });

  it("still rejects unknown output items and content blocks, and ignores unknown usage keys", () => {
    const debug = withDebug(() => {
      expect(() =>
        parseProtocolResponse({
          surface: "openai-responses",
          status: 200,
          body: {
            id: "r",
            object: "response",
            status: "completed",
            output: [
              {
                id: "i",
                type: "message",
                status: "completed",
                role: "assistant",
                phase: "nope",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
          },
        }),
      ).toThrow(/phase/u);
      expect(() =>
        parseProtocolResponse({
          surface: "anthropic-messages",
          status: 200,
          body: {
            id: "m",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok", cache_control: { type: "ephemeral" } }],
            stop_reason: "end_turn",
          },
        }),
      ).toThrow(/cache_control/u);
      const parsed = parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "c",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, extra_usage: 1 },
        },
      });
      expect(parsed.ok && parsed.response.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    });
    expect(debug).toEqual([]);
  });
});
