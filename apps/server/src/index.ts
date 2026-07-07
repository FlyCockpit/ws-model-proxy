import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createContext } from "@ws-model-proxy/api/context";
import { appRouter } from "@ws-model-proxy/api/routers/index";
import { auth, type Session } from "@ws-model-proxy/auth";
import { THEME_INIT_SCRIPT } from "@ws-model-proxy/config/theme-init";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { WebSocketServer } from "ws";
import { betterAuthAdminGate } from "./better-auth-admin-gate.js";
import { deviceAdminGate } from "./device-admin-gate.js";
import { createChatTestRoutes } from "./model-api/chat-test.js";
import { MODEL_API_MAX_REQUEST_BODY_BYTES } from "./model-api/limits.js";
import { openAiErrorBody } from "./model-api/openai-errors.js";
import { createModelApiRoutes } from "./model-api/routes.js";
import {
  authLimiter,
  createRateLimiterMiddleware,
  rpcLimiter,
  signupLimiter,
} from "./rate-limit.js";
import { RELAY_SUBPROTOCOL } from "./relay/protocol.js";
import { createRelayWebsocketMiddleware, relayUpgradeHandler } from "./relay/websocket.js";
import { mountSecurityHeaders } from "./security-headers.js";
import { registerSeoRoutes } from "./seo.js";
import { sessionMiddleware } from "./session-middleware.js";
import { signupAccessGate } from "./signup-access-gate.js";

// ---------------------------------------------------------------------------
// Startup guards
// ---------------------------------------------------------------------------

// Reject wildcard CORS origin — it disables credential support and effectively
// opens the API to any website. Fail hard at startup so the misconfiguration
// is caught immediately in staging/CI, not silently in production.
if (env.CORS_ORIGIN === "*") {
  console.error(
    "[server] FATAL: CORS_ORIGIN must not be '*'. Set it to the exact origin of your frontend (e.g. https://app.example.com).",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------

type AppVariables = {
  requestId: string;
  session: Session | null;
  relayIdentity: import("@ws-model-proxy/api/lib/cli-credential-access").CliWebsocketIdentity;
};

const app = new Hono<{ Variables: AppVariables }>();

// Secure-headers — sets a battery of security headers (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc.) on every response, plus the
// raw-asset `sandbox` CSP override. Ordering between the two is load-bearing and
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

// OpenAI-compatible model API routes. These are public server-to-server
// bearer-token routes: no cookie session auth, no CSRF, and no browser CORS in
// v1. The limit is intentionally larger than the browser/RPC default because
// OpenAI-compatible image requests can carry base64 JSON payloads.
app.use(
  "/v1/*",
  bodyLimit({
    maxSize: MODEL_API_MAX_REQUEST_BODY_BYTES,
    onError: () =>
      new Response(
        JSON.stringify(
          openAiErrorBody({
            message: "Model API request body is too large.",
            type: "rate_limit_error",
            code: "request_too_large",
          }),
        ),
        {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
  }),
);
app.route("/v1", createModelApiRoutes());

// Body-limit — reject oversized payloads early (before JSON parsing) to
// prevent memory exhaustion. 10 MB covers image uploads and large form
// payloads; individual routes can override with a tighter limit if needed.
app.use(
  "/*",
  bodyLimit({
    maxSize: 10 * 1024 * 1024, // 10 MB
    onError: (c) => c.json({ error: "Request is too large. Try uploading a smaller file." }, 413),
  }),
);

// Request-ID — attach a short random ID to every request for log correlation.
// The ID is stored in `c.var.requestId` and included in the logger output.
app.use("/*", async (c, next) => {
  const id = crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  await next();
});

// Logger — custom print function that prepends the request ID for correlation.
app.use("/*", async (c, next) => {
  const logFn = (message: string, ...rest: string[]) => {
    const reqId = c.get("requestId") ?? "-";
    console.log(`[${reqId}] ${message}`, ...rest);
  };
  return logger(logFn)(c, next);
});

// Catch any uncaught error from a route/middleware so admins get a stack
// trace + request context in the logs instead of an opaque 500 in the client.
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "-";
  console.error(
    `[server] [${reqId}] Unhandled error on ${c.req.method} ${c.req.path}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  return c.json({ error: "Something didn't work on our end. Try again in a moment." }, 500);
});

// Shared oRPC error logger. Skips expected client errors (4xx ORPCErrors like
// UNAUTHORIZED / NOT_FOUND / METHOD_NOT_SUPPORTED) so logs only contain real
// problems. Transient 5xx codes (502/503/504 — usually upstream infra blipping)
// log at warn so they don't pollute error dashboards alongside genuine bugs.
function logOrpcError(error: unknown) {
  if (error instanceof ORPCError && error.status < 500) {
    return;
  }
  const isTransient5xx = error instanceof ORPCError && error.status > 500;
  const log = isTransient5xx ? console.warn : console.error;
  if (error instanceof Error) {
    log(`[orpc] ${error.name}: ${error.message}`, error.stack);
  } else {
    log("[orpc] Unknown error:", error);
  }
}
if (env.CORS_ORIGIN) {
  app.use(
    "/*",
    cors({
      origin: env.CORS_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      // NOTE: If you enable CORS, add "x-csrf-token" here — the client's
      // SimpleCsrfProtectionLinkPlugin sends it on every request and the
      // browser will block it in preflight without this.
      allowHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
      credentials: true,
    }),
  );
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

// Rate limit auth endpoints (credential-stuffing defense), EXCEPT get-session
// (handled above). Must be mounted BEFORE the auth handler so every auth
// request is throttled.
app.use("/api/auth/*", async (c, next) => {
  if (c.req.path.endsWith("/get-session")) return next();
  return createRateLimiterMiddleware(authLimiter)(c, next);
});

// Verified-admin gate for the deviceAuthorization plugin's approve/deny
// endpoints. The plugin only checks "is this user signed in" — without this
// guard a signed-in non-admin or unverified admin could call these endpoints
// directly and approve a pending CLI device flow. See
// `device-admin-gate.ts` for the shape of the rejection. Must be mounted
// BEFORE the auth handler.
app.use("/api/auth/device/approve", deviceAdminGate);
app.use("/api/auth/device/deny", deviceAdminGate);

// Admin gate for Better-Auth's admin plugin endpoints. The plugin role-checks
// by default, but these routes can set roles, reset passwords, impersonate
// users, and remove users, so they must also honor this app's verified-admin
// and forced-2FA policy before the Better-Auth handler sees the request.
app.use("/api/auth/admin/*", betterAuthAdminGate);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/api/internal/chat-test/*", sessionMiddleware);
app.use("/api/internal/chat-test/*", createRateLimiterMiddleware(rpcLimiter));
app.route("/api/internal/chat-test", createChatTestRoutes());

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

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    ...csrfPlugins,
  ],
  interceptors: [onError(logOrpcError)],
});

// `BatchHandlerPlugin` matches the client's `BatchLinkPlugin` (see
// `apps/web/src/utils/orpc.ts`). Without it, any time the SPA fires multiple
// concurrent queries with a shared router prefix the client wraps them into
// a single `/rpc/<prefix>/__batch__` POST that the server otherwise 404s.
export const rpcHandler = new RPCHandler(appRouter, {
  plugins: [new BatchHandlerPlugin({ maxSize: 3 }), ...csrfPlugins],
  interceptors: [onError(logOrpcError)],
});

app.use("/*", async (c, next) => {
  const context = await createContext({ context: c });

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
    return startHandler.fetch(request);
  });
} else {
  app.get("/", (c) => {
    return c.text("OK");
  });
}

// ---------------------------------------------------------------------------
// Startup retry — wait for Postgres before accepting traffic
// ---------------------------------------------------------------------------

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

async function waitForDependencies() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("[server] Postgres is reachable.");
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error("[server] FATAL: Postgres not reachable after max retries. Exiting.");
        process.exit(1);
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[server] Postgres not ready (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms…`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

await waitForDependencies();

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = 10_000;
const serverPort = env.SERVER_PORT ?? env.PORT ?? 3000;

const server = serve(
  {
    fetch: app.fetch,
    port: serverPort,
    websocket: {
      server: new WebSocketServer({
        noServer: true,
        handleProtocols(protocols) {
          return protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false;
        },
      }),
    },
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests, then close dependencies
// ---------------------------------------------------------------------------

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[server] Received ${signal} — starting graceful shutdown…`);

  // 1. Stop accepting new connections and drain in-flight requests.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[server] Drain timeout reached, forcing close.");
      resolve();
    }, DRAIN_TIMEOUT_MS);

    server.close((err) => {
      clearTimeout(timeout);
      if (err) {
        console.error("[server] Error closing HTTP server:", err.message);
      }
      resolve();
    });
  });

  // 2. Close database connections.
  try {
    await prisma.$disconnect();
    console.log("[server] Prisma disconnected.");
  } catch (err) {
    console.error("[server] Error disconnecting Prisma:", err);
  }
  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
