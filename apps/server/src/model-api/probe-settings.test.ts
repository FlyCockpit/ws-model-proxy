import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { describe, expect, it } from "vitest";
import { PROBE_MAX_TOKENS, recoveryProbeRequest } from "./probe-settings";

/** A v4 inventory with one surface that can `create`, with reasoning on. */
function inventory(
  surface: "openaiChatCompletions" | "openaiResponses" | "anthropicMessages",
): OpenAiCompatibleCapabilities {
  return {
    version: 4,
    protocol: "openai-compatible",
    surfaces: {
      [surface]: {
        source: "declared",
        confidence: "exact",
        streaming: true,
        operations: ["create"],
        reasoning: true,
      },
    },
  } as unknown as OpenAiCompatibleCapabilities;
}

describe("recovery probe request", () => {
  it("uses the member-test token budget", () => {
    expect(PROBE_MAX_TOKENS).toBe(64);
  });

  it("sends the lowest reasoning level on chat completions", () => {
    const request = recoveryProbeRequest("model-a", inventory("openaiChatCompletions"));
    expect(request).toMatchObject({
      surface: "OPENAI_CHAT_COMPLETIONS",
      family: "chat.completions",
      path: "/v1/chat/completions",
    });
    expect(request?.body).toEqual({
      model: "model-a",
      stream: false,
      max_tokens: PROBE_MAX_TOKENS,
      reasoning_effort: "none",
      messages: [{ role: "user", content: "Reply with pong." }],
    });
  });

  it("sends no reasoning fields on the Responses or Anthropic surfaces", () => {
    const responses = recoveryProbeRequest("model-a", inventory("openaiResponses"));
    expect(responses?.family).toBe("responses");
    expect(responses?.body).toEqual({
      model: "model-a",
      input: "Reply with pong.",
      max_output_tokens: PROBE_MAX_TOKENS,
    });
    const messages = recoveryProbeRequest("model-a", inventory("anthropicMessages"));
    expect(messages?.family).toBe("messages");
    expect(messages?.body).toEqual({
      model: "model-a",
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: "Reply with pong." }],
    });
  });

  it("has no request for a member without a probeable surface", () => {
    expect(recoveryProbeRequest("model-a", null)).toBeNull();
  });
});
