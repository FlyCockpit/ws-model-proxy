import { describe, expect, it } from "vitest";
import { parseOpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";
import { resolveExecutionPath, surfaceAvailabilityMatrix } from "./surface-capabilities";

const anthropic = parseOpenAiCompatibleCapabilities({
  version: 3,
  protocol: "anthropic-compatible",
  surfaces: {
    anthropicMessages: {
      supported: true,
      streaming: true,
      tools: true,
      countTokens: true,
      maxContextTokens: 200_000,
      protocolVersion: "2023-06-01",
      betaFeatures: ["prompt-caching-2024-07-31"],
    },
  },
  source: "declared",
  confidence: "exact",
});

describe("surface capability resolution", () => {
  it("retains v1/v2 readers and accepts the provider-independent v3 inventory", () => {
    expect(
      parseOpenAiCompatibleCapabilities({ version: 1, protocol: "openai-compatible" }),
    ).not.toBeNull();
    expect(
      parseOpenAiCompatibleCapabilities({ version: 2, protocol: "openai-compatible" }),
    ).not.toBeNull();
    expect(anthropic?.version).toBe(3);
  });

  it("reports native, adapted, and unavailable surfaces", () => {
    const matrix = surfaceAvailabilityMatrix({ capabilities: anthropic, adaptationEnabled: true });
    expect(matrix.ANTHROPIC_MESSAGES.mode).toBe("native");
    expect(matrix.OPENAI_CHAT_COMPLETIONS).toMatchObject({
      mode: "adapted",
      nativeSurface: "ANTHROPIC_MESSAGES",
    });
    expect(matrix.OPENAI_COMPLETIONS.mode).toBe("unavailable");
    expect(
      resolveExecutionPath({
        capabilities: anthropic,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        adaptationEnabled: true,
      }).mode,
    ).toBe("adapted");
  });

  it("prefers native and rejects exact feature, version, beta, and context mismatches", () => {
    expect(
      resolveExecutionPath({
        capabilities: anthropic,
        requestedSurface: "ANTHROPIC_MESSAGES",
        adaptationEnabled: true,
      }).mode,
    ).toBe("native");
    for (const request of [
      { reasoning: true },
      { contextTokens: 200_001 },
      { protocolVersion: "2024-01-01" },
      { betaFeatures: ["unknown-beta"] },
    ]) {
      expect(
        resolveExecutionPath({
          capabilities: anthropic,
          requestedSurface: "ANTHROPIC_MESSAGES",
          request,
        }).mode,
      ).toBe("unavailable");
    }
  });

  it("keeps stateful Responses and legacy Completions native-only", () => {
    expect(
      resolveExecutionPath({
        capabilities: anthropic,
        requestedSurface: "OPENAI_RESPONSES",
        request: { stateful: true },
        adaptationEnabled: true,
      }).limitations,
    ).toContain("native_only_operation");
    expect(
      resolveExecutionPath({
        capabilities: anthropic,
        requestedSurface: "OPENAI_COMPLETIONS",
        adaptationEnabled: true,
      }).mode,
    ).toBe("unavailable");
  });
});
