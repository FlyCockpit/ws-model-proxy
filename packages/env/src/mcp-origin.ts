// ---------------------------------------------------------------------------
// MCP needs a secure public origin.
//
// With WMP_MCP_ENABLED on, the MCP resource URL is BETTER_AUTH_URL + "/mcp",
// and @better-auth/mcp accepts it only over https, or over plain http on a
// loopback host (local development). Anything else made the auth module throw
// a bare TypeError at import. This check refuses the same combination first,
// with a message that names both variables and both ways out.
// ---------------------------------------------------------------------------

/**
 * The loopback hosts @better-auth/mcp allows over plain http (its
 * `isLoopbackHost`): `localhost`, `[::1]`, and dotted-quad 127.0.0.0/8.
 * `hostname` is a WHATWG `URL#hostname`, so IPv6 keeps its brackets.
 */
export function isMcpLoopbackHost(hostname: string): boolean {
  const octets = hostname.split(".");
  const ipv4Loopback =
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
  return hostname === "localhost" || hostname === "[::1]" || ipv4Loopback;
}

/**
 * The startup error for an MCP-enabled server whose BETTER_AUTH_URL is plain
 * http on a non-loopback host, or null when the combination is valid.
 * `betterAuthUrl` is the validated origin (env's `originUrl`).
 */
export function mcpOriginProblem({
  mcpEnabled,
  betterAuthUrl,
}: {
  mcpEnabled: boolean;
  betterAuthUrl: string;
}): string | null {
  if (!mcpEnabled) return null;
  const url = new URL(betterAuthUrl);
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isMcpLoopbackHost(url.hostname)) return null;
  return (
    `[env] BETTER_AUTH_URL=${url.origin} uses plain http on a host that is not loopback, ` +
    "and the MCP server (WMP_MCP_ENABLED, on by default) requires https there. Fix one of: " +
    "set BETTER_AUTH_URL to the public https origin (e.g. https://wsmp.example.com); " +
    "for local use only, set it to http://localhost:<port> or http://127.0.0.1:<port>; " +
    "or set WMP_MCP_ENABLED=false to run without the MCP server."
  );
}
