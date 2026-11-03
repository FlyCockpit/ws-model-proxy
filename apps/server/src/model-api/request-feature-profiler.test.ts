import { describe, expect, it } from "vitest";
import { profileSurfaceRequest, reasoningOnlyTurnedOff } from "./request-feature-profiler.js";

describe("profileSurfaceRequest", () => {
  it("profiles tools, structured output, reasoning, and directional modalities", () => {
    expect(
      profileSurfaceRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
              { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
              { type: "video_url", video_url: { url: "https://example.test/video" } },
            ],
          },
        ],
        tools: [{ type: "web_search_preview" }],
        parallel_tool_calls: true,
        response_format: { type: "json_schema", json_schema: { name: "answer" } },
        reasoning_effort: "high",
        modalities: ["text", "audio", "image", "video"],
      }),
    ).toEqual({
      tools: true,
      hostedTools: true,
      parallelTools: true,
      structuredOutput: true,
      reasoning: true,
      inputImages: true,
      inputAudio: true,
      inputVideo: true,
      outputImages: true,
      outputAudio: true,
      outputVideo: true,
    });
  });

  it("recognizes Responses and Anthropic feature spellings without treating functions as hosted", () => {
    expect(
      profileSurfaceRequest({
        input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }],
        tools: [{ type: "function", name: "lookup" }],
        text: { format: { type: "json_schema", name: "answer", schema: {} } },
        thinking: { type: "enabled", budget_tokens: 1024 },
        audio: { format: "wav" },
      }),
    ).toEqual({
      tools: true,
      parallelTools: true,
      structuredOutput: true,
      reasoning: true,
      inputImages: true,
      outputAudio: true,
    });
  });

  it("keeps established reasoning routing semantics for effort and disabled thinking", () => {
    expect(profileSurfaceRequest({ reasoning_effort: "none" })).toEqual({ reasoning: true });
    expect(profileSurfaceRequest({ thinking: { type: "disabled" } })).toEqual({});
    expect(profileSurfaceRequest({ output_config: { effort: "high" } })).toEqual({});
    expect(profileSurfaceRequest({ effort: "high" })).toEqual({});
  });
});

describe("reasoningOnlyTurnedOff", () => {
  it("is true when the only reasoning control is an effort of none", () => {
    expect(reasoningOnlyTurnedOff({ reasoning_effort: "none" })).toBe(true);
    expect(reasoningOnlyTurnedOff({ reasoning_effort: "NONE" })).toBe(true);
    expect(reasoningOnlyTurnedOff({ reasoning: { effort: "none" } })).toBe(true);
    expect(reasoningOnlyTurnedOff({ reasoning: { effort: "none", summary: null } })).toBe(true);
    expect(
      reasoningOnlyTurnedOff({ reasoning_effort: "none", thinking: { type: "disabled" } }),
    ).toBe(true);
  });

  it("is false when reasoning is asked for, or not mentioned", () => {
    expect(reasoningOnlyTurnedOff({})).toBe(false);
    expect(reasoningOnlyTurnedOff({ reasoning_effort: "minimal" })).toBe(false);
    expect(reasoningOnlyTurnedOff({ reasoning: { effort: "low" } })).toBe(false);
    expect(reasoningOnlyTurnedOff({ reasoning: { effort: "none", summary: "auto" } })).toBe(false);
    expect(reasoningOnlyTurnedOff({ reasoning_effort: "none", reasoning: true })).toBe(false);
    expect(
      reasoningOnlyTurnedOff({ reasoning_effort: "none", thinking: { type: "enabled" } }),
    ).toBe(false);
    expect(reasoningOnlyTurnedOff({ thinking: { type: "disabled" } })).toBe(false);
  });
});

describe("tool history", () => {
  it("needs tools for a tool call or result in the history, even without tool definitions", () => {
    // Chat Completions: an assistant tool call and its tool result.
    expect(
      profileSurfaceRequest({
        messages: [
          { role: "user", content: "Look it up." },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "42" },
        ],
      }),
    ).toEqual({ tools: true });
    // Responses: function call items.
    expect(
      profileSurfaceRequest({
        input: [
          { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "42" },
        ],
      }),
    ).toEqual({ tools: true });
    // Anthropic Messages: tool_use / tool_result blocks.
    expect(
      profileSurfaceRequest({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
        ],
      }),
    ).toEqual({ tools: true });
  });

  it("leaves a plain conversation and an empty tool_calls list alone", () => {
    expect(
      profileSurfaceRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", tool_calls: [] },
        ],
      }),
    ).toEqual({});
  });
});
