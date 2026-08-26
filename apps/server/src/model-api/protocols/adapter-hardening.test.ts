import { describe, expect, it } from "vitest";
import {
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
