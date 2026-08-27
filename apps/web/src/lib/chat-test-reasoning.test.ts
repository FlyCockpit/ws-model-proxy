import { describe, expect, it } from "vitest";
import {
  anthropicTranscript,
  completionDeltas,
  requireChatTestOutput,
  responsesTranscript,
} from "./chat-test-reasoning";

describe("Chat Test reasoning extractors", () => {
  it("separates Completions thinking and visible deltas", () => {
    expect(
      completionDeltas({ choices: [{ delta: { reasoning_content: "plan", content: "answer" } }] }),
    ).toEqual({ content: "answer", thinking: "plan" });
    expect(completionDeltas({ choices: [{ delta: { reasoning: { effort: "high" } } }] })).toEqual({
      content: "",
      thinking: "",
    });
    expect(completionDeltas({ choices: [{ delta: { reasoning: "plan" } }] })).toEqual({
      content: "",
      thinking: "plan",
    });
  });

  it("preserves the legacy choices[].text completion fallback", () => {
    expect(
      completionDeltas({ choices: [{ delta: { role: "assistant" }, text: "answer" }] }),
    ).toEqual({
      content: "answer",
      thinking: "",
    });
  });

  it("reads Responses reasoning without encrypted content", () => {
    expect(
      responsesTranscript({
        output: [
          {
            type: "reasoning",
            summary: [{ text: "think" }],
            content: " more",
            encrypted_content: "secret",
          },
          { type: "message", content: [{ text: "visible" }] },
          { type: "function_call", content: [{ text: "not visible" }] },
        ],
      }),
    ).toEqual({ content: "visible", thinking: "think more" });
  });

  it("reads Anthropic visible text and accepts thinking-only replies", () => {
    expect(anthropicTranscript({ content: [{ type: "text", text: "visible" }] })).toEqual({
      content: "visible",
      thinking: "",
    });
    expect(
      responsesTranscript({ output: [{ type: "reasoning", summary: [{ text: "think" }] }] }),
    ).toEqual({ content: "", thinking: "think" });
    expect(
      anthropicTranscript({
        content: [{ type: "thinking", thinking: "think", signature: "ignored" }],
      }),
    ).toEqual({ content: "", thinking: "think" });
  });

  it("rejects successful streams that contain neither visible text nor thinking", () => {
    expect(() => requireChatTestOutput({ content: "", thinking: "" }, "stream failed")).toThrow(
      "stream failed",
    );
    expect(requireChatTestOutput({ content: "answer", thinking: "" }, "stream failed")).toEqual({
      content: "answer",
      thinking: "",
    });
    expect(requireChatTestOutput({ content: "", thinking: "plan" }, "stream failed")).toEqual({
      content: "",
      thinking: "plan",
    });
  });
});
