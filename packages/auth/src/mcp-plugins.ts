import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";

/**
 * Dormant, `WMP_MCP_ENABLED`-gated Better Auth 1.7 MCP plugin set (MCP plan
 * Phase 0b). While disabled this returns an empty array so the auth instance's
 * plugin list is exactly (admin, twoFactor, deviceAuthorization) — no OAuth
 * routes, no JWKS endpoint, and no OAuth/JWKS tables expected by the 1.7.3
 * runtime prisma-adapter schema check.
 *
 * The option set here is deliberately MINIMAL but valid: enough for the auth
 * instance to initialize and for the Better Auth schema generator to emit the
 * full OAuth/JWKS model set. Full option tuning (scopes, lifetimes, grant
 * types, privileges, DCR-off controls, localized login/consent) is Phase 2 of
 * the MCP plan; the login/consent routes these paths point at are Phase 6.
 */
export function resolveMcpPlugins({ enabled, baseUrl }: { enabled: boolean; baseUrl: string }) {
  if (!enabled) return [];

  // RFC 8707 resource identifier for this MCP server: the canonical public
  // origin plus /mcp. `mcp()` validates it (HTTPS, no query/fragment; HTTP is
  // accepted only on loopback hosts, which covers local dev origins).
  const resource = new URL("/mcp", baseUrl).toString();

  return [
    jwt(),
    mcp({
      resource,
      // Phase 2 replaces these placeholder paths with the localized MCP
      // login/consent routes built in Phase 6 of the MCP plan.
      loginPage: "/mcp-login",
      consentPage: "/mcp-consent",
    }),
    cimd({
      // Upstream hardened Node transport: resolve-once DNS validation,
      // public-routable address checks, connection pinning, TLS hostname
      // validation, byte/time limits, and redirect refusal
      // (@better-auth/cimd/node at 1.7.3).
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ];
}
