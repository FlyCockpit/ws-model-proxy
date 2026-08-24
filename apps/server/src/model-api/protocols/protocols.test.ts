import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AdapterError,
  CanonicalStreamParser,
  parseAnthropicMessagesRequest,
  parseOpenAiChatRequest,
  parseOpenAiResponsesRequest,
  parseProtocolResponse,
  renderAnthropicMessagesRequest,
  renderOpenAiChatRequest,
  renderProtocolError,
  renderProtocolErrorMetadata,
  renderProtocolResponse,
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
    const before = structuredClone(canonical);
    expect(() => renderAnthropicMessagesRequest(canonical, "upstream")).toThrow(
      "lossy instruction-role collapse",
    );
    expect(canonical).toEqual(before);
    expect(
      renderAnthropicMessagesRequest(canonical, "upstream", {
        allowLossyInstructionRoleCollapse: true,
      }),
    ).toMatchObject({
      system: [{ type: "text", text: "policy" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(canonical).toEqual(before);
  });

  it("accepts only client-defined Responses function tools", () => {
    expect(
      parseOpenAiResponsesRequest({
        model: "requested",
        input: "hello",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        parallel_tool_calls: false,
      }).tools,
    ).toEqual([{ name: "lookup", inputSchema: { type: "object" } }]);
  });

  it("preserves lossless data images and forces single-call tool behavior", () => {
    const dataUrl = "data:image/png;base64,iVBORw==";
    const canonical = parseOpenAiChatRequest({
      model: "m",
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      parallel_tool_calls: false,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }],
    });
    expect(canonical.messages[0]?.content[0]).toMatchObject({
      type: "image",
      source: { kind: "base64", mediaType: "image/png", data: "iVBORw==" },
    });
    expect(renderOpenAiChatRequest(canonical, "upstream")).toMatchObject({
      parallel_tool_calls: false,
      messages: [{ content: [{ image_url: { url: dataUrl } }] }],
    });
  });

  it.each([
    [{ temperature: 1.01 }, "temperature"],
    [{ top_p: -0.1 }, "top_p"],
    [{ stop: [] }, "stop"],
    [{ stop: ["a", "b", "c", "d", "e"] }, "stop"],
    [{ stop: [""] }, "stop"],
  ])("rejects sampling controls outside the strict intersection", (extra, field) => {
    expect(() => parseOpenAiChatRequest({ model: "m", messages: [], ...extra })).toThrow(field);
  });

  it("round-trips ordinary tools with stable call IDs and safely equivalent controls", () => {
    const canonical = parseAnthropicMessagesRequest({
      model: "claude",
      max_tokens: 128,
      temperature: 0.4,
      stop_sequences: ["END"],
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
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

describe("published fixture provenance", () => {
  it("pins every published-derived payload by SHA-256", async () => {
    const directory = new URL("./fixtures/generated-conformance/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as {
      fixtures: Array<{ payload: string; payloadSha256: string }>;
    };
    expect(manifest.fixtures).toHaveLength(4);
    for (const fixture of manifest.fixtures) {
      const bytes = await readFile(new URL(fixture.payload, directory));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.payloadSha256);
    }
  });

  it("keeps adapter goldens explicitly pinned to the canonical adapter version", async () => {
    const directory = new URL("./fixtures/adapter-golden/", import.meta.url);
    for (const file of ["instruction-collapse-v1.json", "tool-roundtrip-v1.json"]) {
      const fixture = JSON.parse(await readFile(new URL(file, directory), "utf8")) as {
        adapterVersion: string;
      };
      expect(fixture.adapterVersion).toBe("1.0.0");
    }
  });
});

describe("non-stream protocol responses", () => {
  it("parses and renders one-candidate Chat with safe response metadata", () => {
    const parsed = parseProtocolResponse({
      surface: "openai-chat",
      status: 200,
      headers: new Headers({ "x-request-id": "req_1", "retry-after": "2" }),
      body: {
        id: "chat_1",
        object: "chat.completion",
        model: "gpt",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "hello",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    });
    expect(parsed).toMatchObject({
      ok: true,
      metadata: { requestId: "req_1", retryAfter: "2" },
      response: { id: "chat_1", stopReason: "tool", items: [{ text: "hello" }, { id: "call_1" }] },
    });
    if (!parsed.ok) throw new Error("expected success");
    expect(renderProtocolResponse("anthropic-messages", parsed.response)).toMatchObject({
      id: "chat_1",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "call_1" },
      ],
      stop_reason: "tool_use",
    });
  });

  it("parses structured upstream errors and renders the requested envelope", () => {
    const parsed = parseProtocolResponse({
      surface: "anthropic-messages",
      status: 429,
      headers: new Headers({ "request-id": "req_limit", "retry-after": "3" }),
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    });
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        code: "rate_limit_error",
        upstreamStatus: 429,
        requestId: "req_limit",
        retryAfter: "3",
      },
    });
    if (parsed.ok) throw new Error("expected error");
    expect(renderProtocolError("openai-responses", parsed.error)).toEqual({
      error: {
        message: "slow down",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_error",
      },
    });
    const metadata = renderProtocolErrorMetadata(parsed.error);
    expect(metadata.status).toBe(429);
    expect(Object.fromEntries(metadata.headers)).toMatchObject({
      "retry-after": "3",
      "x-request-id": "req_limit",
    });
  });

  it("rejects citations, unknown nested output, incomplete tool JSON, and multiple candidates", () => {
    expect(() =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: {
          id: "x",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "c", type: "function", function: { name: "f", arguments: "{" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      }),
    ).toThrow("complete JSON");
    expect(() =>
      parseProtocolResponse({
        surface: "openai-chat",
        status: 200,
        body: { id: "x", object: "chat.completion", choices: [{}, {}] },
      }),
    ).toThrow("exactly one");
    expect(() =>
      parseProtocolResponse({
        surface: "anthropic-messages",
        status: 200,
        body: {
          id: "m",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "x", citations: [{ url: "private" }] }],
          stop_reason: "end_turn",
        },
      }),
    ).toThrow("citations");
  });
});

describe("canonical streaming state machines", () => {
  it("decodes arbitrary UTF-8 splits, CRLF, comments, and multiline SSE data", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const bytes = new TextEncoder().encode(
      ': keepalive\r\ndata: {"id":"chat_1","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"hé"},\r\ndata: "finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n',
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
      { type: "item_complete", index: 0 },
      { type: "stop", reason: "stop" },
      { type: "complete" },
    ]);
    expect(parser.retrySafe).toBe(false);
  });

  it("does not invent an event boundary when CRLF is split across byte chunks", () => {
    const parser = new CanonicalStreamParser("openai-chat");
    const first = new TextEncoder().encode(
      'data: {"id":"chat_1","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\r',
    );
    expect(parser.push(first)).toEqual([]);
    expect(parser.push(new TextEncoder().encode("\n\r\ndata: [DONE]\r\n\r\n"))).toMatchObject([
      { type: "message_start", id: "chat_1" },
      { type: "item_start" },
      { type: "text_delta", delta: "ok" },
      { type: "item_complete" },
      { type: "stop", reason: "stop" },
      { type: "complete" },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("tracks partial tool JSON, enforces bounded buffers, and detects truncation", () => {
    const parser = new CanonicalStreamParser("anthropic-messages", { maxToolArgumentsBytes: 4 });
    const start =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
    const tool =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"12345"}}\n\n';
    parser.push(new TextEncoder().encode(start));
    expect(() => parser.push(new TextEncoder().encode(tool))).toThrow("bounded buffer");
    const truncated = new CanonicalStreamParser("openai-responses");
    truncated.push(
      new TextEncoder().encode(
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r","object":"response","created_at":0,"status":"in_progress","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt","output":[],"parallel_tool_calls":false,"previous_response_id":null,"reasoning":{"effort":null,"summary":null},"store":false,"temperature":null,"text":{"format":{"type":"text"}},"tool_choice":"none","tools":[],"top_p":null,"truncation":"disabled","metadata":{},"usage":null}}\n\n',
      ),
    );
    expect(() => truncated.finish()).toThrow("terminal event");
  });
});
