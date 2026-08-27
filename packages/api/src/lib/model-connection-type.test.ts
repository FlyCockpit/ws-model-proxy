import { describe, expect, it } from "vitest";
import { suggestedConnectionSurface } from "./model-connection-type";

describe("suggestedConnectionSurface", () => {
  it("prefers modern native connection types in priority order", () => {
    expect(
      suggestedConnectionSurface({
        capabilities: {
          version: 4,
          protocol: "openai-compatible",
          surfaces: {
            openaiResponses: { source: "probe", confidence: "high", operations: ["create"] },
            openaiChatCompletions: { source: "probe", confidence: "high", operations: ["create"] },
          },
        },
      }),
    ).toBe("OPENAI_RESPONSES");
  });

  it("uses the pool availability policy and never suggests legacy completions", () => {
    expect(
      suggestedConnectionSurface({
        surfaces: {
          OPENAI_CHAT_COMPLETIONS: { native: 0, adapted: 1 },
          ANTHROPIC_MESSAGES: { native: 1, adapted: 0 },
        },
      }),
    ).toBe("OPENAI_CHAT_COMPLETIONS");
  });
});
