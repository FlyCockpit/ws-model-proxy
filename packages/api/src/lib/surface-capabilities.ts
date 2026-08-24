import type { OpenAiCompatibleCapabilities } from "./openai-compatible-capabilities";

export const modelApiSurfaces = [
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
  "ANTHROPIC_MESSAGES",
  "OPENAI_COMPLETIONS",
] as const;
export type ModelApiSurface = (typeof modelApiSurfaces)[number];
export type SurfaceMode = "native" | "adapted" | "unavailable";

export type SurfaceRequestRequirements = {
  stream?: boolean;
  contextTokens?: number;
  images?: boolean;
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  hostedTools?: boolean;
  stateful?: boolean;
  countTokens?: boolean;
  protocolVersion?: string;
  betaFeatures?: readonly string[];
};

export type SurfaceAvailability = {
  mode: SurfaceMode;
  nativeSurface?: ModelApiSurface;
  streaming: boolean;
  limitations: string[];
};

type SurfaceFeatures = {
  supported?: boolean;
  streaming?: boolean;
  maxContextTokens?: number;
  images?: boolean;
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  hostedTools?: boolean;
  countTokens?: boolean;
  stateful?: boolean;
  protocolVersion?: string;
  betaFeatures?: string[];
};

function nativeFeatures(capabilities: OpenAiCompatibleCapabilities, surface: ModelApiSurface) {
  if (capabilities.version === 3) {
    const key = {
      OPENAI_CHAT_COMPLETIONS: "openaiChatCompletions",
      OPENAI_RESPONSES: "openaiResponses",
      ANTHROPIC_MESSAGES: "anthropicMessages",
      OPENAI_COMPLETIONS: "openaiCompletions",
    }[surface] as keyof typeof capabilities.surfaces;
    return capabilities.surfaces[key];
  }
  if (surface === "OPENAI_CHAT_COMPLETIONS") return capabilities.chatCompletions;
  if (surface === "OPENAI_RESPONSES") return capabilities.responses;
  if (surface === "OPENAI_COMPLETIONS") return capabilities.completions;
  return undefined;
}

function incompatibilities(features: SurfaceFeatures, request: SurfaceRequestRequirements) {
  const failures: string[] = [];
  if (request.stream && features.streaming !== true) failures.push("streaming_unavailable");
  if (
    request.contextTokens !== undefined &&
    (features.maxContextTokens === undefined || request.contextTokens > features.maxContextTokens)
  )
    failures.push("context_limit_unknown_or_exceeded");
  for (const key of [
    "images",
    "tools",
    "parallelTools",
    "structuredOutput",
    "reasoning",
    "hostedTools",
    "stateful",
    "countTokens",
  ] as const) {
    if (request[key] && features[key] !== true) failures.push(`${key}_unavailable`);
  }
  if (request.protocolVersion && features.protocolVersion !== request.protocolVersion) {
    failures.push("protocol_version_unsupported");
  }
  const allowedBetas = new Set(features.betaFeatures ?? []);
  if (request.betaFeatures?.some((beta) => !allowedBetas.has(beta))) {
    failures.push("beta_feature_unsupported");
  }
  return failures;
}

export function surfaceAvailabilityMatrix({
  capabilities,
  adaptationEnabled = false,
}: {
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  adaptationEnabled?: boolean;
}): Record<ModelApiSurface, SurfaceAvailability> {
  const result = {} as Record<ModelApiSurface, SurfaceAvailability>;
  for (const requested of modelApiSurfaces) {
    const native = capabilities ? nativeFeatures(capabilities, requested) : undefined;
    if (native?.supported === true) {
      result[requested] = {
        mode: "native",
        nativeSurface: requested,
        streaming: native.streaming === true,
        limitations: [],
      };
      continue;
    }
    // Legacy Completions and stateful Responses are deliberately never adapted.
    const adaptationSources =
      requested === "OPENAI_COMPLETIONS"
        ? []
        : modelApiSurfaces.filter(
            (surface) => surface !== requested && surface !== "OPENAI_COMPLETIONS",
          );
    const source =
      adaptationEnabled && capabilities
        ? adaptationSources.find(
            (surface) => nativeFeatures(capabilities, surface)?.supported === true,
          )
        : undefined;
    const sourceFeatures =
      source && capabilities ? nativeFeatures(capabilities, source) : undefined;
    result[requested] = source
      ? {
          mode: "adapted",
          nativeSurface: source,
          streaming: sourceFeatures?.streaming === true,
          limitations: ["strict_common_subset", "native_extensions_unavailable"],
        }
      : { mode: "unavailable", streaming: false, limitations: ["surface_unavailable"] };
  }
  return result;
}

export function resolveExecutionPath({
  capabilities,
  requestedSurface,
  request = {},
  adaptationEnabled = false,
}: {
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  requestedSurface: ModelApiSurface;
  request?: SurfaceRequestRequirements;
  adaptationEnabled?: boolean;
}): SurfaceAvailability {
  const matrix = surfaceAvailabilityMatrix({ capabilities, adaptationEnabled });
  const selected = matrix[requestedSurface];
  if (selected.mode === "unavailable" || !capabilities || !selected.nativeSurface) return selected;
  if (
    selected.mode === "adapted" &&
    (requestedSurface === "OPENAI_COMPLETIONS" || request.stateful)
  ) {
    return { mode: "unavailable", streaming: false, limitations: ["native_only_operation"] };
  }
  const features = nativeFeatures(capabilities, selected.nativeSurface);
  if (!features)
    return { mode: "unavailable", streaming: false, limitations: ["surface_unavailable"] };
  const failures = incompatibilities(features, request);
  const limitations = [...selected.limitations, ...failures];
  return failures.length > 0
    ? { mode: "unavailable", nativeSurface: selected.nativeSurface, streaming: false, limitations }
    : { ...selected, limitations };
}
