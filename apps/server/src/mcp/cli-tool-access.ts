import { cliTokenAllows } from "@ws-model-proxy/api/lib/cli-token-capability";

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
      allowCliFileRead: boolean;
      scopes: readonly string[];
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
  // Read-only audit log of what agents did on CLI devices: same visibility rule.
  ["forwarder_cli_activity_list", "command"],
  // Defines commands that run on the person's machine (custom metric sources),
  // so it needs the same per-credential opt-in as the tools above.
  ["forwarder_device_metric_sources_set", "command"],
  ["forwarder_device_engine_adapters_set", "command"],
  ["forwarder_device_engine_adapters_clear", "command"],
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

export function isCliTool(name: string): boolean {
  return CLI_TOOL_CAPABILITIES.has(name);
}

/** PAT-only capability consent, shared by listing, calls, core and admission. */
export function cliToolAllowed(
  name: string,
  credential: McpRequestCredential | undefined,
  scopes: readonly string[] | undefined,
): boolean {
  const capability = CLI_TOOL_CAPABILITIES.get(name);
  if (capability === undefined) return false;
  if (credential?.kind !== "pat") return false;
  // Command tools (and the read-only activity log) are gated by the flag
  // alone here, as before: each tool's own scope rule is enforced by the
  // manifest and by admission. File tools consult the shared consent table.
  if (capability === "command") return credential.allowCliCommands === true;
  return cliTokenAllows({ ...credential, scopes: scopes ?? [] }, capability);
}
