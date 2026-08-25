import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  },
}));

import {
  conservativeProviderLiability,
  parseProviderUsage,
  publicTargetCompatibility,
} from "./public-overflow.js";

const request = {
  requestedProtocol: "openai" as const,
  requestedSurface: "openai-chat" as const,
  stream: false,
  requiredFeatures: [],
  adaptationEnabled: false,
  requestedOutputTokens: 80n,
  renderForTarget: undefined,
  liability: { tokens: 200n, accountingVersion: "provider-billable-v1" },
};

describe("public overflow compatibility", () => {
  it("fails closed when context or native capability inventory is unknown", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: null,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("CONTEXT_UNKNOWN");
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 1000,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: [],
          nativeSurfaces: [],
          supportsStreaming: false,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("PROTOCOL_UNAVAILABLE");
  });

  it("rejects an over-ceiling request before budget or egress", () => {
    expect(
      publicTargetCompatibility(
        {
          contextWindow: 199,
          maxOutputTokens: 100,
          protocol: "openai",
          nativeProtocols: ["openai"],
          nativeSurfaces: ["openai-chat"],
          supportsStreaming: true,
          supportedFeatures: [],
        },
        request,
      ),
    ).toBe("CONTEXT_EXCEEDED");
  });

  it("requires both adaptation gates and a known native target protocol", () => {
    const target = {
      contextWindow: 1000,
      maxOutputTokens: 100,
      protocol: "anthropic" as const,
      nativeProtocols: ["anthropic" as const],
      nativeSurfaces: ["anthropic-messages" as const],
      supportsStreaming: true,
      supportedFeatures: [],
    };
    expect(publicTargetCompatibility(target, request)).toBe("PROTOCOL_UNAVAILABLE");
    expect(
      publicTargetCompatibility(target, {
        ...request,
        adaptationEnabled: true,
        renderForTarget: async () => {
          throw new Error("not invoked by prefilter");
        },
      }),
    ).toBe("COMPATIBLE");
  });

  it("reserves conservative input plus requested output tokens", () => {
    expect(
      conservativeProviderLiability({
        estimatedInputTokens: 120n,
        requestedOutputTokens: 80n,
      }),
    ).toEqual({
      tokens: 200n,
      spend: undefined,
      currency: undefined,
      pricingVersion: undefined,
      accountingVersion: "provider-billable-v1",
    });
  });

  it("merges split Anthropic usage without erasing earlier billable categories", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(
      parseProviderUsage([
        encode(
          'event: message_start\ndata: {"message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}}\n\n',
        ),
        encode('event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n'),
      ]),
    ).toMatchObject({
      inputTokens: 12n,
      outputTokens: 7n,
      cacheReadTokens: 3n,
      categoriesComplete: true,
      confidence: "REPORTED",
    });
  });
});
