import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));

import { openAiModelListExtensionsFromCapabilities } from "./model-list-modalities.js";
import { parseEmbeddingProviderUsage, publicTargetCompatibility } from "./public-overflow.js";

const contract = {
  model: "embed-model",
  revision: "rev-1",
  dimensions: 768,
  normalization: "l2" as const,
  vectorSpace: "space-1",
};
const target = {
  protocol: "openai" as const,
  contextWindow: 8192,
  maxOutputTokens: null,
  nativeProtocols: ["openai" as const],
  nativeSurfaces: [],
  supportsStreaming: false,
  supportedFeatures: [],
  capabilityInventory: {
    version: 4 as const,
    protocol: "openai-compatible" as const,
    surfaces: {},
    embeddings: { supported: true, contract },
  },
};
const request = {
  requestedProtocol: "openai" as const,
  requestedSurface: "openai-chat" as const,
  stream: false,
  requiredFeatures: [],
  adaptationEnabled: false,
  path: "/v1/embeddings",
  embeddingContract: contract,
  liability: { tokens: 5n, accountingVersion: "provider-billable-v1" },
  estimatedInputTokens: 5n,
  requestedOutputTokens: 0n,
};
describe("external embedding policy", () => {
  it("admits native embeddings without chat capabilities or generation limits", () => {
    expect(publicTargetCompatibility(target, request)).toBe("COMPATIBLE");
  });
  it("rejects missing contracts and same-dimensional alternate vector spaces", () => {
    expect(publicTargetCompatibility(target, { ...request, embeddingContract: undefined })).toBe(
      "PROTOCOL_UNAVAILABLE",
    );
    expect(
      publicTargetCompatibility(target, {
        ...request,
        embeddingContract: { ...contract, revision: "other" },
      }),
    ).toBe("PROTOCOL_UNAVAILABLE");
    expect(publicTargetCompatibility(target, { ...request, stream: true })).toBe(
      "PROTOCOL_UNAVAILABLE",
    );
    expect(publicTargetCompatibility(target, { ...request, estimatedInputTokens: 8193n })).toBe(
      "COMPATIBLE",
    );
  });
  it("settles embedding input usage with zero output and refuses contradictory output", () => {
    const encode = (usage: unknown) => [
      new TextEncoder().encode(JSON.stringify({ data: [], usage })),
    ];
    expect(
      parseEmbeddingProviderUsage(encode({ prompt_tokens: 5, total_tokens: 5 })),
    ).toMatchObject({ inputTokens: 5n, outputTokens: 0n, categoriesComplete: true });
    expect(
      parseEmbeddingProviderUsage(
        encode({ prompt_tokens: 5, total_tokens: 6, completion_tokens: 1 }),
      ),
    ).toBeUndefined();
    expect(
      parseEmbeddingProviderUsage(encode({ prompt_tokens: 5, total_tokens: 6 })),
    ).toMatchObject({ categoriesComplete: false });
  });
  it("advertises embedding output without generated text", () => {
    const advertised = openAiModelListExtensionsFromCapabilities(target.capabilityInventory);
    expect(advertised.capabilities.embeddings).toBe(true);
    expect(advertised.architecture.output_modalities).toEqual(["embedding"]);
  });
});
