import { env } from "@ws-model-proxy/env/server";

/**
 * Canonical public request URL handling (MCP plan Phase 1, security
 * invariant 2).
 *
 * OAuth issuer, discovery, JWKS, token, MCP resource, and DPoP `htu`
 * validation must use the CONFIGURED public origin (`BETTER_AUTH_URL`),
 * never an untrusted forwarded host. This helper captures and validates the
 * RAW request authority BEFORE any rewriting, then builds the canonical
 * request info (scheme+host from `BETTER_AUTH_URL`, original method, path,
 * query, and a safe header set).
 *
 * Strictest coherent rule for forwarding headers (documented, deliberate):
 *
 * 1. The direct `Host` header must appear exactly once and be either the
 *    canonical public host (host+port of `BETTER_AUTH_URL`) or a member of
 *    `TRUSTED_INGRESS_HOSTS`.
 * 2. `x-forwarded-host` / `x-forwarded-proto` NEVER influence the result on
 *    their own. When the direct Host already equals the canonical public
 *    host (the normal TLS-termination-at-proxy case), forwarded values are
 *    ignored entirely — a spoofed `x-forwarded-host` has no effect.
 * 3. When the direct Host is only on the trusted ingress allowlist (an
 *    internal listener address), `x-forwarded-host` MUST be present,
 *    singular (any comma — including trailing/leading/empty entries —
 *    rejects), and equal the canonical public host (case-insensitive),
 *    otherwise the authority is ambiguous and the request is rejected.
 * 4. The raw request URL must be origin-form (or an absolute form whose
 *    authority agrees with the validated direct Host). The canonical URL is
 *    built by STRING CONCATENATION onto the configured origin — never URL
 *    re-resolution — so a `//`-prefixed path can never re-anchor the
 *    authority, and such paths are rejected outright.
 * 5. When `Origin` is present, it must pass strict origin-syntax validation
 *    (http/https scheme, no userinfo/path/query/hash, no comma folding, not
 *    the literal "null") and its origin must equal the configured web origin
 *    (`CORS_ORIGIN` when set — the split-origin browser app — else the
 *    `BETTER_AUTH_URL` origin) OR the `BETTER_AUTH_URL` origin, matching
 *    `trustedOrigins` in packages/auth/src/index.ts.
 *
 * Phase 3 wires this in front of the OAuth/JWKS handlers, the forwarded
 * well-known routes, and `/mcp`. Nothing uses it yet.
 */

/**
 * Code-level trusted-ingress host allowlist (host[:port]). Kept EMPTY and
 * FROZEN by default: the canonical public host already covers
 * TLS-terminating proxies that preserve `Host`. Populate only for fixed
 * internal listeners whose direct Host differs (e.g. "localhost:3000" for a
 * dev ingress) — entries here additionally require a matching singular
 * `x-forwarded-host` (rule 3). Deliberately NOT an env var: no such var
 * exists today and widening this trust boundary belongs to an explicit
 * reviewed change.
 */
export const TRUSTED_INGRESS_HOSTS: readonly string[] = Object.freeze([]);

/** Hop-by-hop headers (RFC 9110/7238) — never forwarded, never trusted. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Forwarding headers — dropped from the canonical request; see rules above.
 * `forwarded` is the standard RFC 7239 name (not `forward`).
 */
const FORWARDING_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-protocol",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-real-ip",
]);

export type PublicRequestRejectionReason =
  | "missing-host"
  | "ambiguous-host"
  | "host-not-allowed"
  | "forwarded-host-mismatch"
  | "origin-mismatch";

export type PublicRequestResult =
  | {
      ok: true;
      method: string;
      /** Canonical absolute URL: BETTER_AUTH_URL scheme+host + original path+query. */
      url: string;
      /** Safe header set (hop-by-hop and forwarding headers dropped, Host canonicalized). */
      headers: Headers;
    }
  | { ok: false; reason: PublicRequestRejectionReason };

export type PublicRequestOptions = {
  /** Canonical public origin. Defaults to env.BETTER_AUTH_URL. */
  canonicalOrigin?: string;
  /**
   * Allowed browser origin for the Origin check (primary). Defaults to
   * CORS_ORIGIN ?? BETTER_AUTH_URL. The BETTER_AUTH_URL origin is ALWAYS in
   * the allowed set as well (see rule 5).
   */
  webOrigin?: string;
  /** Overrides TRUSTED_INGRESS_HOSTS (tests / explicit call sites). */
  trustedIngressHosts?: readonly string[];
  /**
   * Replacement abort signal for the materialized clone (F8 pass 4):
   * defaults to `request.signal`, but the /mcp route passes its OWNED
   * admission-controller signal so the transport factory's fence
   * (`ctx.requestInfo.signal`) and the SDK's closed-flag check at fetch
   * entry observe shutdown/client aborts for THIS request. NOTE (F8 pass
   * 5): the SDK's body reads of this clone are NOT cancellable through
   * the signal — the factory fence (mcp/handler.ts) and the auth DB-seam
   * fence are the enforcement.
   */
  signal?: AbortSignal;
};

/** Thrown by {@link cloneRequestOntoPublicOrigin} when validation rejects. */
export class PublicRequestError extends Error {
  constructor(public readonly reason: PublicRequestRejectionReason) {
    super(`[public-request-url] rejected: ${reason}`);
    this.name = "PublicRequestError";
  }
}

function safeHeaderSet(request: Request, canonicalHost: string): Headers {
  // Connection-nominated headers (RFC 9110 7.6.1): every name listed in
  // `Connection` is hop-by-hop for this hop and must be dropped too.
  const connectionNominated = new Set<string>();
  const connectionHeader = request.headers.get("connection");
  if (connectionHeader !== null) {
    for (const token of connectionHeader.split(",")) {
      const name = token.trim().toLowerCase();
      if (name.length > 0) connectionNominated.add(name);
    }
  }
  const headers = new Headers();
  // set-cookie values must survive individually: undici's header iteration
  // folds duplicates with ", " which is lossy for cookies — copy them via
  // getSetCookie/append instead.
  const setCookies = request.headers.getSetCookie();
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "set-cookie") continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || FORWARDING_HEADERS.has(lower)) continue;
    if (lower.startsWith("proxy-")) continue;
    if (connectionNominated.has(lower)) continue;
    headers.append(key, value);
  }
  // RFC 9110 7.6.1: a Connection-nominated `set-cookie` is hop-by-hop for
  // this hop just like any other nominated header — the nomination must
  // win over the copy loop, not just over the iteration above.
  if (!connectionNominated.has("set-cookie")) {
    for (const cookie of setCookies) {
      headers.append("set-cookie", cookie);
    }
  }
  headers.set("host", canonicalHost);
  return headers;
}

/**
 * Strict Origin grammar, checked against the RAW value BEFORE any URL
 * parsing: exactly `scheme://host[:port]` and nothing else. `new URL()`
 * normalizes away exactly the syntax this gates (`https:host` becomes a
 * valid URL, `/blocked/..` collapses to `/`, `%2e` decodes to `.`, `?`/`#`
 * with empty payloads vanish, tabs are stripped) — so post-parse component
 * checks cannot catch them. No userinfo, no path (not even `/`), no query,
 * no fragment, no comma folding, no percent-encoding in the host, no
 * control characters. Host is an IPv4/registered name or an IPv6 literal.
 */
const STRICT_ORIGIN_PATTERN =
  /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/**
 * Strict Origin-header syntax validation (rule 5). Returns the origin
 * string when the RAW value is a bare http(s) origin — grammar-gated
 * BEFORE parsing (see {@link STRICT_ORIGIN_PATTERN}) — and `null`
 * otherwise. `new URL()` is used afterwards purely to compute `.origin`
 * (which lowercases the host) for the case-insensitive allowed-set
 * comparison.
 */
function parseStrictOrigin(raw: string): string | null {
  if (raw === "null") return null;
  if (!STRICT_ORIGIN_PATTERN.test(raw)) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * ASCII-OWS-only trim (L15, Part F pass 2): `.trim()` would also strip
 * Unicode whitespace (e.g. NBSP \u00a0), laundering a padded Host into an
 * exact canonical/allowlist match. Strip only tab/space before the
 * case-insensitive comparisons; any OTHER malformed spelling (NBSP padding,
 * inner whitespace, control characters) simply fails the exact comparison
 * and is rejected as host-not-allowed.
 */
function asciiOwsTrim(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, "");
}

/**
 * Validate the raw request authority and derive the canonical request info.
 * Pure with respect to the request: the body is never touched, and no header
 * of the input is modified.
 */
export function resolvePublicRequest(
  request: Request,
  options: PublicRequestOptions = {},
): PublicRequestResult {
  const canonicalOrigin = options.canonicalOrigin ?? env.BETTER_AUTH_URL;
  const webOrigin = options.webOrigin ?? env.CORS_ORIGIN ?? env.BETTER_AUTH_URL;
  const trustedHosts = options.trustedIngressHosts ?? TRUSTED_INGRESS_HOSTS;

  const canonicalUrl = new URL(canonicalOrigin);
  const canonicalHost = canonicalUrl.host;

  // Rule 1: exactly one Host header (Headers folds duplicates with ", ").
  const host = request.headers.get("host");
  if (host === null || asciiOwsTrim(host).length === 0) {
    return { ok: false, reason: "missing-host" };
  }
  if (host.includes(",")) {
    return { ok: false, reason: "ambiguous-host" };
  }

  const directHost = asciiOwsTrim(host).toLowerCase();
  const isCanonicalHost = directHost === canonicalHost.toLowerCase();
  const isTrustedIngress = trustedHosts.some((allowed) => allowed.toLowerCase() === directHost);
  if (!isCanonicalHost && !isTrustedIngress) {
    return { ok: false, reason: "host-not-allowed" };
  }

  // Rule 3: a non-canonical (allowlisted) direct Host must carry the public
  // host in x-forwarded-host — present, singular (no commas at all), and an
  // exact case-insensitive match.
  if (!isCanonicalHost) {
    const forwarded = request.headers.get("x-forwarded-host");
    if (forwarded === null) {
      return { ok: false, reason: "forwarded-host-mismatch" };
    }
    if (forwarded.split(",").length !== 1) {
      return { ok: false, reason: "forwarded-host-mismatch" };
    }
    // ASCII-OWS-only trim: `.trim()` would also strip Unicode whitespace
    // (e.g. NBSP \u00a0), laundering a padded non-canonical value into an
    // exact match. Strip only tab/space, then compare case-insensitively.
    const value = forwarded.replace(/^[\t ]+|[\t ]+$/g, "").toLowerCase();
    if (value.length === 0 || value !== canonicalHost.toLowerCase()) {
      return { ok: false, reason: "forwarded-host-mismatch" };
    }
  }
  // Rule 2 (canonical direct Host): forwarding headers are simply ignored —
  // they are additionally dropped from the safe header set below.

  // Rule 4: the raw request URL must be origin-form (or an absolute form
  // whose authority agrees with the validated direct Host). Backslashes
  // normalize to slashes in special URLs, so `/\evil.example.com` parses to
  // the pathname `//evil.example.com` — the startsWith("//") check catches
  // it before concatenation could ever re-anchor the authority.
  const raw = new URL(request.url);
  if (!raw.pathname.startsWith("/") || raw.pathname.startsWith("//")) {
    return { ok: false, reason: "host-not-allowed" };
  }
  // Absolute-form authority conflict: scheme is deliberately NOT compared
  // (the socket scheme is not authoritative and the canonical scheme is
  // re-derived from config below — tolerating `http://` under TLS
  // termination); a non-empty raw host that differs from the validated
  // direct Host is an authority conflict.
  if (raw.host !== "" && raw.host.toLowerCase() !== directHost) {
    return { ok: false, reason: "host-not-allowed" };
  }

  // Rule 5: an explicit Origin must be a syntactically strict origin and
  // match the allowed set (web origin OR the canonical server origin —
  // mirroring trustedOrigins in packages/auth/src/index.ts).
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const parsedOrigin = parseStrictOrigin(origin);
    const allowedOrigins = new Set([new URL(webOrigin).origin, canonicalUrl.origin]);
    if (parsedOrigin === null || !allowedOrigins.has(parsedOrigin)) {
      return { ok: false, reason: "origin-mismatch" };
    }
  }

  // Rule 4 (canonical URL): STRING CONCATENATION onto the configured origin,
  // never URL re-resolution. An empty-but-present query delimiter (`?`) is
  // preserved exactly.
  const query = raw.search !== "" ? raw.search : request.url.endsWith("?") ? "?" : "";
  return {
    ok: true,
    method: request.method,
    url: `${canonicalOrigin}${raw.pathname}${query}`,
    headers: safeHeaderSet(request, canonicalHost),
  };
}

/**
 * Materialize a new `Request` onto the canonical public origin, preserving
 * method, path, query, body, abort signal, and the safe header set from
 * {@link resolvePublicRequest}. Follows the repo's established
 * clone-and-override pattern (`new Request(...)` around `auth.handler`/SSR
 * mounting in apps/server/src/index.ts): the body stream is passed through
 * (`duplex: "half"`), not buffered — read it from the returned request.
 *
 * @throws {PublicRequestError} when the raw authority fails validation.
 */
export function cloneRequestOntoPublicOrigin(
  request: Request,
  options: PublicRequestOptions = {},
): Request {
  const result = resolvePublicRequest(request, options);
  if (!result.ok) {
    throw new PublicRequestError(result.reason);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method: result.method,
    headers: result.headers,
    signal: options.signal ?? request.signal,
  };
  if (request.body !== null) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(result.url, init);
}
