import { describe, expect, it } from "vitest";
import { profileSurfaceRequest } from "./request-feature-profiler.js";

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
});
