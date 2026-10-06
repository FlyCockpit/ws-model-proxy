/** The 27 MCP tools of 0.4.0 (spec §6.2 + owner round 3 + review), in manifest order. READ tokens get the first 7. */
export const MCP_READ_TOOLS = [
  "nodes_get",
  "runtimes_get",
  "pools_get",
  "profiles_get",
  "providers_get",
  "requests_list",
  "metrics_query",
] as const;

export const MCP_FULL_TOOLS = [
  "model_test",
  "pool_create",
  "pool_update",
  "pool_delete",
  "runtime_create",
  "runtime_update",
  "runtime_delete",
  "runtime_start",
  "runtime_stop",
  "profile_save",
  "profile_apply",
  "profile_delete",
  "node_update",
  "node_secret_set",
  "node_command_run",
  "node_command_get",
  "node_command_queue_for_user",
  "node_file_read",
  "node_file_write",
  "node_file_edit",
] as const;

export const MCP_TOOL_NAMES = [...MCP_READ_TOOLS, ...MCP_FULL_TOOLS] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
