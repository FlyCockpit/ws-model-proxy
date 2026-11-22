/**
 * The capability inventory of a cloud provider model (`provider_model.nativeCapabilities`):
 * which generation surfaces the provider serves natively for it, and what the catalog knows
 * about its features. Pure, so the providers router (which writes it), the model API (which
 * reads it) and the web form (which shows the defaults) agree.
 */
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
} from "./openai-compatible-capabilities";
import { type ModelApiSurface, modelApiSurfaces } from "./surface-capabilities";

export const PROVIDER_MODEL_SURFACES = modelApiSurfaces;
export type ProviderModelSurface = ModelApiSurface;

/** The Anthropic API version every Messages surface declares (what clients send). */
const ANTHROPIC_VERSION = "2023-06-01";

/** What the OpenRouter catalog says about a model's features; absent means unknown. */
export type ProviderModelCatalogFeatures = {
  contextLength: number | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
};

function isOpenRouter(providerType: string): boolean {
  return providerType.trim().toLowerCase() === "openrouter";
}

/**
 * The surfaces a model gets when nobody declared them. OpenRouter serves Chat Completions for
 * every model, and also the vendor's own API for its models: Responses for `openai/*`,
 * Messages for `anthropic/*` (the surfaces the OpenRouter usage dialect was checked against).
 * Other surfaces are served by protocol adaptation. A generic account is an OpenAI-compatible
 * URL unless its models declare the Anthropic Messages surface.
 */
export function defaultProviderModelSurfaces(
  providerType: string,
  upstreamModelId: string,
): ProviderModelSurface[] {
  if (!isOpenRouter(providerType)) return ["OPENAI_CHAT_COMPLETIONS"];
  const vendor = upstreamModelId.trim().toLowerCase().split("/")[0];
  return [
    "OPENAI_CHAT_COMPLETIONS",
    ...(vendor === "openai" ? (["OPENAI_RESPONSES"] as const) : []),
    ...(vendor === "anthropic" ? (["ANTHROPIC_MESSAGES"] as const) : []),
  ];
}

export class ProviderModelSurfacesError extends Error {}

/**
 * A v4 inventory for these surfaces. A generic account speaks one wire protocol: Anthropic
 * Messages alone (anthropic-compatible), or OpenAI surfaces (openai-compatible). OpenRouter
 * speaks all three on one openai-compatible endpoint. Throws ProviderModelSurfacesError for
 * an empty or mixed generic declaration.
 */
export function providerModelInventory(input: {
  providerType: string;
  surfaces: readonly ProviderModelSurface[];
  catalog?: ProviderModelCatalogFeatures | null;
  source?: "declared" | "provider";
}): OpenAiCompatibleCapabilities {
  const surfaces = new Set(input.surfaces);
  if (surfaces.size === 0) throw new ProviderModelSurfacesError("Choose at least one API.");
  const messages = surfaces.has("ANTHROPIC_MESSAGES");
  const openAi = surfaces.has("OPENAI_CHAT_COMPLETIONS") || surfaces.has("OPENAI_RESPONSES");
  const openRouter = isOpenRouter(input.providerType);
  if (!openRouter && messages && openAi)
    throw new ProviderModelSurfacesError(
      "A generic account speaks one protocol: Anthropic Messages alone, or OpenAI APIs.",
    );
  const protocol = !openRouter && messages ? "anthropic-compatible" : "openai-compatible";
  const catalog = input.catalog;
  const source = input.source ?? "provider";
  const confidence = catalog ? "high" : "unknown";
  const features = {
    source,
    confidence,
    streaming: true,
    ...(catalog
      ? {
          ...(catalog.contextLength !== null ? { maxContextTokens: catalog.contextLength } : {}),
          inputImages: catalog.inputModalities.includes("image"),
          inputAudio: catalog.inputModalities.includes("audio"),
          inputVideo: catalog.inputModalities.includes("video"),
          outputImages: catalog.outputModalities.includes("image"),
          outputAudio: catalog.outputModalities.includes("audio"),
          tools: catalog.supportsTools,
          structuredOutput: catalog.supportsStructuredOutput,
          reasoning: catalog.supportsReasoning,
        }
      : {}),
  } as const;
  const inventory = {
    version: 4,
    protocol,
    source,
    confidence,
    surfaces: {
      ...(surfaces.has("OPENAI_CHAT_COMPLETIONS")
        ? {
            openaiChatCompletions: {
              ...features,
              streamUsage: true,
              operations: ["create"],
            },
          }
        : {}),
      ...(surfaces.has("OPENAI_RESPONSES")
        ? { openaiResponses: { ...features, operations: ["create"] } }
        : {}),
      ...(messages
        ? {
            anthropicMessages: {
              ...features,
              operations: ["create"],
              protocolVersions: [{ version: ANTHROPIC_VERSION, betaFeatures: [] }],
            },
          }
        : {}),
    },
  };
  const parsed = parseOpenAiCompatibleCapabilities(inventory);
  if (!parsed) throw new ProviderModelSurfacesError("These APIs cannot be declared together.");
  return parsed;
}

/**
 * The inventory a model serves with. A stored inventory wins; an LLM model with none (one
 * created before inventories were written) gets its provider type's default surfaces.
 * Other model types stay without one (their contracts are declared, never defaulted).
 */
export function effectiveProviderModelCapabilities(model: {
  type: string;
  upstreamModelId: string;
  providerType: string;
  nativeCapabilities: unknown;
}): OpenAiCompatibleCapabilities | null {
  const stored = parseOpenAiCompatibleCapabilities(model.nativeCapabilities);
  if (stored) return stored;
  if (model.nativeCapabilities != null || model.type !== "LLM") return null;
  return providerModelInventory({
    providerType: model.providerType,
    surfaces: defaultProviderModelSurfaces(model.providerType, model.upstreamModelId),
  });
}

/** The surfaces an inventory declares natively, in the fixed surface order. */
export function providerModelSurfacesOf(
  inventory: OpenAiCompatibleCapabilities | null,
): ProviderModelSurface[] {
  if (inventory?.version !== 4) return [];
  const declared = inventory.surfaces;
  return PROVIDER_MODEL_SURFACES.filter((surface) =>
    surface === "OPENAI_CHAT_COMPLETIONS"
      ? declared.openaiChatCompletions !== undefined
      : surface === "OPENAI_RESPONSES"
        ? declared.openaiResponses !== undefined
        : declared.anthropicMessages !== undefined,
  );
}
