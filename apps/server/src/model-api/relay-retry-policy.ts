export type RelayRetryOperation = {
  family: string;
  capability: string;
  additionalCapabilities?: readonly string[];
};

export type RelayRetryFailureCategory = "precommit_5xx" | "precommit_transport";

export function relayOperationRetrySafety(
  operation: RelayRetryOperation,
): "pre_commit_only" | "idempotent" | "never" {
  if (operation.family !== "responses") return "pre_commit_only";
  if (operation.additionalCapabilities?.includes("responses.statefulFollowUps")) return "never";
  if (
    operation.capability === "responses.statefulFollowUps" ||
    operation.capability === "responses.retrieve" ||
    operation.capability === "responses.delete" ||
    operation.capability === "responses.cancel" ||
    operation.capability === "responses.listInputItems" ||
    operation.capability === "responses.compact"
  )
    return "never";
  if (operation.capability === "responses.countTokens") return "idempotent";
  return "pre_commit_only";
}

export function shouldRetryRelayOperation(
  operation: RelayRetryOperation,
  _failure: RelayRetryFailureCategory,
): boolean {
  return relayOperationRetrySafety(operation) !== "never";
}
