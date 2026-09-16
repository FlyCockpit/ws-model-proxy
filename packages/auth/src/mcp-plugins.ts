import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { env } from "@ws-model-proxy/env/server";
import { jwt } from "better-auth/plugins";
import {
  canonicalMcpResource,
  MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_CIMD_REGISTRATION_POLICY,
  MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES,
  MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  MCP_CONSENT_PAGE_PATH_DEFAULT,
  MCP_LOGIN_PAGE_PATH_DEFAULT,
  MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
  MCP_REFRESH_RETRY_WINDOW_SECONDS,
  MCP_SCOPES,
} from "./mcp-config";
import { createMcpPostLoginOptions, issueMcpGrantClaims } from "./mcp-grant";

/**
 * Dormant, `WMP_MCP_ENABLED`-gated Better Auth 1.7 MCP plugin set (MCP plan
 * Phase 0b/2). While disabled this returns an empty array so the auth
 * instance's plugin list is exactly (admin, twoFactor, deviceAuthorization) —
 * no OAuth routes, no JWKS endpoint, and no OAuth/JWKS tables expected by the
 * 1.7.3 runtime prisma-adapter schema check.
 *
 * Phase 2 pins the full option set against the installed 1.7.3 typings
 * (`McpOptions extends OAuthOptions` from @better-auth/mcp/dist/index.d.mts):
 * `mcp()` IS the OAuth provider (never compose a separate `oauthProvider()`),
 * so every OAuth Provider option is passed flat here.
 */
export function resolveMcpPlugins({ enabled, baseUrl }: { enabled: boolean; baseUrl: string }) {
  if (!enabled) return [];

  // RFC 8707 resource identifier for this MCP server: the canonical public
  // origin plus /mcp (mcp-config, MCP plan invariant 1). `mcp()` validates it
  // (HTTPS, no query/fragment; HTTP is accepted only on loopback hosts, which
  // covers local dev origins), folds it into the provider `resources` list,
  // audience-binds issued tokens to it, and links it into newly registered
  // clients. DPoP is NOT required globally on this resource: capability is
  // advertised and proofs validated only when a CIMD client opts in via
  // `dpop_bound_access_tokens: true`.
  const resource = canonicalMcpResource(baseUrl);

  // Application-owned grant generation integration (see mcp-grant.ts). The
  // postLogin callbacks read the validated signed oauth_query and stamp the
  // private mcp_grant_id claim through the access-token claims extension.
  const postLogin = createMcpPostLoginOptions({
    secret: env.BETTER_AUTH_SECRET,
    loginPage: MCP_LOGIN_PAGE_PATH_DEFAULT,
  });

  return [
    // jwt(): self-contained access JWTs for the MCP resource. Session payloads
    // must not be signed into headers when an OAuth provider plugin (mcp) is
    // active — the option exists precisely for this composition.
    jwt({
      disableSettingJwtHeader: true,
    }),
    mcp({
      resource,

      // Locale-prefixed MCP login/consent paths derived in mcp-config from
      // DEFAULT_LOCALE; the routes themselves are built in Phase 6. The same
      // login route is the postLogin page (reauthorization branch).
      loginPage: MCP_LOGIN_PAGE_PATH_DEFAULT,
      consentPage: MCP_CONSENT_PAGE_PATH_DEFAULT,
      postLogin,

      // Scopes this server can mint; registration ceilings below cap what a
      // CIMD client can register as capabilities (defaults + allowed extras).
      // Registration ceilings do NOT replace authorization-request scope
      // validation — Better Auth validates every requested scope at authorize
      // time, and the server-side authorize scope boundary (apps/server)
      // rejects missing/blank scopes locally.
      scopes: [...MCP_SCOPES],
      clientRegistrationDefaultScopes: [...MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES],
      clientRegistrationAllowedScopes: [...MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES],
      // Public clients always require PKCE; this pins the same policy for
      // dynamically registered confidential clients (server-owned policy —
      // registration requests cannot relax it).
      clientRegistrationRequirePKCE: true,

      // DCR disabled through BOTH registration controls: the RFC 7591 endpoint
      // is off (allowDynamicClientRegistration) and open/unauthenticated
      // registration is off too. CIMD first-use discovery (cimd() below) is
      // the only client-registration path.
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,

      // User-bound tools only: authorization code + rotating refresh. Never
      // client_credentials.
      grantTypes: ["authorization_code", "refresh_token"],

      // Token lifetimes (mcp-config named constants): 10-minute access JWTs,
      // 72-hour rolling refresh inactivity, 30-second rotated-refresh retry
      // window (mcp() itself defaults the reuse interval to 30s; pinned so a
      // future default change cannot silently widen it).
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
      refreshTokenReuseInterval: MCP_REFRESH_RETRY_WINDOW_SECONDS,

      // Per-client resource enforcement (RFC 8707 §3): a client must be linked
      // to the MCP resource to request tokens for it. Defaults to true; pinned
      // explicitly so the security posture is config-visible.
      enforcePerClientResources: true,

      // Deny user-facing OAuth client/resource CRUD: CIMD-owned clients are
      // discovered, never managed through the user-facing endpoints, and
      // resources are operator-owned. Returning false (not undefined) denies
      // every action unconditionally.
      clientPrivileges: () => false,
      resourcePrivileges: () => false,

      // Application-owned grant generation: create-when-absent /
      // reuse-when-active / reject-tombstone on authorization-code exchange;
      // exact-active-grant required on refresh; read-only exact-reference on
      // introspection; stamps the immutable grant ID as the private
      // mcp_grant_id JWT claim. Fails closed (throws) so no token is minted
      // without a live grant decision. The hook input's `referenceId` IS the
      // consent HMAC returned by postLogin.consentReferenceId (persisted on
      // the consent/verification record and forwarded at code exchange,
      // refresh, and introspection) — it is forwarded as the AUTHORITATIVE
      // durable grant key; sessionId reaches the grant function only for the
      // authorization_code mint-time derivation fallback.
      extensions: [
        {
          claims: {
            accessToken: (input: {
              grantType?: string | undefined;
              user?: { id?: string | undefined } | null;
              client: { clientId: string };
              sessionId?: string | null | undefined;
              referenceId?: string | undefined;
            }) =>
              issueMcpGrantClaims({
                grantType: input.grantType,
                userId: input.user?.id,
                clientId: input.client.clientId,
                referenceId: input.referenceId,
                sessionId: input.sessionId,
                secret: env.BETTER_AUTH_SECRET,
              }),
          },
        },
      ],
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
