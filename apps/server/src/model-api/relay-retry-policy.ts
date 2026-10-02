import {
  type ResponsesOperation,
  responsesOperationRetrySafety,
} from "@ws-model-proxy/api/lib/surface-capabilities";

export type RelayRetryOperation = {
  family: string;
  capability: string;
  additionalCapabilities?: readonly string[];
};

export type RelayRetryFailureCategory =
  | "precommit_5xx"
  | "precommit_transport"
  | "precommit_content_type_mismatch"
  | "precommit_context_exceeded";

const ENGINE_CONTEXT_OVERFLOW = [
  /maximum context length/i,
  /exceed_context_size_error/i,
  /context_length_exceeded/i,
  /exceeds the context window/i,
  /requested token count exceeds/i,
  /prompt is too long/i,
  /max_model_len/i,
];

/** Engine 4xx that means the prompt did not fit this member's context. */
export function isEngineContextOverflow(status: number, bodyText: string): boolean {
  if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
  return ENGINE_CONTEXT_OVERFLOW.some((pattern) => pattern.test(bodyText));
}

export function relayOperationRetrySafety(
  operation: RelayRetryOperation,
): "pre_commit_only" | "idempotent" | "never" {
  if (operation.family !== "responses") return "pre_commit_only";
  const responsesOperation = responsesOperationForRelay(operation);
  return responsesOperationRetrySafety(responsesOperation);
}

function responsesOperationForRelay(operation: RelayRetryOperation): ResponsesOperation {
  if (operation.additionalCapabilities?.includes("responses.statefulFollowUps"))
    return "statefulFollowUps";
  const capability = operation.capability.replace("responses.", "");
  if (capability === "statefulFollowUps") return "statefulFollowUps";
  if (capability === "retrieve") return "retrieve";
  if (capability === "delete") return "delete";
  if (capability === "cancel") return "cancel";
  if (capability === "listInputItems") return "listInputItems";
  if (capability === "countTokens") return "countTokens";
  if (capability === "compact") return "compact";
  return "create";
}

export function shouldRetryRelayOperation(
  operation: RelayRetryOperation,
  _failure: RelayRetryFailureCategory,
): boolean {
  return relayOperationRetrySafety(operation) !== "never";
}
