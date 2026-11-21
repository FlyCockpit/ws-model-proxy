/** Shared wire scopes and credential access. This module is safe to import in a browser. */
export const AGENT_SCOPES = [
  "read",
  "pools",
  "runtimes",
  "nodes:manage",
  "commands",
  "files",
  "models:test",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export const ALL_AGENT_SCOPES: readonly AgentScope[] = AGENT_SCOPES;
const dbScopes = [
  "READ",
  "POOLS",
  "RUNTIMES",
  "NODES_MANAGE",
  "COMMANDS",
  "FILES",
  "MODELS_TEST",
] as const;
type DbScope = (typeof dbScopes)[number];
export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === "string" && (AGENT_SCOPES as readonly string[]).includes(value);
}
export function agentScopeToDb(scope: AgentScope): DbScope {
  const value = dbScopes[AGENT_SCOPES.indexOf(scope)];
  if (value === undefined) throw new Error("Unknown agent scope");
  return value;
}
export function agentScopeFromDb(scope: DbScope): AgentScope {
  const value = AGENT_SCOPES[dbScopes.indexOf(scope)];
  if (value === undefined) throw new Error("Unknown stored agent scope");
  return value;
}
export type AgentAccess = { scopes: readonly AgentScope[]; nodeIds: readonly string[] | null };
export function agentHasScope(access: AgentAccess, scope: AgentScope): boolean {
  return access.scopes.includes(scope);
}
export function agentNodeAllowed(access: AgentAccess, nodeId: string): boolean {
  return access.nodeIds === null || access.nodeIds.includes(nodeId);
}
export function accessNarrowed(before: AgentAccess, after: AgentAccess): boolean {
  return (
    before.scopes.some((scope) => !after.scopes.includes(scope)) ||
    (after.nodeIds !== null &&
      (before.nodeIds === null || before.nodeIds.some((id) => !after.nodeIds?.includes(id))))
  );
}
export const MCP_FINE_SCOPES = [
  "mcp:pools",
  "mcp:runtimes",
  "mcp:nodes:manage",
  "mcp:commands",
  "mcp:files",
  "mcp:models:test",
] as const;
export function oauthScopeCeiling(tokenScopes: readonly string[]): AgentScope[] {
  return AGENT_SCOPES.filter((scope) => scope === "read" || tokenScopes.includes(`mcp:${scope}`));
}

/** Literal OAuth token matching: ASCII space only, without trimming or case folding. */
export function requestsRemovedMcpWrite(scope: unknown): boolean {
  return typeof scope === "string" && scope.split(" ").includes("mcp:write");
}

/**
 * An authorize request must name its scopes. Better Auth 1.7.18 answers a missing `scope` with
 * every scope stored on the client (better-auth#12194), and a client registered without a
 * `scope` stores the whole registration ceiling, so wsmp refuses it instead.
 */
export const MCP_MISSING_SCOPE_DESCRIPTION =
  "The authorization request must specify a non-empty scope.";

/** A missing (`undefined`/`null`) or blank `scope` value; arrays are left to the provider. */
export function scopeParameterMissing(scope: unknown): boolean {
  return (
    scope === undefined || scope === null || (typeof scope === "string" && scope.trim() === "")
  );
}

export const MCP_REMOVED_WRITE_DESCRIPTION = `mcp:write was removed in wsmp 1.0. Request mcp:read plus the scopes you need: ${MCP_FINE_SCOPES.join(", ")}.`;
