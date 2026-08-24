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
  inputImages?: boolean;
  outputImages?: boolean;
  inputAudio?: boolean;
  outputAudio?: boolean;
  inputVideo?: boolean;
  outputVideo?: boolean;
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  hostedTools?: boolean;
  stateful?: boolean;
  countTokens?: boolean;
  protocolVersion?: string;
  betaFeatures?: readonly string[];
  responsesOperation?: ResponsesOperation;
  responseId?: string;
};

export type ResponsesOperation =
  | "create"
  | "statefulFollowUps"
  | "retrieve"
  | "delete"
  | "cancel"
  | "listInputItems"
  | "countTokens"
  | "compact";

export type SurfaceAvailability = {
  requestedSurface?: ModelApiSurface;
  mode: SurfaceMode;
  nativeSurface?: ModelApiSurface;
  method?: "GET" | "POST" | "DELETE";
  path?: string;
  requirements?: Readonly<SurfaceRequestRequirements>;
  retrySafety?: "pre_commit_only" | "idempotent" | "never";
  streaming: boolean;
  limitations: string[];
};

type SurfaceFeatures = {
  supported?: boolean;
  streaming?: boolean;
  maxContextTokens?: number;
  inputImages?: boolean;
  outputImages?: boolean;
  inputAudio?: boolean;
  outputAudio?: boolean;
  inputVideo?: boolean;
  outputVideo?: boolean;
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  hostedTools?: boolean;
  countTokens?: boolean;
  protocolVersion?: string;
  betaFeatures?: string[];
  responsesLifecycle?: Partial<Record<Exclude<ResponsesOperation, "create">, boolean>>;
};

function nativeFeatures(
  capabilities: OpenAiCompatibleCapabilities,
  surface: ModelApiSurface,
): SurfaceFeatures | undefined {
  if (capabilities.version === 3) {
    const key = {
      OPENAI_CHAT_COMPLETIONS: "openaiChatCompletions",
      OPENAI_RESPONSES: "openaiResponses",
      ANTHROPIC_MESSAGES: "anthropicMessages",
      OPENAI_COMPLETIONS: "openaiCompletions",
    }[surface] as keyof typeof capabilities.surfaces;
    return capabilities.surfaces[key];
  }
  if (surface === "OPENAI_CHAT_COMPLETIONS") {
    const legacy = capabilities.chatCompletions;
    return legacy
      ? {
          ...legacy,
          inputImages: legacy.vision,
          inputAudio: legacy.audio,
          inputVideo: legacy.video,
        }
      : undefined;
  }
  if (surface === "OPENAI_RESPONSES") return capabilities.responses;
  if (surface === "OPENAI_COMPLETIONS") return capabilities.completions;
  return undefined;
}

function operationFor(surface: ModelApiSurface, request: SurfaceRequestRequirements) {
  if (surface === "OPENAI_CHAT_COMPLETIONS")
    return { method: "POST" as const, path: "/v1/chat/completions" };
  if (surface === "OPENAI_COMPLETIONS") return { method: "POST" as const, path: "/v1/completions" };
  if (surface === "ANTHROPIC_MESSAGES")
    return {
      method: "POST" as const,
      path: request.countTokens ? "/v1/messages/count_tokens" : "/v1/messages",
    };
  const responseId = request.responseId ? encodeURIComponent(request.responseId) : ":responseId";
  switch (responsesOperationFor(request)) {
    case "retrieve":
      return { method: "GET" as const, path: `/v1/responses/${responseId}` };
    case "delete":
      return { method: "DELETE" as const, path: `/v1/responses/${responseId}` };
    case "cancel":
      return { method: "POST" as const, path: `/v1/responses/${responseId}/cancel` };
    case "listInputItems":
      return { method: "GET" as const, path: `/v1/responses/${responseId}/input_items` };
    case "compact":
      return { method: "POST" as const, path: `/v1/responses/${responseId}/compact` };
    case "countTokens":
      return { method: "POST" as const, path: "/v1/responses/count_tokens" };
    default:
      return { method: "POST" as const, path: "/v1/responses" };
  }
}

function responsesOperationFor(request: SurfaceRequestRequirements): ResponsesOperation {
  return (
    request.responsesOperation ??
    (request.countTokens ? "countTokens" : request.stateful ? "statefulFollowUps" : "create")
  );
}

function retrySafetyFor(surface: ModelApiSurface, request: SurfaceRequestRequirements) {
  if (surface !== "OPENAI_RESPONSES") return "pre_commit_only" as const;
  switch (responsesOperationFor(request)) {
    case "retrieve":
    case "listInputItems":
    case "countTokens":
    case "delete":
      return "idempotent" as const;
    case "statefulFollowUps":
      return "never" as const;
    default:
      return "pre_commit_only" as const;
  }
}

function adaptedSubsetFailures(request: SurfaceRequestRequirements): string[] {
  const failures: string[] = [];
  for (const key of [
    "inputAudio",
    "outputAudio",
    "inputImages",
    "outputImages",
    "inputVideo",
    "outputVideo",
    "parallelTools",
    "structuredOutput",
    "reasoning",
    "hostedTools",
    "stateful",
    "countTokens",
  ] as const) {
    if (request[key]) failures.push(`${key}_not_adaptable`);
  }
  if (request.betaFeatures?.length) failures.push("beta_feature_not_adaptable");
  return failures;
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
    "inputImages",
    "outputImages",
    "inputAudio",
    "outputAudio",
    "inputVideo",
    "outputVideo",
    "tools",
    "parallelTools",
    "structuredOutput",
    "reasoning",
    "hostedTools",
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
  const operation = operationFor(requestedSurface, request);
  const describe = (availability: SurfaceAvailability): SurfaceAvailability => ({
    ...availability,
    requestedSurface,
    ...operation,
    requirements: { ...request },
    retrySafety: retrySafetyFor(requestedSurface, request),
  });
  const matrix = surfaceAvailabilityMatrix({ capabilities, adaptationEnabled });
  const selected = matrix[requestedSurface];
  if (selected.mode === "unavailable" || !capabilities || !selected.nativeSurface)
    return describe(selected);
  if (
    selected.mode === "adapted" &&
    (requestedSurface === "OPENAI_COMPLETIONS" ||
      (requestedSurface === "OPENAI_RESPONSES" && responsesOperationFor(request) !== "create"))
  ) {
    return describe({
      mode: "unavailable",
      streaming: false,
      limitations: ["native_only_operation"],
    });
  }
  const features = nativeFeatures(capabilities, selected.nativeSurface);
  if (!features)
    return describe({
      mode: "unavailable",
      streaming: false,
      limitations: ["surface_unavailable"],
    });
  const lifecycleOperation =
    requestedSurface === "OPENAI_RESPONSES" ? responsesOperationFor(request) : undefined;
  const lifecycleUnsupported =
    lifecycleOperation && lifecycleOperation !== "create"
      ? features.responsesLifecycle?.[lifecycleOperation] !== true
      : false;
  const anthropicCountTokensUnsupported =
    requestedSurface === "ANTHROPIC_MESSAGES" &&
    request.countTokens === true &&
    features.countTokens !== true;
  const failures = [
    ...incompatibilities(features, request),
    ...(lifecycleUnsupported ? [`responses_${lifecycleOperation}_unavailable`] : []),
    ...(anthropicCountTokensUnsupported ? ["countTokens_unavailable"] : []),
    ...(selected.mode === "adapted" ? adaptedSubsetFailures(request) : []),
  ];
  const limitations = [...selected.limitations, ...failures];
  return describe(
    failures.length > 0
      ? {
          mode: "unavailable",
          nativeSurface: selected.nativeSurface,
          streaming: false,
          limitations,
        }
      : { ...selected, limitations },
  );
}
