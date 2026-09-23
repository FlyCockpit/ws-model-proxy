import { createServerFn } from "@tanstack/react-start";

/**
 * SERVER RUNTIME MCP availability for the web MCP login/consent routes
 * (Phase 6).
 *
 * Deliberately NOT a Vite build-time flag: this server function reads the
 * same validated `@ws-model-proxy/env/server` module the Hono surface reads
 * (the L25 narrowed env contract — one shared source per mounted app), so a
 * runtime `WMP_MCP_ENABLED` flip gates the web routes exactly like it gates
 * authorization, discovery, and `/mcp`. The env module is imported DYNAMICALLY
 * inside the handler (the auth-session.ts pattern) so no server-env graph is
 * ever pulled into a client bundle.
 *
 * Route usage: both `/$lang/mcp-login` and `/$lang/mcp-consent` call this in
 * `beforeLoad` and throw `notFound()` BEFORE any session/client work when
 * disabled (invariant 13: flag-off MCP login/consent routes are real 404s).
 *
 * `allowNoExpiry` mirrors the mint-time WMP_MCP_PAT_ALLOW_NO_EXPIRY contract
 * (packages/api/src/routers/mcp-tokens.ts) for the settings token panel: the
 * create dialog lists "No expiry" only while the deployment allows it. The
 * selected default is 90 days either way. The procedure still re-validates
 * at mint time — the flag here is UX pre-loading, not authorization. An
 * omitted expiresAt is 90 days; only an explicit null is no expiry.
 */
export const getMcpWebAvailability = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ enabled: boolean; allowNoExpiry: boolean }> => {
    // Initialization failures (including the dynamic import itself —
    // R83/R84 F7) resolve to enabled: false / allowNoExpiry: false — the
    // fail-closed direction. The serverFn never leaks error internals to the
    // client.
    try {
      const { env } = await import("@ws-model-proxy/env/server");
      return {
        enabled: env.WMP_MCP_ENABLED === true,
        allowNoExpiry: env.WMP_MCP_PAT_ALLOW_NO_EXPIRY === true,
      };
    } catch {
      return { enabled: false, allowNoExpiry: false };
    }
  },
);
