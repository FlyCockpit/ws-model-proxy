import type { MiddlewareHandler } from "hono";

/**
 * MCP discovery alias forwarding (MCP plan Phase 3).
 *
 * Probe results (2026-09-16, installed better-auth@1.7.3 family, real
 * `auth.handler` driven with a memory adapter and `resolveMcpPlugins`):
 * the oauth-provider/mcp plugins' `onRequest` hooks already serve ALL FOUR
 * well-known paths natively, so the alias→handler mapping is a VERBATIM
 * forward of the original request — no path rewriting, no synthesized
 * documents:
 *
 * - `/.well-known/oauth-protected-resource` and
 *   `/.well-known/oauth-protected-resource/mcp` — mcp() plugin onRequest
 *   (mcp dist index.mjs: PROTECTED_RESOURCE_METADATA_PATH + resource-path
 *   variant `/mcp`); serves the RFC 9728 resource metadata document
 *   (`resource`, `authorization_servers`, `bearer_methods_supported`,
 *   `dpop_signing_alg_values_supported`, `scopes_supported`).
 * - `/.well-known/oauth-authorization-server/api/auth` and
 *   `/api/auth/.well-known/oauth-authorization-server` — oauth-provider
 *   onRequest (authorize-*.mjs handleIssuerMetadataRequest): the issuer is
 *   `<BETTER_AUTH_URL>/api/auth`, so its pathname `/api/auth` yields exactly
 *   these two metadata path spellings; serves the RFC 8414 authorization
 *   server metadata (issuer, authorization/token/jwks/introspection/
 *   revocation endpoints, scopes, DPoP algorithms, CIMD advertisement via
 *   `client_id_metadata_document_supported`). No `registration_endpoint` is
 *   advertised (DCR disabled in resolveMcpPlugins), and no OpenID discovery
 *   document is served while `openid` is not among the configured scopes.
 *
 * Upstream also natively answers HEAD with the GET status+headers and no
 * body, and answers other methods with 405 `Allow: GET, HEAD`. This module
 * enforces that contract EXPLICITLY (flag-off 404, local method gate, and a
 * bodyless HEAD adapter) so the behavior cannot drift with an upstream bump:
 * the handler is only ever invoked for GET (upstream HEAD handling is not
 * relied upon) and HEAD responses are rebuilt with a null body.
 *
 * The paths are RESERVED (registered before static assets and SSR) even
 * while the flag is off, so a flag-off request can never fall through to the
 * SPA/SSR catch-all.
 */
export const MCP_WELL_KNOWN_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

/** Header value used for the local 405 method gate (upstream's exact value). */
const ALLOW_GET_HEAD = "GET, HEAD";

/**
 * Create the forwarding middleware for one well-known alias.
 *
 * Contract (per MCP plan Phase 3):
 * - flag OFF → 404 for EVERY method (path still reserved);
 * - GET → provider metadata from the installed Better Auth handler;
 * - HEAD → same status + headers as GET, NO body (explicit adapter);
 * - every other method → 405 with `Allow: GET, HEAD`.
 */
export function createMcpDiscoveryForwarder(options: {
  enabled: boolean;
  handler: (request: Request) => Response | Promise<Response>;
}): MiddlewareHandler {
  const { enabled, handler } = options;
  return async (c) => {
    // Flag-off: reserved but absent. Every method, including GET/HEAD.
    if (!enabled) {
      return c.notFound();
    }

    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return c.newResponse(null, 405, { Allow: ALLOW_GET_HEAD });
    }

    if (method === "HEAD") {
      // Bodyless HEAD adapter: run the real GET (the provider's metadata
      // documents are side-effect-free reads) and rebuild the response with
      // the same status + headers and a null body. Never forwards a HEAD
      // (upstream HEAD handling exists but is not relied upon).
      const getRequest = new Request(c.req.raw, { method: "GET" });
      const response = await handler(getRequest);
      return new Response(null, { status: response.status, headers: response.headers });
    }

    return handler(c.req.raw);
  };
}
