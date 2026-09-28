/**
 * MCP tool calls run procedures with a synthetic session whose id is the
 * verified user id behind an `mcp:` marker (apps/server/src/mcp/context.ts).
 * Browser sessions carry Better Auth's random ids, which never use it.
 * Procedures use this to keep human-only changes out of MCP.
 */
export function isMcpSession(context: { session: { session: { id: string } } }): boolean {
  return context.session.session.id.startsWith("mcp:");
}
