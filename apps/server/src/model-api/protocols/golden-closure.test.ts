import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AdapterError, parseOpenAiChatRequest, renderAnthropicMessagesRequest } from "./index.js";

describe("adapter golden behavior", () => {
  it("executes every pinned tool round-trip field against rendered request wire", async () => {
    const golden = JSON.parse(
      await readFile(
        new URL("./fixtures/adapter-golden/tool-roundtrip-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      canonical: { toolName: string; callId: string; arguments: string; result: string };
      openaiChat: { toolType: string; parallelToolCalls: boolean };
      anthropic: {
        toolType: string;
        resultType: string;
        disableParallelToolUse: boolean;
      };
    };
    const canonical = parseOpenAiChatRequest({
      model: "gpt",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: golden.canonical.callId,
              type: golden.openaiChat.toolType,
              function: {
                name: golden.canonical.toolName,
                arguments: golden.canonical.arguments,
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: golden.canonical.callId,
          content: golden.canonical.result,
        },
      ],
      tools: [
        {
          type: golden.openaiChat.toolType,
          function: {
            name: golden.canonical.toolName,
            parameters: { type: "object" },
          },
        },
      ],
      tool_choice: {
        type: golden.openaiChat.toolType,
        function: { name: golden.canonical.toolName },
      },
      parallel_tool_calls: golden.openaiChat.parallelToolCalls,
    });
    const wire = renderAnthropicMessagesRequest(canonical, "claude");
    expect(wire.tool_choice).toEqual({
      type: "tool",
      name: golden.canonical.toolName,
      disable_parallel_tool_use: golden.anthropic.disableParallelToolUse,
    });
    expect(wire.tools).toEqual([expect.objectContaining({ name: golden.canonical.toolName })]);
    expect(wire.messages).toEqual([
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: golden.anthropic.toolType,
            id: golden.canonical.callId,
            name: golden.canonical.toolName,
            input: JSON.parse(golden.canonical.arguments),
          }),
        ],
      }),
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: golden.anthropic.resultType,
            tool_use_id: golden.canonical.callId,
            content: [{ type: "text", text: golden.canonical.result }],
          }),
        ],
      }),
    ]);
  });

  it("executes the pinned instruction-collapse rejection and opt-in output", async () => {
    const golden = JSON.parse(
      await readFile(
        new URL("./fixtures/adapter-golden/instruction-collapse-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      sourceInstructions: Array<{ role: "system" | "developer"; text: string }>;
      strictResult: string;
      developerOnlyInstructions: Array<{ role: "developer"; text: string; sourceIndex: number }>;
      developerOnlyAnthropicSystem: Array<{ type: "text"; text: string }>;
      lossyOptInAnthropicSystem: Array<{ type: "text"; text: string }>;
      limitation: string;
    };
    const canonical = parseOpenAiChatRequest({
      model: "m",
      messages: golden.sourceInstructions.map((item) => ({
        role: item.role,
        content: item.text,
      })),
    });
    try {
      renderAnthropicMessagesRequest(canonical, "claude");
      throw new Error("expected strict rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe(golden.strictResult);
    }
    expect(
      renderAnthropicMessagesRequest(canonical, "claude", {
        allowLossyInstructionRoleCollapse: true,
      }).system,
    ).toEqual(golden.lossyOptInAnthropicSystem);
    expect(canonical.limitations).toContain(golden.limitation);
    const developerOnly = parseOpenAiChatRequest({
      model: "m",
      messages: golden.developerOnlyInstructions.map((item) => ({
        role: item.role,
        content: item.text,
      })),
    });
    expect(renderAnthropicMessagesRequest(developerOnly, "claude").system).toEqual(
      golden.developerOnlyAnthropicSystem,
    );
  });
});
