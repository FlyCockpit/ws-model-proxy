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
  | "precommit_content_type_mismatch";

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
