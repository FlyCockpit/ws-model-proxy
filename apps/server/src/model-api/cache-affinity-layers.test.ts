import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asJson,
  canonicalizeAffinitySurface,
  extractAffinityLayers,
} from "./cache-affinity-layers.js";

const extractorSource = readFileSync(
  new URL("./cache-affinity-layers.ts", import.meta.url),
  "utf8",
);

describe("canonicalizeAffinitySurface", () => {
  it("maps ProtocolSurface and telemetry aliases to canonical surfaces", () => {
    expect(canonicalizeAffinitySurface("openai-chat")).toBe("openai-chat");
    expect(canonicalizeAffinitySurface("OPENAI_CHAT_COMPLETIONS")).toBe("openai-chat");
    expect(canonicalizeAffinitySurface("openai-responses")).toBe("openai-responses");
    expect(canonicalizeAffinitySurface("OPENAI_RESPONSES")).toBe("openai-responses");
    expect(canonicalizeAffinitySurface("anthropic-messages")).toBe("anthropic-messages");
    expect(canonicalizeAffinitySurface("ANTHROPIC_MESSAGES")).toBe("anthropic-messages");
  });

  it("treats Completions and unknown labels as unknown", () => {
    expect(canonicalizeAffinitySurface("OPENAI_COMPLETIONS")).toBeNull();
    expect(canonicalizeAffinitySurface("completions")).toBeNull();
    expect(canonicalizeAffinitySurface("openai-completions")).toBeNull();
    expect(canonicalizeAffinitySurface("")).toBeNull();
  });
});

describe("extractAffinityLayers", () => {
  it("does not import adapter parsers", () => {
    expect(extractorSource).not.toMatch(/protocols\/openai-chat/);
    expect(extractorSource).not.toMatch(/protocols\/openai-responses/);
    expect(extractorSource).not.toMatch(/protocols\/anthropic-messages/);
    expect(extractorSource).not.toMatch(/parseOpenAiChatRequest/);
    expect(extractorSource).not.toMatch(/parseOpenAiResponsesRequest/);
    expect(extractorSource).not.toMatch(/parseAnthropicMessagesRequest/);
  });

  it("splits Chat {system, user} into instruction and conversation units without continuation", () => {
    const layers = extractAffinityLayers("openai-chat", {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
    });
    expect(layers.instructionUnits).toEqual([{ role: "system", content: "S" }]);
    expect(layers.conversationUnits).toEqual([{ role: "user", content: "U" }]);
    expect(layers.tools).toBeUndefined();
    expect(layers.isContinuation).toBe(false);
    expect(layers.consumedKeys).toEqual(["messages"]);
    expect(layers.consumedKeys).not.toContain("prompt");
  });

  it("keeps Chat instruction units when the user turn differs", () => {
    const first = extractAffinityLayers("openai-chat", {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U1" },
      ],
    });
    const second = extractAffinityLayers("openai-chat", {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U2" },
      ],
    });
    expect(second.instructionUnits).toEqual(first.instructionUnits);
    expect(second.conversationUnits).not.toEqual(first.conversationUnits);
  });

  it("includes tools in consumedKeys only when tools JSON is defined", () => {
    const without = extractAffinityLayers("openai-chat", {
      messages: [{ role: "user", content: "U" }],
    });
    const withTools = extractAffinityLayers("openai-chat", {
      messages: [{ role: "user", content: "U" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    expect(without.consumedKeys).toEqual(["messages"]);
    expect(without.tools).toBeUndefined();
    expect(withTools.consumedKeys).toEqual(["messages", "tools"]);
    expect(withTools.tools).toEqual([{ type: "function", function: { name: "lookup" } }]);
    expect(withTools.instructionUnits).toEqual([]);

    const anthropic = extractAffinityLayers("anthropic-messages", {
      system: "S",
      messages: [{ role: "user", content: "U" }],
      tools: [{ name: "lookup" }],
    });
    expect(anthropic.consumedKeys).toEqual(["system", "messages", "tools"]);
    expect(anthropic.tools).toEqual([{ name: "lookup" }]);
    expect(
      extractAffinityLayers("anthropic-messages", {
        system: "S",
        messages: [{ role: "user", content: "U" }],
      }).consumedKeys,
    ).toEqual(["system", "messages"]);

    const responses = extractAffinityLayers("openai-responses", {
      instructions: "S",
      input: "U",
      tools: [{ name: "lookup" }],
    });
    expect(responses.consumedKeys).toEqual(["instructions", "input", "tools"]);
    expect(responses.tools).toEqual([{ name: "lookup" }]);
    expect(
      extractAffinityLayers("openai-responses", { instructions: "S", input: "U" }).consumedKeys,
    ).toEqual(["instructions", "input"]);
  });

  it("does not consume malformed Chat messages and leaves conversation empty", () => {
    const layers = extractAffinityLayers("openai-chat", { messages: "not-an-array" });
    expect(layers.conversationUnits).toEqual([]);
    expect(layers.instructionUnits).toEqual([]);
    expect(layers.consumedKeys).not.toContain("messages");
    expect(layers.isContinuation).toBe(false);
  });

  it("case-normalizes Chat roles so System and Assistant behave as system and assistant", () => {
    const layers = extractAffinityLayers("openai-chat", {
      messages: [
        { role: "System", content: "S" },
        { role: "User", content: "U" },
        { role: "Assistant", content: "A" },
      ],
    });
    expect(layers.instructionUnits).toEqual([{ role: "System", content: "S" }]);
    expect(layers.conversationUnits).toEqual([
      { role: "User", content: "U" },
      { role: "Assistant", content: "A" },
    ]);
    expect(layers.isContinuation).toBe(true);
  });

  it("lifts interleaved Chat system and developer messages into the instruction layer", () => {
    const layers = extractAffinityLayers("openai-chat", {
      messages: [
        { role: "system", content: "S1" },
        { role: "user", content: "U1" },
        { role: "developer", content: "D" },
        { role: "user", content: "U2" },
      ],
    });
    expect(layers.instructionUnits).toEqual([
      { role: "system", content: "S1" },
      { role: "developer", content: "D" },
    ]);
    expect(layers.conversationUnits).toEqual([
      { role: "user", content: "U1" },
      { role: "user", content: "U2" },
    ]);
    expect(layers.isContinuation).toBe(false);
  });

  it("never reads Chat prompt or input as conversation units", () => {
    const layers = extractAffinityLayers("openai-chat", {
      messages: [{ role: "user", content: "U" }],
      prompt: "legacy prompt",
      input: "responses input",
      system: "top-level system",
      instructions: "top-level instructions",
    });
    expect(layers.conversationUnits).toEqual([{ role: "user", content: "U" }]);
    expect(layers.instructionUnits).toEqual([]);
    expect(layers.consumedKeys).toEqual(["messages"]);
  });

  it("does not fall back to Chat prompt, input, system, or instructions when messages is missing or malformed", () => {
    const stray = {
      prompt: "legacy prompt",
      input: "responses input",
      system: "top-level system",
      instructions: "top-level instructions",
    };
    const missing = extractAffinityLayers("openai-chat", stray);
    const malformed = extractAffinityLayers("openai-chat", { ...stray, messages: "not-an-array" });
    for (const layers of [missing, malformed]) {
      expect(layers.instructionUnits).toEqual([]);
      expect(layers.conversationUnits).toEqual([]);
      expect(layers.consumedKeys).toEqual([]);
      expect(layers.tools).toBeUndefined();
    }
  });

  it("marks Chat tool, function, tool_calls, and function_call follow-ups as continuations", () => {
    expect(
      extractAffinityLayers("openai-chat", {
        messages: [
          { role: "user", content: "U" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
        ],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("openai-chat", {
        messages: [{ role: "tool", tool_call_id: "c1", content: "ok" }],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("openai-chat", {
        messages: [{ role: "function", name: "lookup", content: "{}" }],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("openai-chat", {
        messages: [
          { role: "assistant", content: null, function_call: { name: "lookup", arguments: "{}" } },
        ],
      }).isContinuation,
    ).toBe(true);
  });

  it("treats Anthropic system string and block array as one instruction unit each", () => {
    const text = extractAffinityLayers("anthropic-messages", {
      system: "text",
      messages: [{ role: "user", content: "U" }],
    });
    const blocks = extractAffinityLayers("anthropic-messages", {
      system: [{ type: "text", text: "text" }],
      messages: [{ role: "user", content: "U" }],
    });
    expect(text.instructionUnits).toEqual(["text"]);
    expect(text.instructionUnits).toHaveLength(1);
    expect(text.conversationUnits).toEqual([{ role: "user", content: "U" }]);
    expect(blocks.instructionUnits).toEqual([[{ type: "text", text: "text" }]]);
    expect(blocks.instructionUnits).toHaveLength(1);
    expect(blocks.conversationUnits).toEqual([{ role: "user", content: "U" }]);
    expect(text.isContinuation).toBe(false);
    expect(text.consumedKeys).toEqual(["system", "messages"]);
  });

  it("does not partially match distinct Anthropic system block arrays", () => {
    const first = extractAffinityLayers("anthropic-messages", {
      system: [
        { type: "text", text: "block1" },
        { type: "text", text: "block2" },
      ],
    });
    const second = extractAffinityLayers("anthropic-messages", {
      system: [
        { type: "text", text: "block1" },
        { type: "text", text: "block3" },
      ],
    });
    expect(first.instructionUnits).toHaveLength(1);
    expect(second.instructionUnits).toHaveLength(1);
    expect(first.instructionUnits).not.toEqual(second.instructionUnits);
  });

  it("does not lift Anthropic messages-array system roles into the instruction layer", () => {
    const layers = extractAffinityLayers("anthropic-messages", {
      messages: [{ role: "system", content: "not top-level" }],
    });
    expect(layers.instructionUnits).toEqual([]);
    expect(layers.conversationUnits).toEqual([{ role: "system", content: "not top-level" }]);
  });

  it("does not consume malformed Anthropic messages", () => {
    const layers = extractAffinityLayers("anthropic-messages", {
      system: "S",
      messages: "not-an-array",
    });
    expect(layers.instructionUnits).toEqual(["S"]);
    expect(layers.conversationUnits).toEqual([]);
    expect(layers.consumedKeys).toEqual(["system"]);
    expect(layers.consumedKeys).not.toContain("messages");
    expect(layers.isContinuation).toBe(false);
  });

  it("marks Anthropic assistant text as continuation without tool blocks", () => {
    const layers = extractAffinityLayers("anthropic-messages", {
      system: "S",
      messages: [
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
    });
    expect(layers.isContinuation).toBe(true);
    expect(layers.conversationUnits).toEqual([
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
    ]);
  });

  it("marks Anthropic user tool_result and tool_use content as continuation", () => {
    expect(
      extractAffinityLayers("anthropic-messages", {
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("anthropic-messages", {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup" }] },
        ],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("anthropic-messages", {
        messages: [{ role: "user", content: [{ type: "Tool_Result", tool_use_id: "t1" }] }],
      }).isContinuation,
    ).toBe(true);
  });

  it("treats Responses scalar input as one user conversation unit", () => {
    const layers = extractAffinityLayers("openai-responses", { input: "hello" });
    expect(layers.instructionUnits).toEqual([]);
    expect(layers.conversationUnits).toEqual(["hello"]);
    expect(layers.isContinuation).toBe(false);
    expect(layers.consumedKeys).toEqual(["input"]);
  });

  it("lifts Responses top-level instructions and input system/developer items", () => {
    const layers = extractAffinityLayers("openai-responses", {
      instructions: "top",
      input: [
        { role: "system", content: "S" },
        { role: "developer", content: "D" },
        { role: "user", content: "U" },
      ],
    });
    expect(layers.instructionUnits).toEqual([
      "top",
      { role: "system", content: "S" },
      { role: "developer", content: "D" },
    ]);
    expect(layers.conversationUnits).toEqual([{ role: "user", content: "U" }]);
    expect(layers.isContinuation).toBe(false);
    expect(layers.consumedKeys).toEqual(["instructions", "input"]);
  });

  it("marks Responses function_call_output, computer_call, custom_tool_call_output, mcp_call, and reasoning as continuation", () => {
    for (const type of [
      "function_call_output",
      "computer_call",
      "custom_tool_call_output",
      "mcp_call",
      "reasoning",
      "file_search_call",
      "web_search_call_output",
      "image_generation_call",
      "future_vendor_call",
      "Future_Vendor_Call_Output",
    ]) {
      expect(
        extractAffinityLayers("openai-responses", {
          input: [{ type, id: "x" }],
        }).isContinuation,
        type,
      ).toBe(true);
    }
  });

  it("marks Responses assistant message items as continuation without a call type", () => {
    expect(
      extractAffinityLayers("openai-responses", {
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "A" }] },
        ],
      }).isContinuation,
    ).toBe(true);
    expect(
      extractAffinityLayers("openai-responses", {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "U" }] }],
      }).isContinuation,
    ).toBe(false);
  });

  it("keeps Responses item_reference as a conversation unit without continuation", () => {
    const layers = extractAffinityLayers("openai-responses", {
      input: [{ type: "item_reference", id: "resp_1" }],
    });
    expect(layers.conversationUnits).toEqual([{ type: "item_reference", id: "resp_1" }]);
    expect(layers.isContinuation).toBe(false);
  });

  it("does not consume malformed Responses input objects", () => {
    const layers = extractAffinityLayers("openai-responses", { input: { id: "not-array" } });
    expect(layers.conversationUnits).toEqual([]);
    expect(layers.consumedKeys).not.toContain("input");
    expect(layers.isContinuation).toBe(false);
  });

  it("detects continuation on the raw array before any unit cap", () => {
    const chatMessages = Array.from({ length: 64 }, (_, index) => ({
      role: "user",
      content: `u${index}`,
    }));
    chatMessages.push({ role: "assistant", content: "late" });
    const chat = extractAffinityLayers("openai-chat", { messages: chatMessages });
    expect(chat.isContinuation).toBe(true);
    expect(chat.conversationUnits).toHaveLength(65);

    const responsesInput = [
      ...Array.from({ length: 64 }, (_, index) => ({
        role: "user",
        content: `u${index}`,
      })),
      { type: "computer_call", id: "call_late" },
    ];
    const responses = extractAffinityLayers("openai-responses", { input: responsesInput });
    expect(responses.isContinuation).toBe(true);
    expect(responses.conversationUnits).toHaveLength(65);
  });

  it("returns zero instruction units for Responses stored prompt templates", () => {
    const layers = extractAffinityLayers("openai-responses", {
      prompt: { id: "pmpt_123", version: "1" },
    });
    expect(layers.instructionUnits).toEqual([]);
    expect(layers.conversationUnits).toEqual([]);
    expect(layers.consumedKeys).toEqual([]);
  });

  it("returns empty layers for Completions and unknown surfaces", () => {
    const completions = extractAffinityLayers("OPENAI_COMPLETIONS", {
      prompt: "complete this",
      tools: [{ name: "x" }],
    });
    const unknown = extractAffinityLayers("not-a-surface", {
      messages: [{ role: "system", content: "S" }],
    });
    expect(completions).toEqual({
      instructionUnits: [],
      conversationUnits: [],
      tools: undefined,
      consumedKeys: [],
      isContinuation: false,
    });
    expect(unknown).toEqual(completions);
  });

  it("accepts production telemetry aliases for the same payload shape", () => {
    const payload = {
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
    };
    expect(extractAffinityLayers("OPENAI_CHAT_COMPLETIONS", payload)).toEqual(
      extractAffinityLayers("openai-chat", payload),
    );
    expect(
      extractAffinityLayers("ANTHROPIC_MESSAGES", { system: "S", messages: [{ role: "user" }] }),
    ).toEqual(
      extractAffinityLayers("anthropic-messages", { system: "S", messages: [{ role: "user" }] }),
    );
    expect(extractAffinityLayers("OPENAI_RESPONSES", { input: "x" })).toEqual(
      extractAffinityLayers("openai-responses", { input: "x" }),
    );
  });

  it("returns uncapped instruction units and keeps tools off that list", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      role: "system",
      content: `S${index}`,
    }));
    messages.push({ role: "user", content: "U" });
    const layers = extractAffinityLayers("openai-chat", {
      messages,
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    expect(layers.instructionUnits).toHaveLength(9);
    expect(layers.conversationUnits).toHaveLength(1);
    expect(layers.tools).toEqual([{ type: "function", function: { name: "lookup" } }]);
  });

  it("never throws on unknown fields, extra keys, or non-strict payloads", () => {
    const garbage: Record<string, unknown>[] = [
      { messages: [{ role: 1, content: { nested: true }, extra: [1, 2] }], vendor: { x: 1 } },
      { messages: [null, "plain", 3, { role: "user" }] },
      { system: { unexpected: true }, messages: { not: "array" } },
      { instructions: { id: 1 }, input: 12, tools: "nope" },
      { messages: [{ content: [{ type: 4 }] }] },
    ];
    for (const payload of garbage) {
      expect(() => extractAffinityLayers("openai-chat", payload)).not.toThrow();
      expect(() => extractAffinityLayers("anthropic-messages", payload)).not.toThrow();
      expect(() => extractAffinityLayers("openai-responses", payload)).not.toThrow();
      expect(() => extractAffinityLayers("OPENAI_COMPLETIONS", payload)).not.toThrow();
    }
    const mixed = extractAffinityLayers("openai-chat", {
      messages: [null, "plain", 3, { role: "user", content: "U" }],
    });
    expect(mixed.conversationUnits).toEqual([null, "plain", 3, { role: "user", content: "U" }]);
    expect(mixed.isContinuation).toBe(false);
    expect(mixed.consumedKeys).toEqual(["messages"]);
  });

  it("drops non-JSON values from asJson and rejects arrays that contain them", () => {
    expect(asJson({ a: 1, b: () => 1, c: undefined })).toEqual({ a: 1 });
    expect(asJson([1, undefined])).toBeUndefined();
    expect(asJson([1, () => 1])).toBeUndefined();
    expect(
      extractAffinityLayers("openai-chat", {
        messages: [{ role: "user", content: "U" }],
        tools: [1, undefined],
      }).consumedKeys,
    ).not.toContain("tools");
  });
});
