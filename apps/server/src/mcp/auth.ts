import { requireMcpAuth } from "@better-auth/mcp";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { ContextServices } from "@ws-model-proxy/api/context";
import {
  authenticateMcpPersonalToken,
  isMcpPersonalTokenSecret,
  type McpPersonalTokenIdentity,
} from "@ws-model-proxy/api/lib/mcp-token-access";
import { isUserBanned } from "@ws-model-proxy/auth/is-user-banned";
import {
  MCP_ISSUER,
  MCP_RESOURCE_URL,
  mcpPatClientId,
  mcpScopesAllow,
  parseMcpScopes,
} from "@ws-model-proxy/auth/mcp-config";
import { MCP_GRANT_ID_CLAIM } from "@ws-model-proxy/auth/mcp-grant";
import type prismaClientDefault from "@ws-model-proxy/db";
import type { Context } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { mcpIdentityKey, mcpIdentityQuotaLimiter } from "../mcp-rate-limit";
import { cloneRequestOntoPublicOrigin, PublicRequestError } from "../public-request-url";
import { createMcpAdmissionGate, type McpAdmission, type McpAdmissionGate } from "./admission";
import { createMcpContext, type McpContext, type McpSessionUser } from "./context";
import {
  mcpForbiddenResponse,
  mcpInternalErrorResponse,
  mcpInvalidRequestResponse,
  mcpRequestAbortedResponse,
  mcpSanitizedLog,
  mcpShuttingDownResponse,
  mcpUnauthorizedResponse,
} from "./errors";

/**
 * MCP request authentication (Phase 4 items 1-9).
 *
 * The INSTALLED upstream verification API is `requireMcpAuth(auth, handler,
 * opts)` from `@better-auth/mcp@1.7.3` (dist/index.d.mts,
 * src/require-mcp-auth.d.ts): it verifies the Bearer JWT against the
 * authorization server's JWKS (signature, issuer, audience=resource,
 * expiry), validates DPoP proofs (with the auth DB-backed replay store),
 * enforces `requiredScopes` with a custom `isScopeSatisfied` matcher, and
 * answers unauthenticated/insufficient-scope requests with the upstream
 * RFC 6750/9728 challenges. This module NEVER decodes or verifies a JWT
 * itself and NEVER queries legacy opaque-token rows — everything upstream
 * owns stays upstream's.
 *
 * After upstream verification, the handler here performs the
 * application-owned admission sequence (each step fails closed):
 *
 *   1. nonempty string `sub` + `client_id` claims;
 *   2. scope claim parsed + deduped (`parseMcpScopes` — the SAME pure
 *      parser the protected-resource matcher uses);
 *   3. the actually-presented Bearer/DPoP credential extracted from the
 *      Authorization header;
 *   4. the verified payload converted to SDK v2 `AuthInfo`;
 *   5. a nonempty private `mcp_grant_id` claim; the EXACT McpGrant loaded
 *      by `(id, sub, client_id)` — missing, mismatched, or revoked
 *      (tombstoned) grants are rejected BEFORE any tool runs;
 *   6. the live Prisma user loaded by `sub`;
 *   7. missing users (401), actively banned users (403), and users
 *      requiring 2FA under the global force-2FA policy (403) rejected;
 *   8. the oRPC context built with a synthetic session that NEVER contains
 *      the access token (`mcp/context.ts`);
 *   9. `AuthInfo` passed to the transport's `.fetch(request, { authInfo })`.
 *
 * The scope predicate: the ENDPOINT baseline is the read baseline
 * (`requiredScopes: ["mcp:read"]` with a matcher where `mcp:write` also
 * satisfies it — exactly `mcpScopesAllow(scope, "read")`); literal
 * `mcp:write` for write tools is enforced at tool dispatch (Phase 5).
 */

/** The auth-instance shape the upstream wrapper needs ($context for DPoP replay). */
export type McpAuthInstance = Parameters<typeof requireMcpAuth>[0];

/** Minimal Prisma surface this module uses (mocked in tests via mockDeep). */
export type McpAuthPrisma = {
  mcpGrant: Pick<typeof prismaClientDefault.mcpGrant, "findUnique">;
  user: Pick<typeof prismaClientDefault.user, "findUnique">;
};

/** The transport surface this module hands verified requests to. */
export interface McpTransport {
  fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
}

/** Identity-quota consumption outcome (429 carries Retry-After seconds). */
export type McpQuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface CreateMcpRequestHandlerOptions {
  /** Better Auth instance backing verification (needs `$context`). */
  authInstance: McpAuthInstance;
  /** Module-lifetime MCP transport (`createMcpTransport`). */
  transport: McpTransport;
  /** Prisma client (or test double) for the grant + user lookups. */
  prisma: McpAuthPrisma;
  /** Global force-2FA policy (same source as the admin gate). */
  isForceTwoFactorRequired: () => Promise<boolean>;
  /** Same ContextServices the normal server path injects into createContext. */
  services?: ContextServices;
  /** Canonical resource URL (audience). Default: mcp-config constant. */
  resourceUrl?: string;
  /** Expected token issuer. Default: mcp-config constant. */
  issuerUrl?: string;
  /** Identity-quota consumer. Default: the Phase 3 mcp:identity: limiter. */
  consumeIdentityQuota?: (sub: string, clientId: string) => Promise<McpQuotaResult>;
  /** Clock injectable for ban-boundary determinism in tests. */
  now?: () => Date;
  /**
   * Shutdown admission gate (F8): when the route handler is admitted, the
   * gate is decremented when the response settles; after `close()` is
   * called, new admissions get a safe 503 JSON-RPC error. Defaults to a
   * handler-local gate (never closed) so unit tests can omit it; the
   * production app passes the ONE gate the graceful-shutdown sequence
   * closes alongside the transport.
   */
  admissionGate?: McpAdmissionGate;
  /**
   * Shadow-await budget for the ABORT release path (F8 pass 5), in
   * milliseconds. When the abort race wins, the permit is NOT released
   * until the underlying admitted promise (verifier/transport
   * continuations) settles — normally fast because the DB-seam fence
   * rejects their next database operation — but a continuation stuck on an
   * uncancellable upstream network fetch (JWKS with the dropped signal;
   * undici times out at ~300s) must not hold the shutdown hostage, so the
   * shadow-await releases at this cap. Default 10s, matching the graceful
   * shutdown drain budget. Injectable so tests can pin the bounded-release
   * contract quickly.
   */
  abortShadowAwaitMs?: number;
  /**
   * Verified-request seam (Phase 5): invoked after EVERY admission check
   * passes, right before the transport fetch, with the AuthInfo and the
   * synthetic-session oRPC context.
   */
  onVerified?: (verified: McpVerifiedRequest) => void;
  /**
   * MCP personal-token verifier. Default looks up hashed `wsmp_mcp_` secrets.
   * Injectable so unit tests can exercise the PAT admission branch without a
   * real credential table.
   */
  authenticatePersonalToken?: (
    rawSecret: string,
    now: Date,
  ) => Promise<McpPersonalTokenIdentity | null>;
}

/** Hono context variables the /mcp route reads (requestId from the wrapper). */
type McpHonoContext = Context<{ Variables: { requestId: string } }>;

const defaultConsumeIdentityQuota = async (
  sub: string,
  clientId: string,
): Promise<McpQuotaResult> => {
  try {
    await mcpIdentityQuotaLimiter.consume(mcpIdentityKey(sub, clientId));
    return { ok: true };
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      return { ok: false, retryAfterSeconds: Math.ceil(rejection.msBeforeNext / 1000) };
    }
    throw rejection;
  }
};

/**
 * The upstream scope matcher: `mcp:write` satisfies the read baseline.
 * Only `mcp:read` is configured as a required scope; the matcher applies
 * `mcpScopesAllow` semantics verbatim (never widens granted scopes).
 */
/**
 * Read-baseline scope matcher (mcp:write implies mcp:read). Exported for the
 * scope-predicate tests; production consumes it directly at the
 * `isScopeSatisfied` seam below.
 */
export function mcpReadBaselineMatcher(requiredScope: string, grantedScopes: ReadonlySet<string>) {
  return mcpScopesAllow([...grantedScopes], requiredScope === "mcp:read" ? "read" : "write");
}

async function loadMcpGrant(prisma: McpAuthPrisma, id: string) {
  return prisma.mcpGrant.findUnique({
    where: { id },
    select: { id: true, userId: true, clientId: true, revokedAt: true },
  });
}

/** Extract the presented Bearer/DPoP credential from the Authorization header. */
export function extractPresentedCredential(
  header: string | null,
): { scheme: "Bearer" | "DPoP"; token: string } | null {
  if (header === null) return null;
  const match = /^(\S+)\s+(\S+)$/.exec(header);
  const scheme = match?.[1]?.toLowerCase();
  const token = match?.[2];
  if (scheme === undefined || token === undefined) return null;
  if (scheme !== "bearer" && scheme !== "dpop") return null;
  return { scheme: scheme === "bearer" ? "Bearer" : "DPoP", token };
}

/** A verified request, produced only after every admission check passes. */
export interface McpVerifiedRequest {
  authInfo: AuthInfo;
  orpcContext: McpContext;
  /** Route request id for correlation (Phase 5: tool dispatch binding + logs). */
  requestId: string;
  /**
   * The OWNED admission signal (Part G pass 2, G1): tool dispatch races and
   * fences procedure calls and diagnostic cores on it, so client aborts and
   * gate.close() tear down a running tool's work.
   */
  signal: AbortSignal;
}

/**
 * Build the /mcp POST handler: an admission-barrier wrapper (F8 — owns every
 * admitted exchange from route entry until its promise SETTLES, so the
 * shutdown close() covers even pre-factory body-parse stages; post-close
 * admissions get a safe 503 JSON-RPC error) around the upstream
 * `requireMcpAuth` wrapper and the application-owned admission sequence,
 * then the transport fetch. All known failures are safe 401/403 responses;
 * unexpected failures become a generic internal MCP error with the request
 * ID (sanitized logging only); SDK-RETURNED internal errors get the request
 * ID stamped onto `error.data` (F9, byte-exact per F10).
 *
 * F8 pass-4/pass-5 terminal semantics implemented here:
 *
 * 1. RELEASE-ON-SETTLEMENT (normal path): when the admitted sequence wins
 *    the race, the permit releases in the handler's `finally` after
 *    everything already settled.
 * 2. PROMPT-SETTLEMENT RACE + STAGE FENCES: the admitted sequence is raced
 *    against the owned permit signal (rejects on abort — the handler answers
 *    the safe 499 immediately), and EVERY await in the admission path
 *    (canonicalize, verifier, grant, user, policy, quota, transport fetch)
 *    is fenced afterwards (`signal.aborted` → stop; never START the next
 *    stage). On the ABORT path the permit is NOT released when the outer
 *    handler settles: a bounded SHADOW-AWAIT holds it until the underlying
 *    verifier/transport promise settles (or the
 *    {@link CreateMcpRequestHandlerOptions.abortShadowAwaitMs} cap) — the
 *    installed verifier continuation chain is NOT cancellable (it drops the
 *    signal, see mcp/handler.ts + the DB-seam fence rationale), so release
 *    must await its stragglers, bounded.
 * 3. SYNCHRONOUS ENTRY CHECK: an ALREADY-aborted request signal returns the
 *    safe 499 BEFORE admitting (no permit, no listener — an abort listener
 *    never fires for an already-aborted signal, so admitting would strand
 *    the gate at outstanding=1 forever).
 * 4. OWNED SIGNAL: the canonical clone handed to the verifier and transport
 *    carries the PERMIT controller's signal (not the raw client signal).
 *    WHAT THIS DOES: the transport factory's fence observes it via
 *    `ctx.requestInfo.signal`, and the SDK's own closed-flag check observes
 *    it at fetch entry. WHAT THIS DOES NOT DO: it does NOT cancel the SDK's
 *    body reads (the installed verifier/transport chain drops the signal —
 *    body reads are not cancellable through it). The FACTORY FENCE
 *    (mcp/handler.ts) is the enforcement that no post-abort server is
 *    created; the DB-SEAM FENCE (@ws-model-proxy/auth/auth-db-shutdown-fence,
 *    armed by the admission gate's onClosed) is the enforcement that no
 *    post-close database operation starts.
 * 5. FRAMING-SAFE EARLY EXITS (F10 pass 5): every handler-built early-exit
 *    response is finalized through {@link finalizeMcpEarlyExitResponse},
 *    which sets `Content-Length` EXPLICITLY to the actual body byte length
 *    — Hono merges response headers into its context-scoped prepared
 *    headers, so a LOSING continuation's merged length must never frame the
 *    WINNING response's body.
 */
export function createMcpRequestHandler(options: CreateMcpRequestHandlerOptions) {
  const resourceUrl = options.resourceUrl ?? MCP_RESOURCE_URL;
  const issuerUrl = options.issuerUrl ?? MCP_ISSUER;
  const consumeIdentityQuota = options.consumeIdentityQuota ?? defaultConsumeIdentityQuota;
  const now = options.now ?? (() => new Date());
  const admissionGate = options.admissionGate ?? createMcpAdmissionGate();
  const abortShadowAwaitMs = options.abortShadowAwaitMs ?? DEFAULT_ABORT_SHADOW_AWAIT_MS;

  return async (c: McpHonoContext): Promise<Response> => {
    const requestId = c.get("requestId");
    const requestSignal = c.req.raw.signal;
    // Synchronous entry fence (F8 piece 3): an ALREADY-aborted signal is
    // rejected BEFORE any admission — registering an abort listener for an
    // already-aborted signal never fires, so admitting here would strand the
    // gate at outstanding=1 and hang close() forever.
    if (requestSignal.aborted) {
      mcpSanitizedLog("rejected: request already aborted", { requestId });
      return finalizeMcpEarlyExitResponse(c, mcpRequestAbortedResponse());
    }
    // Admission barrier (F8): take ownership of this exchange BEFORE any
    // body handling — a request that passed the body cap but is still
    // awaiting its body has no SDK-tracked server, so the route-level
    // admission is the only thing the shutdown close() can await.
    const admission = admissionGate.admit();
    if (admission === null) {
      mcpSanitizedLog("rejected: shutting down", { requestId });
      return finalizeMcpEarlyExitResponse(c, mcpShuttingDownResponse());
    }
    // The OWNED controller (F8 piece 4): the client signal and gate.close()
    // both abort it; the canonical clone below carries ITS signal so the
    // transport factory's fence (ctx.requestInfo.signal) and the SDK's
    // closed-flag check at fetch entry observe cancellation. This does NOT
    // cancel the SDK's body reads (see the module docblock) — the factory
    // fence and the DB-seam fence are the enforcement.
    const owned = admission.controller;
    const onClientAbort = () => owned.abort();
    requestSignal.addEventListener("abort", onClientAbort);
    // Prompt-settlement race (F8 piece 2): rejects as soon as the owned
    // signal aborts — the handler then answers the safe 499 below WITHOUT
    // waiting for the (possibly never-settling) admitted sequence. The
    // sequence's own stage fences stop the abandoned continuation at its
    // current await; the DB-seam fence rejects any database operation it
    // attempts after gate close.
    let detachAbortRace = () => {};
    const abortRace = new Promise<never>((_, reject) => {
      const rejectAborted = () => reject(new McpAdmissionAbortedError());
      if (owned.signal.aborted) {
        rejectAborted();
        return;
      }
      owned.signal.addEventListener("abort", rejectAborted, { once: true });
      detachAbortRace = () => owned.signal.removeEventListener("abort", rejectAborted);
    });
    // The admitted promise is kept named (F8 pass 5): on the abort path the
    // permit's release must SHADOW-AWAIT it (the verifier continuation chain
    // is not cancellable and may still perform database work after the 499).
    const admitted = handleAdmittedRequest(c, {
      options,
      resourceUrl,
      issuerUrl,
      consumeIdentityQuota,
      now,
      signal: owned.signal,
    });
    let abortWon = false;
    try {
      return await Promise.race([admitted, abortRace]);
    } catch (error) {
      if (error instanceof McpAdmissionAbortedError) {
        abortWon = true;
        return finalizeMcpEarlyExitResponse(c, mcpRequestAbortedResponse());
      }
      // Unexpected failure — generic internal error, sanitized log line
      // (constructor name only). MCP clients must receive the JSON-RPC
      // error grammar even on this defensive path (handleAdmittedRequest
      // already catches its own errors; this branch is a belt-and-braces
      // guard for anything that escapes it).
      mcpSanitizedLog(
        `internal error (${error instanceof Error ? error.constructor.name : typeof error})`,
        { requestId },
      );
      return finalizeMcpEarlyExitResponse(c, mcpInternalErrorResponse({ requestId }));
    } finally {
      detachAbortRace();
      requestSignal.removeEventListener("abort", onClientAbort);
      if (!abortWon) {
        // Normal path: the race resolved through `admitted`, so it has
        // already settled — release immediately (no permit leak).
        admission.release();
      } else {
        // Abort path (F8 pass 5): the handler has answered 499, but the
        // admitted promise may still be pending (un-cancellable verifier
        // continuation). Hold the permit until it settles — bounded by the
        // shadow-await cap so close() can never hang on an uncancellable
        // upstream fetch. The DB-seam fence guarantees the residual
        // continuation cannot touch the database; the factory fence
        // guarantees it cannot create servers.
        releaseAfterStrayContinuations(admitted, admission, {
          requestId,
          capMs: abortShadowAwaitMs,
        });
      }
    }
  };
}

/**
 * Default shadow-await budget for the abort release path (F8 pass 5):
 * 10 seconds, matching the graceful-shutdown HTTP drain budget — close()
 * waits at most one drain-budget for uncancellable verifier continuations
 * (their DB work is already fenced; only a hung upstream network fetch,
 * e.g. a JWKS fetch whose signal the upstream chain drops — undici
 * eventually times out at ~300s — can outlive it, and the permit then
 * releases with a sanitized log line instead of blocking shutdown).
 */
const DEFAULT_ABORT_SHADOW_AWAIT_MS = 10_000;

/**
 * Release the admission permit only after the admitted promise (verifier /
 * transport continuations) settles, bounded by `capMs` (F8 pass 5). Runs
 * detached: the 499 response is already on its way to the client; this
 * exists so the shutdown gate's close() awaits real settlement of every
 * DB-capable continuation, with a hard cap for uncancellable ones.
 */
/** Outcome of the shadow-await race: the strays settled, or the budget cap fired. */
type McpShadowAwaitOutcome = "settled" | "cap";

function releaseAfterStrayContinuations(
  admitted: Promise<Response>,
  admission: McpAdmission,
  { requestId, capMs }: { requestId: string; capMs: number },
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const strays = Promise.allSettled([admitted]).then((): McpShadowAwaitOutcome => "settled");
  const cap = new Promise<McpShadowAwaitOutcome>((resolve) => {
    timer = setTimeout(() => resolve("cap"), capMs);
  });
  void Promise.race([strays, cap]).then((outcome) => {
    clearTimeout(timer);
    if (outcome === "cap") {
      // Sanitized (Part D): static reason + request id only.
      mcpSanitizedLog("abort shadow-await budget reached; releasing permit", { requestId });
    }
    admission.release();
  });
}

/**
 * F10 pass 5 — framing-safe finalization for EVERY handler-built early-exit
 * response. Hono's `c.newResponse` merges the passed response's headers
 * into its context-scoped prepared headers (context.js #newResponse uses
 * the prepared Headers object by reference and SETs every passed header),
 * and a LOSING continuation of the abort race may have already merged ITS
 * response's headers — including a Content-Length for a DIFFERENT body —
 * into the same prepared headers. Finalizing with an EXPLICIT byte-exact
 * Content-Length overwrites any inherited length, so the winning response
 * can never be mis-framed (the Node adapter preserves supplied lengths).
 * Early-exit bodies are always our own static JSON strings, so reading the
 * text is lossless here (the byte-exact pass-through arm in
 * handleAdmittedRequest is deliberately NOT rebuilt).
 */
async function finalizeMcpEarlyExitResponse(
  c: McpHonoContext,
  response: Response,
): Promise<Response> {
  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.set("content-length", String(new TextEncoder().encode(body).length));
  // Hono reads only `.status`/`.headers` from the second argument — a
  // bodyless Response is the type-clean carrier for the finalized init.
  return c.newResponse(body, new Response(null, { status: response.status, headers }));
}

/** Module-private sentinel: the owned admission signal aborted (never escapes). */
class McpAdmissionAbortedError extends Error {
  constructor() {
    super("MCP admission aborted");
    this.name = "McpAdmissionAbortedError";
  }
}

async function handleAdmittedRequest(
  c: McpHonoContext,
  deps: {
    options: CreateMcpRequestHandlerOptions;
    resourceUrl: string;
    issuerUrl: string;
    consumeIdentityQuota: (sub: string, clientId: string) => Promise<McpQuotaResult>;
    now: () => Date;
    /** The owned admission signal — fences every stage of this sequence. */
    signal: AbortSignal;
  },
): Promise<Response> {
  const { options, resourceUrl, issuerUrl, consumeIdentityQuota, now, signal } = deps;
  // Canonical-authority boundary (security invariant 2, F1): validate the
  // RAW request authority BEFORE the upstream verifier sees anything, then
  // hand the verifier the CANONICAL CLONE (scheme+host from
  // BETTER_AUTH_URL, original method/path/query/body/abort signal, safe
  // header set). This closes both probed escapes: a hostile Host/Origin
  // can no longer reach verification at all, and DPoP `htu` is derived
  // from the CONFIGURED public origin — a valid HTTPS-bound proof arrives
  // intact even when the socket between the TLS terminator and this
  // process is plain HTTP (and local HTTP dev stays HTTP, because the
  // configured origin is http://localhost there). Runs AFTER the feature
  // gate / method gate / IP limiter / body cap in the mounted chain, so
  // flag-off 404 and 405-before-auth semantics are unchanged.
  let canonicalRequest: Request;
  try {
    // OWNED SIGNAL (F8 piece 4): the clone carries the permit controller's
    // signal, not the raw client signal — the transport factory's fence and
    // the SDK's closed-flag check at fetch entry observe it. Body reads of
    // the clone are NOT cancellable through this signal (the installed
    // chain drops it); the factory fence and the DB-seam fence are the
    // enforcement.
    canonicalRequest = cloneRequestOntoPublicOrigin(c.req.raw, { signal });
  } catch (error) {
    if (error instanceof PublicRequestError) {
      // Static 400, reason to the sanitized log only (never disclosed to
      // the caller — probing feedback is not owed).
      mcpSanitizedLog(`rejected: untrusted request authority (${error.reason})`, {
        requestId: c.get("requestId"),
      });
      return finalizeMcpEarlyExitResponse(c, mcpInvalidRequestResponse());
    }
    throw error;
  }

  const presented = extractPresentedCredential(canonicalRequest.headers.get("authorization"));
  const isPersonalToken =
    presented?.scheme === "Bearer" && isMcpPersonalTokenSecret(presented.token);

  // Built per request (a cheap closure) so the request ID threads into the
  // admission sequence's error responses and sanitized logs.
  const wrapped = requireMcpAuth(
    options.authInstance,
    (request, accessTokenClaims) =>
      handleVerifiedRequest({
        request,
        claims: accessTokenClaims,
        requestId: c.get("requestId"),
        options,
        resourceUrl,
        consumeIdentityQuota,
        now,
        signal,
      }),
    {
      issuer: issuerUrl,
      resource: resourceUrl,
      requiredScopes: ["mcp:read"],
      isScopeSatisfied: mcpReadBaselineMatcher,
    },
  );
  try {
    let response: Response;
    if (isPersonalToken && presented) {
      const authenticatePersonalToken =
        options.authenticatePersonalToken ?? authenticateMcpPersonalToken;
      let identity: McpPersonalTokenIdentity | null;
      try {
        identity = await authenticatePersonalToken(presented.token, now());
      } catch (error) {
        mcpSanitizedLog(
          `personal token lookup failed (${
            error instanceof Error ? error.constructor.name : typeof error
          })`,
          { requestId: c.get("requestId") },
        );
        return finalizeMcpEarlyExitResponse(
          c,
          mcpInternalErrorResponse({ requestId: c.get("requestId") }),
        );
      }
      if (signal.aborted) return mcpRequestAbortedResponse();
      if (identity === null) {
        return finalizeMcpEarlyExitResponse(
          c,
          mcpUnauthorizedResponse({
            description: "Invalid MCP personal token",
            resourceUrl,
          }),
        );
      }
      response = await handleVerifiedRequest({
        request: canonicalRequest,
        claims: {
          sub: identity.userId,
          client_id: mcpPatClientId(identity.id),
          scope: identity.scopes.join(" "),
          [MCP_GRANT_ID_CLAIM]: identity.grantId,
          ...(identity.expiresAt ? { exp: Math.floor(identity.expiresAt.getTime() / 1000) } : {}),
        },
        requestId: c.get("requestId"),
        options,
        resourceUrl,
        consumeIdentityQuota,
        now,
        signal,
      });
    } else {
      response = await wrapped(canonicalRequest);
    }
    // Fence after the verifier/factory/dispatch await (F8): an abort that
    // landed mid-exchange skips response augmentation entirely.
    if (signal.aborted) return mcpRequestAbortedResponse();
    // F9: the installed SDK CATCHES factory/dispatch failures internally
    // and RETURNS its own HTTP 500 JSON-RPC -32603 ("Internal server
    // error") — the catch below only sees THROWN errors, so without this
    // step the correlation request ID is absent from those bodies (the
    // SDK's onerror hook receives only the Error, never the request).
    // Augmentation is defensive: malformed/non-JSON 5xx bodies pass
    // through unchanged.
    const correlated = await augmentSdkInternalErrorRequestId(response, c.get("requestId"));
    // CANCELLATION FENCE AFTER THE AUGMENTATION AWAIT (F10 pass 5): the
    // augmentation itself awaits a body read; an abort that landed DURING
    // that await must finalize the ABORT response, never the losing 500 —
    // the losing continuation's c.newResponse merge below would otherwise
    // publish the 500's headers (including its Content-Length) onto the
    // shared prepared headers after the 499 already won.
    if (signal.aborted) return await finalizeMcpEarlyExitResponse(c, mcpRequestAbortedResponse());
    // Merge through Hono (c.newResponse) so headers set by EARLIER
    // middleware on the chain (the mcp:ip: limiter's X-RateLimit-* set)
    // survive the raw upstream Response — returning it directly would
    // bypass Hono's header finalization.
    if (!correlated.headers.has("content-length")) {
      // Framing hygiene (F10 pass 5): if this response does not carry its
      // own length, drop any length a LOSING continuation's merge may have
      // left on the context's prepared headers — a stale length would
      // mis-frame this body (the Node adapter preserves supplied lengths;
      // an absent length means correct chunked framing).
      c.header("content-length", undefined);
    }
    return c.newResponse(correlated.body, correlated);
  } catch (error) {
    // Unexpected failure — generic internal error, sanitized log line
    // (constructor name only; Prisma/better-auth messages carry SQL and
    // credential material). NEVER rethrow into app.onError's generic 500:
    // MCP clients must receive the JSON-RPC error grammar. Finalized
    // through finalizeMcpEarlyExitResponse like every other early exit
    // (F6/F10) so the already-consumed IP-quota headers survive this exit
    // AND the framing can never inherit another body's length.
    mcpSanitizedLog(
      `internal error (${error instanceof Error ? error.constructor.name : typeof error})`,
      { requestId: c.get("requestId") },
    );
    return finalizeMcpEarlyExitResponse(
      c,
      mcpInternalErrorResponse({ requestId: c.get("requestId") }),
    );
  }
}

/**
 * F9/F10: stamp the correlation request ID onto an SDK-handled
 * internal-error response. The installed `createMcpHandler` catch path
 * returns `{jsonrpc: "2.0", error: {code: -32603, message: "Internal server
 * error"}, id: …}` with HTTP 500 — the application catch never fires for
 * those, and the SDK's configured `onerror(error)` hook receives no request
 * context, so this is the one place the Hono request ID can be attached.
 * Preserves any existing `error.data` fields; the sanitized correlation log
 * line (request ID only) fires exactly when augmentation happens.
 *
 * BYTE-EXACT CONTRACT (F10 pass 4): the body is probed on a CLONE via
 * `arrayBuffer()` + strict UTF-8 decoding (`TextDecoder(fatal: true)`) +
 * `JSON.parse`. On ANY failure (read error, invalid UTF-8, parse error,
 * non-object, non-JSON-RPC shape, non-object error.code) the ORIGINAL
 * Response object is returned COMPLETELY UNTOUCHED — byte-identical body,
 * original headers (a `response.text()`-based rebuild would launder
 * malformed UTF-8 into replacement characters and drop BOMs). On success
 * the rebuilt response sets `Content-Length` EXPLICITLY to the augmented
 * body's byte length — the Node adapter preserves an existing (now stale)
 * length, so nothing downstream would fix it otherwise.
 */
async function augmentSdkInternalErrorRequestId(
  response: Response,
  requestId: string,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return response;
  // Decide on a CLONE so every pass-through path can return the ORIGINAL
  // Response object with its body stream undisturbed and byte-identical.
  let bytes: ArrayBuffer;
  try {
    bytes = await response.clone().arrayBuffer();
  } catch {
    return response;
  }
  // BOM-carrying bodies pass through UNTOUCHED: strict decoding PRESERVES a
  // leading BOM (U+FEFF) and V8's JSON.parse ACCEPTS it — rebuilding would
  // silently drop the BOM from the representation. No installed SDK
  // producer emits one; byte preservation wins over augmentation here.
  const byteOctets = bytes.byteLength >= 3 ? new Uint8Array(bytes.slice(0, 3)) : null;
  if (
    byteOctets !== null &&
    byteOctets[0] === 0xef &&
    byteOctets[1] === 0xbb &&
    byteOctets[2] === 0xbf
  ) {
    return response;
  }
  let text: string;
  try {
    // Strict decode: invalid UTF-8 (which a text()-based rebuild would
    // silently replace with U+FFFD) must fail into the untouched
    // pass-through path.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return response;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return response;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return response;
  }
  const body = parsed as { jsonrpc?: unknown; error?: unknown };
  if (body.jsonrpc !== "2.0" || body.error === null || typeof body.error !== "object") {
    return response;
  }
  const error = body.error as { code?: unknown; data?: unknown };
  if (typeof error.code !== "number") {
    return response;
  }
  const existingData: Record<string, unknown> =
    error.data !== null && typeof error.data === "object" && !Array.isArray(error.data)
      ? { ...(error.data as Record<string, unknown>) }
      : {};
  error.data = { ...existingData, requestId };
  mcpSanitizedLog("sdk internal error response", { requestId });
  const augmented = JSON.stringify(body);
  const headers = new Headers(response.headers);
  // The augmented body's exact byte length — never the stale original.
  headers.set("content-length", String(augmentedByteLength(augmented)));
  return new Response(augmented, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Byte length of the rebuilt augmentation body (UTF-8, edge-neutral). */
function augmentedByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function handleVerifiedRequest({
  request,
  claims,
  requestId,
  options,
  resourceUrl,
  consumeIdentityQuota,
  now,
  signal,
}: {
  request: Request;
  claims: Record<string, unknown>;
  requestId: string;
  options: CreateMcpRequestHandlerOptions;
  resourceUrl: string;
  consumeIdentityQuota: (sub: string, clientId: string) => Promise<McpQuotaResult>;
  now: () => Date;
  /** Owned admission signal — every stage below is fenced on it (F8). */
  signal: AbortSignal;
}): Promise<Response> {
  // STAGE FENCES (F8 piece 2): after EVERY awaited stage, an aborted signal
  // stops the sequence HERE — the next stage (especially the user lookup,
  // the quota, the verified seam, and the transport fetch/factory) is never
  // STARTED. The route-level abort race settles the handler promptly; these
  // fences are the guarantee that the abandoned continuation stops.
  if (signal.aborted) return mcpRequestAbortedResponse();
  // 1. Nonempty string sub + client_id (verified payload, but shape is ours).
  const sub = claims.sub;
  const clientId = claims.client_id;
  if (typeof sub !== "string" || sub.length === 0) {
    return mcpUnauthorizedResponse({
      description: "Token subject is missing or malformed",
      resourceUrl,
    });
  }
  if (typeof clientId !== "string" || clientId.length === 0) {
    return mcpUnauthorizedResponse({
      description: "Token client_id is missing or malformed",
      resourceUrl,
    });
  }

  // 2. Scope claim parsed + deduped (shared pure parser).
  const scopes = parseMcpScopes(
    typeof claims.scope === "string" || Array.isArray(claims.scope) ? claims.scope : null,
  );

  // 3. The actually-presented credential (upstream verified it; we carry it).
  const credential = extractPresentedCredential(request.headers.get("authorization"));
  if (credential === null) {
    return mcpUnauthorizedResponse({
      description: "Missing presented access credential",
      resourceUrl,
    });
  }

  // 5. Exact live grant: nonempty private claim, exact (id, sub, client_id)
  // row, active (revokedAt null) — BEFORE any tool runs.
  const grantIdClaim = claims[MCP_GRANT_ID_CLAIM];
  if (typeof grantIdClaim !== "string" || grantIdClaim.length === 0) {
    mcpSanitizedLog("rejected: missing mcp_grant_id claim", { sub, clientId });
    return mcpUnauthorizedResponse({
      description: "Token carries no MCP grant binding",
      resourceUrl,
    });
  }
  let grant: Awaited<ReturnType<typeof loadMcpGrant>>;
  try {
    grant = await loadMcpGrant(options.prisma, grantIdClaim);
  } catch (error) {
    mcpSanitizedLog(
      `grant lookup failed (${error instanceof Error ? error.constructor.name : typeof error})`,
      { sub, clientId },
    );
    return mcpInternalErrorResponse({ requestId });
  }
  if (signal.aborted) return mcpRequestAbortedResponse();
  if (
    grant === null ||
    grant.userId !== sub ||
    grant.clientId !== clientId ||
    grant.revokedAt !== null
  ) {
    // Ownership-hiding generic 403, no challenge: a NEW grant generation
    // CAN restore access after revocation (re-authorization is not
    // useless), but a scope challenge would misrepresent this denial as a
    // step-up problem and leak that a specific grant ever existed. The
    // denial reason is not disclosed.
    mcpSanitizedLog("rejected: grant missing, mismatched, or revoked", { sub, clientId });
    return mcpForbiddenResponse();
  }

  // 6-7. Live user: missing → 401; active ban → 403; forced 2FA not set up → 403.
  // FULL Prisma user row (invariant 5): the synthetic oRPC context must
  // satisfy the production `Session["user"]` shape — no projection.
  let user: McpSessionUser | null;
  try {
    user = await options.prisma.user.findUnique({ where: { id: sub } });
  } catch (error) {
    mcpSanitizedLog(
      `user lookup failed (${error instanceof Error ? error.constructor.name : typeof error})`,
      { sub, clientId },
    );
    return mcpInternalErrorResponse({ requestId });
  }
  if (signal.aborted) return mcpRequestAbortedResponse();
  if (user === null) {
    mcpSanitizedLog("rejected: user not found", { sub, clientId });
    return mcpUnauthorizedResponse({
      description: "Token subject no longer exists",
      resourceUrl,
    });
  }
  if (isUserBanned(user, now())) {
    mcpSanitizedLog("rejected: user banned", { sub, clientId });
    return mcpForbiddenResponse();
  }
  let forceTwoFactor = false;
  try {
    forceTwoFactor = await options.isForceTwoFactorRequired();
  } catch (error) {
    mcpSanitizedLog(
      `force-2fa policy lookup failed (${
        error instanceof Error ? error.constructor.name : typeof error
      })`,
      { sub, clientId },
    );
    return mcpInternalErrorResponse({ requestId });
  }
  if (signal.aborted) return mcpRequestAbortedResponse();
  if (forceTwoFactor && user.twoFactorEnabled !== true) {
    mcpSanitizedLog("rejected: two-factor setup required", { sub, clientId });
    return mcpForbiddenResponse();
  }

  // Identity quota: keyed by VERIFIED (sub, client_id) only (Phase 3 limiter).
  let quota: McpQuotaResult;
  try {
    quota = await consumeIdentityQuota(sub, clientId);
  } catch (error) {
    mcpSanitizedLog(
      `identity quota failed (${error instanceof Error ? error.constructor.name : typeof error})`,
      { sub, clientId },
    );
    return mcpInternalErrorResponse({ requestId });
  }
  if (!quota.ok) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests" },
        id: null,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(quota.retryAfterSeconds),
        },
      },
    );
  }
  // Final fence: once the signal is aborted, the verified seam and the
  // transport fetch (factory!) are never entered.
  if (signal.aborted) return mcpRequestAbortedResponse();

  // 4 + 8 + 9. AuthInfo from the VERIFIED payload; synthetic oRPC context
  // (never contains the access token); pass AuthInfo to the handler request
  // context.
  const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
  const authInfo: AuthInfo = {
    token: credential.token,
    clientId,
    scopes,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    resource: new URL(resourceUrl),
    extra: { ...claims },
  };
  const orpcContext = createMcpContext({
    user,
    expiresAt: new Date((expiresAt ?? Math.floor(now().getTime() / 1000) + 60) * 1000),
    now: now(),
    // G1: thread the request's OWNED admission signal into the services so
    // procedures with external side effects (the credential test's HTTPS
    // probe) can refuse to START work once the caller aborted. The signal
    // is the permit controller's own — never the presented token.
    services: { ...options.services, signal },
  });

  // Verified-request seam (Phase 5): the tool dispatch binding consumes the
  // oRPC context here (app.ts wires bindMcpToolDispatch — one router client
  // per request is created from it when the transport factory registers
  // tools). The synthetic session NEVER carries the access token (pinned by
  // tests).
  options.onVerified?.({ authInfo, orpcContext, requestId, signal });

  return options.transport.fetch(request, { authInfo });
}
