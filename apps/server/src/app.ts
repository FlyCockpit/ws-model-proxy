import { createHash } from "node:crypto";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createContext } from "@ws-model-proxy/api/context";
import { appRouter } from "@ws-model-proxy/api/routers/index";
import type { Session } from "@ws-model-proxy/auth";
import { auth as defaultAuth } from "@ws-model-proxy/auth";
import { armAuthDbShutdownFence } from "@ws-model-proxy/auth/auth-db-shutdown-fence";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { THEME_INIT_SCRIPT } from "@ws-model-proxy/config/theme-init";
import prismaDefault from "@ws-model-proxy/db";
import { env as defaultEnv } from "@ws-model-proxy/env/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { betterAuthAdminGate } from "./better-auth-admin-gate.js";
import { CORS_ALLOW_HEADERS } from "./cors-headers.js";
import { deviceAdminGate } from "./device-admin-gate.js";
import {
  EMAIL_RECIPIENT_PATHS,
  emailRecipientLimit,
  SIGNUP_MEDIA_TYPES,
  SIGNUP_RECIPIENT_PATH,
} from "./email-recipient-limit.js";
import { createMcpAdmissionGate } from "./mcp/admission.js";
import { createMcpRequestHandler, type McpAuthInstance } from "./mcp/auth.js";
import { createMcpTransport } from "./mcp/handler.js";
import { bindMcpToolDispatch } from "./mcp/tool-dispatch.js";
import { mcpAuthorizeScopeGuard } from "./mcp-authorize-scope-guard.js";
import { createMcpDiscoveryForwarder, MCP_WELL_KNOWN_PATHS } from "./mcp-discovery.js";
import {
  MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES,
  MCP_OAUTH_CONSENT_MAX_BODY_BYTES,
  MCP_OAUTH_TOKEN_MAX_BODY_BYTES,
  mcpOauthBodyCap,
  mcpOauthRateLimits,
} from "./mcp-oauth-rate-limit.js";
import {
  isMcpOauthRateLimitedRequest,
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_CONSENT_PATH,
  MCP_OAUTH_CONTINUE_PATH,
  MCP_OAUTH_TOKEN_PATH,
  onMcpOauthRoute,
} from "./mcp-oauth-route-match.js";
import {
  createMcpFeatureGate,
  MCP_ENDPOINT_PATH,
  mcpBodyCap,
  mcpIpKey,
  mcpIpLimiter,
  mcpMethodGate,
} from "./mcp-rate-limit.js";
import { createMcpWebPageGate } from "./mcp-web-page-gate.js";
import { mediaAdminGate } from "./media/admin-gate.js";
import { createSameOriginGuard } from "./media/csrf-guard.js";
import {
  createMediaAdminDeleteAllHandler,
  createMediaAdminPurgeExpiredHandler,
  createMediaAdminStatsHandler,
  createMediaConfigHandler,
  createMediaGetHandler,
  createMediaSignHandler,
  createMediaUploadHandler,
} from "./media/routes.js";
import { createProductionCapacityRuntime } from "./model-api/capacity/production-runtime.js";
import { createChatTestRoutes } from "./model-api/chat-test.js";
import {
  createModelApiFileGetHandler,
  createModelApiFileUploadHandler,
} from "./model-api/files.js";
import { MODEL_API_MAX_REQUEST_BODY_BYTES } from "./model-api/limits.js";
import { openAiErrorBody } from "./model-api/openai-errors.js";
import { createPoolMemberTestRoutes } from "./model-api/pool-member-test.js";
import { repairExpiredProviderBudgets } from "./model-api/provider-budget.js";
import { createModelApiRoutes } from "./model-api/routes.js";
import { transcriptionContentLengthGuard } from "./model-api/transcription-body-guard.js";
import { logOrpcError } from "./orpc-error-log.js";
import {
  authLimiter,
  createRateLimiterMiddleware,
  emailRecipientLimiter,
  rpcLimiter,
  signupLimiter,
  signupRecipientLimiter,
} from "./rate-limit.js";
import { createRelayWebsocketMiddleware, relayUpgradeHandler } from "./relay/websocket.js";
import {
  authRouteLogPath,
  isAuthRoutePath,
  oauthRequestLogLine,
  stripsOAuthQuery,
} from "./request-log-redaction.js";
import { createRpcBatchHandlerPlugin } from "./rpc-batch-plugin.js";
import { mountSecurityHeaders } from "./security-headers.js";
import { registerSeoRoutes } from "./seo.js";
import { sessionMiddleware } from "./session-middleware.js";
import { signupAccessGate } from "./signup-access-gate.js";
import { getOrSetSsrCache } from "./ssr-cache.js";
import { unhandledErrorLogArgs } from "./unhandled-error-log.js";

/**
 * Testable app factory (Part E pass 3, ledger L24; contract narrowed pass 4, L25).
 *
 * This module owns the ENTIRE Hono app construction — middleware order,
 * route registration, onError, the oRPC handlers, and the production
 * static/SSR mounts — extracted VERBATIM from the former module-scope
 * construction in index.ts. index.ts keeps only dependency construction
 * (env validation, prisma, auth), the startup guards, the createApp call,
 * listen, and signal/graceful-shutdown wiring.
 *
 * NARROWED ENV CONTRACT (L25): the factory reads the SHARED validated env
 * from `@ws-model-proxy/env/server` for everything — exactly like the
 * imported consumers it mounts (the authorize guard, the general and MCP
 * OAuth limiters, the alias gates). It does NOT accept per-construction
 * env overrides: a per-construction override could only reach the
 * factory-local reads while the import-time consumers (limiter buckets)
 * and request-time readers (the guard) kept reading the shared module env,
 * producing internally contradictory configurations. Tests that need a
 * specific env shape must `vi.mock("@ws-model-proxy/env/server", ...)` with
 * hoisted values — the established suite pattern — so every consumer in
 * the mounted app consults the SAME env source (pinned by the
 * configuration-consistency tests in app-order.test.ts).
 *
 * The registration ORDER here is load-bearing (see the block comments):
 * the MCP discovery alias gates must sit between the request-ID/log wrapper
 * and the CORS/body-limit middleware so they own every method on their
 * reserved paths. The contract tests in app-order.test.ts mount the REAL
 * output of this factory (never a hand-built fixture chain) so a reorder
 * inside this function FAILS those tests (mutation-verified).
 */

type AppVariables = {
  requestId: string;
  session: Session | null;
  relayIdentity: import("@ws-model-proxy/api/lib/cli-credential-access").CliWebsocketIdentity;
};

/** The auth dependency shape consumed by the app: only `handler` is used. */
type AuthHandler = Pick<typeof defaultAuth, "handler">;

export interface CreateAppOptions {
  /**
   * Prisma client used by /ready. Defaults to the shared module client.
   * (There is deliberately NO env option — see the NARROWED ENV CONTRACT in
   * the module header: the factory reads the shared validated env from
   * `@ws-model-proxy/env/server`, the same source every mounted consumer
   * reads; per-construction overrides cannot reach those consumers.)
   */
  prisma?: typeof prismaDefault;
  /**
   * Better Auth instance (or any handler-compatible object) that serves the
   * /api/auth/* routes and receives the MCP discovery alias forwards.
   * Tests inject a memory-adapter instance; production uses the shared one.
   */
  auth?: AuthHandler;
  /**
   * Better Auth instance used for MCP token verification (upstream
   * `requireMcpAuth` needs `$context` for the DPoP replay store). Defaults
   * to the shared real instance; tests inject the memory-adapter parity
   * instance. Distinct from `auth` (only `.handler` is used there) so the
   * /api/auth surface keeps its narrow contract.
   */
  mcpAuth?: McpAuthInstance;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build the complete Hono app. Async because the production branch
 * dynamically imports the static file server and the TanStack Start SSR
 * bundle (which only exists after apps/web builds). Returns the app, the
 * production capacity lifecycle (closed on graceful shutdown), the
 * module-lifetime MCP transport, and the /mcp admission gate (both closed
 * by the shutdown sequence after the HTTP drain).
 */
export async function createApp(options: CreateAppOptions = {}) {
  // Shared validated env — the SAME module-level source every mounted
  // consumer reads (guard, limiters, alias gates). Never overridden here
  // (L25 narrowed contract; see module header).
  const env = defaultEnv;
  const prisma = options.prisma ?? prismaDefault;
  const auth = options.auth ?? defaultAuth;

  const app = new Hono<{ Variables: AppVariables }>();

  // Signed media fetch (HMAC-only, unauthenticated by design). Registered BEFORE
  // the global secure-headers middleware so this route fully owns its response
  // headers: a raw user blob must be served with `Content-Security-Policy:
  // sandbox` + `Cross-Origin-Resource-Policy: same-origin` + `nosniff`, not the
  // app's script/style CSP. A returning handler short-circuits the middleware
  // chain, so secureHeaders never overwrites these. See media/routes.ts.
  app.get("/media/:id", createMediaGetHandler());

  // Secure-headers — sets a battery of security headers (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, etc.) on every response, plus
  // the raw-asset `sandbox` CSP override. Ordering between the two is load-bearing and
  // lives in mountSecurityHeaders (see its doc comment + security-headers.test.ts).
  // CSP: tighten per route if third-party scripts/analytics are needed.
  const cspConnectSrc = ["'self'", ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [])];

  // CSP hash authorizing the inlined anti-FOUC theme bootstrap (THEME_INIT_SCRIPT,
  // injected into <head> by apps/web/src/routes/__root.tsx). Computed from the
  // shared string at startup, so it can never drift from the inlined content. An
  // inline script needs a nonce or hash to run under `script-src 'self' 'nonce-…'`;
  // this static bootstrap can't carry a per-request nonce, so it uses a hash.
  const themeInitCspHash = `'sha256-${createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64")}'`;
  mountSecurityHeaders(app, { cspConnectSrc, themeInitCspHash });

  // Harness-facing media upload (bearer model-token auth — the SAME auth posture
  // as the rest of /v1: no cookies, no CSRF, no browser CORS). Mounted with its
  // OWN body limit of MEDIA_MAX_UPLOAD_BYTES and registered BEFORE the generic
  // /v1/* limiter below so the upload path gets the media cap; the returning
  // handler short-circuits, so the /v1/* 32 MB limiter never runs for these exact
  // paths. Mirrors the /api/internal/media pattern (own limit ahead of the global
  // limiter). GET /v1/files/:id (no body) is the re-sign path and rides along
  // under the same registration so it, too, precedes the catch-all in
  // createModelApiRoutes. Oversize returns the same request_too_large shape as the
  // /v1 body limit below.
  app.use(
    "/v1/files",
    bodyLimit({
      maxSize: env.MEDIA_MAX_UPLOAD_BYTES,
      onError: () =>
        new Response(
          JSON.stringify(
            openAiErrorBody({
              message: "Model API request body is too large.",
              type: "invalid_request_error",
              code: "request_too_large",
            }),
          ),
          {
            status: 413,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        ),
    }),
  );
  app.post("/v1/files", createModelApiFileUploadHandler());
  app.get("/v1/files/:id", createModelApiFileGetHandler());

  // OpenAI-compatible model API routes. These are public server-to-server
  // bearer-token routes: no cookie session auth, no CSRF, and no browser CORS in
  // v1. The limit is intentionally larger than the browser/RPC default because
  // OpenAI-compatible image requests can carry base64 JSON payloads.
  for (const transcriptionPath of ["/v1/audio/transcriptions", "/v1/audio/translations"] as const) {
    app.use(
      transcriptionPath,
      transcriptionContentLengthGuard(env.MODEL_API_TRANSCRIPTION_MAX_MULTIPART_BYTES),
    );
  }
  const generalModelApiBodyLimit = bodyLimit({
    maxSize: MODEL_API_MAX_REQUEST_BODY_BYTES,
    onError: () =>
      new Response(
        JSON.stringify(
          openAiErrorBody({
            message: "Model API request body is too large.",
            type: "invalid_request_error",
            code: "request_too_large",
          }),
        ),
        {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
  });
  app.use("/v1/*", (c, next) => {
    if (c.req.path === "/v1/audio/transcriptions" || c.req.path === "/v1/audio/translations") {
      return next();
    }
    return generalModelApiBodyLimit(c, next);
  });
  const capacityLifecycle = env.MODEL_API_GLOBAL_CAPACITY_ENABLED
    ? createProductionCapacityRuntime()
    : undefined;
  app.route(
    "/v1",
    createModelApiRoutes({
      capacityRuntime: capacityLifecycle?.runtime,
    }),
  );

  // Same-origin guard for the cookie-authenticated media MUTATION routes (upload,
  // sign, admin purge/delete). These plain Hono routes have no oRPC-style custom
  // header / CSRF-token check, so a cross-site multipart form POST could otherwise
  // ride the victim's cookies. The guard only acts on mutating methods, so the
  // GET config + signed GET /media routes are unaffected. Allowed origins are the
  // app's own origin and, on a split-origin deploy, the SPA origin (CORS_ORIGIN).
  const mediaCsrfGuard = createSameOriginGuard({
    allowedOrigins: [
      new URL(env.BETTER_AUTH_URL).origin,
      ...(env.CORS_ORIGIN ? [new URL(env.CORS_ORIGIN).origin] : []),
    ],
  });

  // Ephemeral media upload (session-authenticated). Mounted with its OWN body
  // limit of MEDIA_MAX_UPLOAD_BYTES and registered BEFORE the global 10 MB
  // limiter below, mirroring the /v1 pattern: the POST handler returns, so the
  // global limiter never runs for this exact path. `/api/internal/media` (no
  // trailing `/*`) matches only the upload endpoint — `/api/internal/media/sign`
  // is a JSON route that stays under the global limit.
  app.use("/api/internal/media", sessionMiddleware);
  app.use("/api/internal/media", createRateLimiterMiddleware(rpcLimiter));
  app.use("/api/internal/media", mediaCsrfGuard);
  app.use(
    "/api/internal/media",
    bodyLimit({
      maxSize: env.MEDIA_MAX_UPLOAD_BYTES,
      onError: (c) =>
        c.json({ error: "Upload is too large.", maxBytes: env.MEDIA_MAX_UPLOAD_BYTES }, 413),
    }),
  );
  app.post("/api/internal/media", createMediaUploadHandler());

  // Request-ID — attach a short random ID to every request for log correlation.
  // The ID is stored in `c.var.requestId` and included in the logger output.
  // (Registered BEFORE the global body limiter below so oversized-request
  // rejections are logged with a correlation ID too; the MCP discovery alias
  // gates must sit between this middleware and the body limiter.)
  app.use("/*", async (c, next) => {
    const id = crypto.randomUUID().slice(0, 8);
    c.set("requestId", id);
    await next();
  });

  // Logger — custom print function that prepends the request ID for correlation.
  // Better Auth route paths can carry LIVE credentials in deeper path segments
  // and queries (`/api/auth/reset-password/<token>`; oauth2 `state`/PKCE), so
  // EVERY `/api/auth` path logs a TRUNCATED pair of lines — first three path
  // segments only, query dropped, incoming (`<--`) and outgoing (`-->`) — via
  // `authRouteLogPath`. The two MCP login/consent PAGES (signed OAuth query
  // carriers) keep the query-stripped outgoing line from `oauthRequestLogLine`.
  // Correlation uses the per-request requestId, never the URL. All other paths
  // keep the stock behavior.
  app.use("/*", async (c, next) => {
    const reqId = c.get("requestId") ?? "-";
    if (isAuthRoutePath(c.req.path)) {
      const logPath = authRouteLogPath(c.req.path);
      const start = Date.now();
      console.log(`[${reqId}] <-- ${c.req.method} ${logPath}`);
      await next();
      console.log(
        oauthRequestLogLine({
          requestId: reqId,
          method: c.req.method,
          path: logPath,
          status: c.res.status,
          elapsedMs: Date.now() - start,
        }),
      );
      return;
    }
    if (stripsOAuthQuery(c.req.path)) {
      const start = Date.now();
      await next();
      console.log(
        oauthRequestLogLine({
          requestId: reqId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          elapsedMs: Date.now() - start,
        }),
      );
      return;
    }
    const logFn = (message: string, ...rest: string[]) => {
      console.log(`[${reqId}] ${message}`, ...rest);
    };
    return logger(logFn)(c, next);
  });

  // MCP discovery aliases (Phase 3): mounted IMMEDIATELY after the request-ID +
  // request-log middleware and BEFORE every other request-terminating
  // middleware — CORS (which would answer OPTIONS with 204), the global 10 MB
  // body limiter (which would answer an oversized POST with 413), and
  // everything later — so the alias gates OWN EVERY METHOD on these four
  // paths: flag-off 404 for every method; flag-on 405 `Allow: GET, HEAD` for
  // every non-GET/HEAD (OPTIONS included); GET forwards VERBATIM to the Better
  // Auth handler (the installed 1.7.3 plugins serve all four natively — see
  // mcp-discovery.ts for the probe notes; the metadata responses depend on
  // nothing from later middleware, so forwarding in place is correct); HEAD
  // gets an explicit bodyless adapter. The paths stay RESERVED before static
  // assets and SSR (this mount is far ahead of both) even while the flag is
  // off, so a flag-off request can never fall through to the SPA/SSR
  // catch-all.
  for (const wellKnownPath of MCP_WELL_KNOWN_PATHS) {
    app.all(
      wellKnownPath,
      createMcpDiscoveryForwarder({
        enabled: env.WMP_MCP_ENABLED,
        handler: (request) => auth.handler(request),
      }),
    );
  }

  // MCP web login/consent pages (Phase 6): while WMP_MCP_ENABLED is off, the
  // valid-locale forms of /:lang/mcp-login and /:lang/mcp-consent return a
  // REAL 404 here — mounted in the SAME pre-CORS/pre-global-body-limit block
  // as the discovery aliases (the L23 ordering lesson: later blocks answer
  // OPTIONS with 204 and oversized POSTs with 413, so the gate must own every
  // method itself) and far ahead of the oRPC catch-all, static assets, and
  // SSR, so a flag-off request can never fall through to the SPA shell. The
  // gate matches EXACT raw pathnames of supported locales only
  // (mcp-web-page-gate.ts): near-miss locale forms keep the normal
  // redirect-to-default-locale handling. While enabled it is a pass-through;
  // the routes' own beforeLoad ALSO throws notFound() from the server-runtime
  // flag (apps/web/src/server/mcp-availability.ts), so both the HTTP and the
  // router boundary stay gated.
  app.use("/*", createMcpWebPageGate({ enabled: () => env.WMP_MCP_ENABLED === true }));

  // /mcp — the MCP JSON-RPC transport (Phase 4), mounted in the SAME
  // pre-CORS/pre-global-body-limit block as the discovery aliases so the
  // chain owns every method on its reserved path and an oversized body gets
  // the MCP 1 MB cap (never the global 10 MB answer). ORDER (pinned by the
  // chain-order tests; mirrors mcp-rate-limit.ts's documented sequence):
  //   1. feature gate — flag-off 404 for EVERY method (reserved path);
  //   2. method gate — 405 `Allow: POST` for non-POST BEFORE auth, so the
  //      method policy is visible without credentials;
  //   3. unconditional mcp:ip: limiter (PRE-auth, IP-keyed only);
  //   4. 1 MB request-body cap;
  //   5. requireMcpAuth + live user/ban/2FA checks (mcp/auth.ts);
  //      the mcp:identity: quota (verified sub+client_id) is consumed inside
  //      the authenticated handler, immediately after the claims are
  //      verified and BEFORE the transport runs;
  //   6. the MCP handler (fresh McpServer per request, SDK-owned teardown).
  // The ADMISSION GATE (F8) is created here and shared with the shutdown
  // sequence: every admitted /mcp exchange is owned from route entry until
  // its promise SETTLES (with stage fences on an owned abort signal —
  // covering the pre-factory body-parse window the SDK does not track);
  // close() aborts outstanding admitted controllers (bounded shutdown) and
  // new admissions get 503. The gate's closed flag also arms the transport
  // FACTORY FENCE (mcp/handler.ts) so no admitted request can create a
  // server, register tools, or touch the DB after shutdown began. The
  // gate's onClosed hook arms the AUTH DB-SEAM FENCE (F8 pass 5,
  // @ws-model-proxy/auth/auth-db-shutdown-fence): the installed
  // requireMcpAuth continuation chain drops the abort signal, so its stray
  // continuations (DPoP replay reservations through the auth instance's
  // internal adapter) would otherwise START database operations after gate
  // drain and the Prisma disconnect — from close() onward every NEW
  // better-auth adapter DB operation rejects immediately (transparent
  // while the gate is open; normal /api/auth traffic is gone by then —
  // HTTP drain and connection termination run first).
  // The gate's onClosed hook arms the DB-SEAM FENCE (Part G pass 2, G1:
  // @ws-model-proxy/db/shutdown-fence — the ONE shared Prisma client
  // packages/db exports is wrapped there at construction, so the fence
  // covers BOTH better-auth's adapter operations AND the direct procedure
  // and diagnostic calls the MCP tool dispatch makes; the Part F
  // armAuthDbShutdownFence import is a thin delegation to that single
  // arming seam): the installed requireMcpAuth continuation chain drops
  // the abort signal, and a tool continuation parked on an in-flight
  // procedure await can resume after the permit released — from close()
  // onward every NEW database operation through the shared client rejects
  // immediately (transparent while the gate is open; normal traffic is
  // gone by then — HTTP drain and connection termination run first).
  const mcpAdmissionGate = createMcpAdmissionGate({ onClosed: armAuthDbShutdownFence });
  const mcpHandler = createMcpTransport({ isShuttingDown: () => mcpAdmissionGate.closed });
  app.use(MCP_ENDPOINT_PATH, createMcpFeatureGate({ enabled: env.WMP_MCP_ENABLED }));
  app.use(MCP_ENDPOINT_PATH, mcpMethodGate);
  app.use(
    MCP_ENDPOINT_PATH,
    createRateLimiterMiddleware(mcpIpLimiter, { resolveKey: (c) => mcpIpKey(c) }),
  );
  app.use(MCP_ENDPOINT_PATH, mcpBodyCap);
  app.post(
    MCP_ENDPOINT_PATH,
    createMcpRequestHandler({
      authInstance: options.mcpAuth ?? defaultAuth,
      transport: mcpHandler,
      prisma,
      isForceTwoFactorRequired,
      admissionGate: mcpAdmissionGate,
      services: {
        repairExpiredProviderBudgets: (scope) => repairExpiredProviderBudgets(new Date(), scope),
      },
      // Phase 5 tool dispatch binding: after every admission check passes,
      // the verified AuthInfo (passed VERBATIM by the SDK into the transport
      // factory's request context) is bound to the per-request oRPC context,
      // the route request id, and the OWNED admission signal (G1: tool
      // dispatch races/fences procedure calls and diagnostic cores on it, so
      // a client abort or gate.close() tears down the tool's network work
      // and never STARTS the next pipeline stage), so the manifest tools
      // registered for THIS request resolve their router client
      // (mcp/tool-dispatch.ts).
      onVerified: ({ authInfo, orpcContext, requestId, signal }) =>
        bindMcpToolDispatch(authInfo, { orpcContext, requestId, signal }),
    }),
  );

  // Body-limit — reject oversized payloads early (before JSON parsing) to
  // prevent memory exhaustion. 10 MB covers image uploads and large form
  // payloads; individual routes can override with a tighter limit if needed.
  // (Runs AFTER the MCP discovery alias gates above, which own every method on
  // their reserved paths.)
  app.use(
    "/*",
    bodyLimit({
      maxSize: 10 * 1024 * 1024, // 10 MB
      onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
    }),
  );

  // Catch any uncaught error from a route/middleware so admins get a log
  // line + request context instead of an opaque 500 in the client. EVERY
  // path — including the pre-dispatch createContext failure in the catch-all
  // below and non-auth application routes — logs the SANITIZED line (error
  // constructor name only): better-auth/Prisma failures carry SQL messages
  // and raw stacks, which must never reach the logs on any path (see
  // unhandled-error-log.ts, pass-10 ruling).
  app.onError((err, c) => {
    console.error(
      ...unhandledErrorLogArgs(err, c.req.method, c.req.path, c.get("requestId") ?? "-"),
    );
    return c.json({ error: "Something didn't work on our end. Try again in a moment." }, 500);
  });

  // Shared oRPC error logger (sanitized — see orpc-error-log.ts, pass 11):
  // skips expected client errors (4xx ORPCErrors), warns transient 5xx,
  // logs ORPCError message+ctor only (no stack) and unknown-Error ctor
  // names only (no message/stack — Prisma messages embed SQL + params).
  // Installed on BOTH handlers below; these are HANDLED errors that never
  // reach app.onError, so this sink must sanitize itself (R37 finding 2).
  if (env.CORS_ORIGIN) {
    app.use(
      "/*",
      cors({
        origin: env.CORS_ORIGIN,
        allowMethods: ["GET", "POST", "OPTIONS"],
        // Adding a header the client sets? It must go in CORS_ALLOW_HEADERS or
        // the preflight fails and the request never leaves the browser — a
        // failure mode invisible in local dev. See cors-headers.ts.
        allowHeaders: [...CORS_ALLOW_HEADERS],
        credentials: true,
      }),
    );
  }

  // Liveness probe — answers whether this Node process can serve HTTP. Keep this
  // independent of external services so orchestrators do not restart healthy app
  // containers during a transient Postgres failover.
  app.get("/health", (c) => c.json({ ok: true }));

  // Readiness probe — checks dependencies for deploy gates and manual diagnosis.
  app.get("/ready", async (c) => {
    const checks = {
      postgres: false,
    };
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 3000, "postgres readiness check");
      checks.postgres = true;

      return c.json({ ok: true, checks });
    } catch {
      return c.json({ ok: false, checks }, 503);
    }
  });

  // SEO / discoverability: /robots.txt, /sitemap.xml, /llms.txt. Registered here
  // — before the static-asset middleware and the SSR catch-all below — so the
  // `/$lang/...` router never swallows them and returns the SPA HTML shell.
  registerSeoRoutes(app);

  app.use("/api/cli/ws", createRelayWebsocketMiddleware());
  app.get("/api/cli/ws", relayUpgradeHandler());

  // Signup kill-switch — reject email/password signup before it reaches
  // Better-Auth when runtime signup is disabled, except for the first account on
  // an empty instance. The auth database hook also enforces this and promotes
  // that first user to admin.
  app.use("/api/auth/sign-up/*", signupAccessGate);

  // Signup-specific rate limiter — stricter than the general auth limiter.
  // Must be mounted BEFORE the general authLimiter so signup traffic is throttled
  // at the tighter limit first.
  app.use("/api/auth/sign-up/*", createRateLimiterMiddleware(signupLimiter));

  // `get-session` is a benign, cookie-authenticated read that the SPA polls on
  // navigation/focus — many calls per minute under normal use. It must NOT be
  // subject to the strict credential-stuffing limiter below: at 10/60s with a
  // 15-minute block, normal polling locks legitimate users out, and because
  // sign-in/sign-up share the /api/auth/* bucket, it blocks those too (a fresh
  // user hits "Too many attempts" on their very first signup). Give it the
  // general RPC ceiling instead. Mounted BEFORE the strict limiter.
  app.use("/api/auth/get-session", createRateLimiterMiddleware(rpcLimiter));

  // MCP OAuth endpoint rate limits (Phase 3), mounted only while the MCP flag
  // is on: an EXACT raw-method+raw-path allowlist (authorize GET/POST, consent,
  // continue, token, revoke, public-client, public-client-prelogin, JWKS — see
  // mcp-oauth-route-match.ts, the ONE shared predicate also used by the
  // general-limiter exemption below) is EXEMPT from the strict authLimiter
  // below and handled by the MCP OAuth limiters instead (IP-keyed protocol
  // bucket; session-keyed consent/continue bucket with IP fallback).
  // Near-misses (wrong method, percent-encoded path spellings like
  // `/api/%61uth/...`, unlisted paths) keep the general limiter — better-call
  // routes on the RAW pathname, so those spellings are 404s downstream and
  // must not consume MCP buckets. Body caps run BEFORE the limiters so garbage
  // oversized requests burn no budget. The session middleware and the caps are
  // guarded by `onMcpOauthRoute` — Hono's path-only pattern matching would
  // otherwise run them for EVERY method on those paths and for decoded
  // percent-encoded spellings; they now fire on exactly POST consent, POST
  // continue, POST authorize, POST token. The session mount is the one
  // deliberate exception to "not mounted on /api/auth/*" — solely to resolve
  // the rate-limit key (its result is otherwise unused; Better Auth still does
  // its own session lookup). Flag-off: nothing below is mounted and the
  // exemption in the general limiter is not honored, so behavior is
  // byte-identical to pre-Phase-3.
  if (env.WMP_MCP_ENABLED) {
    app.use(
      MCP_OAUTH_CONSENT_PATH,
      onMcpOauthRoute("POST", MCP_OAUTH_CONSENT_PATH, sessionMiddleware),
    );
    app.use(
      MCP_OAUTH_CONTINUE_PATH,
      onMcpOauthRoute("POST", MCP_OAUTH_CONTINUE_PATH, sessionMiddleware),
    );
    app.use(
      MCP_OAUTH_AUTHORIZE_PATH,
      onMcpOauthRoute(
        "POST",
        MCP_OAUTH_AUTHORIZE_PATH,
        mcpOauthBodyCap(MCP_OAUTH_AUTHORIZE_MAX_BODY_BYTES),
      ),
    );
    app.use(
      MCP_OAUTH_TOKEN_PATH,
      onMcpOauthRoute(
        "POST",
        MCP_OAUTH_TOKEN_PATH,
        mcpOauthBodyCap(MCP_OAUTH_TOKEN_MAX_BODY_BYTES),
      ),
    );
    app.use(
      MCP_OAUTH_CONSENT_PATH,
      onMcpOauthRoute(
        "POST",
        MCP_OAUTH_CONSENT_PATH,
        mcpOauthBodyCap(MCP_OAUTH_CONSENT_MAX_BODY_BYTES),
      ),
    );
    app.use("/api/auth/*", mcpOauthRateLimits);
  }

  // Rate limit auth endpoints (credential-stuffing defense), EXCEPT get-session
  // (handled above) and the flag-on MCP OAuth allowlist (handled by the MCP
  // OAuth limiters above). Must be mounted BEFORE the auth handler so every auth
  // request is throttled.
  app.use("/api/auth/*", async (c, next) => {
    if (c.req.path.endsWith("/get-session")) return next();
    if (env.WMP_MCP_ENABLED && isMcpOauthRateLimitedRequest(c)) return next();
    return createRateLimiterMiddleware(authLimiter)(c, next);
  });

  // Per-recipient caps on anonymous endpoints that mail a caller-supplied
  // address. Mounted AFTER the IP-keyed auth limiter (security control); this
  // layer stops rotating-IP mail cannons. See email-recipient-limit.ts.
  for (const path of EMAIL_RECIPIENT_PATHS) {
    app.use(path, emailRecipientLimit(emailRecipientLimiter));
  }
  app.use(SIGNUP_RECIPIENT_PATH, emailRecipientLimit(signupRecipientLimiter, SIGNUP_MEDIA_TYPES));

  // Verified-admin gate for the deviceAuthorization plugin's approve/deny
  // endpoints. The plugin only checks "is this user signed in" — without this
  // guard a signed-in non-admin or unverified admin could call these endpoints
  // directly and approve a pending CLI device flow. See `device-admin-gate.ts`
  // for the shape of the rejection. Must be mounted BEFORE the auth handler.
  app.use("/api/auth/device/approve", deviceAdminGate);
  app.use("/api/auth/device/deny", deviceAdminGate);

  // Admin gate for Better-Auth's admin plugin endpoints. The plugin role-checks
  // by default, but these routes can set roles, reset passwords, impersonate
  // users, and remove users, so they must also honor this app's verified-admin
  // and forced-2FA policy before the Better Auth handler sees the request.
  app.use("/api/auth/admin/*", betterAuthAdminGate);

  // MCP authorization scope boundary (Phase 2): while WMP_MCP_ENABLED is on,
  // reject missing/blank `scope` on GET/form-POST /api/auth/oauth2/authorize
  // locally and non-redirecting (Better Auth 1.7 has no defaultScope); forward
  // every present scope unchanged so Better Auth validates client/redirect
  // before any redirected protocol error. Flag-off: untouched pass-through.
  // Mounted immediately before the auth handler.
  app.use("/api/auth/oauth2/authorize", mcpAuthorizeScopeGuard);

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/internal/chat-test/*", sessionMiddleware);
  // Same-origin guard as on the media mutators. Chat-test is less exposed (its
  // JSON body can't come from a cross-site HTML form without a preflight), but
  // uniform coverage keeps the cookie-auth mutation surface one policy. Cost:
  // cookie-bearing non-browser callers without an Origin header are rejected.
  app.use("/api/internal/chat-test/*", mediaCsrfGuard);
  app.use("/api/internal/chat-test/*", createRateLimiterMiddleware(rpcLimiter));
  app.route("/api/internal/chat-test", createChatTestRoutes());

  app.use("/api/internal/pools/*", sessionMiddleware);
  app.use("/api/internal/pools/*", mediaCsrfGuard);
  app.use("/api/internal/pools/*", createRateLimiterMiddleware(rpcLimiter));
  app.route("/api/internal/pools", createPoolMemberTestRoutes());

  // Mint fresh short-lived signed media URLs (session-authenticated, owner-
  // checked). Small JSON body, so it lives under the global 10 MB limit — no
  // dedicated body limit needed. The upload endpoint itself is mounted earlier
  // with its larger limit.
  app.use("/api/internal/media/sign", sessionMiddleware);
  app.use("/api/internal/media/sign", createRateLimiterMiddleware(rpcLimiter));
  app.use("/api/internal/media/sign", mediaCsrfGuard);
  app.post("/api/internal/media/sign", createMediaSignHandler());

  // Media capability discovery (session-authenticated). Small GET, no body, so it
  // stays under the global limit. Reports whether upload storage is configured
  // and the hard per-upload byte cap so the client can pick upload vs base64.
  app.use("/api/internal/media/config", sessionMiddleware);
  app.use("/api/internal/media/config", createRateLimiterMiddleware(rpcLimiter));
  app.get("/api/internal/media/config", createMediaConfigHandler());

  // Admin media policy surface (verified-admin only). Small JSON bodies, so these
  // stay under the global 10 MB limit. `sessionMiddleware` resolves the session
  // once (used by the rate limiter's uid keying AND the admin gate), then
  // `mediaAdminGate` enforces verified-admin + forced-2FA, returning 404 for
  // non-admins so the surface's existence isn't leaked. Metadata/policy only:
  // stats are aggregate counts, and purge/delete-all are audit-logged by count.
  app.use("/api/internal/media/admin/*", sessionMiddleware);
  app.use("/api/internal/media/admin/*", createRateLimiterMiddleware(rpcLimiter));
  app.use("/api/internal/media/admin/*", mediaCsrfGuard);
  app.use("/api/internal/media/admin/*", mediaAdminGate);
  app.get("/api/internal/media/admin/stats", createMediaAdminStatsHandler());
  app.post("/api/internal/media/admin/purge-expired", createMediaAdminPurgeExpiredHandler());
  app.post("/api/internal/media/admin/delete-all", createMediaAdminDeleteAllHandler());

  // Resolve the Better-Auth session once per request on paths that need it.
  // Mounted BEFORE the rate limiters so they can key on the user id without
  // each making their own getSession() call. Not mounted on /api/auth/*
  // (Better-Auth does its own lookup) or /health / SSR / dev-only routes.
  app.use("/rpc/*", sessionMiddleware);

  // Rate limit RPC endpoint — general API traffic.
  app.use("/rpc/*", createRateLimiterMiddleware(rpcLimiter));
  app.use("/api-reference/*", createRateLimiterMiddleware(rpcLimiter));

  // When CORS_ORIGIN is set (cross-origin deployment), validate the x-csrf-token
  // header sent by the client's SimpleCsrfProtectionLinkPlugin. Same-origin
  // deployments don't need this because browsers block cross-origin custom
  // headers at preflight anyway.
  const csrfPlugins = env.CORS_ORIGIN ? [new SimpleCsrfProtectionHandlerPlugin()] : [];

  const apiHandler = new OpenAPIHandler(appRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      }),
      ...csrfPlugins,
    ],
    interceptors: [onError(logOrpcError)],
  });

  // `maxSize` is an operation-count protocol contract shared with the client via
  // `@ws-model-proxy/config/rpc-policy`, not a request-body byte limit. Changing
  // it requires updating and passing the transport boundary tests.
  const rpcHandler = new RPCHandler(appRouter, {
    plugins: [createRpcBatchHandlerPlugin(), ...csrfPlugins],
    interceptors: [onError(logOrpcError)],
  });

  app.use("/*", async (c, next) => {
    const context = await createContext({
      context: c,
      services: {
        repairExpiredProviderBudgets: (scope) => repairExpiredProviderBudgets(new Date(), scope),
      },
    });

    const rpcResult = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context: context,
    });

    if (rpcResult.matched) {
      return c.newResponse(rpcResult.response.body, rpcResult.response);
    }

    const apiResult = await apiHandler.handle(c.req.raw, {
      prefix: "/api-reference",
      context: context,
    });

    if (apiResult.matched) {
      return c.newResponse(apiResult.response.body, apiResult.response);
    }

    await next();
  });

  if (env.NODE_ENV === "production") {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { dirname, join } = await import("node:path");

    // The built web assets live at apps/web/dist — a sibling of apps/server.
    // Resolve them from THIS module's location, not the process CWD: the bundle
    // runs as /app/apps/server/dist/index.mjs with CWD=/app, so a CWD- or
    // module-relative "../web/dist" lands in the wrong place. `serveStatic`
    // (CWD-relative) and dynamic import (module-relative) disagree on the base,
    // so we hand both an absolute path computed from import.meta.url.
    const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

    // Serve static client assets (JS, CSS, images)
    // Vite/rolldown content-hashes every file under /assets, so each URL is
    // immutable: a code change produces a new filename, never a new body at the
    // same URL. Safe to cache for a year. This middleware runs before the
    // serveStatic below (sets the header, then defers to it).
    // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
    // SSR shell — index.html and version.json must stay revalidated so new
    // deploys are picked up.
    app.use("/assets/*", async (c, next) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      await next();
    });
    app.use("/assets/*", serveStatic({ root: join(webDist, "client") }));
    app.use("/*", serveStatic({ root: join(webDist, "client") }));

    // Mount TanStack Start for SSR — handles all non-static requests. The bundle
    // is produced by `apps/web` at build time and doesn't exist when this file is
    // type-checked, so the specifier is computed at runtime (a non-literal import
    // is left external by rolldown automatically).
    const startHandlerUrl = pathToFileURL(join(webDist, "server/server.js")).href;
    const { default: startHandler } = await import(startHandlerUrl);
    app.all("/*", async (c) => {
      // Forward the per-request CSP nonce (from secureHeaders) to the SSR
      // renderer via a request header. getRouter() reads it server-side and sets
      // router.options.ssr.nonce, so TanStack Start stamps the matching nonce on
      // every inline script it injects — otherwise script-src would block them.
      const nonce = c.get("secureHeadersNonce");
      let request = c.req.raw;
      if (typeof nonce === "string") {
        const headers = new Headers(request.headers);
        headers.set("x-csp-nonce", nonce);
        request = new Request(request, { headers });
      }
      return getOrSetSsrCache(request, () => startHandler.fetch(request), { nonce });
    });
  } else {
    app.get("/", (c) => {
      return c.text("OK");
    });
  }

  return { app, capacityLifecycle, mcpHandler, mcpAdmissionGate };
}
