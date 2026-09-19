import { canonicalMcpResource } from "@ws-model-proxy/auth/mcp-config";
import { env } from "@ws-model-proxy/env/server";
import type { MiddlewareHandler } from "hono";

/**
 * Server-side authorization request boundary (MCP plan Phase 2).
 *
 * Better Auth 1.7 has no `defaultScope` option: a missing/blank `scope` on
 * `/api/auth/oauth2/authorize` must be rejected HERE, locally and
 * non-redirecting, because forwarding it would let Better Auth produce a
 * redirected protocol error using the caller's (still unvalidated)
 * redirect_uri. Any PRESENT scope is forwarded UNCHANGED so Better Auth
 * validates the client, redirect URI, and scope values first — application
 * code never parses/rebuilds unsupported-scope redirects.
 *
 * RFC 8707 resource indicator: the authorize request must ask for THIS
 * server's canonical MCP resource (`<BETTER_AUTH_URL>/mcp`, mcp-config
 * invariant 1). A missing resource — or a requested set that does not
 * contain the canonical resource — is rejected locally with
 * `invalid_target`, never via the caller's redirect_uri, for the same
 * unvalidated-redirect reason as the scope rule.
 *
 * PARITY-REPLICATION (pass 3): every parsing decision below replicates the
 * INSTALLED downstream consumer (better-call@1.4.0 `getBody` + the
 * oauth-provider@1.7.3 query parsing) verbatim, so the guard judges exactly
 * the request Better Auth would judge — no more, no less:
 *
 * - Applicability (better-call getBody allowlist): the content-type BASE
 *   (`(ct ?? "").toLowerCase().split(";")[0].trim()`) is admissible iff it
 *   INCLUDES `application/x-www-form-urlencoded` (`===` is subsumed). Any
 *   other POST content type (pure application/json, multipart/form-data,
 *   text/plain, missing) is NOT applicable — forwarded unchanged, and
 *   better-call rejects it with 415 before any redirect could happen.
 * - JSON branch: an admissible type whose FULL (lowercased) value matches
 *   `/^application\/([a-z0-9.+-]*\+)?json/i` is parsed as JSON downstream
 *   (the JSON regex is checked BEFORE the form branch in getBody) — this
 *   admits the whole hybrid family like
 *   `application/json+application/x-www-form-urlencoded`.
 * - Form branch: better-call reads `request.formData()` and object-assigns
 *   entries in iteration order, so the LAST value per key is what Better
 *   Auth sees — including the fact that a BOM-prefixed `\uFEFFscope` key is
 *   simply NOT `scope` (downstream then defaults to the full scope set,
 *   which is exactly the shape this boundary exists to reject locally).
 *   `resource` on the form path is therefore the LAST occurrence ONLY, as a
 *   single string — no space-splitting, no union across occurrences.
 * - JSON branch `resource`: absent → local invalid_target; string → exact
 *   membership on that value; array → membership across elements (arrays
 *   are schema-legitimate there); other types → forward (downstream
 *   invalid_request).
 * - GET query (GET ONLY — HEAD is not-applicable: the provider registers
 *   GET/POST, so better-call findRoute 404s a HEAD authorize request and
 *   the guard must not be broader than the route it fronts): a SINGLE
 *   blank `scope` occurrence → local
 *   invalid_scope; MULTIPLE `scope` occurrences → forward unchanged
 *   (downstream redirects invalid_request "scope must not appear more than
 *   once" — acceptable, and never decided locally). `resource`:
 *   `getAll` 0 → local invalid_target; 1 → membership on that single
 *   UNSPLIT value; >1 → membership across ALL occurrences (arrays are
 *   schema-legitimate for GET query parameters).
 *
 * Scope is always judged before resource. The request body is inspected
 * through `request.clone()` only, so the original body is never consumed
 * and the downstream auth handler receives the exact bytes. A JSON-branch
 * body that fails to parse is FORWARDED — downstream fails on the same
 * bytes itself (SyntaxError → APIError 400, no leak). A form-branch body
 * that fails `formData()` (e.g. `text/application/x-www-form-urlencoded`
 * passes the substring allowlist but undici refuses to form-parse it) is
 * rejected LOCALLY with 400 `invalid_request`, non-redirecting (same
 * unvalidated-redirect_uri rationale; RFC 6749 §5.2 malformed-request
 * semantics) — forwarding it would surface as a downstream 500 plus a raw
 * TypeError on the console. While `WMP_MCP_ENABLED` is off the guard is
 * inactive: pure pass-through, nothing read, nothing cloned.
 *
 * APPLICABILITY (L18, pass 4): the guard fires only when the RAW request
 * pathname is EXACTLY the authorize path. better-call routes on the raw
 * pathname, but Hono's `c.req.path` percent-DECODES unreserved triples
 * like `%61`, so a request for `/api/auth/oauth2/%61uthorize` would
 * otherwise be judged here while downstream 404s — the guard must never be
 * broader than the route it fronts.
 */

export const MCP_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

/** Boundary verdict for one authorize request. */
export type AuthorizeBoundaryDecision =
  | "forward"
  | "not-applicable"
  | "invalid-scope"
  | "invalid-target"
  | "invalid-request";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
/** better-call getBody: JSON is matched on the FULL normalized content type. */
const JSON_CONTENT_TYPE_REGEX = /^application\/([a-z0-9.+-]*\+)?json/i;

/** better-call getBody allowlist: base (before `;`) INCLUDES the form type. */
function contentTypeBase(contentType: string | null): string {
  return (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

function isFormAdmissible(contentType: string | null): boolean {
  return contentTypeBase(contentType).includes(FORM_CONTENT_TYPE);
}

function isJsonBranch(contentType: string | null): boolean {
  return (
    isFormAdmissible(contentType) && JSON_CONTENT_TYPE_REGEX.test((contentType ?? "").toLowerCase())
  );
}

function isBlankScope(scope: string | null | undefined): boolean {
  return scope == null || scope.trim().length === 0;
}

/**
 * Whether a requested resource set contains the canonical MCP resource
 * (membership — used for the schema-legitimate list shapes: repeated GET
 * query occurrences and JSON-branch arrays).
 */
export function requestedResourcesIncludeCanonical(
  resources: readonly string[],
  baseUrl: string,
): boolean {
  return resources.includes(canonicalMcpResource(baseUrl));
}

function inspectQuery(params: URLSearchParams, canonical: string): AuthorizeBoundaryDecision {
  // scope: exactly one occurrence may be judged locally; repeats are left to
  // downstream's "must not appear more than once" invalid_request redirect.
  const scopes = params.getAll("scope");
  if (scopes.length > 1) return "forward";
  if (scopes.length === 0 || isBlankScope(scopes[0])) return "invalid-scope";
  const resources = params.getAll("resource");
  if (resources.length === 0) return "invalid-target";
  if (resources.length === 1) {
    return resources[0] === canonical ? "forward" : "invalid-target";
  }
  return requestedResourcesIncludeCanonical(resources, canonical) ? "forward" : "invalid-target";
}

function inspectJsonObject(
  body: Record<string, unknown>,
  canonical: string,
): AuthorizeBoundaryDecision {
  const scope = body.scope;
  if (scope === undefined || (typeof scope === "string" && isBlankScope(scope))) {
    return "invalid-scope";
  }
  if (typeof scope !== "string") return "forward"; // downstream invalid_request
  const resource = body.resource;
  if (resource === undefined) return "invalid-target";
  if (typeof resource === "string") {
    return resource === canonical ? "forward" : "invalid-target";
  }
  if (Array.isArray(resource)) {
    return requestedResourcesIncludeCanonical(
      resource.filter((entry): entry is string => typeof entry === "string"),
      canonical,
    )
      ? "forward"
      : "invalid-target";
  }
  return "forward"; // non-string non-array: downstream invalid_request
}

async function inspectFormPost(
  request: Request,
  canonical: string,
): Promise<AuthorizeBoundaryDecision> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // The content type passed the substring allowlist but undici refuses to
    // form-parse it (e.g. `text/application/x-www-form-urlencoded`). Judge
    // it HERE: forwarding would let downstream's formData() throw the same
    // TypeError as a non-APIError → 500 + raw-TypeError log. Local 400
    // invalid_request, non-redirecting (RFC 6749 §5.2 malformed request).
    return "invalid-request";
  }
  // LAST value per key, in iteration order — exactly better-call's
  // `formData().forEach((value, key) => { result[key] = value.toString(); })`.
  const last = new Map<string, string>();
  for (const [key, value] of form.entries()) {
    last.set(key, value.toString());
  }
  const scope = last.get("scope");
  if (scope === undefined || isBlankScope(scope)) return "invalid-scope";
  const resource = last.get("resource");
  if (resource === undefined) return "invalid-target";
  return resource === canonical ? "forward" : "invalid-target";
}

async function inspectJsonPost(
  request: Request,
  canonical: string,
): Promise<AuthorizeBoundaryDecision> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return "not-applicable"; // downstream: 400 invalid JSON on the same bytes
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "forward"; // downstream body validation rejects non-objects
  }
  return inspectJsonObject(body as Record<string, unknown>, canonical);
}

/**
 * Judge an authorize request's `scope` and `resource` parameters against
 * the pinned downstream semantics without consuming its body.
 * `"not-applicable"` means the method/content-type combination is not one
 * the boundary governs — forwarded for Better Auth to answer (415).
 */
export async function inspectAuthorizeRequest(
  request: Request,
  baseUrl: string,
): Promise<AuthorizeBoundaryDecision> {
  const canonical = canonicalMcpResource(baseUrl);
  // GET only: the provider registers GET/POST handlers, so better-call's
  // findRoute 404s a HEAD authorize request. Judging HEAD here would fire
  // the boundary on a request downstream never serves (L18 applicability:
  // the guard must never be broader than the route it fronts) — HEAD is
  // not-applicable → forwarded → downstream 404.
  if (request.method === "GET") {
    return inspectQuery(new URL(request.url).searchParams, canonical);
  }
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type");
    if (!isFormAdmissible(contentType)) return "not-applicable";
    if (isJsonBranch(contentType)) return inspectJsonPost(request, canonical);
    return inspectFormPost(request, canonical);
  }
  return "not-applicable";
}

function authorizationErrorBody(error: string, errorDescription: string): Response {
  return new Response(JSON.stringify({ error, error_description: errorDescription }), {
    status: 400,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * RFC 6749 §5.2-style error response for the invalid scope: 400,
 * `application/json; charset=utf-8`, no-store (§5.1). Delivered directly to
 * the caller — the caller's redirect_uri is NEVER used (it is unvalidated at
 * this point).
 */
export function invalidAuthorizeScopeResponse(): Response {
  return authorizationErrorBody(
    "invalid_scope",
    "The authorization request must specify a non-empty scope.",
  );
}

/**
 * RFC 9207/RFC 8707-style error response when the requested resource set is
 * missing or does not include this server's canonical MCP resource. Same
 * local, non-redirecting shape as the scope rejection.
 */
export function invalidAuthorizeTargetResponse(): Response {
  return authorizationErrorBody(
    "invalid_target",
    "The authorization request must include this server's MCP resource in the resource parameter.",
  );
}

/**
 * RFC 6749 §5.2-style error response for a form-admissible body that cannot
 * be form-parsed at all (exotic content types like
 * `text/application/x-www-form-urlencoded` that pass better-call's substring
 * allowlist but are refused by the body parser). Same local,
 * non-redirecting shape as the other rejections.
 */
export function invalidAuthorizeRequestResponse(): Response {
  return authorizationErrorBody(
    "invalid_request",
    "The authorization request body could not be parsed.",
  );
}

/** Mounted on `/api/auth/oauth2/authorize` before the Better Auth handler. */
export const mcpAuthorizeScopeGuard: MiddlewareHandler = async (c, next) => {
  if (!env.WMP_MCP_ENABLED) return next();
  // RAW pathname (still percent-encoded): better-call routes on the raw
  // pathname, so an encoded form like `%61uthorize` is NOT this route
  // downstream (404 there) and must not be judged here either. Hono's
  // c.req.path would decode it and wrongly trigger the guard.
  if (new URL(c.req.raw.url).pathname !== MCP_AUTHORIZE_PATH) return next();
  const decision = await inspectAuthorizeRequest(c.req.raw, env.BETTER_AUTH_URL);
  if (decision === "invalid-scope") return invalidAuthorizeScopeResponse();
  if (decision === "invalid-target") return invalidAuthorizeTargetResponse();
  if (decision === "invalid-request") return invalidAuthorizeRequestResponse();
  return next();
};
