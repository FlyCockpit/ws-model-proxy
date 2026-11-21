import { DEFAULT_LOCALE, type Locale } from "@ws-model-proxy/config/locales";
import { env } from "@ws-model-proxy/env/server";
import { MCP_FINE_SCOPES } from "./agent-scopes";

/**
 * Pure MCP configuration.
 *
 * Everything here is derived from `BETTER_AUTH_URL` / `CORS_ORIGIN` and named
 * code constants — deliberately NO new env vars. Security invariant 1: one
 * canonical public MCP resource URL derived from `BETTER_AUTH_URL`, ending in
 * `/mcp`. Token lifetimes stay named constants in code, not operator tuning.
 *
 * The `*` derivation functions are pure (explicit inputs) so tests and later
 * phases can compute canonical values for any origin; the module-level
 * constants bind them to the validated server env.
 */

// ---------------------------------------------------------------------------
// Token lifetimes — named constants, not environment variables.
// ---------------------------------------------------------------------------

/** Resource-bound MCP access JWT lifetime: 10 minutes. */
export const MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;

/** Rolling refresh-token inactivity lifetime: 72 hours. */
export const MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS = 72 * 60 * 60;

/** Cached refresh-response retry window: 30 seconds. */
export const MCP_REFRESH_RETRY_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------
// Registration + protocol policy.
// ---------------------------------------------------------------------------

/** MCP client registration, pinned to the MCP 2026-07-28 profile. */
export const MCP_METADATA_PROFILE = "mcp-2026-07-28";

export const MCP_CIMD_REGISTRATION_POLICY = {
  metadataProfile: MCP_METADATA_PROFILE,
  /** Advertise RFC 7591 dynamic client registration alongside CIMD. */
  dynamicClientRegistration: true,
} as const;

// ---------------------------------------------------------------------------
// Scopes / resource policy.
// ---------------------------------------------------------------------------

/** Every scope this MCP server can mint. */
export const MCP_SCOPES = ["mcp:read", ...MCP_FINE_SCOPES, "offline_access"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** Resource metadata and challenges advertise every permission the person may approve. */
export const MCP_RESOURCE_SCOPES = ["mcp:read", ...MCP_FINE_SCOPES] as const;

/** Provider/CIMD ceiling defaults; DCR without a requested subset retains MCP_SCOPES. */
export const MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES = ["mcp:read", "offline_access"] as const;

/** CIMD client-registration ceiling: extra scopes a client may add. */
export const MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES = MCP_FINE_SCOPES;

/** Synthetic OAuth client-id prefix for MCP personal access tokens. */
export const MCP_PAT_CLIENT_ID_PREFIX = "pat:" as const;

/** Grant referenceId for every PAT generation (clientId already includes the token id). */
export const MCP_PAT_GRANT_REFERENCE = "pat" as const;

/** Build the grant `clientId` for one personal token. */
export function mcpPatClientId(tokenId: string): string {
  return `${MCP_PAT_CLIENT_ID_PREFIX}${tokenId}`;
}

export function isMcpPatClientId(clientId: string): boolean {
  return clientId.startsWith(MCP_PAT_CLIENT_ID_PREFIX);
}

/**
 * Ceiling on a user's simultaneously ACTIVE personal tokens (active =
 * unrevoked, live grant, unexpired). Enforced inside the create transaction
 * so a compromised session cannot spray unlimited long-lived tokens.
 */
export const MCP_PAT_MAX_ACTIVE_PER_USER = 10;

export { MCP_PAT_MAX_TTL_DAYS } from "./mcp-pat-limits";

/**
 * Minimum age before the admission path rewrites `lastUsedAt`, so hot MCP
 * traffic does not write the token row on every request.
 */
export const MCP_PAT_LAST_USED_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Canonical URL derivation (pure functions).
// ---------------------------------------------------------------------------

/** OAuth issuer / authorization-server base: `<origin>/api/auth`. */
export function canonicalMcpIssuer(baseUrl: string): string {
  return new URL("/api/auth", baseUrl).toString();
}

/** RFC 8705 resource identifier for this MCP server: `<origin>/mcp`. */
export function canonicalMcpResource(baseUrl: string): string {
  return new URL("/mcp", baseUrl).toString();
}

/**
 * Configured web (browser) origin. `CORS_ORIGIN` is the browser origin on
 * split-origin deploys (see packages/auth/src/index.ts `trustedOrigins` and
 * the verification-callback rewrite); otherwise the app is same-origin and
 * `BETTER_AUTH_URL` is both. Both env values are validated origin-only
 * strings (no path/credentials), so no re-parsing is needed.
 */
export function resolveMcpWebOrigin({
  corsOrigin,
  baseUrl,
}: {
  corsOrigin: string | undefined;
  baseUrl: string;
}): string {
  return corsOrigin ?? baseUrl;
}

/** Locale-prefixed MCP login route path mounted by Phase 6 (`/$lang/mcp-login`). */
export function mcpLoginPagePath(locale: Locale = DEFAULT_LOCALE): string {
  return `/${locale}/mcp-login`;
}

/** Locale-prefixed MCP consent route path mounted by Phase 6 (`/$lang/mcp-consent`). */
export function mcpConsentPagePath(locale: Locale = DEFAULT_LOCALE): string {
  return `/${locale}/mcp-consent`;
}

// ---------------------------------------------------------------------------
// Env-bound canonical values (single source of truth for the server surface).
// ---------------------------------------------------------------------------

export const MCP_ISSUER: string = canonicalMcpIssuer(env.BETTER_AUTH_URL);
export const MCP_RESOURCE_URL: string = canonicalMcpResource(env.BETTER_AUTH_URL);
/** Default-locale login path (what the auth plugin's `loginPage` points at). */
export const MCP_LOGIN_PAGE_PATH_DEFAULT: string = mcpLoginPagePath();
/** Default-locale consent path (what the auth plugin's `consentPage` points at). */
export const MCP_CONSENT_PAGE_PATH_DEFAULT: string = mcpConsentPagePath();

// ---------------------------------------------------------------------------
// Protected-resource scope matcher (security invariant 9).
// ---------------------------------------------------------------------------

/**
 * Split/deduplicate an OAuth `scope` claim (space-separated string or list)
 * into a clean scope array. Splitting is on the ASCII space `" "` ONLY:
 * tokens are used literally (never trimmed into validity, no case folding)
 * so padded or case-variant tokens like `"mcp:read "` / `"MCP:READ"` do
 * NOT match the literal scope names. A string with leading/trailing
 * whitespace is malformed and grants nothing (fail closed by not-granting,
 * never by rejecting the input); inner empty tokens from repeated spaces
 * are ignored. Array entries are used literally (deduplicated only).
 */
export function parseMcpScopes(scope: string | readonly string[] | null | undefined): string[] {
  if (typeof scope === "string") {
    if (scope !== scope.trim()) return [];
    return [...new Set(scope.split(" ").filter((entry) => entry.length > 0))];
  }
  return [...new Set(scope ?? [])];
}

/** Protected-resource admission requires the literal mcp:read baseline. */
export function mcpScopesAllow(
  scope: string | readonly string[] | null | undefined,
  requirement: "read",
): boolean {
  return requirement === "read" && parseMcpScopes(scope).includes("mcp:read");
}
