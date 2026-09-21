/**
 * Pure helpers for the MCP login/consent pages (Phase 6).
 *
 * The signed OAuth transaction lives in the page URL as individual query
 * parameters (client_id, scope, resource, state, code_challenge, … plus the
 * `sig` signature and the signed-parameter-name list). Better Auth's
 * `oauthProviderClient()` fetch plugin reads `window.location.search` and
 * forwards exactly the signed parameters as `oauth_query` on every non-GET
 * auth request — the pages NEVER reconstruct, re-sign, or append OAuth state
 * themselves. These helpers only READ what is already in the URL and decide
 * purely over response payloads; they never build an authorize URL and never
 * follow a caller-provided callback.
 */

/** MCP scopes the consent page knows how to explain. */
export type ExplainableMcpScope = "read" | "write" | "offline_access";

export interface McpOAuthSearchInfo {
  /** `client_id` query parameter when present and nonempty. */
  clientId: string | null;
  /** Space-separated `scope` split into literal tokens (deduplicated, order kept). */
  scopes: string[];
  /** Whether the URL carries Better Auth's `sig` signature parameter. */
  hasSignedQuery: boolean;
  /**
   * Whether the URL can drive an MCP page flow at all: a nonempty
   * `client_id` AND a `sig`. Anything else is rendered as a localized
   * invalid-request state — the signed endpoints would reject it anyway
   * (prelogin 401 invalid_signature, consent invalid_request).
   */
  usable: boolean;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseMcpOAuthSearch(search: Record<string, unknown>): McpOAuthSearchInfo {
  const clientId = nonEmptyString(search.client_id);
  const rawScope = nonEmptyString(search.scope);
  const scopes = rawScope === null ? [] : [...new Set(rawScope.split(" ").filter(Boolean))];
  const hasSignedQuery = Array.isArray(search.sig)
    ? search.sig.some((entry) => typeof entry === "string" && entry.length > 0)
    : nonEmptyString(search.sig) !== null;
  return {
    clientId,
    scopes,
    hasSignedQuery,
    usable: clientId !== null && hasSignedQuery,
  };
}

/**
 * Extract the only navigation signal the MCP pages accept: a Better Auth
 * OAuth response whose `redirect === true` AND whose `url` is a nonempty
 * string. Everything else (redirect false, missing/non-string url, null
 * data) means "do not navigate" — the pages then render their localized
 * terminal states instead of guessing a destination.
 */
export function resolveOauthRedirectUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.redirect !== true) return null;
  const url = nonEmptyString(record.url);
  return url;
}

/**
 * Map raw scope tokens to consent-page explanation keys. `mcp:read` and
 * `mcp:write` map to their explanations (write explains read too — invariant
 * 9); unknown tokens map to null and are still COUNTED so the page can show
 * a generic "additional access" row rather than silently hiding a scope.
 */
export function explainableMcpScopes(
  scopes: readonly string[],
): Array<{ raw: string; key: ExplainableMcpScope | null }> {
  return scopes.map((raw) => {
    if (raw === "mcp:read") return { raw, key: "read" };
    if (raw === "mcp:write") return { raw, key: "write" };
    if (raw === "offline_access") return { raw, key: "offline_access" };
    return { raw, key: null };
  });
}

/**
 * Narrow display-safe projection of the public-client / prelogin responses.
 *
 * The REAL wire shape (probed in the installed
 * @better-auth/oauth-provider@1.7.3 dist, authorize-9whjxVLJ.mjs):
 * getClientPublicEndpoint (:2303-2322) returns schemaToOAuth's output
 * (:2237-2256), whose display fields are snake_case — `client_id`,
 * `client_name`, `client_uri`, `logo_uri` (plus contacts/tos_uri/policy_uri).
 * A valid provider response therefore carries the canonical name/uri under
 * `client_name`/`client_uri`; the camelCase spellings are tolerated only as
 * defense in depth against client-shape drift. The `logo_uri` (icon) is
 * DELIBERATELY DROPPED: rendering it would mean fetching an untrusted remote
 * image on every consent view. Only the text fields survive, and only when
 * structurally valid (missing optional fields project to null).
 */
export interface McpPublicClientInfo {
  clientId: string;
  name: string | null;
  uri: string | null;
}

export function toMcpPublicClientInfo(data: unknown): McpPublicClientInfo | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const clientId = nonEmptyString(record.client_id ?? record.clientId);
  if (clientId === null) return null;
  return {
    clientId,
    name: nonEmptyString(record.client_name ?? record.name),
    uri: nonEmptyString(record.client_uri ?? record.uri),
  };
}

// ---------------------------------------------------------------------------
// Signed-query-preserving navigation + query-cache identity (Part H pass 2)
// ---------------------------------------------------------------------------

/**
 * Build a same-origin MCP page href from the RAW query string.
 *
 * Why raw: TanStack Router round-trips search through
 * `parseSearch` → `stringifySearch` on EVERY navigation and even when
 * deriving `location.searchStr` (installed @tanstack/router-core@1.171.21
 * dist router.js `parseLocation`/`buildLocation`). Better Auth signed
 * queries carry REPEATED `ba_param` keys; a parse/stringify round trip
 * collapses them into a single JSON-array parameter, and the installed
 * `buildSignedOAuthQuery` then drops `client_id`/`scope` (they are no longer
 * listed by any `ba_param` occurrence the provider recognizes), killing the
 * signature. The only URL sources that never round-trip are the browser's
 * own `window.location.search` and the raw server request URL — every MCP
 * login↔consent transition must be built from one of those (R83/R84 F1).
 */
export function mcpPageHref(
  lang: string,
  page: "mcp-login" | "mcp-consent",
  rawSearch: string,
): string {
  const query = rawSearch === "" || rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`;
  return `/${lang}/${page}${query}`;
}

/**
 * Stable fingerprint of the PARSED search object for query-cache keying.
 *
 * Deterministic for a given URL (sorted keys, JSON values), so two different
 * signed transactions (different sig/state/code_challenge) always produce
 * different fingerprints while the same transaction re-parses identically.
 * This binds the prelogin/reauth query caches to the OAuth TRANSACTION so a
 * different or expired transaction can never reuse a prior decision (R83/R84
 * F5); session binding is added by the caller via the session identity key
 * part.
 */
export function mcpSearchFingerprint(search: Record<string, unknown>): string {
  const keys = Object.keys(search).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${key}=${JSON.stringify(search[key] ?? null)}`);
  }
  return parts.join("&");
}

/** Query-key prefix for the tombstone reauth probe (invalidated on sign-out). */
export const MCP_REAUTH_STATUS_QUERY_KEY = "mcp-reauth-status";

/**
 * Query key for the tombstone reauth probe — bound to session + transaction.
 * The `sessionKey` part MUST be the SESSION id (not the user id): the grant
 * generation is HMAC(sessionId, clientId), so the same user with a replaced
 * session is a different generation with a different decision (R85/R86 N1).
 */
export function mcpReauthStatusQueryKey(
  sessionKey: string,
  clientId: string,
  fingerprint: string,
): readonly unknown[] {
  return [MCP_REAUTH_STATUS_QUERY_KEY, sessionKey, clientId, fingerprint];
}

/** Query key for the prelogin client projection — bound to the transaction. */
export function mcpPreloginClientQueryKey(
  clientId: string,
  fingerprint: string,
): readonly unknown[] {
  return ["mcp-prelogin-client", clientId, fingerprint];
}
