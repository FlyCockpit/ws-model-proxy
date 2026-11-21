import {
  MCP_MISSING_SCOPE_DESCRIPTION,
  MCP_REMOVED_WRITE_DESCRIPTION,
  requestsRemovedMcpWrite,
} from "@ws-model-proxy/auth/agent-scopes";
import { canonicalMcpResource } from "@ws-model-proxy/auth/mcp-config";
import { env } from "@ws-model-proxy/env/server";
import type { MiddlewareHandler } from "hono";

/**
 * Server-side authorization request boundary (Phase 2).
 *
 * Better Auth 1.7 has no `defaultScope` option. A MISSING `scope` on
 * `/api/auth/oauth2/authorize` would default to every scope stored on the
 * client (better-auth#12194; a DCR client registered without `scope` stores
 * the whole ceiling), so it is rejected HERE. A blank one (Better Auth would
 * split it into no scopes, or refuse a tab-joined value) is refused too, as
 * wsmp policy. Both answers are local and non-redirecting: wsmp's chosen
 * boundary, so the caller never sees a protocol error before the client and
 * redirect URI are validated (Better Auth itself redirects errors only to a
 * registered URI, else its error page). The scope-policy plugin repeats the
 * refusal at the provider for dispatches that skip this guard. The removed
 * mcp:write scope is also refused locally. Any other PRESENT scope is
 * forwarded UNCHANGED so Better Auth validates the client, redirect URI, and
 * scope values first — application code never parses/rebuilds
 * unsupported-scope redirects.
 *
 * RFC 8707 resource indicator: the authorize request must ask for THIS
 * server's canonical MCP resource (`<BETTER_AUTH_URL>/mcp`, mcp-config
 * invariant 1). A missing resource — or a requested set that does not
 * contain the canonical resource — is rejected locally with
 * `invalid_target`, never via the caller's redirect_uri, for the same
 * unvalidated-redirect reason as the scope rule.
 *
 * Parsing matches installed better-call 1.4.5 / oauth-provider 1.7.18:
 * - Only the exact base media type application/x-www-form-urlencoded is
 *   accepted for POST (case-insensitive, parameters excluded). Hybrid types,
 *   JSON and multipart are forwarded unchanged for the handler's 415.
 * - Form entries use the last value per key, including BOM-prefixed keys
 *   being distinct from scope/resource. A resource value is never split.
 * - GET duplicate scopes are left to downstream validation; repeated resource
 *   keys are treated as a set that must contain this server's resource.
 *
 * Scope is judged before resource. Only a clone is read, preserving the body
 * bytes for Better Auth. Form parsing failures are local non-redirecting 400s.
 * While WMP_MCP_ENABLED is off this middleware does not inspect requests.
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
  | "removed-scope"
  | "invalid-target"
  | "invalid-request";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
/** better-call getBody allowlist compares the exact base media type. */
function isFormAdmissible(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().split(";")[0]?.trim() === FORM_CONTENT_TYPE;
}

function isBlankScope(scope: string | null | undefined): boolean {
  return scope == null || scope.trim().length === 0;
}

/**
 * Whether a requested resource set contains the canonical MCP resource
 * (membership — used for the schema-legitimate list shapes: repeated GET
 * query occurrences).
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
  if (requestsRemovedMcpWrite(scopes[0])) return "removed-scope";
  const resources = params.getAll("resource");
  if (resources.length === 0) return "invalid-target";
  if (resources.length === 1) {
    return resources[0] === canonical ? "forward" : "invalid-target";
  }
  return requestedResourcesIncludeCanonical(resources, canonical) ? "forward" : "invalid-target";
}

async function inspectFormPost(
  request: Request,
  canonical: string,
): Promise<AuthorizeBoundaryDecision> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // Keep malformed form requests local; never redirect using an unvalidated URI.
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
  if (requestsRemovedMcpWrite(scope)) return "removed-scope";
  const resource = last.get("resource");
  if (resource === undefined) return "invalid-target";
  return resource === canonical ? "forward" : "invalid-target";
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
  return authorizationErrorBody("invalid_scope", MCP_MISSING_SCOPE_DESCRIPTION);
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
 * RFC 6749 §5.2-style error response for a form body that cannot be parsed.
 * Same local, non-redirecting shape as the other rejections.
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
  if (decision === "removed-scope")
    return authorizationErrorBody("invalid_scope", MCP_REMOVED_WRITE_DESCRIPTION);
  if (decision === "invalid-scope") return invalidAuthorizeScopeResponse();
  if (decision === "invalid-target") return invalidAuthorizeTargetResponse();
  if (decision === "invalid-request") return invalidAuthorizeRequestResponse();
  return next();
};
