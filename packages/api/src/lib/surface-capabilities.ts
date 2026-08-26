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
  allowLossyDeveloperRoleCollapse?: boolean;
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
  /** Native Responses lifecycle support, reported separately from create. */
  lifecycleOperations?: readonly Exclude<ResponsesOperation, "create">[];
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
  protocolVersions?: Array<{ version: string; betaFeatures: string[] }>;
  operations?: string[];
  responsesLifecycle?: Partial<Record<Exclude<ResponsesOperation, "create">, boolean>>;
};

function nativeFeatures(
  capabilities: OpenAiCompatibleCapabilities,
  surface: ModelApiSurface,
): SurfaceFeatures | undefined {
  if (capabilities.version === 3 || capabilities.version === 4) {
    const key = {
      OPENAI_CHAT_COMPLETIONS: "openaiChatCompletions",
      OPENAI_RESPONSES: "openaiResponses",
      ANTHROPIC_MESSAGES: "anthropicMessages",
      OPENAI_COMPLETIONS: "openaiCompletions",
    }[surface] as keyof typeof capabilities.surfaces;
    const inventorySurface = capabilities.surfaces[key];
    if (!inventorySurface) return undefined;
    if (capabilities.version === 4) {
      if (!("operations" in inventorySurface)) return undefined;
      const operations: readonly string[] = inventorySurface.operations;
      return {
        ...inventorySurface,
        // The matrix describes whether a native create endpoint exists. A
        // lifecycle-only inventory remains addressable through the exact
        // resolver, but must not advertise native create support.
        supported: operations.includes("create"),
        countTokens: operations.includes("countTokens"),
        responsesLifecycle:
          inventorySurface === capabilities.surfaces.openaiResponses
            ? {
                statefulFollowUps: operations.includes("statefulFollowUps"),
                retrieve: operations.includes("retrieve"),
                delete: operations.includes("delete"),
                cancel: operations.includes("cancel"),
                listInputItems: operations.includes("listInputItems"),
                countTokens: operations.includes("countTokens"),
                compact: operations.includes("compact"),
              }
            : undefined,
      };
    }
    return inventorySurface;
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
  return responsesOperationRetrySafety(responsesOperationFor(request));
}

export function responsesOperationRetrySafety(operation: ResponsesOperation) {
  switch (operation) {
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
  const versionInventory = request.protocolVersion
    ? features.protocolVersions?.find(({ version }) => version === request.protocolVersion)
    : undefined;
  if (
    request.protocolVersion &&
    (features.protocolVersions
      ? !versionInventory
      : features.protocolVersion !== request.protocolVersion)
  ) {
    failures.push("protocol_version_unsupported");
  }
  const allowedBetas = new Set(
    features.protocolVersions
      ? (versionInventory?.betaFeatures ?? [])
      : (features.betaFeatures ?? []),
  );
  if (request.betaFeatures?.some((beta) => !allowedBetas.has(beta))) {
    failures.push("beta_feature_unsupported");
  }
  return failures;
}

function requestedOperation(surface: ModelApiSurface, request: SurfaceRequestRequirements): string {
  if (surface === "OPENAI_RESPONSES") return responsesOperationFor(request);
  if (surface === "ANTHROPIC_MESSAGES" && request.countTokens) return "countTokens";
  return "create";
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
    const lifecycleOperations =
      requested === "OPENAI_RESPONSES"
        ? (
            [
              "statefulFollowUps",
              "retrieve",
              "delete",
              "cancel",
              "listInputItems",
              "countTokens",
              "compact",
            ] as const
          ).filter((operation) => native?.responsesLifecycle?.[operation] === true)
        : undefined;
    if (native?.supported === true) {
      result[requested] = {
        mode: "native",
        nativeSurface: requested,
        streaming: native.streaming === true,
        limitations: [],
        ...(lifecycleOperations?.length ? { lifecycleOperations } : {}),
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
    const lacksAnthropicInitialUsage =
      requested === "ANTHROPIC_MESSAGES" &&
      (source === "OPENAI_CHAT_COMPLETIONS" || source === "OPENAI_RESPONSES");
    result[requested] = source
      ? {
          mode: "adapted",
          nativeSurface: source,
          streaming: sourceFeatures?.streaming === true && !lacksAnthropicInitialUsage,
          limitations: [
            "strict_common_subset",
            "native_extensions_unavailable",
            ...(lacksAnthropicInitialUsage ? ["anthropic_initial_usage_unavailable"] : []),
          ],
          ...(lifecycleOperations?.length ? { lifecycleOperations } : {}),
        }
      : {
          mode: "unavailable",
          streaming: false,
          limitations: ["surface_unavailable"],
          ...(lifecycleOperations?.length ? { lifecycleOperations } : {}),
        };
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
  if (!capabilities)
    return describe({
      mode: "unavailable",
      streaming: false,
      limitations: ["surface_unavailable"],
    });

  const nativeOnly =
    requestedSurface === "OPENAI_COMPLETIONS" ||
    (requestedSurface === "OPENAI_RESPONSES" && responsesOperationFor(request) !== "create") ||
    (requestedSurface === "ANTHROPIC_MESSAGES" && request.countTokens === true);
  const evaluate = (nativeSurface: ModelApiSurface, mode: "native" | "adapted") => {
    const features = nativeFeatures(capabilities, nativeSurface);
    if (!features) return undefined;
    const operationName =
      mode === "native" ? requestedOperation(requestedSurface, request) : "create";
    const operationSupported =
      capabilities.version === 4
        ? features.operations?.includes(operationName) === true
        : mode === "native" && requestedSurface === "OPENAI_RESPONSES" && operationName !== "create"
          ? features.responsesLifecycle?.[
              operationName as Exclude<ResponsesOperation, "create">
            ] === true
          : mode === "native" &&
              requestedSurface === "ANTHROPIC_MESSAGES" &&
              operationName === "countTokens"
            ? features.countTokens === true
            : features.supported === true;
    if (!operationSupported) return undefined;
    const normalizedRequest =
      mode === "adapted"
        ? { ...request, protocolVersion: undefined, betaFeatures: undefined }
        : request;
    const failures = [
      ...incompatibilities(features, normalizedRequest),
      ...(mode === "adapted" ? adaptedSubsetFailures(request) : []),
      ...(mode === "adapted" &&
      requestedSurface === "ANTHROPIC_MESSAGES" &&
      request.stream === true &&
      (nativeSurface === "OPENAI_CHAT_COMPLETIONS" || nativeSurface === "OPENAI_RESPONSES")
        ? ["anthropic_initial_usage_unavailable"]
        : []),
    ];
    if (failures.length) return { failures, features };
    return { failures: [], features };
  };

  // Exact requested protocol always wins when it satisfies the complete
  // operation/stream/feature contract.
  const exact = evaluate(requestedSurface, "native");
  if (exact?.failures.length === 0)
    return describe({
      mode: "native",
      nativeSurface: requestedSurface,
      streaming: exact.features.streaming === true,
      limitations: [],
    });

  if (nativeOnly) {
    return describe({
      mode: "unavailable",
      streaming: false,
      limitations: ["native_only_operation", ...(exact?.failures ?? [])],
    });
  }

  if (adaptationEnabled) {
    // Stable order is intentional and makes equal candidates deterministic.
    let firstCandidateFailure: { nativeSurface: ModelApiSurface; failures: string[] } | undefined;
    for (const source of modelApiSurfaces) {
      if (source === requestedSurface || source === "OPENAI_COMPLETIONS") continue;
      const candidate = evaluate(source, "adapted");
      if (candidate && !firstCandidateFailure)
        firstCandidateFailure = { nativeSurface: source, failures: candidate.failures };
      if (candidate?.failures.length === 0)
        return describe({
          mode: "adapted",
          nativeSurface: source,
          streaming: candidate.features.streaming === true,
          limitations: ["strict_common_subset", "native_extensions_unavailable"],
        });
    }
    if (firstCandidateFailure)
      return describe({
        mode: "unavailable",
        nativeSurface: firstCandidateFailure.nativeSurface,
        streaming: false,
        limitations: firstCandidateFailure.failures,
      });
  }

  return describe({
    mode: "unavailable",
    nativeSurface: exact ? requestedSurface : undefined,
    streaming: false,
    limitations: exact?.failures ?? ["surface_unavailable"],
  });
}
