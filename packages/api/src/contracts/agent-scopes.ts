import {
  type AgentAccess,
  type AgentScope,
  agentHasScope,
} from "@ws-model-proxy/auth/agent-scopes";
import type { McpToolName } from "./tool-names";

export * from "@ws-model-proxy/auth/agent-scopes";
export const AGENT_SCOPE_OF_TOOL: Record<McpToolName, AgentScope> = {
  nodes_get: "read",
  runtimes_get: "read",
  pools_get: "read",
  profiles_get: "read",
  providers_get: "read",
  requests_list: "read",
  metrics_query: "read",
  model_test: "models:test",
  pool_create: "pools",
  pool_update: "pools",
  pool_delete: "pools",
  runtime_create: "runtimes",
  runtime_update: "runtimes",
  runtime_delete: "runtimes",
  runtime_start: "runtimes",
  runtime_stop: "runtimes",
  profile_save: "runtimes",
  profile_apply: "runtimes",
  profile_delete: "runtimes",
  node_update: "nodes:manage",
  node_delete: "nodes:manage",
  node_secret_set: "nodes:manage",
  node_command_run: "commands",
  node_command_get: "commands",
  node_command_queue_for_user: "commands",
  node_file_read: "files",
  node_file_write: "files",
  node_file_edit: "files",
};
export function agentScopesForTool(name: McpToolName): AgentScope {
  return AGENT_SCOPE_OF_TOOL[name];
}
export function agentToolAllowed(access: AgentAccess, name: McpToolName): boolean {
  return agentHasScope(access, AGENT_SCOPE_OF_TOOL[name]);
}
