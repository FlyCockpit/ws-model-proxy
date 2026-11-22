import { describe, expect, it } from "vitest";
import {
  defaultProviderModelSurfaces,
  effectiveProviderModelCapabilities,
  ProviderModelSurfacesError,
  providerModelInventory,
  providerModelSurfacesOf,
} from "./provider-model-capabilities";
import { resolveExecutionPath, surfaceAvailabilityMatrix } from "./surface-capabilities";

describe("provider model capabilities", () => {
  it("defaults OpenRouter models to Chat plus the vendor's own API, generic ones to Chat", () => {
    expect(defaultProviderModelSurfaces("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toEqual(
      ["OPENAI_CHAT_COMPLETIONS"],
    );
    expect(defaultProviderModelSurfaces("openrouter", "openai/gpt-6-luna")).toEqual([
      "OPENAI_CHAT_COMPLETIONS",
      "OPENAI_RESPONSES",
    ]);
    expect(defaultProviderModelSurfaces("openrouter", "anthropic/claude-haiku-5.5")).toEqual([
      "OPENAI_CHAT_COMPLETIONS",
      "ANTHROPIC_MESSAGES",
    ]);
    expect(defaultProviderModelSurfaces("generic", "anthropic/claude-haiku-5.5")).toEqual([
      "OPENAI_CHAT_COMPLETIONS",
    ]);
  });

  it("builds an inventory every declared surface serves natively, streaming included", () => {
    const inventory = providerModelInventory({
      providerType: "openrouter",
      surfaces: ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES", "ANTHROPIC_MESSAGES"],
    });
    const matrix = surfaceAvailabilityMatrix({ capabilities: inventory });
    for (const surface of [
      "OPENAI_CHAT_COMPLETIONS",
      "OPENAI_RESPONSES",
      "ANTHROPIC_MESSAGES",
    ] as const)
      expect(matrix[surface]).toMatchObject({ mode: "native", streaming: true });
    expect(inventory.protocol).toBe("openai-compatible");
    expect(providerModelSurfacesOf(inventory)).toEqual([
      "OPENAI_CHAT_COMPLETIONS",
      "OPENAI_RESPONSES",
      "ANTHROPIC_MESSAGES",
    ]);
    // A Messages client sending the usual anthropic-version header and tools.
    expect(
      resolveExecutionPath({
        capabilities: inventory,
        requestedSurface: "ANTHROPIC_MESSAGES",
        request: { stream: true, tools: true, protocolVersion: "2023-06-01" },
      }),
    ).toMatchObject({ mode: "native", nativeSurface: "ANTHROPIC_MESSAGES" });
  });

  it("a generic account speaks one protocol", () => {
    expect(
      providerModelInventory({ providerType: "generic", surfaces: ["ANTHROPIC_MESSAGES"] })
        .protocol,
    ).toBe("anthropic-compatible");
    expect(() =>
      providerModelInventory({
        providerType: "generic",
        surfaces: ["ANTHROPIC_MESSAGES", "OPENAI_CHAT_COMPLETIONS"],
      }),
    ).toThrow(ProviderModelSurfacesError);
    expect(() => providerModelInventory({ providerType: "generic", surfaces: [] })).toThrow(
      ProviderModelSurfacesError,
    );
  });

  it("keeps the catalog's features, so a model without tools refuses tool requests", () => {
    const inventory = providerModelInventory({
      providerType: "openrouter",
      surfaces: ["OPENAI_CHAT_COMPLETIONS"],
      catalog: {
        contextLength: 128_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: false,
        supportsReasoning: true,
        supportsStructuredOutput: false,
      },
    });
    expect(
      resolveExecutionPath({
        capabilities: inventory,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request: { tools: true },
      }).mode,
    ).toBe("unavailable");
    expect(
      resolveExecutionPath({
        capabilities: inventory,
        requestedSurface: "OPENAI_CHAT_COMPLETIONS",
        request: { stream: true, reasoning: true },
      }).mode,
    ).toBe("native");
  });

  it("serves a language model stored without an inventory with its provider's defaults", () => {
    const legacy = effectiveProviderModelCapabilities({
      type: "LLM",
      upstreamModelId: "anthropic/claude-haiku-5.5",
      providerType: "openrouter",
      nativeCapabilities: null,
    });
    expect(providerModelSurfacesOf(legacy)).toEqual([
      "OPENAI_CHAT_COMPLETIONS",
      "ANTHROPIC_MESSAGES",
    ]);
    // A stored inventory wins; other model types and unreadable inventories get none.
    const stored = providerModelInventory({
      providerType: "openrouter",
      surfaces: ["OPENAI_RESPONSES"],
    });
    expect(
      providerModelSurfacesOf(
        effectiveProviderModelCapabilities({
          type: "LLM",
          upstreamModelId: "anthropic/claude-haiku-5.5",
          providerType: "openrouter",
          nativeCapabilities: stored,
        }),
      ),
    ).toEqual(["OPENAI_RESPONSES"]);
    for (const model of [
      { type: "EMBEDDINGS", nativeCapabilities: null },
      { type: "LLM", nativeCapabilities: { version: 99 } },
    ])
      expect(
        effectiveProviderModelCapabilities({
          ...model,
          upstreamModelId: "openai/text-embedding-3-small",
          providerType: "openrouter",
        }),
      ).toBeNull();
  });
});
