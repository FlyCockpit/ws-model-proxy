import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
        "anthropic-ratelimit-requests-reset": "2s",
        "anthropic-ratelimit-tokens-limit": "100",
        "anthropic-ratelimit-tokens-remaining": "80",
        "anthropic-ratelimit-tokens-reset": "3s",
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
      "anthropic-ratelimit-requests-reset": "2s",
      "anthropic-ratelimit-tokens-limit": "100",
      "anthropic-ratelimit-tokens-remaining": "80",
      "anthropic-ratelimit-tokens-reset": "3s",
    });
    expect(metadata.headers.has("x-request-id")).toBe(false);
    const openAiMetadata = renderProtocolErrorMetadata("openai-chat", parsed.error);
    expect(Object.fromEntries(openAiMetadata.headers)).toMatchObject({
      "x-request-id": "header",
      "retry-after": "2",
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "3",
      "x-ratelimit-reset-requests": "2s",
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "80",
      "x-ratelimit-reset-tokens": "3s",
    });
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
