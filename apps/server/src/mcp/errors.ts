import { hasUntrustedStructure } from "@ws-model-proxy/auth/auth-logger-bridge";

/**
 * Standards-compliant safe MCP error responses (Phase 4 item 5).
 *
 * Header shapes MIRROR the installed upstream challenge builder
 * (`createResourceServerChallenge` in @better-auth/oauth-provider@1.7.3,
 * resource-challenge-*.mjs — read before writing this module):
 *
 * - 401 (invalid/missing credentials): `WWW-Authenticate: Bearer
 *   error="invalid_token", error_description="…",
 *   resource_metadata="<origin>/.well-known/oauth-protected-resource<mcp-path>"`
 *   per RFC 6750 §3 + the RFC 9728 `resource_metadata` pointer.
 * - 403 insufficient_scope (fixable by step-up authorization): RFC 6750 §3.1
 *   `insufficient_scope` challenge naming the missing scope(s).
 * - 403 NON-fixable denial (revoked grant, banned user, forced-2FA): NO
 *   WWW-Authenticate header at all — the upstream builder deliberately
 *   returns `undefined` for plain FORBIDDEN ("a permission denial that
 *   re-authorizing cannot fix must not be answered with a challenge that
 *   sends the user through consent for scopes they already hold"). The body
 *   is a generic JSON-RPC error with no reason detail.
 *
 * Bodies match the upstream JSON-RPC error shape (`{jsonrpc: "2.0", error:
 * {code, message}, id: null}`) so a client sees one error grammar on /mcp.
 *
 * Logging regime (Part D redaction, invariant 10): every log line carries
 * ONLY a sanitized static reason string, the VERIFIED subject/client ids,
 * the request id, and (Phase 5) the tool name — never tokens, token
 * digests, queries, paths with credentials, or error messages/stacks from
 * Prisma/better-auth internals.
 */

const INTERNAL_ERROR_JSONRPC_CODE = -32603;
/** Upstream uses -32000 for authorization-layer JSON-RPC error bodies. */
const AUTHORIZATION_ERROR_JSONRPC_CODE = -32000;

/** Max safe description length — descriptions here are static strings, but keep the bound. */
const MAX_DESCRIPTION_LENGTH = 120;

function quoteAuthParam(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * RFC 9728 protected-resource metadata URL for the canonical MCP resource —
 * derived exactly the way the upstream challenge builder derives it:
 * `<resource origin>/.well-known/oauth-protected-resource<resource path>`.
 */
export function mcpResourceMetadataUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  const resourcePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${resourcePath}`;
}

function authorizationErrorBody(message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: AUTHORIZATION_ERROR_JSONRPC_CODE, message },
    id: null,
  });
}

/**
 * 401 invalid_token challenge (post-verification failures upstream's
 * wrapper never sees: malformed claims, missing subject/client, missing
 * presented credential, unknown user). Re-authorization can plausibly fix
 * these, so the RFC 6750 + RFC 9728 challenge IS sent.
 */
export function mcpUnauthorizedResponse({
  description,
  resourceUrl,
}: {
  description: string;
  resourceUrl: string;
}): Response {
  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const challenge = [
    'error="invalid_token"',
    `resource_metadata="${quoteAuthParam(mcpResourceMetadataUrl(resourceUrl))}"`,
    `error_description="${quoteAuthParam(safeDescription)}"`,
  ].join(", ");
  return new Response(authorizationErrorBody("Unauthorized"), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer ${challenge}`,
    },
  });
}

/**
 * 403 NON-fixable denial (revoked/tombstoned/mismatched grant, banned
 * user, forced-2FA not satisfied). NO WWW-Authenticate header and a generic
 * body: the denial reason is deliberately not disclosed (ownership-hiding
 * convention; upstream's own builder omits the challenge for exactly this
 * class). The sanitized reason goes to the server log only.
 */
export function mcpForbiddenResponse(): Response {
  return new Response(authorizationErrorBody("Forbidden"), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Unexpected-failure catch-all: a generic internal MCP JSON-RPC error
 * carrying the request ID for correlation. Never includes the underlying
 * error's message, stack, or query (Part D redaction regime).
 */
export function mcpInternalErrorResponse({ requestId }: { requestId: string }): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: INTERNAL_ERROR_JSONRPC_CODE,
        message: "Internal error",
        data: { requestId },
      },
      id: null,
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * 503 for post-close /mcp admissions (F8): the graceful-shutdown sequence
 * has closed the MCP admission gate, so the request is refused BEFORE the
 * verifier or the transport runs. Generic JSON-RPC body (the shutdown state
 * is not a secret); finalized through c.newResponse by the caller so chain
 * headers (X-RateLimit-*) survive this exit too.
 */
export function mcpShuttingDownResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: AUTHORIZATION_ERROR_JSONRPC_CODE, message: "Server is shutting down" },
      id: null,
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * 499 for aborted /mcp exchanges (F8 pass 4): the client request signal was
 * already aborted at entry, aborted mid-exchange (peer disconnect / drain
 * timeout), or the admission gate closed and cancelled the exchange. 499
 * ("client closed request") mirrors the installed SDK's own ConnectionClosed
 * mapping. Generic JSON-RPC body; finalized through c.newResponse by the
 * caller so chain headers (X-RateLimit-*) survive this exit too.
 */
export function mcpRequestAbortedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: AUTHORIZATION_ERROR_JSONRPC_CODE, message: "Client closed request" },
      id: null,
    }),
    {
      status: 499,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * 400 for requests rejected by the canonical-authority boundary (hostile
 * Host/Origin, ambiguous authority, spoofed forwarding headers). Static
 * body, no detail: the reason goes to the sanitized server log only.
 */
export function mcpInvalidRequestResponse(): Response {
  return new Response(authorizationErrorBody("Invalid request"), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * TERMINAL log-field policy (F7 / L19, Part F pass 2): dynamic identifier
 * values (sub, client_id, tool name) are logged VERBATIM only when they
 * carry no structural character. A verified `client_id` can be a CIMD
 * document URL — the installed CIMD URL validator permits query strings
 * (`https://client.example.com/client.json?access_token=…` passes), so a
 * URL-shaped identifier would carry credential-bearing query/path material
 * straight into the logs. Reuses the Part D terminal trigger
 * (`hasUntrustedStructure`, packages/auth auth-logger-bridge) — the SAME
 * character/scheme-word set, applied to the whole FIELD value: any trigger
 * redacts the whole value. Partial URL-scrubbing is deliberately NOT
 * revived (rejected in Part D pass 9 as provably unfinishable).
 */
function safeLogField(value: string): string {
  return hasUntrustedStructure(value) ? "[redacted]" : value;
}

/**
 * Sanitized /mcp log line: static reason + VERIFIED subject/client ids +
 * request id + (Phase 5) tool name. Nothing else — in particular never the
 * presented credential, scope string, grant reference, or an error object.
 * Dynamic identifier values carrying URL/query/credential structure are
 * redacted whole (see {@link safeLogField}).
 */
export function mcpSanitizedLog(
  reason: string,
  fields: {
    sub?: string;
    clientId?: string;
    requestId?: string;
    toolName?: string;
  } = {},
): void {
  const parts = [`[mcp] ${reason}`];
  if (fields.sub) parts.push(`sub=${safeLogField(fields.sub)}`);
  if (fields.clientId) parts.push(`client=${safeLogField(fields.clientId)}`);
  if (fields.requestId) parts.push(`request=${safeLogField(fields.requestId)}`);
  if (fields.toolName) parts.push(`tool=${safeLogField(fields.toolName)}`);
  console.error(parts.join(" "));
}

/**
 * 403 insufficient_scope challenge (a token valid for the read baseline but
 * not for a write action).
 */
export function mcpInsufficientScopeResponse({
  requiredScopes,
  resourceUrl,
  description,
}: {
  requiredScopes: readonly string[];
  resourceUrl: string;
  description: string;
}): Response {
  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const scopes = [...new Set(requiredScopes)].join(" ");
  const challenge = [
    'error="insufficient_scope"',
    `scope="${quoteAuthParam(scopes)}"`,
    `resource_metadata="${quoteAuthParam(mcpResourceMetadataUrl(resourceUrl))}"`,
    `error_description="${quoteAuthParam(safeDescription)}"`,
  ].join(", ");
  return new Response(authorizationErrorBody("Forbidden"), {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer ${challenge}`,
    },
  });
}
