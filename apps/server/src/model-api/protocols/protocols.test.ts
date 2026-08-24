import { describe, expect, it } from "vitest";
import {
  AdapterError,
  CanonicalStreamParser,
  parseAnthropicMessagesRequest,
  parseOpenAiChatRequest,
  parseOpenAiResponsesRequest,
  renderAnthropicMessagesRequest,
  renderOpenAiChatRequest,
} from "./index.js";

describe("canonical request adapters", () => {
  it("preserves interleaved system/developer boundaries and rejects implicit authority collapse", () => {
    const canonical = parseOpenAiChatRequest({
      model: "requested",
      messages: [
        { role: "system", content: "system one" },
        { role: "user", content: "hello" },
        { role: "developer", content: [{ type: "text", text: "developer one" }] },
        { role: "system", content: "system two" },
      ],
    });
    expect(canonical.instructions).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system one" }],
        boundary: { sourceIndex: 0 },
      },
      {
        role: "developer",
        content: [{ type: "text", text: "developer one" }],
        boundary: { sourceIndex: 2 },
      },
      {
        role: "system",
        content: [{ type: "text", text: "system two" }],
        boundary: { sourceIndex: 3 },
      },
    ]);
    expect(() => renderAnthropicMessagesRequest(canonical, "upstream")).toThrowError(AdapterError);
    const rendered = renderAnthropicMessagesRequest(canonical, "upstream", {
      allowLossyInstructionRoleCollapse: true,
    });
    expect(rendered.system).toEqual([
      { type: "text", text: "system one" },
      { type: "text", text: "developer one" },
      { type: "text", text: "system two" },
    ]);
    expect(rendered.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(canonical.limitations).toContain("anthropic_instruction_authority_collapse");
  });

  it("allows developer-only adaptation while surfacing the Anthropic limitation", () => {
    const canonical = parseOpenAiResponsesRequest({
      model: "requested",
      instructions: "policy",
      input: "hello",
    });
    expect(renderAnthropicMessagesRequest(canonical, "upstream")).toMatchObject({
      system: [{ type: "text", text: "policy" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(canonical.limitations).toContain("anthropic_instruction_authority_collapse");
  });

  it("accepts only client-defined Responses function tools", () => {
    expect(
      parseOpenAiResponsesRequest({
        model: "requested",
        input: "hello",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }).tools,
    ).toEqual([{ name: "lookup", inputSchema: { type: "object" } }]);
  });

  it("round-trips ordinary tools with stable call IDs and safely equivalent controls", () => {
    const canonical = parseAnthropicMessagesRequest({
      model: "claude",
      max_tokens: 128,
      temperature: 0.4,
      stop_sequences: ["END"],
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_stable", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_stable", content: "sunny" }],
        },
      ],
    });
    expect(renderOpenAiChatRequest(canonical, "gpt")).toMatchObject({
      max_completion_tokens: 128,
      temperature: 0.4,
      stop: ["END"],
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_stable" }] },
        { role: "tool", tool_call_id: "call_stable", content: "sunny" },
      ],
    });
  });

  it.each([
    [{ model: "m", input: "x", previous_response_id: "resp_private" }, "previous_response_id"],
    [{ model: "m", input: "x", tools: [{ type: "web_search" }] }, "tools[0].type"],
    [{ model: "m", messages: [], logprobs: true }, "body.logprobs"],
    [{ model: "m", messages: [], n: 2 }, "n"],
  ])("rejects unsupported or unknown semantic fields", (body, parameter) => {
    expect(() =>
      "input" in body ? parseOpenAiResponsesRequest(body) : parseOpenAiChatRequest(body),
    ).toThrow(parameter);
  });
});

describe("canonical streaming state machines", () => {
  it("decodes arbitrary UTF-8 splits, CRLF, comments, and multiline SSE data", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const bytes = new TextEncoder().encode(
      ': keepalive\r\ndata: {"id":"chat_1","model":"gpt","choices":[{"index":0,"delta":{"content":"hé"},\r\ndata: "finish_reason":null}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const events = [
      ...parser.push(bytes.slice(0, 77)),
      ...parser.push(bytes.slice(77, 83)),
      ...parser.push(bytes.slice(83)),
      ...parser.finish(),
    ];
    expect(events).toEqual([
      { type: "message_start", id: "chat_1", model: "gpt" },
      { type: "item_start", index: 0, id: "text-0", itemType: "text" },
      { type: "text_delta", index: 0, delta: "hé" },
      { type: "complete" },
    ]);
    expect(parser.retrySafe).toBe(false);
  });

  it("does not invent an event boundary when CRLF is split across byte chunks", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const first = new TextEncoder().encode(
      'data: {"id":"chat_1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\r',
    );
    expect(parser.push(first)).toEqual([]);
    expect(parser.push(new TextEncoder().encode("\n\r\ndata: [DONE]\r\n\r\n"))).toMatchObject([
      { type: "message_start", id: "chat_1" },
      { type: "item_start" },
      { type: "text_delta", delta: "ok" },
      { type: "complete" },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("tracks partial tool JSON, enforces bounded buffers, and detects truncation", () => {
    const parser = new CanonicalStreamParser("anthropic-messages", { maxToolArgumentsBytes: 4 });
    const start = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg"}}\n\n';
    const tool =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"12345"}}\n\n';
    parser.push(new TextEncoder().encode(start));
    expect(() => parser.push(new TextEncoder().encode(tool))).toThrow("bounded buffer");
    const truncated = new CanonicalStreamParser("openai-responses");
    truncated.push(
      new TextEncoder().encode(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      ),
    );
    expect(() => truncated.finish()).toThrow("terminal event");
  });
});
