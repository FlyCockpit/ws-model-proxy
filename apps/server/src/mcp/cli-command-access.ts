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

const CLI_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "forwarder_cli_command_run",
  "forwarder_cli_command_result",
]);

export function isCliCommandTool(name: string): boolean {
  return CLI_COMMAND_TOOL_NAMES.has(name);
}

/**
 * CLI command tools are visible and callable only for a personal token that
 * was minted with the flag. OAuth, and PATs without the flag, are denied.
 * A missing credential (older bindings) is treated as OAuth.
 */
export function cliCommandsAllowed(credential: McpRequestCredential | undefined): boolean {
  return credential?.kind === "pat" && credential.allowCliCommands === true;
}
