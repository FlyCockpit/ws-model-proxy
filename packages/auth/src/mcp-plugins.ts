import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { jwt } from "better-auth/plugins";
import {
  canonicalMcpResource,
  MCP_CIMD_REGISTRATION_POLICY,
  MCP_CONSENT_PAGE_PATH_DEFAULT,
  MCP_LOGIN_PAGE_PATH_DEFAULT,
} from "./mcp-config";

/**
 * Dormant, `WMP_MCP_ENABLED`-gated Better Auth 1.7 MCP plugin set (MCP plan
 * Phase 0b). While disabled this returns an empty array so the auth instance's
 * plugin list is exactly (admin, twoFactor, deviceAuthorization) — no OAuth
 * routes, no JWKS endpoint, and no OAuth/JWKS tables expected by the 1.7.3
 * runtime prisma-adapter schema check.
 *
 * The option set here is deliberately MINIMAL but valid: enough for the auth
 * instance to initialize and for the Better Auth schema generator to emit the
 * full OAuth/JWKS model set. Resource and login/consent paths come from
 * mcp-config (Phase 1) so there is one canonical derivation; full option
 * tuning (scopes, lifetimes, grant types, privileges, DCR-off controls) is
 * Phase 2 of the MCP plan; the login/consent routes these paths point at are
 * Phase 6.
 */
export function resolveMcpPlugins({ enabled, baseUrl }: { enabled: boolean; baseUrl: string }) {
  if (!enabled) return [];

  // RFC 8707 resource identifier for this MCP server: the canonical public
  // origin plus /mcp (mcp-config, MCP plan invariant 1). `mcp()` validates it
  // (HTTPS, no query/fragment; HTTP is accepted only on loopback hosts, which
  // covers local dev origins).
  const resource = canonicalMcpResource(baseUrl);

  return [
    jwt(),
    mcp({
      resource,
      // Locale-prefixed MCP login/consent paths derived in mcp-config from
      // DEFAULT_LOCALE; the routes themselves are built in Phase 6.
      loginPage: MCP_LOGIN_PAGE_PATH_DEFAULT,
      consentPage: MCP_CONSENT_PAGE_PATH_DEFAULT,
    }),
    cimd({
      // Upstream hardened Node transport: resolve-once DNS validation,
      // public-routable address checks, connection pinning, TLS hostname
      // validation, byte/time limits, and redirect refusal
      // (@better-auth/cimd/node at 1.7.3).
      fetchClientMetadataResource,
      metadataProfile: MCP_CIMD_REGISTRATION_POLICY.metadataProfile,
    }),
  ];
}
