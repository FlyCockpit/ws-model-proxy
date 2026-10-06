/**
 * Machine-readable reasons for deployment planning refusals (`data.reason`).
 *
 * Every refusal carrying one of these has a fixed, developer-written message
 * (it may name node ids, never caller free text), so the MCP bridge may copy
 * that message to agents. Never rename or reuse a code; add new codes at the
 * end instead.
 */
export const deploymentRefusalReasons = Object.freeze([
  // Input the caller can change.
  "invalid_rank_count",
  "unknown_node",
  "wrong_node_count",
  "label_mismatch",
  "head_address_unavailable",
  "unknown_placeholder",
  "unsafe_placeholder_value",
  "command_too_large",
  "invalid_recipe_slug",
  // Node state and grants.
  "not_enough_nodes",
  "node_offline",
  "cli_upgrade_required",
  "deployments_not_enabled",
  "unsupported_execution",
  "deployment_operator_unavailable",
  // Resources.
  "budget_exceeded",
  "resources_held",
  "no_free_ports",
  "stopped_node_unavailable",
  // Command policy.
  "commands_off",
  "protected_instance",
] as const);

export type DeploymentRefusalReason = (typeof deploymentRefusalReasons)[number];

const reasonValues: ReadonlySet<string> = new Set<string>(deploymentRefusalReasons);

export function isDeploymentRefusalReason(value: unknown): value is DeploymentRefusalReason {
  return typeof value === "string" && reasonValues.has(value);
}

/** A node the planner passed over when it chose nodes itself, and why. */
export type DeploymentSkippedNode = {
  nodeId: string;
  reason: DeploymentRefusalReason;
  message: string;
};
