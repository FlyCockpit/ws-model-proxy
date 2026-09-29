import { mcpScopesAllow } from "@ws-model-proxy/auth/mcp-config";

/**
 * Admission credential for one verified /mcp request.
 *
 * The kind is chosen by the admission branch (personal-token secret vs OAuth
 * verifier). It is never inferred from `clientId`.
 */
export type McpRequestCredential =
  | {
      kind: "pat";
      tokenId: string;
      allowCliCommands: boolean;
      expiresAt: Date | null;
    }
  | { kind: "oauth" };

/**
 * What a CLI tool needs from the node. `command` tools run or request shell
 * commands; `file_read` / `file_write` tools (relay 2.8) read or change files.
 * The capability names match `cli-agent-admission.ts`; the credential rules
 * differ per capability here, in ONE table, so the tool list, the call-time
 * check and the core never disagree.
 */
export type CliToolCapability = "command" | "file_read" | "file_write";

const CLI_TOOL_CAPABILITIES: ReadonlyMap<string, CliToolCapability> = new Map([
  ["forwarder_cli_command_run", "command"],
  ["forwarder_cli_supervised_command_start", "command"],
  ["forwarder_cli_command_result", "command"],
  ["forwarder_cli_file_read", "file_read"],
  ["forwarder_cli_file_stat", "file_read"],
  ["forwarder_cli_dir_list", "file_read"],
  ["forwarder_cli_file_search", "file_read"],
  ["forwarder_cli_file_edit", "file_write"],
  ["forwarder_cli_file_write", "file_write"],
  ["forwarder_cli_file_rename", "file_write"],
  ["forwarder_cli_dir_create", "file_write"],
  ["forwarder_cli_file_delete", "file_write"],
]);

export function cliToolCapability(name: string): CliToolCapability | undefined {
  return CLI_TOOL_CAPABILITIES.get(name);
}

export function isCliTool(name: string): boolean {
  return CLI_TOOL_CAPABILITIES.has(name);
}

/**
 * CLI tools are visible and callable only for a personal token that was
 * minted with `allowCliCommands`. OAuth, and PATs without the flag, are
 * denied; a missing credential (older bindings) is treated as OAuth. File
 * tools additionally need the literal `mcp:write` scope in this phase
 * (a read-only PAT path arrives with the read grant). `scopes` is the
 * request's granted scopes; command tools ignore it, as before.
 */
export function cliToolAllowed(
  name: string,
  credential: McpRequestCredential | undefined,
  scopes: readonly string[] | undefined,
): boolean {
  const capability = CLI_TOOL_CAPABILITIES.get(name);
  if (capability === undefined) return false;
  if (credential?.kind !== "pat" || credential.allowCliCommands !== true) return false;
  if (capability === "command") return true;
  return mcpScopesAllow(scopes ?? [], "write");
}
