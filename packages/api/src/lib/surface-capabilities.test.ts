import { describe, expect, it } from "vitest";
import wireFixtures from "./fixtures/capabilities-v3-wire.json";
import { parseOpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";
import { resolveExecutionPath, surfaceAvailabilityMatrix } from "./surface-capabilities";

const anthropic = parseOpenAiCompatibleCapabilities({
  version: 3,
  protocol: "anthropic-compatible",
  surfaces: {
    anthropicMessages: {
      source: "declared",
      confidence: "exact",
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
  it("accepts and rejects the shared v3 wire fixtures", () => {
    for (const fixture of wireFixtures.valid)
      expect(parseOpenAiCompatibleCapabilities(fixture)).not.toBeNull();
    for (const fixture of wireFixtures.invalid)
      expect(parseOpenAiCompatibleCapabilities(fixture)).toBeNull();
  });
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

  it("resolves every Responses operation's selection, method, path, and retry safety", () => {
    const fixture = structuredClone(wireFixtures.valid[1]);
    if (fixture?.version !== 3 || fixture.protocol !== "openai-compatible") {
      throw new Error("expected the OpenAI Responses v3 routing fixture");
    }
    const capabilities = parseOpenAiCompatibleCapabilities(fixture);
    const cases = [
      ["create", "POST", "/v1/responses", "pre_commit_only"],
      ["statefulFollowUps", "POST", "/v1/responses", "never"],
      ["retrieve", "GET", "/v1/responses/resp%2Fa", "idempotent"],
      ["delete", "DELETE", "/v1/responses/resp%2Fa", "idempotent"],
      ["cancel", "POST", "/v1/responses/resp%2Fa/cancel", "pre_commit_only"],
      ["listInputItems", "GET", "/v1/responses/resp%2Fa/input_items", "idempotent"],
      ["compact", "POST", "/v1/responses/resp%2Fa/compact", "pre_commit_only"],
      ["countTokens", "POST", "/v1/responses/count_tokens", "idempotent"],
    ] as const;
    for (const [responsesOperation, method, path, retrySafety] of cases) {
      expect(
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request: { responsesOperation, responseId: "resp/a" },
        }),
      ).toMatchObject({
        mode: "native",
        nativeSurface: "OPENAI_RESPONSES",
        requestedSurface: "OPENAI_RESPONSES",
        method,
        path,
        retrySafety,
      });
    }
  });

  it("categorically rejects adapted Responses lifecycle operations other than create", () => {
    const lifecycleOperations = [
      ["statefulFollowUps", "never"],
      ["retrieve", "idempotent"],
      ["delete", "idempotent"],
      ["cancel", "pre_commit_only"],
      ["listInputItems", "idempotent"],
      ["countTokens", "idempotent"],
      ["compact", "pre_commit_only"],
    ] as const;
    for (const [responsesOperation, retrySafety] of lifecycleOperations) {
      expect(
        resolveExecutionPath({
          capabilities: anthropic,
          requestedSurface: "OPENAI_RESPONSES",
          request: { responsesOperation },
          adaptationEnabled: true,
        }),
      ).toMatchObject({
        mode: "unavailable",
        limitations: ["native_only_operation"],
        retrySafety,
      });
    }
    expect(
      resolveExecutionPath({
        capabilities: anthropic,
        requestedSurface: "OPENAI_RESPONSES",
        request: { responsesOperation: "create" },
        adaptationEnabled: true,
      }).mode,
    ).toBe("adapted");
  });

  it("checks input and output media modalities directionally", () => {
    const capabilities = parseOpenAiCompatibleCapabilities({
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiResponses: {
          source: "declared",
          confidence: "exact",
          supported: true,
          inputImages: true,
          outputImages: false,
          inputAudio: true,
          outputAudio: false,
          inputVideo: false,
          outputVideo: true,
        },
      },
    });
    for (const request of [{ outputAudio: true }, { inputVideo: true }]) {
      expect(
        resolveExecutionPath({
          capabilities,
          requestedSurface: "OPENAI_RESPONSES",
          request,
        }).mode,
      ).toBe("unavailable");
    }
    expect(
      resolveExecutionPath({
        capabilities,
        requestedSurface: "OPENAI_RESPONSES",
        request: { inputImages: true, inputAudio: true, outputVideo: true },
      }).mode,
    ).toBe("native");
  });

  it("maps legacy chat vision to directional image input only", () => {
    const legacy = parseOpenAiCompatibleCapabilities({
      version: 2,
      protocol: "openai-compatible",
      chatCompletions: { supported: true, vision: true },
    });
    expect(
      resolveExecutionPath({
        capabilities: legacy,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request: { inputImages: true },
      }).mode,
    ).toBe("native");
    expect(
      resolveExecutionPath({
        capabilities: legacy,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request: { outputImages: true },
      }).mode,
    ).toBe("unavailable");
  });

  it("pre-dispatch excludes adapted Anthropic streaming without initial usage", () => {
    const chatOnly = parseOpenAiCompatibleCapabilities({
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: {
          source: "declared",
          confidence: "exact",
          supported: true,
          streaming: true,
        },
      },
    });
    expect(
      resolveExecutionPath({
        capabilities: chatOnly,
        requestedSurface: "ANTHROPIC_MESSAGES",
        request: { stream: true },
        adaptationEnabled: true,
      }),
    ).toMatchObject({
      mode: "unavailable",
      limitations: expect.arrayContaining(["anthropic_initial_usage_unavailable"]),
    });
    expect(
      resolveExecutionPath({
        capabilities: chatOnly,
        requestedSurface: "ANTHROPIC_MESSAGES",
        request: { stream: false },
        adaptationEnabled: true,
      }).mode,
    ).toBe("adapted");
  });

  it("reports adapted streaming support directionally", () => {
    const chatOnly = parseOpenAiCompatibleCapabilities({
      version: 3,
      protocol: "openai-compatible",
      surfaces: {
        openaiChatCompletions: {
          source: "declared",
          confidence: "exact",
          supported: true,
          streaming: true,
        },
      },
    });
    const chatMatrix = surfaceAvailabilityMatrix({
      capabilities: chatOnly,
      adaptationEnabled: true,
    });
    expect(chatMatrix.OPENAI_RESPONSES).toMatchObject({
      mode: "adapted",
      nativeSurface: "OPENAI_CHAT_COMPLETIONS",
      streaming: true,
    });
    expect(chatMatrix.ANTHROPIC_MESSAGES).toMatchObject({
      mode: "adapted",
      nativeSurface: "OPENAI_CHAT_COMPLETIONS",
      streaming: false,
      limitations: expect.arrayContaining(["anthropic_initial_usage_unavailable"]),
    });

    const anthropicMatrix = surfaceAvailabilityMatrix({
      capabilities: anthropic,
      adaptationEnabled: true,
    });
    expect(anthropicMatrix.OPENAI_CHAT_COMPLETIONS.streaming).toBe(true);
    expect(anthropicMatrix.OPENAI_RESPONSES.streaming).toBe(true);
  });
});
