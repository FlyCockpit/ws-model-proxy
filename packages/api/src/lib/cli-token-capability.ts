/** Literal scopes and explicit PAT flags; missing consent always denies. */
export function cliTokenAllows(
  token: { allowCliCommands?: boolean; allowCliFileRead?: boolean; scopes?: readonly string[] },
  capability: "command" | "file_read" | "file_write",
): boolean {
  const scopes = token.scopes ?? [];
  if (token.allowCliCommands === true && scopes.includes("mcp:write")) return true;
  return (
    capability === "file_read" && token.allowCliFileRead === true && scopes.includes("mcp:read")
  );
}
