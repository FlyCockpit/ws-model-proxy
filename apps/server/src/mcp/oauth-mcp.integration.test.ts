import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mcp } from "@better-auth/mcp";
import { type ServerType, serve } from "@hono/node-server";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import {
  createMcpPostLoginOptions,
  deriveMcpConsentReferenceId,
  issueMcpGrantClaims,
} from "@ws-model-proxy/auth/mcp-grant";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { jwt } from "better-auth/plugins";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { McpAuthInstance } from "./auth";
import {
  createDpopProof,
  decodeJwtPayload,
  type Ed25519KeyPair,
  fromBase64Url,
  generateDpopKey,
  generateEd25519Key,
  importEd25519PublicJwk,
  signEd25519,
  toBase64Url,
  totpCode,
  totpSecretFromUri,
  verifyEd25519,
} from "./oauth-dpop-test-utils";

/**
 * Disposable-PostgreSQL MCP OAuth integration suite (MCP plan Phase 9b /
 * Part K2). Runs the INSTALLED better-auth@1.7.3 oauth-provider/mcp/cimd
 * stack end-to-end over a REAL Prisma client and REAL PostgreSQL — the
 * `.review-loop/partK-gap-analysis.md` Section 3 worklist. Every test cites
 * the gap row it closes.
 *
 * Convention (identical to apps/server/src/model-api/*.integration.test.ts):
 * - `SCHEMA_VALIDATION_DATABASE_URL` selects the disposable database;
 *   without it the whole suite SKIPS (normal `pnpm --filter server test`).
 * - `REQUIRE_POSTGRES_INTEGRATION=1` makes a missing URL a hard error
 *   (what `pnpm test:pg` sets — the suite may never silently skip there).
 * - `createPrismaClient(databaseUrl)` from `@ws-model-proxy/db/client-factory`;
 *   `crypto.randomUUID()` suffixes keep every fixture row unique per run.
 *
 * Harness shape:
 * - The PRODUCTION auth instance is imported from `@ws-model-proxy/auth`
 *   with `@ws-model-proxy/env/server` mocked flag-ON and `@ws-model-proxy/db`
 *   mocked to the disposable client — real signup policy hooks, real admin/
 *   twoFactor/device plugins, real resolveMcpPlugins plugin set, and the
 *   1.7.3 prisma-adapter deferred SCHEMA CHECK against real PostgreSQL
 *   (gap row: "Better Auth startup schema validation against real PG").
 * - A real loopback HTTP listener serves the app because the installed
 *   `requireMcpAuth` verifier fetches the JWKS over real HTTP
 *   (better-fetch `fetchRefusingRedirects`); BETTER_AUTH_URL points at it.
 * - A TEST-CONSTRUCTED auth instance with production-shaped options but
 *   SHORT token lifetimes covers the rolling-expiry / cached-retry rows
 *   without weakening any production constant (all lifetimes are mcp()
 *   options, so no production injection point was needed). The SAME
 *   instance construction is the injection point for the row 13/15
 *   barriers: the `extensions[].claims.accessToken` hook (the claims-hook
 *   seam, the same seam the short-TTL overrides use) wraps the REAL
 *   issueMcpGrantClaims in a test-controlled promise gate that parks an
 *   issuance BEFORE or AFTER the grant check until released — NO production
 *   barrier mechanism exists or is added. One further gate, at the
 *   TEST-CONSTRUCTED app's auth-handler mount, parks a request BEFORE the
 *   auth handler runs (row 13(b): the pending code must still be
 *   UNCONSUMED when the revoke scans for it; the installed token endpoint
 *   consumes the verification row before the claims hook).
 * - CIMD registration goes through a DETERMINISTIC metadata transport
 *   (vi.mock of the installed `@better-auth/cimd/node` module, resolved
 *   through the same file packages/auth imports).
 * - `@ws-model-proxy/mailer` sendEmail is captured (and SMTP is reported
 *   configured) so the email-verification and email-OTP branches run for
 *   real without an SMTP server; everything else in the mailer is real.
 *
 * needs-infra (labeled, not silently skipped): the SOCIAL login branch of
 * the signed-login continuation (no SSO provider is configured server-side,
 * `ssoEnabled: false` since Phase 0 — an IdP would be required).
 */

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[oauth-mcp] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

// ---------------------------------------------------------------------------
// Hoisted shared state. The BETTER_AUTH_URL (loopback listener origin) must
// exist BEFORE any import that loads mcp-config's env-bound constants, so
// the port is chosen here, deterministically for this file, and the real
// listener binds it in beforeAll. The pg script runs the suite with
// --no-file-parallelism, and normal runs never construct the listener.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => {
  return {
    // Placeholder loopback origin. Before ANY listener binds, the module
    // body below reserves a REAL port by binding port 0 (kernel-assigned)
    // and overwrites this value, so every construction-time env read
    // (BETTER_AUTH_URL at auth-instance import) and every BASE-derived URL
    // see a port the kernel actually had free (R118 suggestion: never
    // sample an unreserved port from a fixed range).
    baseUrl: "http://127.0.0.1:1",
    /**
     * When set, request-time env reads (the /mcp canonical-authority
     * boundary) see this origin instead — row 8's second-origin instance.
     * Construction-time reads (the production auth instance) keep baseUrl.
     */
    activeBaseUrl: undefined as string | undefined,
    secret: "oauth-mcp-integration-secret-at-least-32ch",
    /** Prisma client over the disposable database (set by the db mock). */
    db: undefined as unknown,
    /** Captured outgoing emails (sendEmail seam). */
    emails: [] as { to: string; subject: string; html: string }[],
    /** Deterministic CIMD metadata documents by client_id URL. */
    cimdDocuments: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock("@ws-model-proxy/env/server", () => {
  const env = {
    WMP_MCP_ENABLED: true,
    // Getter: request-time readers see the active (possibly second-origin)
    // base; construction-time reads captured state.baseUrl.
    get BETTER_AUTH_URL(): string {
      return state.activeBaseUrl ?? state.baseUrl;
    },
    BETTER_AUTH_SECRET: state.secret,
    CORS_ORIGIN: undefined,
    NODE_ENV: "test",
    // Reported-configured SMTP so the email-verification + email-OTP
    // branches run; sendEmail itself is captured (mailer mock below).
    SMTP_HOST: "smtp.integration.test",
    RATE_LIMIT_AUTH_POINTS: 5000,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 900,
    RATE_LIMIT_SIGNUP_POINTS: 5000,
    RATE_LIMIT_SIGNUP_DURATION: 3600,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
    RATE_LIMIT_RPC_POINTS: 5000,
    RATE_LIMIT_RPC_DURATION: 60,
    RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 5000,
    RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
    RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
    RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 5000,
    RATE_LIMIT_MCP_POINTS: 5000,
    RATE_LIMIT_MCP_DURATION: 60,
    RATE_LIMIT_MCP_CONSENT_POINTS: 5000,
    RATE_LIMIT_MCP_CONSENT_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  };
  return { env, SIGNUP_ENABLED: true };
});

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: state.secret,
    DATABASE_URL:
      process.env.SCHEMA_VALIDATION_DATABASE_URL ?? "postgresql://oauth-mcp-skip-placeholder",
    NODE_ENV: "test",
    SMTP_HOST: "smtp.integration.test",
    TRANSLATION_PROVIDER: "openrouter",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const actual = (await vi.importActual<Record<string, unknown>>("@ws-model-proxy/db")) as {
    default: unknown;
  };
  const factory = (await vi.importActual<Record<string, unknown>>(
    "@ws-model-proxy/db/client-factory",
  )) as { createPrismaClient: (url: string) => unknown };
  // Read the env var directly: vi.mock factories are hoisted above the
  // module-level `databaseUrl` const, so closing over it would throw.
  const url = process.env.SCHEMA_VALIDATION_DATABASE_URL;
  if (state.db === undefined && url !== undefined) {
    state.db = factory.createPrismaClient(url);
  }
  // In skip mode `default` is a benign object (never undefined): the
  // production auth instance is still constructed through the transitive
  // import chain (./handler → tools → appRouter → auth), and the installed
  // prisma-adapter reads `<default>._runtimeDataModel` at construction —
  // undefined there surfaces as an UNHANDLED rejection that fails the
  // whole suite even though no test ran.
  return { ...actual, default: state.db ?? {} };
});

vi.mock("../../../../packages/mailer/src/index", async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>;
  return {
    ...actual,
    sendEmail: async (options: { to: string; subject: string; html: string }) => {
      state.emails.push({ to: options.to, subject: options.subject, html: options.html });
    },
  };
});

// Deterministic CIMD metadata transport: replaces the installed hardened
// Node transport exactly where packages/auth/src/mcp-plugins.ts imports it.
// The specifier is the same FILE the production import resolves to (through
// the packages/auth/node_modules symlink), so the mock covers the
// production-shaped auth instance too.
vi.mock("../../../../packages/auth/node_modules/@better-auth/cimd/dist/node.mjs", () => ({
  fetchClientMetadataResource: async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const document = state.cimdDocuments.get(url);
    if (document === undefined) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

// The production auth instance is imported LAZILY (in beforeAll, AFTER the
// mocks above, and only when the disposable URL is configured): importing
// it at module scope in skip mode would drag the whole auth chain — and
// through the db mock a CONSTRUCTED real Prisma client — into every normal
// `pnpm --filter server test` run, whose teardown surfaces as an unhandled
// Prisma error that fails the suite even though no test ran.
let auth: typeof import("@ws-model-proxy/auth").auth;

/** The single shared disposable Prisma client (from the db mock). */
const db = state.db as ReturnType<typeof createPrismaClient>;

// ---------------------------------------------------------------------------
// Loopback port selection (R118 suggestion; R119 F6 + R120 F7 wording):
// bind port 0 in a short-lived child process, read back the kernel-assigned
// port, then serve on it. This selects a RECENTLY-AVAILABLE kernel-assigned
// port — it is NOT a reservation: the child's socket closes before the real
// listener binds, so another process can still claim the port in between.
// The residual collision window is closed by BIND-TIME RETRY at every
// listener (the main listener binds before the auth import and retries with
// a fresh port + updated origin constants; launchShortOrigin and row 8
// reconstruct their origin-bound instances). spawnSync keeps it synchronous
// — the main origin must be known BEFORE the production auth instance is
// imported (BETTER_AUTH_URL is read at import time).
// ---------------------------------------------------------------------------
function reserveLoopbackPort(): number {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});',
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const port = Number.parseInt(probe.stdout.trim(), 10);
  if (probe.status !== 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`loopback port selection failed: ${probe.stderr}`);
  }
  return port;
}

// Reserved BEFORE the describe body captures BASE and before beforeAll
// imports the production auth instance (integration runs only; skip-mode
// runs never reserve).
if (databaseUrl) {
  state.baseUrl = `http://127.0.0.1:${reserveLoopbackPort()}`;
}

integration("MCP OAuth end-to-end over disposable PostgreSQL", () => {
  // `let` (not const): the main-listener EADDRINUSE retry in beforeAll can
  // rebind the origin BEFORE the auth import, and every closure below reads
  // the updated values.
  let BASE = state.baseUrl;
  let CANONICAL = `${BASE}/mcp`;
  let ISSUER = `${BASE}/api/auth`;
  const AUTHORIZE = "/api/auth/oauth2/authorize";
  const TOKEN = "/api/auth/oauth2/token";
  const CONSENT = "/api/auth/oauth2/consent";
  const FORM = "application/x-www-form-urlencoded";
  const JSON_TYPE = "application/json";
  const CALLBACK = "https://client.example.test/callback";
  const VERIFIER = "integration-pkce-verifier-at-least-forty-three-characters";
  const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

  let listener: ServerType | undefined;
  /** The production-shaped app: authorize guard + auth handler + /mcp. */
  let app: RequestIdApp;
  /** Second loopback listener for the short-TTL instance (row 8). */
  let shortListener: ServerType | undefined;
  /** Cached lazy `mcp-config` import (see loadMcpConfig below). */
  let mcpConfigPromise: Promise<typeof import("@ws-model-proxy/auth/mcp-config")> | undefined;

  /** App shape with the /mcp requestId variable (mirrors apps/server app.ts). */
  type RequestIdApp = Hono<{ Variables: { requestId: string } }>;

  type AuthLike = McpAuthInstance & {
    handler: (request: Request) => Response | Promise<Response>;
  };

  /**
   * Resolve once the server's `listening` event fires; reject (and detach)
   * on the server `error` event instead of surfacing it as an unhandled
   * async 'error' — this is what makes EADDRINUSE a REJECTable error every
   * caller can retry (R118 suggestion; R119 F6/R120 F7: every listener now
   * retries bind collisions).
   */
  function awaitListening(server: ServerType): Promise<ServerType> {
    return new Promise((resolveListen, rejectListen) => {
      const onListen = () => {
        detach();
        resolveListen(server);
      };
      const onError = (error: Error) => {
        detach();
        rejectListen(error);
      };
      const detach = () => {
        server.off("listening", onListen);
        server.off("error", onError);
      };
      server.on("listening", onListen);
      server.on("error", onError);
      if (server.listening) onListen();
    });
  }

  /**
   * Serve `target` on a loopback port and RESOLVE only once the listener is
   * confirmed listening — a bind failure (EADDRINUSE &c.) rejects instead of
   * surfacing as an async unhandled 'error' event.
   */
  async function serveLoopback(target: RequestIdApp, port: number): Promise<ServerType> {
    return await awaitListening(serve({ fetch: target.fetch, port, hostname: "127.0.0.1" }));
  }

  function isAddrInUse(error: unknown): boolean {
    return (error as { code?: string }).code === "EADDRINUSE";
  }

  /**
   * The MAIN listener's delegate holder: the port is CLAIMED (with
   * EADDRINUSE retry, before the production auth import — the instance
   * captures BETTER_AUTH_URL at import time and could never rebind) while
   * the real app is only assigned to the holder afterwards. Until then the
   * delegate serves a 503 placeholder; nothing can reach the port before
   * the suite starts (the port is only ever shared with this process).
   */
  const mainAppHolder: { current: RequestIdApp | undefined } = { current: undefined };
  const bootPlaceholderApp = new Hono<{ Variables: { requestId: string } }>().all(
    "*",
    () => new Response("starting", { status: 503 }),
  );
  async function serveLoopbackDelegate(port: number): Promise<ServerType> {
    return await awaitListening(
      serve({
        fetch: (request: Request) => (mainAppHolder.current ?? bootPlaceholderApp).fetch(request),
        port,
        hostname: "127.0.0.1",
      }),
    );
  }

  /**
   * Build the production-shaped app (authorize guard + auth handler + /mcp).
   * The /mcp machinery imports are DYNAMIC so a skip-mode run never loads
   * the appRouter chain (and through it the auth instance + its deferred
   * prisma-adapter schema check) into a normal `pnpm --filter server test`.
   *
   * Test-only seams (never production mechanism):
   * - `issuerUrl` overrides ONLY the verifier's expected issuer (row 12's
   *   single-defect issuer control).
   * - `requestGate` pauses every /api/auth request BEFORE the auth handler
   *   runs (row 13(b): the pending-code revocation must land while the
   *   authorization code is still UNCONSUMED — the installed token endpoint
   *   deletes the verification row (consumeVerificationValue) BEFORE the
   *   claims hook runs, so a claims-hook pause can no longer exercise the
   *   pending-code enumeration).
   */
  async function buildOAuthApp(
    authInstance: AuthLike,
    options?: {
      withMcp?: boolean;
      baseUrl?: string;
      resourceUrl?: string;
      issuerUrl?: string;
      requestGate?: { wait: () => Promise<void> };
      /**
       * EXTRA authorize target BASES the guard accepts (TEST-ONLY seam,
       * never a production mechanism). Row 12's issuer-negative leg needs a
       * REAL token minted by the SECOND origin whose audience is the
       * PRODUCTION canonical resource (a resource the origin2 client is
       * linked to in the shared DB); the production guard's target is
       * env-bound to its own origin, so this harness variant widens the
       * accepted target set. Each base is judged exactly like the
       * production guard judges its own: `canonicalMcpResource(base)`.
       */
      authorizeTargetBases?: string[];
    },
  ): Promise<RequestIdApp> {
    const [
      { createMcpAdmissionGate },
      { createMcpTransport },
      { createMcpRequestHandler },
      { bindMcpToolDispatch },
      guard,
    ] = await Promise.all([
      import("./admission"),
      import("./handler"),
      import("./auth"),
      import("./tool-dispatch"),
      import("../mcp-authorize-scope-guard"),
    ]);
    const baseUrl = options?.baseUrl ?? BASE;
    const canonical = options?.resourceUrl ?? `${baseUrl}/mcp`;
    const issuer = options?.issuerUrl ?? `${baseUrl}/api/auth`;
    const created: RequestIdApp = new Hono<{ Variables: { requestId: string } }>();
    // The guard module is imported DYNAMICALLY here (see loadMcpConfig): a
    // static import would evaluate mcp-config's MCP_RESOURCE_URL constant
    // before the loopback port reservation has fixed state.baseUrl.
    if (options?.authorizeTargetBases === undefined && baseUrl === BASE) {
      // The production guard verbatim (env-bound origin, request-time read).
      created.use(AUTHORIZE, guard.mcpAuthorizeScopeGuard);
    } else {
      // Same inspection, explicit target set: `[baseUrl, ...extra]`. A
      // request is forwarded when ANY target accepts it; otherwise the most
      // specific rejection wins (scope > target > request).
      const targets = [baseUrl, ...(options?.authorizeTargetBases ?? [])];
      created.use(AUTHORIZE, async (c, next) => {
        const decisions = await Promise.all(
          targets.map(async (target) => await guard.inspectAuthorizeRequest(c.req.raw, target)),
        );
        if (decisions.includes("forward") || decisions.includes("not-applicable")) return next();
        if (decisions.includes("invalid-scope")) return guard.invalidAuthorizeScopeResponse();
        if (decisions.includes("invalid-target")) return guard.invalidAuthorizeTargetResponse();
        return guard.invalidAuthorizeRequestResponse();
      });
    }
    const authHandler: (request: Request) => Response | Promise<Response> = options?.requestGate
      ? async (request) => {
          await options.requestGate!.wait();
          return await authInstance.handler(request);
        }
      : (request) => authInstance.handler(request);
    created.on(["GET", "POST"], "/api/auth/*", (c) => authHandler(c.req.raw));
    // Root discovery aliases (the /api/auth-prefixed fourth alias is already
    // under the auth handler mount): forwarded VERBATIM, exactly like
    // apps/server/src/app.ts mounts createMcpDiscoveryForwarder.
    for (const alias of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      created.all(alias, (c) => authInstance.handler(c.req.raw));
    }
    if (options?.withMcp === true) {
      const gate = createMcpAdmissionGate();
      const transport = createMcpTransport({ isShuttingDown: () => gate.closed });
      created.use("/mcp", async (c, next) => {
        c.set("requestId", crypto.randomUUID());
        return next();
      });
      created.post("/mcp", (c) =>
        createMcpRequestHandler({
          authInstance,
          transport,
          prisma: db,
          isForceTwoFactorRequired,
          admissionGate: gate,
          consumeIdentityQuota: async () => ({ ok: true }),
          ...(baseUrl === BASE &&
          options?.resourceUrl === undefined &&
          options?.issuerUrl === undefined
            ? {}
            : { resourceUrl: canonical, issuerUrl: issuer }),
          onVerified: ({ authInfo, orpcContext, requestId, signal }) =>
            bindMcpToolDispatch(authInfo, { orpcContext, requestId, signal }),
        })(c),
      );
    }
    return created;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    // BIND FIRST, IMPORT SECOND (R119 F6 + R120 F7): claim the main port
    // through the delegate holder, retrying EADDRINUSE with a freshly
    // selected port and updating the origin constants — all BEFORE the
    // production auth instance is imported (its baseURL/JWKS URLs are
    // captured at import time from state.baseUrl, so a retry after the
    // import could not rebind).
    for (let attempt = 0; ; attempt += 1) {
      try {
        listener = await serveLoopbackDelegate(Number(new URL(BASE).port));
        break;
      } catch (error) {
        if (attempt >= 2 || !isAddrInUse(error)) throw error;
        const retryPort = reserveLoopbackPort();
        state.baseUrl = `http://127.0.0.1:${retryPort}`;
        BASE = state.baseUrl;
        CANONICAL = `${BASE}/mcp`;
        ISSUER = `${BASE}/api/auth`;
      }
    }
    // Dynamic import AFTER the vi.mock declarations are registered AND the
    // origin is final: the production auth instance (flag-on plugin set)
    // over the mocked disposable Prisma client.
    ({ auth } = await import("@ws-model-proxy/auth"));
    process.env.DATABASE_URL = databaseUrl;
    app = await buildOAuthApp(auth as unknown as AuthLike, { withMcp: true });
    mainAppHolder.current = app;
    // The canonical MCP resource row: idempotent seed (the provider also
    // seeds it lazily; both paths converge on the unique identifier).
    await db.oauthResource.upsert({
      where: { identifier: CANONICAL },
      create: { identifier: CANONICAL, name: "WS Model Proxy MCP" },
      update: {},
    });
  });

  afterAll(async () => {
    listener?.close();
    shortListener?.close();
    await db?.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Flow helpers (shared by every test below).
  // -------------------------------------------------------------------------

  function cookieOf(res: Response): string {
    return res.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  /** Raw Set-Cookie first segments (name=value) for assertions on WHICH
   * cookies an endpoint set (session vs 2FA challenge). */
  function resCookies(res: Response): string[] {
    return res.headers.getSetCookie().map((value) => value.split(";")[0] ?? value);
  }

  async function waitForEmail(
    predicate: (mail: { to: string; subject: string; html: string }) => boolean,
  ): Promise<{ to: string; subject: string; html: string }> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const found = state.emails.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `expected email not captured within 3s; captured subjects: ${state.emails
        .map((mail) => mail.subject)
        .join(" | ")}`,
    );
  }

  async function signUpVerifiedUser(email: string, password: string): Promise<string> {
    const signup = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": JSON_TYPE, origin: BASE },
      body: JSON.stringify({ name: "MCP Integration", email, password }),
    });
    expect(signup.status, `sign-up for ${email}`).toBe(200);
    // Email is reported configured (mocked SMTP_HOST) → verification is
    // required: read the verification URL out of the captured email and
    // click it exactly like a real user would. better-auth sends this email
    // via runInBackgroundOrAwait, so poll briefly for the capture.
    const sent = await waitForEmail(
      (mail) => mail.to === email && mail.subject.toLowerCase().includes("verify"),
    );
    const url = /https?:\/\/[^\s"'<>]+/.exec(sent.html)?.[0];
    expect(url, "verification URL embedded in the email").toBeDefined();
    const verified = await app.request(url!);
    // Any 2xx/3xx completion is the clicked-link contract; the follow-up
    // sign-in below proves the address actually became verified.
    expect(verified.status).toBeLessThan(400);
    const signIn = await app.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": JSON_TYPE, origin: BASE },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status, `verified sign-in for ${email}`).toBe(200);
    return cookieOf(signIn);
  }

  function authorizeForm(extra: Record<string, string>): string {
    return new URLSearchParams(extra).toString();
  }

  async function seedPublicClient(
    clientId: string,
    options?: { skipConsent?: boolean; dpopBound?: boolean },
  ): Promise<void> {
    await db.oauthClient.create({
      data: {
        clientId,
        name: `Integration client ${clientId}`,
        tokenEndpointAuthMethod: "none",
        redirectUris: [CALLBACK],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopes: ["mcp:read", "mcp:write", "offline_access"],
        skipConsent: options?.skipConsent ?? true,
        requirePKCE: true,
        dpopBoundAccessTokens: options?.dpopBound ?? false,
        disabled: false,
      },
    });
    await db.oauthClientResource.create({
      data: { clientId, resourceId: CANONICAL },
    });
  }

  async function authorizeRequest(
    cookie: string | undefined,
    body: Record<string, string>,
  ): Promise<Response> {
    return await app.request(`${BASE}${AUTHORIZE}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE, ...(cookie ? { cookie } : {}) },
      body: authorizeForm(body),
    });
  }

  const baseAuthorizeParams = (clientId: string): Record<string, string> => ({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });

  async function exchangeCode(options: {
    clientId: string;
    code: string;
    verifier?: string;
    dpopProof?: string;
  }): Promise<Response> {
    return await app.request(`${BASE}${TOKEN}`, {
      method: "POST",
      headers: {
        "content-type": FORM,
        ...(options.dpopProof ? { dpop: options.dpopProof } : {}),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.clientId,
        code: options.code,
        ...(options.verifier === undefined ? {} : { code_verifier: options.verifier }),
        redirect_uri: CALLBACK,
      }),
    });
  }

  async function refreshRequest(options: {
    clientId: string;
    refreshToken: string;
    dpopProof?: string;
    app?: Hono;
  }): Promise<Response> {
    return await (options.app ?? app).request(`${BASE}${TOKEN}`, {
      method: "POST",
      headers: {
        "content-type": FORM,
        ...(options.dpopProof ? { dpop: options.dpopProof } : {}),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: options.clientId,
        refresh_token: options.refreshToken,
      }),
    });
  }

  interface TokenSet {
    accessToken: string;
    refreshToken: string;
    tokenType?: string;
    claims: Record<string, unknown>;
  }

  async function parseTokenResponse(res: Response): Promise<TokenSet> {
    const text = await res.text();
    expect(res.status, `token response body ${text.slice(0, 300)}`).toBe(200);
    const json = JSON.parse(text) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    expect(json.access_token.split(".")).toHaveLength(3);
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? "",
      tokenType: json.token_type,
      claims: decodeJwtPayload(json.access_token),
    };
  }

  /** authorize (seeded skip-consent client) → code URL, one round trip. */
  async function authorizeForCode(
    cookie: string,
    clientId: string,
    scope: string,
    extra: Record<string, string> = {},
  ): Promise<URL> {
    const res = await authorizeRequest(cookie, {
      ...baseAuthorizeParams(clientId),
      scope,
      resource: CANONICAL,
      ...extra,
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get("code")).toBeTruthy();
    return location;
  }

  /** Full happy-path code exchange for a seeded client. */
  async function mintTokens(
    cookie: string,
    clientId: string,
    scope: string,
    extra: Record<string, string> = {},
  ): Promise<TokenSet> {
    const location = await authorizeForCode(cookie, clientId, scope, extra);
    const res = await exchangeCode({
      clientId,
      code: location.searchParams.get("code")!,
      verifier: VERIFIER,
    });
    return await parseTokenResponse(res);
  }

  /** Consent-flow mint: authorize → consent page → accept → exchange. */
  async function mintTokensWithConsent(
    cookie: string,
    clientId: string,
    scope: string,
  ): Promise<TokenSet> {
    const consentPage = await authorizeExpectConsent(cookie, clientId, scope);
    const callback = await consentAccept(cookie, consentPage);
    return await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );
  }

  /** Register a deterministic CIMD metadata document for a URL client_id. */
  function registerCimdDocument(clientIdUrl: string, extra: Record<string, unknown> = {}): void {
    state.cimdDocuments.set(clientIdUrl, {
      client_id: clientIdUrl,
      client_name: "CIMD Integration Client",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...extra,
    });
  }

  /** authorize expecting the CONSENT-page redirect; returns its URL. */
  async function authorizeExpectConsent(
    cookie: string,
    clientId: string,
    scope: string,
    extra: Record<string, string> = {},
  ): Promise<URL> {
    const res = await authorizeRequest(cookie, {
      ...baseAuthorizeParams(clientId),
      scope,
      resource: CANONICAL,
      ...extra,
    });
    if (res.status !== 302) {
      throw new Error(
        `expected authorize consent redirect, got ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-consent");
    return location;
  }

  /** Consent accept → the redirect URL (callback with a code). */
  async function consentAccept(cookie: string, consentPage: URL): Promise<URL> {
    const res = await app.request(`${BASE}${CONSENT}`, {
      method: "POST",
      headers: { "content-type": JSON_TYPE, cookie, origin: BASE },
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { redirect: boolean; url: string };
    expect(json.redirect).toBe(true);
    return new URL(json.url, BASE);
  }

  // -------------------------------------------------------------------------
  // Gap row 1: Better Auth startup schema validation against real PG.
  // -------------------------------------------------------------------------

  it("row 1 — Better Auth startup schema validation passes against real PG (flag-on plugin set, prisma-adapter check)", async () => {
    // Any first auth.api/handler call awaits the 1.7.3 prisma-adapter
    // deferred schema check; a schema drift throws APIError INTERNAL. The
    // signUpEmail round trip below is that first call for this instance.
    const suffix = crypto.randomUUID();
    const email = `schema-check-${suffix}@example.test`;
    const signup = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": JSON_TYPE, origin: BASE },
      body: JSON.stringify({ name: "Schema Check", email, password: "schema-check-password-1" }),
    });
    expect(signup.status).toBe(200);
    const row = await db.user.findUnique({ where: { email } });
    expect(row).not.toBeNull();
    expect(row?.emailVerified).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Gap row 2: real user + session + credential rows through the real
  // Prisma adapter.
  // -------------------------------------------------------------------------

  it("row 2 — real user + session + credential rows through the real Prisma adapter (sign-up, verify, sign-in)", async () => {
    const suffix = crypto.randomUUID();
    const email = `user-session-${suffix}@example.test`;
    const password = "integration-password-123";
    const cookie = await signUpVerifiedUser(email, password);
    expect(cookie).toContain("better-auth.session_token");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(true);
    const sessions = await db.session.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const accounts = await db.account.findMany({ where: { userId: user.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("credential");
    expect(accounts[0]?.password).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Gap row 3: CIMD client/resource persistence via the deterministic
  // HTTPS metadata transport (registration through the CIMD profile).
  // -------------------------------------------------------------------------

  it("row 3 — CIMD first-use registration persists client, resource link, and consents through the injected metadata transport", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `https://cimd-${suffix}.example.test/client.json`;
    registerCimdDocument(clientId);
    const cookie = await signUpVerifiedUser(`cimd-${suffix}@example.test`, "cimd-password-123");

    // First use: the provider resolves the URL client_id through the
    // deterministic transport (no DCR endpoint involved) and persists the
    // client row + the canonical resource link.

    // R117 finding 3c: the RESOURCE row itself was pre-seeded by the
    // harness (beforeAll), so its existence proves nothing. What this row
    // proves instead is what the PROVIDER persisted FROM THE TRANSPORT
    // PAYLOAD: the document's client_name, redirect_uris, grant types and
    // auth method land on the oauthClient row, and the client→resource
    // LINK is written by the provider during registration.
    const consentPage = await authorizeExpectConsent(cookie, clientId, "mcp:read offline_access");
    const clientRow = await db.oauthClient.findUnique({ where: { clientId } });
    expect(clientRow).not.toBeNull();
    expect(clientRow?.clientDiscoveryId).toBe("cimd");
    expect(clientRow?.name).toBe("CIMD Integration Client"); // client_name from the document
    expect(clientRow?.redirectUris).toEqual([CALLBACK]); // redirect_uris from the document
    expect(clientRow?.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(clientRow?.responseTypes).toEqual(["code"]);
    expect(clientRow?.tokenEndpointAuthMethod).toBe("none");
    expect(clientRow?.disabled).toBe(false);
    const link = await db.oauthClientResource.findUnique({
      where: { clientId_resourceId: { clientId, resourceId: CANONICAL } },
    });
    // Provider-written during CIMD registration (the harness never links
    // URL clients to the canonical resource).
    expect(link).not.toBeNull();

    // Complete the consent so the generation rows persist too.
    const callback = await consentAccept(cookie, consentPage);
    expect(callback.searchParams.get("code")).toBeTruthy();
    const tokens = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );
    expect(tokens.claims.client_id).toBe(clientId);
    const consentRow = await db.oauthConsent.findFirst({ where: { clientId } });
    expect(consentRow?.referenceId).toMatch(/^[0-9a-f]{64}$/);
    const grantRow = await db.mcpGrant.findFirst({ where: { clientId } });
    expect(grantRow?.referenceId).toBe(consentRow?.referenceId);
  });

  // -------------------------------------------------------------------------
  // Gap row 4: discovery alias matrix against real PG + metadata contents.
  // -------------------------------------------------------------------------

  it("row 4 — all four discovery aliases serve the real metadata documents over real PG", async () => {
    const protectedAliases = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ];
    for (const alias of protectedAliases) {
      const res = await app.request(`${BASE}${alias}`);
      expect(res.status, alias).toBe(200);
      const metadata = (await res.json()) as Record<string, unknown>;
      expect(metadata.resource, alias).toBe(CANONICAL);
      expect(metadata.authorization_servers, alias).toEqual([ISSUER]);
      expect(metadata.bearer_methods_supported, alias).toEqual(["header"]);
      expect(metadata.dpop_signing_alg_values_supported, alias).toContain("ES256");
      // offline_access is authorization-server-only and filtered out here.
      expect(metadata.scopes_supported, alias).toEqual(["mcp:read", "mcp:write"]);
      const head = await app.request(`${BASE}${alias}`, { method: "HEAD" });
      expect(head.status, alias).toBe(200);
      expect(await head.text(), alias).toBe("");
      const post = await app.request(`${BASE}${alias}`, { method: "POST" });
      expect(post.status, alias).toBe(405);
      expect(post.headers.get("allow"), alias).toBe("GET, HEAD");
    }
    for (const alias of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/api/auth/.well-known/oauth-authorization-server",
    ]) {
      const res = await app.request(`${BASE}${alias}`);
      expect(res.status, alias).toBe(200);
      const metadata = (await res.json()) as Record<string, unknown>;
      expect(metadata.issuer, alias).toBe(ISSUER);
      expect(metadata.authorization_endpoint, alias).toBe(`${ISSUER}/oauth2/authorize`);
      expect(metadata.token_endpoint, alias).toBe(`${ISSUER}/oauth2/token`);
      expect(metadata.jwks_uri, alias).toBe(`${ISSUER}/jwks`);
      const scopes = metadata.scopes_supported as string[];
      expect(scopes, alias).toContain("offline_access");
      // DCR stays unadvertised (CIMD-only registration).
      expect(metadata.registration_endpoint, alias).toBeUndefined();
      expect(metadata.dpop_signing_alg_values_supported, alias).toContain("ES256");
      // CIMD advertisement.
      expect((metadata.client_id_metadata_document_supported as boolean) ?? false, alias).toBe(
        true,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Gap row 5: PKCE authorization full happy path + rejection matrix.
  // -------------------------------------------------------------------------

  it("row 5 — PKCE S256 happy path round-trips the verifier; the installed verifier rejects every malformed shape", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `pkce-${suffix}`;
    await seedPublicClient(clientId);
    const cookie = await signUpVerifiedUser(`pkce-${suffix}@example.test`, "pkce-password-123");

    // Happy path: S256 challenge ↔ verifier round trip through a real code.
    const tokens = await mintTokens(cookie, clientId, "mcp:read offline_access");
    expect(tokens.claims.aud).toBe(CANONICAL);
    expect(tokens.claims.iss).toBe(ISSUER);
    expect(typeof tokens.claims.mcp_grant_id).toBe("string");

    // Missing code_challenge entirely (PKCE required for public clients).
    const missing = await authorizeRequest(cookie, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: "mcp:read",
      resource: CANONICAL,
    });
    expect(missing.status).toBe(302);
    const missingLocation = new URL(missing.headers.get("location")!, BASE);
    expect(missingLocation.origin + missingLocation.pathname).toBe(CALLBACK);
    expect(missingLocation.searchParams.get("error")).toBe("invalid_request");

    // plain method: only S256 is supported (installed authorize contract).
    const plain = await authorizeRequest(cookie, {
      ...baseAuthorizeParams(clientId),
      code_challenge_method: "plain",
      code_challenge: VERIFIER,
      scope: "mcp:read",
      resource: CANONICAL,
    });
    expect(plain.status).toBe(302);
    const plainLocation = new URL(plain.headers.get("location")!, BASE);
    expect(plainLocation.searchParams.get("error")).toBe("invalid_request");

    // Challenge without method (and vice versa) is rejected downstream too.
    const half = await authorizeRequest(cookie, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: CHALLENGE,
      scope: "mcp:read",
      resource: CANONICAL,
    });
    expect(half.status).toBe(302);
    expect(new URL(half.headers.get("location")!, BASE).searchParams.get("error")).toBe(
      "invalid_request",
    );

    // Missing verifier at the token endpoint: required-parameter failure.
    const codeUrl = await authorizeForCode(cookie, clientId, "mcp:read");
    const missingVerifier = await exchangeCode({
      clientId,
      code: codeUrl.searchParams.get("code")!,
    });
    expect(missingVerifier.status).toBe(400);
    expect(((await missingVerifier.json()) as { error: string }).error).toBe("invalid_request");

    // Wrong verifier at the token endpoint (installed contract: 401
    // invalid_request — failed PKCE verification is rejected, no tokens).
    const codeUrl2 = await authorizeForCode(cookie, clientId, "mcp:read");
    const wrongVerifier = await exchangeCode({
      clientId,
      code: codeUrl2.searchParams.get("code")!,
      verifier: `${VERIFIER}-wrong`,
    });
    expect(wrongVerifier.status).toBe(401);
    expect(((await wrongVerifier.json()) as { error: string }).error).toBe("invalid_request");
  });

  // -------------------------------------------------------------------------
  // Gap row 7: consent with offline_access, code exchange, refresh rotation.
  // -------------------------------------------------------------------------

  it("row 7 — consent with offline_access → code exchange (shape + mcp_grant_id) → refresh rotation kills the old refresh token", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `rotation-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const cookie = await signUpVerifiedUser(
      `rotation-${suffix}@example.test`,
      "rotation-password-1",
    );

    const consentPage = await authorizeExpectConsent(cookie, clientId, "mcp:read offline_access");
    const callback = await consentAccept(cookie, consentPage);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const first = await parseTokenResponse(
      await exchangeCode({ clientId, code: code!, verifier: VERIFIER }),
    );
    // Token response shape.
    expect(first.refreshToken).not.toBe("");
    expect(first.claims.mcp_grant_id).toEqual(expect.any(String));
    expect(first.claims.scope).toContain("offline_access");
    expect(first.claims.exp).toEqual(expect.any(Number));

    // Rotation: a refresh mints a NEW refresh token.
    const second = await parseTokenResponse(
      await refreshRequest({ clientId, refreshToken: first.refreshToken }),
    );
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    // Same live grant generation across rotation.
    expect(second.claims.mcp_grant_id).toBe(first.claims.mcp_grant_id);

    // Within the pinned 30s reuse window, the OLD refresh token returns the
    // CACHED rotation response (the documented retry semantics), and the
    // cached row is persisted for replay-evidence retention.
    const replayRes = await parseTokenResponse(
      await refreshRequest({ clientId, refreshToken: first.refreshToken }),
    );
    expect(replayRes.accessToken).toBe(second.accessToken);
    expect(replayRes.refreshToken).toBe(second.refreshToken);
    // Replay-evidence retention: the ROTATED-ANCESTOR row exists (looked up
    // by its stored hash — see storedTokenHash), carries the cached
    // rotation response, and is flagged revoked.
    const replayRow = await db.oauthRefreshToken.findUnique({
      where: { token: storedTokenHash(first.refreshToken) },
    });
    expect(replayRow, "rotated ancestor refresh row retained").not.toBeNull();
    expect(replayRow?.rotationReplayResponse).not.toBeNull();
    expect(replayRow?.revoked).not.toBeNull();

    // The minted-code leg also proves consent memory: a second authorize
    // with the same session/scope set skips the consent page.
    const direct = await authorizeRequest(cookie, {
      ...baseAuthorizeParams(clientId),
      scope: "mcp:read offline_access",
      resource: CANONICAL,
    });
    expect(direct.status).toBe(302);
    const directLocation = new URL(direct.headers.get("location")!, BASE);
    expect(directLocation.origin + directLocation.pathname).toBe(CALLBACK);
    expect(directLocation.searchParams.get("code")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Gap row 6: signed login continuations (password / email OTP / TOTP).
  // -------------------------------------------------------------------------

  /** authorize WITHOUT a session → the login page redirect (signed query). */
  async function authorizeExpectLogin(clientId: string, scope: string): Promise<URL> {
    const res = await authorizeRequest(undefined, {
      ...baseAuthorizeParams(clientId),
      scope,
      resource: CANONICAL,
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.pathname).toContain("/mcp-login");
    return location;
  }

  async function jsonPost(
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Promise<Response> {
    return await app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": JSON_TYPE, origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }

  /**
   * The oauth-provider continuation contract: a resumed authorize answers
   * 302 + Location for browser-like requests, and 200 JSON
   * `{redirect: true, url}` for JSON-accepting sign-in/verify requests.
   */
  async function expectContinuation(res: Response): Promise<URL> {
    if (res.status === 302) {
      return new URL(res.headers.get("location")!, BASE);
    }
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const json = JSON.parse(text) as { redirect: boolean; url: string };
    expect(json.redirect).toBe(true);
    return new URL(json.url, BASE);
  }

  it("row 6a — password continuation: sign-in with the signed oauth_query resumes authorization on the new session cookie", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `login-pw-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const email = `login-pw-${suffix}@example.test`;
    const password = "login-pw-password-123";
    await signUpVerifiedUser(email, password);

    const loginPage = await authorizeExpectLogin(clientId, "mcp:read offline_access");
    const res = await jsonPost("/api/auth/sign-in/email", {
      email,
      password,
      oauth_query: loginPage.search.slice(1),
    });
    // The oauth-provider session-cookie hook resumes runOAuth2Authorize:
    // the answer IS the authorize continuation (consent redirect here) plus
    // the fresh session cookie.
    const location = await expectContinuation(res);
    expect(location.pathname).toContain("/mcp-consent");
    const cookie = cookieOf(res);
    expect(cookie).toContain("better-auth.session_token");

    const callback = await consentAccept(cookie, location);
    const tokens = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );
    expect(tokens.claims.sub).toEqual(expect.any(String));
    const user = await db.user.findUnique({ where: { email } });
    expect(tokens.claims.sub).toBe(user?.id);
  });

  it("row 6b — email OTP continuation: challenge cookie → emailed code → verify resumes authorization", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `login-otp-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const email = `login-otp-${suffix}@example.test`;
    const password = "login-otp-password-123";
    const cookie = await signUpVerifiedUser(email, password);

    // Enable the email-OTP second factor (SMTP reported configured → the
    // plugin wires sendOTP through the captured mailer seam).
    const enable = await jsonPost(
      "/api/auth/two-factor/enable",
      { password, method: "otp" },
      cookie,
    );
    expect(enable.status).toBe(200);
    expect(((await enable.json()) as { method?: string }).method).toBe("otp");

    // Fresh browser: sign-in with the signed query → 2FA challenge, no session.
    const loginPage = await authorizeExpectLogin(clientId, "mcp:read offline_access");
    const challenge = await jsonPost("/api/auth/sign-in/email", {
      email,
      password,
      oauth_query: loginPage.search.slice(1),
    });
    expect(challenge.status).toBe(200);
    expect(((await challenge.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true,
    );
    const setCookies = resCookies(challenge);
    expect(setCookies.some((value) => value.startsWith("better-auth.two_factor="))).toBe(true);

    // Request the code; it lands in the captured email sink.
    const challengeCookie = cookieOf(challenge);
    const send = await jsonPost(
      "/api/auth/two-factor/send-otp",
      { trustDevice: false },
      challengeCookie,
    );
    expect(send.status).toBe(200);
    const otpMail = await waitForEmail(
      (mail) => mail.to === email && mail.subject.includes("verification code"),
    );
    const code = /\b(\d{6})\b/.exec(otpMail.html)?.[1];
    expect(code, "six-digit OTP extracted from the emailed html").toBeDefined();

    // Verify with the signed query still in the (raw) body: the challenge is
    // consumed, the session cookie is set, and the oauth-provider after-hook
    // resumes authorize → consent redirect.
    const verify = await jsonPost(
      "/api/auth/two-factor/verify-otp",
      { code, oauth_query: loginPage.search.slice(1) },
      challengeCookie,
    );
    const verifyLocation = await expectContinuation(verify);
    expect(verifyLocation.pathname).toContain("/mcp-consent");
    const sessionCookie = cookieOf(verify);
    expect(sessionCookie).toContain("better-auth.session_token");

    const callback = await consentAccept(sessionCookie, verifyLocation);
    const tokens = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );
    expect(tokens.claims.sub).toEqual(expect.any(String));
  });

  it("row 6c — TOTP continuation: enable + verify TOTP, then sign-in challenge resumes authorization through a fresh TOTP code", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `login-totp-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const email = `login-totp-${suffix}@example.test`;
    const password = "login-totp-password-123";
    const cookie = await signUpVerifiedUser(email, password);

    // Enable TOTP: returns the otpauth URI (secret) + backup codes.
    const enable = await jsonPost("/api/auth/two-factor/enable", { password }, cookie);
    expect(enable.status).toBe(200);
    const enableJson = (await enable.json()) as { totpURI?: string; method?: string };
    expect(enableJson.method).toBe("totp");
    expect(enableJson.totpURI).toBeDefined();
    const secret = totpSecretFromUri(enableJson.totpURI!);

    // Verify once WITH the session (activates the factor: verified=true,
    // twoFactorEnabled=true). The response rotates the session cookie.
    const activationCode = totpCode(secret);
    const activate = await jsonPost(
      "/api/auth/two-factor/verify-totp",
      { code: activationCode },
      cookie,
    );
    expect(activate.status).toBe(200);
    const user = await db.user.findUnique({ where: { email } });
    expect(user?.twoFactorEnabled).toBe(true);

    // Fresh browser: password sign-in with the signed query → challenge.
    const loginPage = await authorizeExpectLogin(clientId, "mcp:read offline_access");
    const challenge = await jsonPost("/api/auth/sign-in/email", {
      email,
      password,
      oauth_query: loginPage.search.slice(1),
    });
    expect(challenge.status).toBe(200);
    expect(((await challenge.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true,
    );
    const challengeCookie = cookieOf(challenge);

    // Fresh TOTP step (a new 30s window may have started since activation).
    const verify = await jsonPost(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(secret), oauth_query: loginPage.search.slice(1) },
      challengeCookie,
    );
    const verifyLocation = await expectContinuation(verify);
    expect(verifyLocation.pathname).toContain("/mcp-consent");
    const sessionCookie = cookieOf(verify);
    expect(sessionCookie).toContain("better-auth.session_token");

    const callback = await consentAccept(sessionCookie, verifyLocation);
    const tokens = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );
    expect(tokens.claims.sub).toEqual(expect.any(String));
  });

  it.todo(
    "row 6d — social-provider login continuation (needs-infra: an external IdP; SSO is not configured in this stack)",
  );

  // -------------------------------------------------------------------------
  // Gap row 8: rolling refresh expiry + cached-retry window, compressed via
  // a TEST-CONSTRUCTED production-shaped auth instance with short lifetimes.
  // -------------------------------------------------------------------------

  // Compressed lifetimes (production: 600 / 259200 / 30 seconds). All three
  // are mcp() options — no production constant is weakened for any row.
  //
  // SIZING (R118 finding 9; R119 F5-adjacent; R120 F5 margin math,
  // qualified per R121 S2 / R124 F2):
  // pass-2's 10/20/6 s scheduled row 8's rotation 6 s before the refresh
  // deadline — an injected 6.5 s scheduling delay flipped the 200 to a 400
  // invalid_grant with no behavior change. The timed windows now carry
  // margins computed against a component-cost ESTIMATE (NOT a proven
  // worst-case bound):
  //   timestamp truncation <= 1 s (second-resolution exp/iat claims)
  //   + DB round trips        ~0.1 s (Prisma writes, local PG)
  //   + EdDSA signing         ~0.05 s
  //   + loopback HTTP         ~0.05 s   =>  ~1.2 s estimated cost.
  // 10/30/10 s with rotation at e1-15 s (mid-window) leaves the rotation a
  // 15 s margin — 13.8 s of pause tolerance (> 2x the injected 6.5 s delay
  // class), the inside-window cached replay ~9.5 s of slack, and the
  // rolling-extension assertion e2 >= e1 + 8 s a 7 s cushion. Every timed
  // wait is computed FROM ROW TIMESTAMPS (expiresAt / iat), so a pause can
  // only consume slack — but a pause LONGER than a token's remaining
  // lifetime before an asserted-success call can still flip that verdict
  // (accepted residual: eliminating it would need a fake clock around the
  // installed verifier, which this production-shaped instance deliberately
  // does not use).
  const SHORT_ACCESS_SECONDS = 10;
  const SHORT_REFRESH_SECONDS = 30;
  const SHORT_REUSE_SECONDS = 10;

  /**
   * Lifetimes for the BARRIER origins (rows 12-15): these rows park
   * issuances/requests behind barriers whose failure allowance
   * (`barrierDeadline`, 30 s) runs while tokens minted BEFORE the park are
   * still expected to be judgeable at /mcp AFTER release. A 10 s access TTL
   * made every post-barrier 403-vs-401 assertion scheduling-sensitive
   * (R120 F5: "barrier waits run while access-token timestamps are already
   * captured"); 300 s of access lifetime excludes the barrier time from the
   * lineage entirely, and 60 s of reuse window makes the post-revoke
   * cached-retry leg (row 13(c)) deterministic instead of a race against a
   * 6 s window.
   */
  const BARRIER_ORIGIN_TTL = { accessSeconds: 300, refreshSeconds: 600, reuseSeconds: 60 };

  /** The lifetimes `buildShortTtlAuth` mints with. */
  interface ShortTtl {
    accessSeconds: number;
    refreshSeconds: number;
    reuseSeconds: number;
  }

  /**
   * Test-controlled gate placed INSIDE the claims-hook seam of a
   * TEST-CONSTRUCTED auth instance (rows 13/15 — the same seam the short
   * TTL overrides use; NO production mechanism is added). The wrapped
   * `extensions[].claims.accessToken` hook resolves the REAL
   * `issueMcpGrantClaims` (the grant check) and parks the issuance at the
   * configured point until the test releases it:
   *
   * - "entry": paused at hook entry — AFTER the reference is in hand
   *   (discovery) but BEFORE the grant check. Used to order a revoke
   *   between discovery and the grant decision.
   * - "after-grant-check": paused AFTER `issueMcpGrantClaims` resolved
   *   (grant check passed, claims computed) but BEFORE the provider writes
   *   any token — exactly the production race window between the claim
   *   decision (mcp-grant.ts) and the provider token writes.
   *
   * `parties > 1` turns the gate into a rendezvous: waiters are released
   * only once that many issuances are parked (row 13(c)'s synchronized
   * concurrent refresh — both requests genuinely AT the rotation-CAS
   * boundary, not merely fired inside one Promise.all).
   *
   * The barrier starts INERT (`activate()` arms it) so the origin's SETUP
   * issuances — sign-up, the first code exchange, the warmup control —
   * pass through untouched; only requests fired AFTER activation park.
   */
  interface ClaimHookBarrier {
    mode: "entry" | "after-grant-check";
    parties: number;
    /** Arm the barrier: only subsequent hook invocations park and count. */
    activate(): void;
    /** Hook-entry marker (test fires the request, then awaits `entered`). */
    markEntered(): void;
    /** Grant-check-completed marker (test awaits `grantChecked`). */
    markGrantChecked(): void;
    /** Blocks the wrapped hook until `open()` (rendezvous: until parties). */
    awaitGate(): Promise<void>;
    entered(count: number): Promise<void>;
    grantChecked(count: number): Promise<void>;
    /** Releases every waiter (idempotent). */
    open(): void;
    counts: { entered: number; grantChecked: number };
  }

  function createClaimHookBarrier(mode: ClaimHookBarrier["mode"], parties = 1): ClaimHookBarrier {
    const counts = { entered: 0, grantChecked: 0 };
    let active = false;
    let opened = false;
    const gateWaiters: Array<() => void> = [];
    const enteredWaiters: Array<{ count: number; resolve: () => void }> = [];
    const checkedWaiters: Array<{ count: number; resolve: () => void }> = [];
    const settle = (have: number, waiters: Array<{ count: number; resolve: () => void }>) => {
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (have >= waiters[index]!.count) {
          waiters[index]!.resolve();
          waiters.splice(index, 1);
        }
      }
    };
    const barrier: ClaimHookBarrier = {
      mode,
      parties,
      counts,
      activate() {
        active = true;
      },
      markEntered() {
        if (!active) return;
        counts.entered += 1;
        settle(counts.entered, enteredWaiters);
      },
      markGrantChecked() {
        if (!active) return;
        counts.grantChecked += 1;
        settle(counts.grantChecked, checkedWaiters);
        if (parties > 1 && counts.grantChecked >= parties) barrier.open();
      },
      awaitGate: async () => {
        if (!active || opened) return;
        await new Promise<void>((resolve) => gateWaiters.push(resolve));
      },
      entered: (count) =>
        counts.entered >= count
          ? Promise.resolve()
          : new Promise<void>((resolve) => enteredWaiters.push({ count, resolve })),
      grantChecked: (count) =>
        counts.grantChecked >= count
          ? Promise.resolve()
          : new Promise<void>((resolve) => checkedWaiters.push({ count, resolve })),
      open: () => {
        opened = true;
        for (const release of gateWaiters.splice(0)) release();
      },
    };
    return barrier;
  }

  /**
   * Lazy loader for `@ws-model-proxy/auth/mcp-config`: its module scope
   * captures `MCP_RESOURCE_URL = canonicalMcpResource(env.BETTER_AUTH_URL)`
   * AT IMPORT TIME, so it must never be imported before the loopback port
   * reservation has fixed `state.baseUrl` (a static import here would bake
   * the placeholder origin into every /mcp resource challenge).
   */
  function loadMcpConfig(): Promise<typeof import("@ws-model-proxy/auth/mcp-config")> {
    mcpConfigPromise ??= import("@ws-model-proxy/auth/mcp-config");
    return mcpConfigPromise;
  }

  async function buildShortTtlAuth(
    base2: string,
    barrier?: ClaimHookBarrier,
    ttl: ShortTtl = {
      accessSeconds: SHORT_ACCESS_SECONDS,
      refreshSeconds: SHORT_REFRESH_SECONDS,
      reuseSeconds: SHORT_REUSE_SECONDS,
    },
  ): Promise<AuthLike> {
    // Loaded lazily (see loadMcpConfig): import order determines the
    // captured resource origin.
    const { MCP_CONSENT_PAGE_PATH_DEFAULT, MCP_LOGIN_PAGE_PATH_DEFAULT, MCP_SCOPES } =
      await loadMcpConfig();
    // Computed BEFORE the instance construction (identical value; the
    // hoisted shape keeps the resource a plain captured string).
    const shortResource = `${base2}/mcp`;
    const buildPlugin = (): ReturnType<typeof mcp> =>
      mcp({
        resource: shortResource,
        loginPage: MCP_LOGIN_PAGE_PATH_DEFAULT,
        consentPage: MCP_CONSENT_PAGE_PATH_DEFAULT,
        postLogin: createMcpPostLoginOptions({
          secret: state.secret,
          loginPage: MCP_LOGIN_PAGE_PATH_DEFAULT,
        }),
        scopes: [...MCP_SCOPES],
        clientRegistrationRequirePKCE: true,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: ttl.accessSeconds,
        refreshTokenExpiresIn: ttl.refreshSeconds,
        refreshTokenReuseInterval: ttl.reuseSeconds,
        enforcePerClientResources: true,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        extensions: [
          {
            claims: {
              accessToken: async (input: {
                grantType?: string | undefined;
                user?: { id?: string | undefined } | null;
                client: { clientId: string };
                sessionId?: string | null | undefined;
                referenceId?: string | undefined;
              }) => {
                barrier?.markEntered();
                if (barrier?.mode === "entry") await barrier.awaitGate();
                const claims = await issueMcpGrantClaims({
                  grantType: input.grantType,
                  userId: input.user?.id,
                  clientId: input.client.clientId,
                  referenceId: input.referenceId,
                  sessionId: input.sessionId,
                  secret: state.secret,
                });
                barrier?.markGrantChecked();
                if (barrier?.mode === "after-grant-check") await barrier.awaitGate();
                return claims;
              },
            },
          },
        ],
      });
    // NOTE: the plugin is built through this inner arrow purely so the
    // lazy-loaded constants above stay in scope; the construction shape
    // itself has been stable since pass 1.
    const shortPlugin = buildPlugin();
    const instance = betterAuth({
      database: prismaAdapter(db, { provider: "postgresql" }),
      baseURL: base2,
      secret: state.secret,
      trustedOrigins: [base2],
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      plugins: [jwt({ disableSettingJwtHeader: true }), shortPlugin],
    });
    return instance as unknown as AuthLike;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sleep until an absolute wall-clock target derived from a ROW TIMESTAMP
   * (never a fixed duration): if scheduling already burned past the target,
   * proceed immediately, so a pause only consumes the target's slack
   * (R118 finding 9). Qualified per R121 S2 / R124 F2: this protects the
   * WAIT side only — an expiry-shaped assertion stays pause-safe (later is
   * still expired), while an asserted-SUCCESS call after a pause longer
   * than the token's remaining lifetime can still flip; see the row-8
   * sizing comment for the accepted residual.
   */
  async function sleepUntil(targetMs: number): Promise<void> {
    const remaining = targetMs - Date.now();
    if (remaining > 0) await sleep(remaining);
  }

  /** Byte-identical cached-rotation comparison (two minted sets). */
  function sameTokenSet(
    left: { access_token: string; refresh_token: string },
    right: { access_token: string; refresh_token: string },
  ): boolean {
    return left.access_token === right.access_token && left.refresh_token === right.refresh_token;
  }

  /**
   * Row lookup key for a presented (raw) refresh token. The installed
   * oauth-provider stores every token HASHED by default (`storeTokens:
   * "hashed"` → base64url(SHA-256(ASCII(token))), the factory default in
   * authorize-*.mjs + storeToken in utils), so DB lookups by a response
   * token must go through this derivation. (Pass 1's single lookup-by-
   * raw-token in row 7 was vacuously green: `findUnique` returned null and
   * the optional-chained assertions compared `undefined` against null.)
   */
  function storedTokenHash(rawToken: string): string {
    return createHash("sha256").update(rawToken).digest("base64url");
  }

  /**
   * Barrier waits fail LOUDLY: a request that never reaches the seam
   * (rejected upstream of the claims hook) would otherwise park the test
   * until its timeout — this converts that into a named error.
   */
  async function barrierDeadline(signal: Promise<void>, label: string): Promise<void> {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`barrier signal not reached: ${label}`)),
          30_000,
        ).unref?.();
      }),
    ]);
  }

  it("row 8 — short-TTL instance: rolling refresh expiry, cached-retry window (compressed), and expired access tokens stop passing /mcp", async () => {
    // A SECOND loopback origin keeps this instance's issuer/JWKS URL
    // distinct (the installed verifier caches JWKS by URL for 300s). The
    // port is kernel-assigned via bind(0), and the BIND RETRIES on
    // EADDRINUSE with a FULL reconstruction of the origin-bound instance
    // (R119 F6 + R120 F7: this listener is a rebuildable test factory,
    // exactly like launchShortOrigin's retry).
    let base2Port = reserveLoopbackPort();
    let BASE2 = `http://127.0.0.1:${base2Port}`;
    let CANONICAL2 = `${BASE2}/mcp`;
    const suffix = crypto.randomUUID();
    const clientId = `short-ttl-${suffix}`;
    const email = `short-ttl-${suffix}@example.test`;
    const password = "short-ttl-password-123";

    // Request-time env readers (the /mcp canonical-authority boundary) must
    // judge the second origin; restored on exit.
    state.activeBaseUrl = BASE2;
    try {
      let shortApp: RequestIdApp | undefined;
      for (let attempt = 0; ; attempt += 1) {
        try {
          shortApp = await buildOAuthApp(await buildShortTtlAuth(BASE2), {
            withMcp: true,
            baseUrl: BASE2,
          });
          shortListener = await serveLoopback(shortApp, base2Port);
          break;
        } catch (error) {
          shortListener?.close();
          state.activeBaseUrl = undefined;
          if (attempt >= 2 || !isAddrInUse(error)) throw error;
          base2Port = reserveLoopbackPort();
          BASE2 = `http://127.0.0.1:${base2Port}`;
          CANONICAL2 = `${BASE2}/mcp`;
          state.activeBaseUrl = BASE2;
        }
      }
      // Client + resource link under the SECOND canonical resource. The
      // short instance's provider can seed the resource row concurrently
      // with this upsert — both paths converge on the unique identifier, so
      // a P2002 here simply means the row already exists.
      try {
        await db.oauthResource.upsert({
          where: { identifier: CANONICAL2 },
          create: { identifier: CANONICAL2, name: "WS Model Proxy MCP (short TTL)" },
          update: {},
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      await db.oauthClient.create({
        data: {
          clientId,
          name: `Integration client ${clientId}`,
          tokenEndpointAuthMethod: "none",
          redirectUris: [CALLBACK],
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          scopes: ["mcp:read", "mcp:write", "offline_access"],
          skipConsent: true,
          requirePKCE: true,
          disabled: false,
        },
      });
      await db.oauthClientResource.create({
        data: { clientId, resourceId: CANONICAL2 },
      });

      // Helpers bound to the second origin (authorize URL form is origin-
      // independent; token/exchange simply target shortApp).
      const authorize2 = async (sessionCookie: string, scope: string): Promise<string> => {
        const res = await shortApp.request(`${BASE2}/api/auth/oauth2/authorize`, {
          method: "POST",
          headers: { "content-type": FORM, origin: BASE2, cookie: sessionCookie },
          body: authorizeForm({
            ...baseAuthorizeParams(clientId),
            scope,
            resource: CANONICAL2,
          }),
        });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location")!, BASE2);
        expect(location.origin + location.pathname).toBe(CALLBACK);
        return location.searchParams.get("code")!;
      };
      const token2 = async (form: URLSearchParams): Promise<Response> =>
        await shortApp!.request(`${BASE2}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": FORM },
          body: form,
        });
      const mcp2 = (accessToken: string, id: number) =>
        shortApp!.request(`${BASE2}/mcp`, {
          method: "POST",
          headers: {
            "content-type": JSON_TYPE,
            accept: "application/json",
            host: new URL(BASE2).host,
            "mcp-method": "tools/list",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "oauth-mcp-it", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });

      // Sign up directly on the short instance (no email verification is
      // configured there — the session cookie is issued immediately).
      const signup = await shortApp!.request(`${BASE2}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": JSON_TYPE, origin: BASE2 },
        body: JSON.stringify({ name: "Short TTL", email, password }),
      });
      expect(signup.status).toBe(200);
      const cookie = cookieOf(signup);

      // WARMUP BEFORE ANY MINT ON THIS INSTANCE (R120 F5 + R121 S2: the
      // pass-3 warmup ran after the first mint, so that mint — and any
      // latency it absorbed — still preceded the cache being hot): a
      // THROWAWAY lineage mints an untimed token FIRST, and its /mcp
      // admission warms the verifier's JWKS HTTP fetch and the DB pool —
      // every mint below (first, second, lineage2) starts with a hot
      // cache, so cold-start latency does not eat into a timed window
      // (qualified per R124 F2: an ordinary warm-cache admission is not
      // zero-cost, only cold-start-free; the sizing comment's residual
      // still applies). The warmup lineage is then abandoned (nothing
      // below counts clientId rows).
      const warmup = await parseTokenResponse(
        await token2(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: await authorize2(cookie, "mcp:read offline_access"),
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      expect((await mcp2(warmup.accessToken, 1003)).status).toBe(200);

      const first = await parseTokenResponse(
        await token2(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: await authorize2(cookie, "mcp:read offline_access"),
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      expect((first.claims.exp as number) - (first.claims.iat as number)).toBe(
        SHORT_ACCESS_SECONDS,
      );

      const refreshForm = (refreshToken: string) =>
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        });

      // ---------------------------------------------------------------------------
      // REFRESH-EXPIRY PROOF ON A PRESENT, UNREVOKED TOKEN (R117/R118: the
      // pass-1 expiry wait ran AFTER a family-killing ancestor replay, so it
      // proved missing-token rejection, not expiry — and a 3600 s refresh
      // TTL mutation still passed). This row NEVER replays the ancestor
      // outside its reuse window before the expiry wait: nothing here can
      // delete the lineage. The token row's OWN timestamps drive every wait.
      // ---------------------------------------------------------------------------
      const rt1Row = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(first.refreshToken) },
      });
      const e1 = rt1Row.expiresAt.getTime();
      expect(rt1Row.revoked).toBeNull(); // present AND active before any wait
      expect(e1).toBeGreaterThan(Date.now()); // not yet expired

      // ROLLING EXTENSION: rotate NEAR THE MIDDLE of the refresh window
      // (15 s before a 30 s deadline) and assert the NEW deadline moved
      // past the original one — activity extends the expiry (a non-rolling
      // provider keeping the ORIGINAL absolute deadline would fail this by
      // e2 - e1 <= 0; mutation prediction, see pass-2 notes).
      // MARGIN MATH (R120 F5, qualified per R121 S2): the ~1.2 s figure is
      // an ESTIMATE of component costs (truncation <= 1 s + DB writes
      // ~0.1 s + EdDSA signing ~0.05 s + loopback HTTP ~0.05 s), not a
      // proven worst-case bound — the honest guarantee is the tolerated
      // SCHEDULING PAUSE: a 15 s margin leaves ~13.8 s of pause tolerance,
      // more than 2x the reviewers' injected 6.5 s delay class (pass-2's
      // 6 s margin flipped under exactly that probe). A pause longer than
      // the remaining token lifetime before an asserted-success call can
      // still flip the row; eliminating that entirely would need a fake
      // clock around the installed verifier, which the production-shaped
      // instance deliberately does not use.
      await sleepUntil(e1 - 15_000);
      const second = await parseTokenResponse(await token2(refreshForm(first.refreshToken)));
      expect(second.refreshToken).not.toBe(first.refreshToken);
      const rt2Row = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(second.refreshToken) },
      });
      const e2 = rt2Row.expiresAt.getTime();
      expect(e2).toBeGreaterThanOrEqual(e1 + 8_000); // deadline EXTENDED, not kept
      const rt1AfterRotation = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(first.refreshToken) },
      });
      expect(rt1AfterRotation.revoked).not.toBeNull(); // rotation revoked RT1

      // The fresh access token passes /mcp while valid (also the row-8
      // valid-admission control) — IMMEDIATELY after the mint so its own
      // 10 s window carries the full margin.
      expect((await mcp2(second.accessToken, 1001)).status).toBe(200);

      // WITHIN the reuse window RT1 replays the CACHED rotation (the
      // "accepted inside" half of the boundary; row 7 pins production
      // scale, this measures the compressed window end-to-end). The replay
      // fires < 1 s after the rotation against a 10 s window.
      const cachedReplay = await parseTokenResponse(await token2(refreshForm(first.refreshToken)));
      expect(
        sameTokenSet(
          { access_token: cachedReplay.accessToken, refresh_token: cachedReplay.refreshToken },
          { access_token: second.accessToken, refresh_token: second.refreshToken },
        ),
      ).toBe(true);

      // ACCESS EXPIRY: past AT2's own iat + SHORT_ACCESS the token no longer
      // passes /mcp (the installed challenge answers with the discovery
      // document). The wait is computed from the token's iat.
      await sleepUntil(((second.claims.iat as number) + SHORT_ACCESS_SECONDS + 1) * 1000);
      const expired = await mcp2(second.accessToken, 1002);
      expect(expired.status).toBe(401);
      expect(expired.headers.get("www-authenticate")).toContain("resource_metadata");

      // REFRESH EXPIRY on the PRESENT token: RT2's row still exists right
      // up to and past its own deadline; the rejection that follows is
      // expiry, not absence.
      expect(
        await db.oauthRefreshToken.findUnique({
          where: { token: storedTokenHash(second.refreshToken) },
        }),
      ).not.toBeNull();
      await sleepUntil(e2 + 1_000);
      const expiredRefresh = await token2(refreshForm(second.refreshToken));
      expect([400, 401]).toContain(expiredRefresh.status);
      expect(((await expiredRefresh.json()) as { error: string }).error).toBe("invalid_grant");
      // The row was PRESENT and expired at rejection time — the rejection
      // reason is the deadline, and the row is retained afterwards.
      const rt2Expired = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(second.refreshToken) },
      });
      expect(rt2Expired.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

      // ---------------------------------------------------------------------------
      // REUSE-WINDOW BOUNDARY on a DEDICATED lineage (nothing before this
      // measured the outside edge): a fresh code exchange mints RT1b; its
      // cached replay inside the window is ACCEPTED, and the same replay
      // past the row's OWN rotationReplayExpiresAt is REJECTED. Placed last
      // because the outside-window rejection wipes the token family
      // (installed invalidateRefreshFamily) — terminal for the lineage.
      // ---------------------------------------------------------------------------
      const lineage2 = await parseTokenResponse(
        await token2(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: await authorize2(cookie, "mcp:read offline_access"),
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      const rotated2 = await parseTokenResponse(await token2(refreshForm(lineage2.refreshToken)));
      const inside = await parseTokenResponse(await token2(refreshForm(lineage2.refreshToken)));
      expect(
        sameTokenSet(
          { access_token: inside.accessToken, refresh_token: inside.refreshToken },
          { access_token: rotated2.accessToken, refresh_token: rotated2.refreshToken },
        ),
      ).toBe(true); // accepted INSIDE the window (cached)
      const rt1bRow = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(lineage2.refreshToken) },
      });
      expect(rt1bRow.rotationReplayExpiresAt).not.toBeNull();
      await sleepUntil(rt1bRow.rotationReplayExpiresAt!.getTime() + 1_000);
      const outside = await token2(refreshForm(lineage2.refreshToken));
      expect([400, 401]).toContain(outside.status); // rejected OUTSIDE the window
      expect(((await outside.json()) as { error: string }).error).toBe("invalid_grant");
    } finally {
      state.activeBaseUrl = undefined;
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Gap row 9: authenticated /mcp SDK tool calls (READ / WRITE / DESTRUCTIVE)
  // through the installed streamable-HTTP handler and the real router.
  // -------------------------------------------------------------------------

  /** One modern (2026-07-28) JSON-RPC exchange against POST /mcp. */
  async function mcpToolCall(
    accessToken: string | undefined,
    method: string,
    params: Record<string, unknown>,
    id: number | string = 1,
    target: RequestIdApp = app,
  ): Promise<Response> {
    return await target.request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": JSON_TYPE,
        accept: "application/json",
        // The canonical-authority boundary requires an explicit canonical
        // Host header (Hono's app.request() does not synthesize one).
        host: new URL(BASE).host,
        // The 2026-07-28 wire requires header/body agreement: Mcp-Method
        // with the body method, Mcp-Name with params.name when present
        // (validateStandardRequestHeaders mismatch -32020).
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "oauth-mcp-it", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  interface McpToolCallResult {
    isError?: boolean;
    structuredContent?: { result?: unknown } & Record<string, unknown>;
  }

  async function expectToolOk(res: Response, id: number | string): Promise<unknown> {
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number | string;
      result?: McpToolCallResult;
      error?: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(id);
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    return body.result?.structuredContent?.result;
  }

  it("row 9 — authenticated /mcp tool calls: READ (app config + pools list), WRITE (pool create), DESTRUCTIVE (pool delete behind confirm), and scope denial stays in-band", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `tools-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: true });
    const cookie = await signUpVerifiedUser(`tools-${suffix}@example.test`, "tools-password-123");

    const tokens = await mintTokens(cookie, clientId, "mcp:read mcp:write offline_access");

    // Unauthenticated requests get the RFC 6750/9728 challenge, not a tool run.
    const anonymous = await mcpToolCall(undefined, "tools/list", {}, 901);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("resource_metadata");

    // tools/list: the full manifest through the real registration seam.
    const list = await mcpToolCall(tokens.accessToken, "tools/list", {}, 902);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (listBody.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("app_config_get");
    expect(names).toContain("forwarder_model_pools_list");
    expect(names).toContain("forwarder_model_pool_create");
    expect(names).toContain("forwarder_model_pool_delete");

    // READ: app_config_get (public config through the synthetic session).
    const config = (await expectToolOk(
      await mcpToolCall(
        tokens.accessToken,
        "tools/call",
        {
          name: "app_config_get",
          arguments: {},
        },
        903,
      ),
      903,
    )) as { signupEnabled: boolean };
    expect(config.signupEnabled).toBe(true);

    // READ: pools list starts empty for this fresh user.
    const poolsBefore = (await expectToolOk(
      await mcpToolCall(
        tokens.accessToken,
        "tools/call",
        {
          name: "forwarder_model_pools_list",
          arguments: {},
        },
        904,
      ),
      904,
    )) as unknown[];
    expect(Array.isArray(poolsBefore)).toBe(true);

    // WRITE: create a pool owned by the verified sub.
    const slug = `it-pool-${suffix.replace(/-/g, "").slice(0, 12)}`;
    const created = (await expectToolOk(
      await mcpToolCall(
        tokens.accessToken,
        "tools/call",
        {
          name: "forwarder_model_pool_create",
          arguments: {
            slug,
            name: "Integration pool",
            maxAttachmentBytes: 25 * 1024 * 1024,
          },
        },
        905,
      ),
      905,
    )) as { id: string; slug: string };
    expect(created.slug).toBe(slug);
    const poolRow = await db.modelPool.findUnique({ where: { id: created.id } });
    expect(poolRow?.slug).toBe(slug);

    // DESTRUCTIVE: delete behind the confirm literal; the row is gone.
    const deleted = (await expectToolOk(
      await mcpToolCall(
        tokens.accessToken,
        "tools/call",
        {
          name: "forwarder_model_pool_delete",
          arguments: { id: created.id, confirm: "DELETE" },
        },
        906,
      ),
      906,
    )) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
    expect(await db.modelPool.findUnique({ where: { id: created.id } })).toBeNull();

    // Scope denial is IN-BAND: a read-only token still passes the endpoint
    // baseline (read satisfied) but the write tool refuses with the stable
    // INSUFFICIENT_SCOPE error — no procedure runs.
    const readOnly = await mintTokens(cookie, clientId, "mcp:read offline_access");
    const denied = await mcpToolCall(
      readOnly.accessToken,
      "tools/call",
      {
        name: "forwarder_model_pool_create",
        arguments: { slug: `${slug}-denied`, name: "Denied", maxAttachmentBytes: 1024 * 1024 },
      },
      907,
    );
    expect(denied.status).toBe(200);
    const deniedBody = (await denied.json()) as {
      result?: McpToolCallResult;
    };
    expect(deniedBody.result?.isError).toBe(true);
    expect(deniedBody.result?.structuredContent?.error).toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScope: "mcp:write",
    });
    expect(await db.modelPool.findFirst({ where: { slug: `${slug}-denied` } })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Shared helpers for rows 10-16 (DPoP, human grant router, second
  // origins, barriers, reauthorization, preflight).
  // -------------------------------------------------------------------------

  /**
   * Human-side router client (rows 11, 13, 14): the same
   * createRouterClient(appRouter) path production uses, with the LIVE full
   * Prisma user row in a synthetic session — the ownership checks read
   * context.session.user.id exactly like a browser-session request would.
   * The oRPC/router modules are imported LAZILY so skip-mode runs never
   * load the appRouter chain (and through it the auth instance).
   */
  async function humanGrantsClient(email: string) {
    const [{ createRouterClient }, { appRouter }, { createMcpContext }] = await Promise.all([
      import("@orpc/server"),
      import("@ws-model-proxy/api/routers/index"),
      import("./context"),
    ]);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return createRouterClient(appRouter, {
      context: createMcpContext({
        user,
        expiresAt: new Date(Date.now() + 3_600_000),
        now: new Date(),
        services: undefined,
      }),
    });
  }

  /** Revoke one connection through the REAL router procedure. */
  async function revokeConnection(email: string, clientRecordId: string): Promise<void> {
    const grants = await humanGrantsClient(email);
    const result = await grants.mcpGrants.revokeMine({
      clientRecordId,
      confirm: "REVOKE",
    });
    expect(result).toEqual({ revoked: true });
  }

  /** One modern tools/list envelope body (shared by the DPoP call helper). */
  function mcpListBody(id: number | string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "oauth-mcp-it", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  }

  /**
   * One /mcp tools/list call presenting the DPoP scheme plus an optional
   * proof header (rows 10 and 12 — the sender-constrained request shape).
   * The scheme defaults to DPoP; second-origin controls pass "Bearer".
   */
  async function mcpDpopCall(
    accessToken: string,
    proof: string | undefined,
    id: number | string,
    target: RequestIdApp = app,
    base: string = BASE,
    scheme: "DPoP" | "Bearer" = "DPoP",
  ): Promise<Response> {
    return await target.request(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": JSON_TYPE,
        accept: JSON_TYPE,
        host: new URL(base).host,
        "mcp-method": "tools/list",
        authorization: `${scheme} ${accessToken}`,
        ...(proof === undefined ? {} : { dpop: proof }),
      },
      body: mcpListBody(id),
    });
  }

  /**
   * A forged (attacker-signed) compact EdDSA JWT with ONE corrupted
   * signature bit (row 12's signature-negative). The header names the REAL
   * production JWKS kid and alg — jose selects verification keys by
   * alg+kid, and row 12 PROVES selection succeeds by verifying the REAL
   * production token against the very same imported JWKS key — so the ONLY
   * defect is the signature itself: nothing upstream of signature
   * verification can reject this token.
   * (R119 finding 3 / R120 finding 4: the pass-2 fixture was ES256 while
   * naming the production kid, so jose died at KEY SELECTION with
   * ERR_JWKS_NO_MATCHING_KEY and a verifier with broken signature checking
   * still rejected it.) The single flipped bit additionally guarantees the
   * signature is corrupt even in the impossible case the attacker key
   * matched the JWKS key material.
   */
  async function mintForgedEdDsaJwt(
    key: Ed25519KeyPair,
    payload: Record<string, unknown>,
    kid?: string,
  ): Promise<string> {
    const header = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          alg: "EdDSA",
          typ: "JWT",
          ...(kid === undefined ? {} : { kid }),
        }),
      ),
    );
    const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = await signEd25519(
      key.privateCryptoKey,
      new TextEncoder().encode(`${header}.${body}`),
    );
    signature[0]! ^= 0b0000_0001; // exactly ONE defect: a corrupted signature
    return `${header}.${body}.${toBase64Url(signature)}`;
  }

  /**
   * Test-controlled request-entry gate (row 13(b)): pauses /api/auth
   * requests BEFORE the auth handler runs. Needed because the installed
   * token endpoint CONSUMES (deletes) the authorization-code verification
   * row before the claims hook runs, so a claims-hook pause can no longer
   * exercise the revoke's pending-code enumeration — the code must still be
   * UNCONSUMED when the revoke scans for it.
   */
  interface RequestEntryGate {
    /** Arm the gate: only subsequent /api/auth requests park. */
    activate: () => void;
    wait: () => Promise<void>;
    open: () => void;
    arrived: (count: number) => Promise<void>;
  }

  function createRequestEntryGate(): RequestEntryGate {
    const barrier = createClaimHookBarrier("entry");
    return {
      activate: () => barrier.activate(),
      // The gate's wait IS the arrival point (unlike the claims-hook
      // barrier, whose hook marks entry itself): mark it so arrived()
      // resolves for parked requests.
      wait: () => {
        barrier.markEntered();
        return barrier.awaitGate();
      },
      open: () => barrier.open(),
      arrived: (count) => barrier.entered(count),
    };
  }

  /** A fresh loopback origin running the SHORT-TTL instance (rows 8-15). */
  interface ShortOrigin {
    app: RequestIdApp;
    base: string;
    canonical: string;
    clientId: string;
    email: string;
    /** The claims-hook barrier when one was injected (rows 13/15). */
    barrier: ClaimHookBarrier | undefined;
    /** Form POST to this origin's token endpoint (optional DPoP proof). */
    token: (form: URLSearchParams, dpopProof?: string) => Promise<Response>;
    /** One modern tools/list call against this origin's /mcp. */
    mcp: (accessToken: string, id: number | string) => Promise<Response>;
    /** Sign a fresh user up on this origin; returns the session cookie. */
    signUp: (password: string) => Promise<string>;
    /** Sign IN again (a SECOND browser session: a fresh grant generation). */
    signIn: (password: string) => Promise<string>;
    /** authorize → callback code for this origin's (or an overridden) resource. */
    authorize: (sessionCookie: string, scope: string, resource?: string) => Promise<string>;
    /**
     * authorize THROUGH THE CONSENT PAGE → callback code (consent-flow
     * clients only): the consent ACCEPT persists the remembered-consent row
     * carrying this session's reference id — the artifact row 13(d)'s
     * revoke collects the fresh generation from.
     */
    authorizeWithConsent: (sessionCookie: string, scope: string) => Promise<string>;
    /**
     * Stop the origin (R119/R120: barrier cleanup must RELEASE every gate
     * and SETTLE parked requests). Async: releases the barrier + request
     * gate (both idempotent), drains every in-flight origin request with a
     * BOUNDED wait, then closes the listener and restores the request-time
     * env origin. Called from finally blocks on success, failure, AND
     * timeout paths.
     */
    stop: () => Promise<void>;
  }

  async function launchShortOrigin(options?: {
    barrier?: ClaimHookBarrier;
    requestGate?: RequestEntryGate;
    /** Extra accepted authorize target BASES (TEST-ONLY; see buildOAuthApp). */
    authorizeTargetBases?: string[];
    /**
     * Consent-flow client (row 13(d)): the authorize round trip goes
     * through the consent page and persists an oauthConsent row carrying
     * the session's reference id. Default: skip-consent (no consent row
     * ever — load-bearing for rows 13(b)/(e), where a pending code is a
     * fresh generation's only artifact).
     */
    consentFlow?: boolean;
    /** Lifetimes; defaults to the barrier-origin TTLs (see BARRIER_ORIGIN_TTL). */
    ttl?: ShortTtl;
  }): Promise<ShortOrigin> {
    const suffix = crypto.randomUUID();
    const clientId = `origin2-${suffix}`;
    const email = `origin2-${suffix}@example.test`;
    // Kernel-assigned port via bind(0) + full reconstruction retry on
    // EADDRINUSE (the auth instance is origin-bound, so a port change
    // means rebuilding the instance — cheap for these test factories; the
    // MAIN listener retries at bind time before its auth import instead).
    let app2: RequestIdApp | undefined;
    let server: ServerType | undefined;
    let base = "";
    for (let attempt = 0; ; attempt += 1) {
      const port = reserveLoopbackPort();
      const candidateBase = `http://127.0.0.1:${port}`;
      // Request-time env readers (the /mcp canonical-authority boundary)
      // must judge this origin while it runs.
      state.activeBaseUrl = candidateBase;
      try {
        app2 = await buildOAuthApp(
          await buildShortTtlAuth(
            candidateBase,
            options?.barrier,
            options?.ttl ?? BARRIER_ORIGIN_TTL,
          ),
          {
            withMcp: true,
            baseUrl: candidateBase,
            requestGate: options?.requestGate,
            authorizeTargetBases: options?.authorizeTargetBases,
          },
        );
        server = await serveLoopback(app2, port);
        base = candidateBase;
        break;
      } catch (error) {
        server?.close();
        state.activeBaseUrl = undefined;
        if (attempt >= 2 || !isAddrInUse(error)) throw error;
      }
    }
    const canonical = `${base}/mcp`;
    try {
      // Resource + client link under this origin's canonical resource. The
      // short instance's provider can seed the resource row concurrently
      // with this upsert — both paths converge on the unique identifier.
      try {
        await db.oauthResource.upsert({
          where: { identifier: canonical },
          create: { identifier: canonical, name: "WS Model Proxy MCP (origin 2)" },
          update: {},
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      await db.oauthClient.create({
        data: {
          clientId,
          name: `Integration client ${clientId}`,
          tokenEndpointAuthMethod: "none",
          redirectUris: [CALLBACK],
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          scopes: ["mcp:read", "mcp:write", "offline_access"],
          // skipConsent DEFAULT: the code round trip never creates a
          // consent row — load-bearing for rows 13(b)/(e), where a PENDING
          // code of a fresh session is then the ONLY artifact of its
          // generation. consentFlow (row 13(d)) flips it off so the
          // consent ACCEPT persists the reference-carrying row instead.
          skipConsent: !(options?.consentFlow === true),
          requirePKCE: true,
          disabled: false,
        },
      });
      await db.oauthClientResource.create({ data: { clientId, resourceId: canonical } });
    } catch (error) {
      server?.close();
      state.activeBaseUrl = undefined;
      throw error;
    }
    // In-flight request tracking (R120 finding 6): every request fired
    // through this origin's helpers registers here so stop() can drain
    // parked requests after releasing the gates instead of leaving their
    // promises pending forever.
    const inFlight = new Set<Promise<unknown>>();
    const track = <T>(promise: Promise<T>): Promise<T> => {
      inFlight.add(promise);
      void promise.then(
        () => inFlight.delete(promise),
        () => inFlight.delete(promise),
      );
      return promise;
    };
    const originRequest = (path: string, init: RequestInit): Promise<Response> =>
      track(Promise.resolve(app2!.request(path, init)));
    const token = async (form: URLSearchParams, dpopProof?: string) =>
      await originRequest(`${base}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": FORM,
          ...(dpopProof === undefined ? {} : { dpop: dpopProof }),
        },
        body: form,
      });
    return {
      app: app2!,
      base,
      canonical,
      clientId,
      email,
      barrier: options?.barrier,
      token,
      mcp: (accessToken, id) =>
        track(mcpDpopCall(accessToken, undefined, id, app2!, base, "Bearer")),
      signUp: async (password) => {
        const res = await originRequest(`${base}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": JSON_TYPE, origin: base },
          body: JSON.stringify({ name: "Origin 2", email, password }),
        });
        expect(res.status, `origin2 sign-up for ${email}`).toBe(200);
        return cookieOf(res);
      },
      signIn: async (password) => {
        const res = await originRequest(`${base}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": JSON_TYPE, origin: base },
          body: JSON.stringify({ email, password }),
        });
        expect(res.status, `origin2 sign-in for ${email}`).toBe(200);
        const cookie = cookieOf(res);
        expect(cookie).toContain("better-auth.session_token");
        return cookie;
      },
      authorize: async (sessionCookie, scope, resource) => {
        const res = await originRequest(`${base}${AUTHORIZE}`, {
          method: "POST",
          headers: { "content-type": FORM, origin: base, cookie: sessionCookie },
          body: authorizeForm({
            ...baseAuthorizeParams(clientId),
            scope,
            resource: resource ?? canonical,
          }),
        });
        expect(res.status).toBe(302);
        const location = new URL(res.headers.get("location")!, base);
        expect(location.origin + location.pathname).toBe(CALLBACK);
        return location.searchParams.get("code")!;
      },
      authorizeWithConsent: async (sessionCookie, scope) => {
        const res = await originRequest(`${base}${AUTHORIZE}`, {
          method: "POST",
          headers: { "content-type": FORM, origin: base, cookie: sessionCookie },
          body: authorizeForm({
            ...baseAuthorizeParams(clientId),
            scope,
            resource: canonical,
          }),
        });
        expect(res.status).toBe(302);
        const consentPage = new URL(res.headers.get("location")!, base);
        expect(consentPage.pathname).toContain("/mcp-consent");
        const accept = await originRequest(`${base}${CONSENT}`, {
          method: "POST",
          headers: { "content-type": JSON_TYPE, origin: base, cookie: sessionCookie },
          body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
        });
        expect(accept.status).toBe(200);
        const json = (await accept.json()) as { redirect: boolean; url: string };
        expect(json.redirect).toBe(true);
        const callback = new URL(json.url, base);
        expect(callback.searchParams.get("code")).toBeTruthy();
        return callback.searchParams.get("code")!;
      },
      stop: async () => {
        // RELEASE every gate first (idempotent) so parked server-side
        // continuations can run to completion, then DRAIN every in-flight
        // origin request under a BOUNDED deadline — a released-but-hung
        // request can never hang the teardown.
        options?.barrier?.open();
        options?.requestGate?.open();
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise<void>((resolveDrain) => {
            setTimeout(resolveDrain, 5_000).unref?.();
          }),
        ]);
        server?.close();
        if (state.activeBaseUrl === base) state.activeBaseUrl = undefined;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Gap row 10: DPoP binding — bound client metadata, proof at the token
  // endpoint, cnf.jkt on the minted token, and the full /mcp proof matrix
  // (ath / htu / htm / key / expiry / replay; missing proof; wrong scheme).
  // -------------------------------------------------------------------------

  it("row 10 — DPoP-bound client: token-endpoint proof binds cnf.jkt; every invalid /mcp proof shape is rejected", async () => {
    const suffix = crypto.randomUUID();
    // R117/R118 finding 3a: the DPoP requirement must arrive through the
    // REAL CIMD metadata transport and be the ONLY enforcement path — the
    // client is NOT seeded directly, and NO authorize request carries the
    // `dpop_jkt` crutch (pass 1 supplied both, so either enforcement path
    // alone kept the test green when the other was broken).
    const clientId = `https://cimd-dpop-${suffix}.example.test/client.json`;
    registerCimdDocument(clientId, { dpop_bound_access_tokens: true });
    const cookie = await signUpVerifiedUser(`dpop-${suffix}@example.test`, "dpop-password-123");
    const key = await generateDpopKey();
    const otherKey = await generateDpopKey();

    // First use registers the client through the deterministic CIMD
    // transport; the document's dpop_bound_access_tokens: true is persisted
    // by the INSTALLED provider as the DEDICATED oauthClient column
    // (oauthToSchema maps it there — the token endpoint reads it back via
    // schemaToOauth's dpop_bound_access_tokens), which is the field the
    // token endpoint's client-required DPoP check consults.
    const consentPage = await authorizeExpectConsent(cookie, clientId, "mcp:read offline_access");
    const registeredClient = await db.oauthClient.findUniqueOrThrow({ where: { clientId } });
    expect(registeredClient.clientDiscoveryId).toBe("cimd");
    expect(registeredClient.dpopBoundAccessTokens).toBe(true);
    const noProofCallback = await consentAccept(cookie, consentPage);

    // A proof-less exchange is refused while the client demands DPoP —
    // with no dpop_jkt anywhere, client-required DPoP is the ONLY
    // enforcement path. MUTATION PREDICTION: drop dpop_bound_access_tokens
    // from the metadata document (leaving everything else identical) and
    // this same exchange SUCCEEDS — executed as a probe during pass-2
    // validation, flipping exactly this assertion (see pass-2 notes).
    const noProof = await exchangeCode({
      clientId,
      code: noProofCallback.searchParams.get("code")!,
      verifier: VERIFIER,
    });
    expect(noProof.status).toBe(400);
    expect(((await noProof.json()) as { error: string }).error).toBe("invalid_dpop_proof");

    // A proof whose htu names the /mcp endpoint instead of the token
    // endpoint is refused at the token endpoint (consent is remembered
    // now, so later legs go straight to the callback code).
    const wrongHtuUrl = await authorizeForCode(cookie, clientId, "mcp:read offline_access");
    const wrongHtuExchange = await exchangeCode({
      clientId,
      code: wrongHtuUrl.searchParams.get("code")!,
      verifier: VERIFIER,
      dpopProof: await createDpopProof({ method: "POST", uri: CANONICAL, key }),
    });
    expect(wrongHtuExchange.status).toBe(400);
    expect(((await wrongHtuExchange.json()) as { error: string }).error).toBe("invalid_dpop_proof");

    // Bound mint: proof at the token endpoint (htu = the token URL) binds
    // the key thumbprint into the token's cnf confirmation.
    const codeUrl = await authorizeForCode(cookie, clientId, "mcp:read offline_access");
    const tokens = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: codeUrl.searchParams.get("code")!,
        verifier: VERIFIER,
        dpopProof: await createDpopProof({ method: "POST", uri: `${BASE}${TOKEN}`, key }),
      }),
    );
    expect(tokens.tokenType).toBe("DPoP");
    expect((tokens.claims.cnf as { jkt?: string })?.jkt).toBe(key.jkt);

    // The bound refresh token also demands a proof at rotation time.
    const refreshNoProof = await refreshRequest({
      clientId,
      refreshToken: tokens.refreshToken,
    });
    expect(refreshNoProof.status).toBe(400);
    expect(((await refreshNoProof.json()) as { error: string }).error).toBe("invalid_dpop_proof");
    const refreshed = await parseTokenResponse(
      await refreshRequest({
        clientId,
        refreshToken: tokens.refreshToken,
        dpopProof: await createDpopProof({ method: "POST", uri: `${BASE}${TOKEN}`, key }),
      }),
    );
    expect((refreshed.claims.cnf as { jkt?: string })?.jkt).toBe(key.jkt);

    // /mcp matrix. Control: a valid ath-bound proof passes.
    const proof = (overrides: Partial<Parameters<typeof createDpopProof>[0]> = {}) =>
      createDpopProof({
        method: "POST",
        uri: CANONICAL,
        key,
        accessToken: tokens.accessToken,
        ...overrides,
      });
    const expectDpopChallenge = (res: Response, code: string) => {
      expect(res.status, `DPoP challenge ${code}`).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toMatch(/^DPoP /);
      expect(challenge).toContain(`error="${code}"`);
    };
    const ok = await mcpDpopCall(tokens.accessToken, await proof(), 2001);
    expect(ok.status).toBe(200);

    // Missing proof header entirely.
    expectDpopChallenge(
      await mcpDpopCall(tokens.accessToken, undefined, 2002),
      "invalid_dpop_proof",
    );

    // Bearer scheme on a bound token (sender-constraint enforcement).
    const bearer = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": JSON_TYPE,
        accept: JSON_TYPE,
        host: new URL(BASE).host,
        "mcp-method": "tools/list",
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: mcpListBody(2003),
    });
    expect(bearer.status).toBe(401);
    expect(bearer.headers.get("www-authenticate")).toContain('error="invalid_token"');

    // Wrong ath (hash of a different access token).
    expectDpopChallenge(
      await mcpDpopCall(
        tokens.accessToken,
        await proof({ accessToken: `not-${tokens.accessToken}` }),
        2004,
      ),
      "invalid_dpop_proof",
    );
    // Wrong htu (the token endpoint instead of /mcp).
    expectDpopChallenge(
      await mcpDpopCall(tokens.accessToken, await proof({ uri: `${BASE}${TOKEN}` }), 2005),
      "invalid_dpop_proof",
    );
    // Wrong htm.
    expectDpopChallenge(
      await mcpDpopCall(tokens.accessToken, await proof({ method: "GET" }), 2006),
      "invalid_dpop_proof",
    );
    // Different signing key than the bound cnf.jkt.
    expectDpopChallenge(
      await mcpDpopCall(tokens.accessToken, await proof({ key: otherKey }), 2007),
      "invalid_dpop_proof",
    );
    // Expired proof iat (default proof max age is 300 s).
    expectDpopChallenge(
      await mcpDpopCall(
        tokens.accessToken,
        await proof({ iat: Math.floor(Date.now() / 1000) - 400 }),
        2008,
      ),
      "invalid_dpop_proof",
    );
    // Replay: the SAME proof (same jti) succeeds once and only once.
    const replayedProof = await proof();
    expect((await mcpDpopCall(tokens.accessToken, replayedProof, 2009)).status).toBe(200);
    expectDpopChallenge(
      await mcpDpopCall(tokens.accessToken, replayedProof, 2010),
      "invalid_dpop_proof",
    );
  });

  // -------------------------------------------------------------------------
  // Gap row 11: human grant listing/revocation against real PG, through the
  // REAL router procedures (aggregation, exact projection, tombstone,
  // retention, idempotency, ownership hiding, and the live /mcp kill).
  // -------------------------------------------------------------------------

  it("row 11 — mcpGrants.listMine/revokeMine over real PG: aggregate projection, tombstoning, retention, idempotency, /mcp kill", async () => {
    const suffix = crypto.randomUUID();
    const clientA = `grants-a-${suffix}`;
    const clientB = `grants-b-${suffix}`;
    await seedPublicClient(clientA, { skipConsent: false });
    await seedPublicClient(clientB, { skipConsent: false });
    const email = `grants-${suffix}@example.test`;
    const cookie = await signUpVerifiedUser(email, "grants-password-123");
    const tokensA = await mintTokensWithConsent(
      cookie,
      clientA,
      "mcp:read mcp:write offline_access",
    );
    const tokensB = await mintTokensWithConsent(cookie, clientB, "mcp:read offline_access");

    // Aggregation: one connection card per client, exact safe projection.
    const grants = await humanGrantsClient(email);
    const connections = await grants.mcpGrants.listMine();
    expect(connections.map((c) => c.clientId).sort()).toEqual([clientA, clientB]);
    const a = connections.find((c) => c.clientId === clientA);
    expect(a).toBeDefined();
    expect(Object.keys(a!).sort()).toEqual(
      [
        "clientRecordId",
        "clientId",
        "name",
        "uri",
        "scopes",
        "firstAuthorizedAt",
        "lastAuthorizedAt",
        "rollingExpiryAt",
        "activeRefreshCount",
        "dpop",
      ].sort(),
    );
    expect(a!.scopes).toEqual(["mcp:read", "mcp:write", "offline_access"].sort());
    expect(a!.activeRefreshCount).toBeGreaterThanOrEqual(1);
    expect(a!.rollingExpiryAt).toBeInstanceOf(Date);
    expect(a!.dpop).toBe("none");
    // No token material or reference IDs ever cross the wire shape.
    const serialized = JSON.stringify(connections);
    expect(serialized).not.toContain(tokensA.refreshToken);
    expect(serialized).not.toContain(tokensB.refreshToken);
    expect(serialized).not.toContain("referenceId");

    // DUPLICATE ACTIVE GENERATIONS (R117/R118 finding 3d): a SECOND browser
    // session of the SAME user for the SAME client mints a SECOND ACTIVE
    // grant generation (the consent reference is session-derived), yet the
    // connection projection stays ONE card per client with the refresh
    // counts AGGREGATED across the generations.
    const grantsUser = await db.user.findUniqueOrThrow({ where: { email } });
    const secondSessionRes = await jsonPost("/api/auth/sign-in/email", {
      email,
      password: "grants-password-123",
    });
    expect(secondSessionRes.status).toBe(200);
    const cookie2 = cookieOf(secondSessionRes);
    expect(cookie2).not.toBe(cookie);
    // mintTokensWithConsent (NOT mintTokens): the installed provider keys
    // remembered consent on the SESSION-derived reference id, so a fresh
    // session of the same user is led through the consent page again — and
    // accepting it with the NEW reference id is exactly what mints the
    // SECOND ACTIVE generation.
    const tokensA2 = await mintTokensWithConsent(cookie2, clientA, "mcp:read offline_access");
    expect(tokensA2.claims.mcp_grant_id).not.toBe(tokensA.claims.mcp_grant_id);
    const activeGrants = await db.mcpGrant.findMany({
      where: { userId: grantsUser.id, clientId: clientA, revokedAt: null },
    });
    expect(activeGrants).toHaveLength(2); // two DISTINCT active generations
    const aggregated = await (await humanGrantsClient(email)).mcpGrants.listMine();
    expect(aggregated.filter((connection) => connection.clientId === clientA)).toHaveLength(1);
    expect(
      aggregated.find((connection) => connection.clientId === clientA)!.activeRefreshCount,
    ).toBeGreaterThanOrEqual(2); // aggregated across both generations

    // Revoke A through the real procedure (Serializable transaction).
    const clientRecordA = await db.oauthClient.findUniqueOrThrow({
      where: { clientId: clientA },
    });
    const tombstonesBefore = await db.mcpGrant.findMany({
      where: { clientId: clientA },
      select: { referenceId: true, revokedAt: true },
    });
    await revokeConnection(email, clientRecordA.id);

    // Tombstoned grants (never deleted, never resurrected), refresh rows
    // retained+revoked as replay evidence, consents deleted, the shared
    // client row PRESERVED.
    const grantsAfter = await db.mcpGrant.findMany({
      where: { clientId: clientA },
      select: { referenceId: true, revokedAt: true },
    });
    expect(grantsAfter.length).toBeGreaterThanOrEqual(tombstonesBefore.length);
    for (const row of grantsAfter) expect(row.revokedAt).not.toBeNull();
    const refreshRows = await db.oauthRefreshToken.findMany({ where: { clientId: clientA } });
    expect(refreshRows.length).toBeGreaterThanOrEqual(1);
    for (const row of refreshRows) expect(row.revoked).not.toBeNull();
    expect(await db.oauthConsent.findFirst({ where: { clientId: clientA } })).toBeNull();
    expect(await db.oauthClient.findUnique({ where: { clientId: clientA } })).not.toBeNull();

    // listMine hides the tombstone-only connection, keeps the live one.
    const afterList = await (await humanGrantsClient(email)).mcpGrants.listMine();
    expect(afterList.map((c) => c.clientId)).toEqual([clientB]);

    // The live /mcp kill: A's access token dies instantly (the admission's
    // live grant check rejects a tombstoned generation with 403), B's runs.
    expect((await mcpToolCall(tokensA.accessToken, "tools/list", {}, 2101)).status).toBe(403);
    expect((await mcpToolCall(tokensB.accessToken, "tools/list", {}, 2102)).status).toBe(200);

    // Refresh for the revoked connection is rejected.
    const refreshA = await refreshRequest({
      clientId: clientA,
      refreshToken: tokensA.refreshToken,
    });
    expect([400, 401]).toContain(refreshA.status);
    expect(((await refreshA.json()) as { error: string }).error).toBe("invalid_grant");

    // Idempotent: the repeat revoke returns the same result and never
    // clears or duplicates a tombstone.
    const revokedAtByReference = new Map(
      grantsAfter.map((row) => [row.referenceId, row.revokedAt!.toISOString()]),
    );
    await revokeConnection(email, clientRecordA.id);
    const stillRevoked = await db.mcpGrant.findMany({
      where: { clientId: clientA },
      select: { referenceId: true, revokedAt: true },
    });
    expect(stillRevoked.length).toBe(grantsAfter.length);
    for (const row of stillRevoked) {
      expect(row.revokedAt?.toISOString()).toBe(revokedAtByReference.get(row.referenceId));
    }

    // Ownership hiding + ceremonial confirmation: an unknown record id and a
    // wrong confirm literal both fail without touching any row (the wrong
    // literal is deliberately ill-typed at the call boundary — zod would
    // reject it before the handler runs).
    const strict = await humanGrantsClient(email);
    await expect(
      strict.mcpGrants.revokeMine({ clientRecordId: "no-such-record", confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const wrongConfirmInput = {
      clientRecordId: clientRecordA.id,
      confirm: "delete",
    } as unknown as { clientRecordId: string; confirm: "REVOKE" };
    await expect(strict.mcpGrants.revokeMine(wrongConfirmInput)).rejects.toThrow();
    const unchanged = await db.mcpGrant.findMany({
      where: { clientId: clientA },
      select: { referenceId: true, revokedAt: true },
    });
    expect(unchanged.length).toBe(stillRevoked.length);

    // A FOREIGN USER'S EXISTING CONNECTION (R117/R118 finding 3d): real
    // rows, real ownership hiding — the primary user attempts to revoke a
    // connection that EXISTS (live grant, working token) but belongs to
    // someone else. NOT_FOUND, and the owner's connection is untouched.
    const foreignClientId = `grants-x-${suffix}`;
    await seedPublicClient(foreignClientId, { skipConsent: false });
    const foreignEmail = `grants-x-${suffix}@example.test`;
    const foreignCookie = await signUpVerifiedUser(foreignEmail, "grants-x-password-123");
    const foreignTokens = await mintTokensWithConsent(
      foreignCookie,
      foreignClientId,
      "mcp:read offline_access",
    );
    const foreignRecord = await db.oauthClient.findUniqueOrThrow({
      where: { clientId: foreignClientId },
    });
    const asPrimaryUser = await humanGrantsClient(email);
    await expect(
      asPrimaryUser.mcpGrants.revokeMine({ clientRecordId: foreignRecord.id, confirm: "REVOKE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const foreignGrant = await db.mcpGrant.findUniqueOrThrow({
      where: { id: foreignTokens.claims.mcp_grant_id as string },
    });
    expect(foreignGrant.revokedAt).toBeNull(); // owner's grant still ACTIVE
    expect((await mcpToolCall(foreignTokens.accessToken, "tools/list", {}, 2103)).status).toBe(200); // owner's token still passes /mcp
    const ownerList = await (await humanGrantsClient(foreignEmail)).mcpGrants.listMine();
    expect(ownerList.map((connection) => connection.clientId)).toEqual([foreignClientId]);
  });

  // -------------------------------------------------------------------------
  // Gap row 12: wrong issuer / audience / resource / proof rejections at
  // the /mcp boundary.
  // -------------------------------------------------------------------------

  it("row 12 — wrong issuer / audience / signature / proof rejections at /mcp", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `wrong-${suffix}`;
    await seedPublicClient(clientId);
    const cookie = await signUpVerifiedUser(`wrong-${suffix}@example.test`, "wrong-password-123");
    const tokens = await mintTokens(cookie, clientId, "mcp:read offline_access");
    const user = await db.user.findUniqueOrThrow({
      where: { email: `wrong-${suffix}@example.test` },
    });

    // -------------------------------------------------------------------------
    // SIGNATURE-negative, EXACTLY ONE DEFECT (R117/R118 finding 3b;
    // R119 finding 3 + R120 finding 4): an attacker-signed JWT whose ONLY
    // invalid property is the signature. Every claim is otherwise REAL:
    // correct issuer and audience, the real subject, the real client, a
    // REAL ACTIVE grant id, valid times — and the header names the REAL
    // production JWKS kid AND alg (EdDSA — production keys are Ed25519 OKP;
    // the pass-2 fixture was ES256 and died at KEY SELECTION with
    // ERR_JWKS_NO_MATCHING_KEY, hiding signature-verification defects).
    //
    // CODE-PATH PIN: the HTTP boundary cannot distinguish jose failures —
    // the installed verifier maps every non-infrastructure JOSEError to the
    // same generic 401 "invalid access token" challenge — so the REACHED
    // code path is pinned INDEPENDENTLY with the SAME JWKS key:
    //   (1) the JWKS carries the EdDSA/OKP/Ed25519 kid the forged header
    //       names, so jose key SELECTION provably succeeds;
    //   (2) the REAL production token VERIFIES against the imported key
    //       (control: the key material and the Ed25519 verification path
    //       are sound);
    //   (3) the forged token's signature FAILS against that same key —
    //       signature verification is the rejection the verifier performs.
    // MUTATION PREDICTION: break signature verification ALONE (e.g. verify
    // with `algorithms: ["none"]`, or skip the verify call) and this token
    // is ACCEPTED — key selection provably succeeds and every other
    // property is real, so no second rejection reason exists to mask it.
    const jwksRes = await app.request(`${ISSUER}/jwks`);
    expect(jwksRes.status).toBe(200);
    const jwks = (await jwksRes.json()) as {
      keys?: { kid?: string; alg?: string; kty?: string; crv?: string; x?: string }[];
    };
    const jwksKey = jwks.keys?.find((key) => typeof key.kid === "string");
    const productionKid = jwksKey?.kid;
    expect(productionKid, "production JWKS kid").toBeDefined();
    // (1) the production key selects for the forged header's alg+kid.
    expect(jwksKey?.alg).toBe("EdDSA");
    expect(jwksKey?.kty).toBe("OKP");
    expect(jwksKey?.crv).toBe("Ed25519");
    expect(jwksKey?.x, "Ed25519 public member for the independent verify").toBeDefined();
    const importedProductionKey = await importEd25519PublicJwk({
      kty: jwksKey!.kty!,
      crv: jwksKey!.crv!,
      x: jwksKey!.x!,
    });
    // (2) CONTROL: the real token verifies against the imported key.
    const [realHeader, realBody, realSignature] = tokens.accessToken.split(".");
    expect(
      await verifyEd25519(
        importedProductionKey,
        fromBase64Url(realSignature!),
        new TextEncoder().encode(`${realHeader}.${realBody}`),
      ),
      "control: the real production token verifies against the JWKS key",
    ).toBe(true);
    const grantId = tokens.claims.mcp_grant_id as string;
    const activeGrant = await db.mcpGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(activeGrant.revokedAt).toBeNull(); // the grant claim it carries is REAL and ACTIVE
    const forgedKey = await generateEd25519Key();
    const now = Math.floor(Date.now() / 1000);
    const forged = await mintForgedEdDsaJwt(
      forgedKey,
      {
        iss: ISSUER,
        aud: CANONICAL,
        sub: user.id,
        client_id: clientId,
        scope: "mcp:read",
        mcp_grant_id: grantId,
        iat: now,
        exp: now + 600,
      },
      productionKid,
    );
    // (3) the forged signature fails against the SAME key that admitted
    // the real token — the one defect is the signature.
    const [forgedHeader, forgedBody, forgedSignature] = forged.split(".");
    expect(
      await verifyEd25519(
        importedProductionKey,
        fromBase64Url(forgedSignature!),
        new TextEncoder().encode(`${forgedHeader}.${forgedBody}`),
      ),
      "the forged signature fails against the production JWKS key",
    ).toBe(false);
    const forgedRes = await mcpToolCall(forged, "tools/list", {}, 2201);
    expect(forgedRes.status).toBe(401);
    expect(forgedRes.headers.get("www-authenticate")).toContain("resource_metadata");

    // -------------------------------------------------------------------------
    // ISSUER-negative, EXACTLY ONE DEFECT: a REAL token minted by the second
    // origin whose audience is the PRODUCTION canonical resource (the shared
    // DB lets origin2's client link to it, and both instances share the same
    // DB-backed JWKS, so the signature VERIFIES against production's JWKS).
    // iss is therefore the token's ONLY defect. The CONTROL proves it: the
    // same boundary with only the expected-issuer flipped to origin2's
    // issuer ACCEPTS the token (mutation prediction for the issuer check —
    // remove `issuer` from the verifier options and the negative below
    // flips to 200, so this test detects issuer-check removal).
    // (Pass 1 presented a forged token with BOTH a foreign issuer and an
    // unknown key, and the "real" foreign token also had a foreign audience
    // — two defects each, so either check alone could reject.)
    // origin2's authorize boundary accepts BOTH its own canonical resource
    // and the linked PRODUCTION canonical (authorizeTargetBases: [BASE] —
    // a TEST-ONLY widening of the guard's accepted targets; the
    // oauthClientResource link is still enforced by the provider itself).
    const origin2 = await launchShortOrigin({ authorizeTargetBases: [BASE] });
    try {
      await db.oauthClientResource.create({
        data: { clientId: origin2.clientId, resourceId: CANONICAL },
      });
      const o2Cookie = await origin2.signUp("origin2-password-123");
      const o2Tokens = await parseTokenResponse(
        await origin2.token(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: origin2.clientId,
            code: await origin2.authorize(o2Cookie, "mcp:read offline_access", CANONICAL),
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      expect(o2Tokens.claims.iss).toBe(`${origin2.base}/api/auth`);
      expect(o2Tokens.claims.aud).toBe(CANONICAL); // audience CORRECT
      const o2Grant = await db.mcpGrant.findUniqueOrThrow({
        where: { id: o2Tokens.claims.mcp_grant_id as string },
      });
      expect(o2Grant.revokedAt).toBeNull(); // grant claim REAL and ACTIVE
      // CONTROL: same resource expectation, expected issuer flipped to
      // origin2's → the otherwise-valid token is ACCEPTED.
      state.activeBaseUrl = undefined;
      const issuerFlipApp = await buildOAuthApp(auth as unknown as AuthLike, {
        withMcp: true,
        baseUrl: BASE,
        issuerUrl: `${origin2.base}/api/auth`,
      });
      expect(
        (await mcpToolCall(o2Tokens.accessToken, "tools/list", {}, 2202, issuerFlipApp)).status,
      ).toBe(200);
      // NEGATIVE at the REAL production boundary: the issuer is the only
      // defect and it is rejected.
      const foreign = await mcpToolCall(o2Tokens.accessToken, "tools/list", {}, 2203);
      expect(foreign.status).toBe(401);
      expect(foreign.headers.get("www-authenticate")).toContain("resource_metadata");
    } finally {
      await origin2.stop();
    }

    // AUDIENCE-negative, EXACTLY ONE DEFECT: a REAL production token
    // (correct issuer, verifiable signature, active grant) against a
    // same-origin /mcp whose expected resource differs from the token's
    // aud. MUTATION PREDICTION: construct the handler with resourceUrl:
    // CANONICAL instead of otherResource and the same token is ACCEPTED —
    // no other rejection reason exists.
    const otherResource = `${BASE}/other-resource`;
    const otherApp = await buildOAuthApp(auth as unknown as AuthLike, {
      withMcp: true,
      baseUrl: BASE,
      resourceUrl: otherResource,
    });
    const wrongAud = await otherApp.request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": JSON_TYPE,
        accept: JSON_TYPE,
        host: new URL(BASE).host,
        "mcp-method": "tools/list",
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: mcpListBody(2205),
    });
    expect(wrongAud.status).toBe(401);
    expect(wrongAud.headers.get("www-authenticate")).toContain("resource_metadata");

    // PROOF-shape negative, EXACTLY ONE DEFECT: the DPoP scheme presented
    // on an UNBOUND (Bearer-type) token — a cryptographically VALID proof
    // whose only mismatch is the token's confirmation method. MUTATION
    // PREDICTION: present the same request with scheme Bearer and it is
    // ACCEPTED (the proof itself verifies).
    const dpopKey = await generateDpopKey();
    const unboundProof = await createDpopProof({
      method: "POST",
      uri: CANONICAL,
      key: dpopKey,
      accessToken: tokens.accessToken,
    });
    const dpopOnUnbound = await mcpDpopCall(tokens.accessToken, unboundProof, 2206);
    expect(dpopOnUnbound.status).toBe(401);
    expect(dpopOnUnbound.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  // -------------------------------------------------------------------------
  // Gap row 13: claim-hook barriers. The invariant: NOTHING from a
  // tombstoned generation refreshes or passes /mcp — no matter WHERE in
  // the issuance sequence the revoke lands.
  //
  // Barrier design (R117/R118 finding 1 — the pass-1 "barriers" were
  // sequential orderings): a test-controlled promise gate is injected at
  // the CLAIMS-HOOK SEAM of the TEST-CONSTRUCTED auth instance (the same
  // seam as the short-TTL overrides — buildShortTtlAuth wraps the real
  // issueMcpGrantClaims; NO production mechanism exists or is added). The
  // wrapped hook parks the issuance at the requested point until released,
  // so the REAL revoke transaction (mcp-grants.ts) and the REAL provider
  // token writes interleave exactly as they can in production:
  //   (a) issuance parked AFTER the grant check → revoke commits → issuance
  //       resumes and COMPLETES → the minted set fails BOTH halves;
  //   (b) a pending code's exchange parked BEFORE consumption (app-boundary
  //       gate — see createRequestEntryGate) → revoke collects the FRESH
  //       generation from the PENDING CODE alone → resumed exchange fails;
  //   (c) two refreshes parked until BOTH are past the grant check, then
  //       released together → they race the installed rotation CAS and
  //       exactly ONE survives;
  //   (d) a CONSUMED code's exchange parked after consumption but before
  //       grant creation, on a CONSENT-FLOW client → the remembered-consent
  //       row is collected → born-dead tombstone → resumed exchange FAILS;
  //   (e) the same interval on the SKIP-CONSENT fixture (zero artifacts) →
  //       the resumed exchange mints a NEW ACTIVE generation — the pinned
  //       post-revoke re-authorization semantics (decision documented at
  //       the (d)+(e) block).
  // -------------------------------------------------------------------------

  it("row 13 — barriers: issuance paused past the grant check dies on both halves after the revoke commits; a fresh generation's pending code is killed by the pending-code enumeration; the consumed-code absent-grant interval is pinned both ways (consent-row collection kills the exchange; an artifact-free generation re-mints as the designed post-revoke re-authorization); barrier-synchronized concurrent refresh has exactly one CAS survivor and a cached retry after revoke", async () => {
    const codeFormFor = (clientId: string, code: string) =>
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        redirect_uri: CALLBACK,
      });
    const refreshFormFor = (clientId: string, refreshToken: string) =>
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      });

    // -------------------------------------------------------------------------
    // (a) ISSUANCE PAUSED AFTER THE GRANT CHECK: the revoke transaction
    // commits BETWEEN the claim decision (issueMcpGrantClasses → "reuse",
    // grant active at check time) and the provider's token writes; the
    // issuance then resumes and COMPLETES — the late-minted artifacts
    // postdate the revoke and were invisible to it — and must STILL fail
    // BOTH halves (refresh + live /mcp). Plus the pass-1 gap: the
    // pre-revoke refresh token is attempted after the revoke.
    // -------------------------------------------------------------------------
    const originA = await launchShortOrigin({
      barrier: createClaimHookBarrier("after-grant-check"),
    });
    try {
      const cookieA = await originA.signUp("origin2-password-123");
      const exchange1 = await parseTokenResponse(
        await originA.token(
          codeFormFor(
            originA.clientId,
            await originA.authorize(cookieA, "mcp:read offline_access"),
          ),
        ),
      );
      // Warmup + valid-admission control for this origin (JWKS fetch and DB
      // connections warm before anything timed).
      expect((await originA.mcp(exchange1.accessToken, 2300)).status).toBe(200);
      const recordA = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: originA.clientId },
      });

      // Fire the second exchange and park it INSIDE the claims hook, PAST
      // the grant check (grantChecked(1) proves the check resolved).
      const pausedCode = await originA.authorize(cookieA, "mcp:read offline_access");
      originA.barrier!.activate(); // setup issuances already done
      const pausedExchange = originA.token(codeFormFor(originA.clientId, pausedCode));
      await barrierDeadline(originA.barrier!.grantChecked(1), "row 13(a) grantChecked(1)");
      await revokeConnection(originA.email, recordA.id); // the revoke COMMITS here
      originA.barrier!.open(); // issuance resumes and COMPLETES
      const lateMinted = await parseTokenResponse(await pausedExchange); // 200: minted
      const rowsAfterLateMint = await db.oauthRefreshToken.count({
        where: { clientId: originA.clientId },
      });
      expect(rowsAfterLateMint).toBe(2); // RT1 + the late-minted RT (post-revoke row)
      const lateRow = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(lateMinted.refreshToken) },
      });
      expect(lateRow.revoked).toBeNull(); // invisible to the revoke: created after it

      // LIVE HALF: the late-minted access token dies at the live grant
      // check (tombstoned generation).
      expect((await originA.mcp(lateMinted.accessToken, 2301)).status).toBe(403);
      // REFRESH HALF: the late-minted refresh token is rejected and mints
      // nothing (the claims hook re-checks the tombstone at refresh time).
      const lateRefresh = await originA.token(
        refreshFormFor(originA.clientId, lateMinted.refreshToken),
      );
      expect([400, 401, 500]).toContain(lateRefresh.status);
      expect(await db.oauthRefreshToken.count({ where: { clientId: originA.clientId } })).toBe(
        rowsAfterLateMint,
      );

      // The PRE-REVOKE refresh token (pass-1 gap): rejected after the revoke.
      const preRevokeRefresh = await originA.token(
        refreshFormFor(originA.clientId, exchange1.refreshToken),
      );
      expect([400, 401]).toContain(preRevokeRefresh.status);
      expect(((await preRevokeRefresh.json()) as { error: string }).error).toBe("invalid_grant");
      // The pre-revoke access token equally dead.
      expect((await originA.mcp(exchange1.accessToken, 2302)).status).toBe(403);
    } finally {
      await originA.stop();
    }

    // -------------------------------------------------------------------------
    // (b) PENDING-CODE REVOCATION on a FRESH generation — the pending-code
    // enumeration is LOAD-BEARING. A fresh session derives a fresh consent
    // reference; the skip-consent client never writes a consent row and the
    // grant row only exists after an exchange — so the PENDING CODE is the
    // generation's ONLY artifact when the revoke scans (asserted below). A
    // second session signs in, authorizes (code issued, never exchanged),
    // and the exchange is parked BEFORE code consumption — the installed
    // token endpoint deletes the verification row before the claims hook
    // runs, so the gate lives at the app boundary (createRequestEntryGate),
    // keeping the code VISIBLE to the revoke's pending-code scan.
    // MUTATION PREDICTION (executed as a probe during pass-2 validation):
    // remove the pending-code collection from the revoke transaction and
    // ref2 is never collected — the revoke still succeeds on ref1, the
    // resumed exchange would CREATE ref2's grant and mint, and the
    // "must fail" assertions below FAIL.
    // COMPANION ROWS: (d) drives the CONSUMED-code interval for a
    // consent-flow client (collection source = the remembered-consent row)
    // and (e) the same interval for THIS skip-consent fixture (no artifact
    // at all) — together they pin the whole absent-grant interval.
    // -------------------------------------------------------------------------
    const requestGate = createRequestEntryGate();
    const originB = await launchShortOrigin({ requestGate });
    try {
      const cookie1 = await originB.signUp("origin2-password-123");
      const gen1 = await parseTokenResponse(
        await originB.token(
          codeFormFor(
            originB.clientId,
            await originB.authorize(cookie1, "mcp:read offline_access"),
          ),
        ),
      );
      expect((await originB.mcp(gen1.accessToken, 2303)).status).toBe(200); // warmup/control
      const userB = await db.user.findUniqueOrThrow({ where: { email: originB.email } });
      const grant1 = await db.mcpGrant.findUniqueOrThrow({
        where: { id: gen1.claims.mcp_grant_id as string },
      });

      // FRESH browser session → FRESH reference generation.
      const cookie2 = await originB.signIn("origin2-password-123");
      const session2 = await db.session.findFirstOrThrow({
        where: { userId: userB.id },
        orderBy: { createdAt: "desc" },
      });
      const ref2 = deriveMcpConsentReferenceId({
        secret: state.secret,
        sessionId: session2.id,
        clientId: originB.clientId,
      });
      expect(ref2).not.toBe(grant1.referenceId);
      // LOAD-BEARING sanity: the fresh generation has NO artifact except
      // the pending code the next line mints.
      expect(
        await db.mcpGrant.count({
          where: { userId: userB.id, clientId: originB.clientId, referenceId: ref2 },
        }),
      ).toBe(0);
      expect(
        await db.oauthConsent.count({
          where: { userId: userB.id, clientId: originB.clientId, referenceId: ref2 },
        }),
      ).toBe(0);
      expect(
        await db.oauthRefreshToken.count({
          where: { userId: userB.id, clientId: originB.clientId, referenceId: ref2 },
        }),
      ).toBe(0);

      const pendingCode = await originB.authorize(cookie2, "mcp:read offline_access");
      // The pending-code row EXISTS and carries the fresh reference (its
      // stored JSON value embeds referenceId) — the row the revoke's
      // pending-code scan will collect. (ref2 is 64 hex chars, so the
      // contains filter is exact-safe.)
      expect(await db.verification.count({ where: { value: { contains: ref2 } } })).toBe(1);
      requestGate.activate(); // setup requests already done
      const pendingExchange = originB.token(codeFormFor(originB.clientId, pendingCode));
      await barrierDeadline(requestGate.arrived(1), "row 13(b) request arrival"); // parked BEFORE code consumption
      // ... and it is STILL unconsumed at the park point (the app-boundary
      // gate precedes the token endpoint's code consumption).
      expect(await db.verification.count({ where: { value: { contains: ref2 } } })).toBe(1);
      const recordB = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: originB.clientId },
      });
      await revokeConnection(originB.email, recordB.id); // commits mid-exchange
      // The fresh generation IS tombstoned — collectable ONLY from the
      // pending code (the sanity counts above ruled out every other table).
      const ref2Grant = await db.mcpGrant.findUnique({
        where: {
          userId_clientId_referenceId: {
            userId: userB.id,
            clientId: originB.clientId,
            referenceId: ref2,
          },
        },
      });
      expect(ref2Grant?.revokedAt).not.toBeNull();
      requestGate.open(); // the exchange completes AFTER the revoke
      const resumed = await pendingExchange;
      expect(resumed.status, await resumed.clone().text()).toBe(500);
      // The installed token endpoint answers the tombstone rejection with
      // a bare 500 and an EMPTY body (pinned pass-1 behavior) — and NOTHING
      // is minted for the tombstoned fresh generation.
      expect(await resumed.clone().text()).toBe("");
      expect(
        await db.oauthRefreshToken.count({
          where: { userId: userB.id, clientId: originB.clientId, referenceId: ref2 },
        }),
      ).toBe(0);
      // The pre-existing generation's access token is dead too.
      expect((await originB.mcp(gen1.accessToken, 2304)).status).toBe(403);
    } finally {
      await originB.stop();
    }

    // -------------------------------------------------------------------------
    // (d)+(e) THE CONSUMED-CODE / ABSENT-GRANT INTERVAL (R119 finding 1).
    // The schedule: the token endpoint has CONSUMED the code (verification
    // row deleted — provable, the claims hook only runs after consumption)
    // but the grant row does not exist yet (the claims hook is parked at
    // ENTRY, before issueMcpGrantClaims) → the revoke commits → the
    // exchange resumes. What the revoke can collect depends ENTIRELY on
    // whether any OTHER artifact ties the fresh reference to it:
    //
    // DECISION (documented, from mcp-plan.md + production code): NO
    // production tombstone/consent check at grant creation is required —
    // the correct closure is to PIN the semantics for BOTH sides.
    // Evidence:
    //  - mcp-plan.md Phase 9: "Better Auth may leave a late inert row; the
    //    acceptance invariant is that no token from a TOMBSTONED generation
    //    can refresh successfully or pass /mcp." The invariant governs
    //    TOMBSTONED generations; a not-yet-existing generation cannot be
    //    tombstoned.
    //  - mcp-plan.md Phase 7 enumerates the revoke's collection sources
    //    exactly (existing McpGrant, consent, refresh, opaque-access rows +
    //    unexpired Verification candidates). It demands no session-derived
    //    sweep and no grant-creation-time check.
    //  - packages/auth/src/mcp-grant.ts: authorization_code mint = create
    //    when absent / reject a tombstone for the EXACT reference — and the
    //    /mcp admission's 403 comment states the design intent verbatim:
    //    "a NEW grant generation CAN restore access after revocation
    //    (re-authorization is not useless)".
    //  - Row 14 already pins the designed post-revoke re-authorization for
    //    a NEW session (new reference): distinct ACTIVE generation, old one
    //    stays tombstoned. An artifact-free reference mid-exchange is the
    //    same semantic: nothing ties it to the revoke.
    //
    // (d) CONSENT-FLOW client: the remembered-consent row (carrying ref2)
    //     IS collected by the revoke → ref2 is tombstoned BORN-DEAD → the
    //     resumed exchange MUST FAIL (bare 500 + empty body, exactly like
    //     (b)). LOAD-BEARING CHECK: the consent-row collection in the
    //     revoke transaction. MUTATION PREDICTION: drop `consents` from
    //     the revoke's generation collection and this leg FAILS (the
    //     resumed exchange mints) — probed during pass-3 validation.
    // (e) SKIP-CONSENT client (the (b) fixture class): NO artifact ties
    //     ref2 to the revoke (code consumed, no consent row, no grant) —
    //     the resumed exchange creates a NEW ACTIVE generation. PINNED
    //     SEMANTICS: the new generation is allowed precisely BECAUSE no
    //     artifact existed (identical to any fresh post-revoke
    //     re-authorization), while EVERY artifact of the OLD generation is
    //     dead on both halves. If the resumed exchange instead FAILED here,
    //     production would be rejecting a create-when-absent mint that
    //     Phase 7/9 explicitly permit.
    // -------------------------------------------------------------------------
    const originD = await launchShortOrigin({
      barrier: createClaimHookBarrier("entry"),
      consentFlow: true,
    });
    try {
      const cookieD1 = await originD.signUp("origin2-password-123");
      const genD1 = await parseTokenResponse(
        await originD.token(
          codeFormFor(
            originD.clientId,
            await originD.authorizeWithConsent(cookieD1, "mcp:read offline_access"),
          ),
        ),
      );
      expect((await originD.mcp(genD1.accessToken, 2309)).status).toBe(200); // warmup/control
      const userD = await db.user.findUniqueOrThrow({ where: { email: originD.email } });

      // FRESH session → FRESH reference; its consent row is written by the
      // consent ACCEPT that issues the pending code.
      const cookieD2 = await originD.signIn("origin2-password-123");
      const sessionD2 = await db.session.findFirstOrThrow({
        where: { userId: userD.id },
        orderBy: { createdAt: "desc" },
      });
      const refD2 = deriveMcpConsentReferenceId({
        secret: state.secret,
        sessionId: sessionD2.id,
        clientId: originD.clientId,
      });
      const codeD2 = await originD.authorizeWithConsent(cookieD2, "mcp:read offline_access");
      // The remembered-consent row is the ONLY artifact tying refD2 to a
      // revoke (grant absent by the schedule; the pending code will be
      // consumed before the park).
      expect(
        await db.oauthConsent.count({
          where: { userId: userD.id, clientId: originD.clientId, referenceId: refD2 },
        }),
      ).toBe(1);
      expect(
        await db.mcpGrant.count({
          where: { userId: userD.id, clientId: originD.clientId, referenceId: refD2 },
        }),
      ).toBe(0);
      expect(await db.verification.count({ where: { value: { contains: refD2 } } })).toBe(1);

      originD.barrier!.activate(); // setup issuances already done
      const pausedD = originD.token(codeFormFor(originD.clientId, codeD2));
      await barrierDeadline(originD.barrier!.entered(1), "row 13(d) claims-hook entry");
      // The defining property of this interval: the code is CONSUMED (the
      // claims hook only runs after consumption) and the grant is NOT yet
      // created.
      expect(await db.verification.count({ where: { value: { contains: refD2 } } })).toBe(0);
      const recordD = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: originD.clientId },
      });
      await revokeConnection(originD.email, recordD.id); // commits mid-interval
      // The consent row WAS the collection source: refD2 is tombstoned
      // BORN-DEAD (a grant row exists and is flagged).
      const refD2Grant = await db.mcpGrant.findUniqueOrThrow({
        where: {
          userId_clientId_referenceId: {
            userId: userD.id,
            clientId: originD.clientId,
            referenceId: refD2,
          },
        },
      });
      expect(refD2Grant.revokedAt).not.toBeNull();
      originD.barrier!.open();
      const resumedD = await pausedD;
      expect(resumedD.status).toBe(500); // bare-500 tombstone rejection
      expect(await resumedD.text()).toBe(""); // empty body (pinned)
      expect(
        await db.oauthRefreshToken.count({
          where: { userId: userD.id, clientId: originD.clientId, referenceId: refD2 },
        }),
      ).toBe(0); // nothing minted for the tombstoned generation
      // The pre-existing generation is dead on both halves.
      expect((await originD.mcp(genD1.accessToken, 2310)).status).toBe(403);
      const oldDRefresh = await originD.token(refreshFormFor(originD.clientId, genD1.refreshToken));
      expect([400, 401]).toContain(oldDRefresh.status);
      expect(((await oldDRefresh.json()) as { error: string }).error).toBe("invalid_grant");
    } finally {
      await originD.stop();
    }

    const originE = await launchShortOrigin({ barrier: createClaimHookBarrier("entry") });
    try {
      const cookieE1 = await originE.signUp("origin2-password-123");
      const genE1 = await parseTokenResponse(
        await originE.token(
          codeFormFor(
            originE.clientId,
            await originE.authorize(cookieE1, "mcp:read offline_access"),
          ),
        ),
      );
      expect((await originE.mcp(genE1.accessToken, 2311)).status).toBe(200); // warmup/control
      const userE = await db.user.findUniqueOrThrow({ where: { email: originE.email } });

      const cookieE2 = await originE.signIn("origin2-password-123");
      const sessionE2 = await db.session.findFirstOrThrow({
        where: { userId: userE.id },
        orderBy: { createdAt: "desc" },
      });
      const refE2 = deriveMcpConsentReferenceId({
        secret: state.secret,
        sessionId: sessionE2.id,
        clientId: originE.clientId,
      });
      expect(refE2).not.toBe(
        (
          await db.mcpGrant.findUniqueOrThrow({
            where: { id: genE1.claims.mcp_grant_id as string },
          })
        ).referenceId,
      );
      const codeE2 = await originE.authorize(cookieE2, "mcp:read offline_access");
      expect(await db.verification.count({ where: { value: { contains: refE2 } } })).toBe(1);

      originE.barrier!.activate(); // setup issuances already done
      const pausedE = originE.token(codeFormFor(originE.clientId, codeE2));
      await barrierDeadline(originE.barrier!.entered(1), "row 13(e) claims-hook entry");
      // THE INTERVAL: code consumed, grant absent, consent never written
      // (skip-consent fixture) — refE2 has ZERO artifacts of any kind.
      expect(await db.verification.count({ where: { value: { contains: refE2 } } })).toBe(0);
      expect(
        await db.oauthConsent.count({
          where: { userId: userE.id, clientId: originE.clientId, referenceId: refE2 },
        }),
      ).toBe(0);
      expect(
        await db.mcpGrant.count({
          where: { userId: userE.id, clientId: originE.clientId, referenceId: refE2 },
        }),
      ).toBe(0);
      const recordE = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: originE.clientId },
      });
      await revokeConnection(originE.email, recordE.id); // commits mid-interval
      // PINNED: the revoke could NOT collect refE2 — no tombstone exists
      // for it (findUnique returns null), by design (Phase 7 enumeration).
      expect(
        await db.mcpGrant.findUnique({
          where: {
            userId_clientId_referenceId: {
              userId: userE.id,
              clientId: originE.clientId,
              referenceId: refE2,
            },
          },
        }),
      ).toBeNull();
      originE.barrier!.open();
      // The resumed exchange SUCCEEDS: create-when-absent mints a NEW
      // ACTIVE generation — the designed post-revoke re-authorization
      // semantic (nothing tied this reference to the revoke).
      const genE2 = await parseTokenResponse(await pausedE);
      expect(genE2.claims.mcp_grant_id).not.toBe(genE1.claims.mcp_grant_id);
      const newE2Grant = await db.mcpGrant.findUniqueOrThrow({
        where: { id: genE2.claims.mcp_grant_id as string },
      });
      expect(newE2Grant.referenceId).toBe(refE2);
      expect(newE2Grant.revokedAt).toBeNull(); // ACTIVE — the pinned semantics
      expect((await originE.mcp(genE2.accessToken, 2312)).status).toBe(200);
      // The new generation's refresh chain works (it is genuinely live).
      const rotatedE2 = await parseTokenResponse(
        await originE.token(refreshFormFor(originE.clientId, genE2.refreshToken)),
      );
      expect(rotatedE2.claims.mcp_grant_id).toBe(genE2.claims.mcp_grant_id);
      // EVERY artifact of the OLD generation is dead on both halves.
      expect((await originE.mcp(genE1.accessToken, 2313)).status).toBe(403);
      const oldERefresh = await originE.token(refreshFormFor(originE.clientId, genE1.refreshToken));
      expect([400, 401]).toContain(oldERefresh.status);
      expect(((await oldERefresh.json()) as { error: string }).error).toBe("invalid_grant");
    } finally {
      await originE.stop();
    }

    // -------------------------------------------------------------------------
    // (c) CONCURRENT REFRESH CAS, BARRIER-SYNCHRONIZED: both refreshes of
    // the SAME token genuinely REACH the rotation-CAS boundary — each parks
    // inside the claims hook past the grant check until the OTHER arrives
    // (a bare Promise.all never establishes that) — then both race the
    // installed conditional rotation update (`incrementOne` guarded by
    // `revoked IS NULL`). EXACTLY ONE survivor; the loser is rejected.
    // -------------------------------------------------------------------------
    const originC = await launchShortOrigin({
      barrier: createClaimHookBarrier("after-grant-check", 2),
    });
    try {
      const cookieC = await originC.signUp("origin2-password-123");
      const gen1 = await parseTokenResponse(
        await originC.token(
          codeFormFor(
            originC.clientId,
            await originC.authorize(cookieC, "mcp:read offline_access"),
          ),
        ),
      );
      expect((await originC.mcp(gen1.accessToken, 2305)).status).toBe(200); // warmup/control

      originC.barrier!.activate(); // setup issuance already done
      const first = originC.token(refreshFormFor(originC.clientId, gen1.refreshToken));
      const second = originC.token(refreshFormFor(originC.clientId, gen1.refreshToken));
      await barrierDeadline(originC.barrier!.grantChecked(2), "row 13(c) grantChecked(2)"); // BOTH parked at the boundary
      originC.barrier!.open(); // released together (rendezvous may auto-open; idempotent)
      const responses = [await first, await second];
      // Proof both genuinely arrived at the seam (not Promise.all timing).
      expect(originC.barrier!.counts).toEqual({ entered: 2, grantChecked: 2 });
      const survivors = responses.filter((res) => res.status === 200);
      expect(
        survivors,
        `race outcomes: ${responses.map((res) => res.status).join(",")}`,
      ).toHaveLength(1);
      const loser = responses.find((res) => res.status !== 200)!;
      expect([400, 401]).toContain(loser.status);
      expect(((await loser.json()) as { error: string }).error).toBe("invalid_grant");
      const winner = await parseTokenResponse(survivors[0]!);
      // Exactly ONE rotation persisted: RT1 (revoked) + the winner's row.
      expect(await db.oauthRefreshToken.count({ where: { clientId: originC.clientId } })).toBe(2);
      expect((await originC.mcp(winner.accessToken, 2306)).status).toBe(200);

      // Post-revoke: the WHOLE family (winner, loser's shared ancestor) is
      // dead on BOTH halves.
      const recordC = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: originC.clientId },
      });
      await revokeConnection(originC.email, recordC.id);
      expect((await originC.mcp(winner.accessToken, 2307)).status).toBe(403);

      // CACHED-RETRY-AFTER-REVOKE FIRST (R119 finding 2 + R120 finding 3:
      // the pass-2 order attempted the revoked winner's refresh FIRST,
      // which deleted the family, so the ancestor "cached retry" could
      // only ever observe the AFTERMATH — the cached branch itself was
      // never exercised). PROVIDER SEMANTICS, PINNED (both round-2
      // reviewers probe-verified the reachable state): presenting a
      // ROTATED ancestor inside its rotation-replay window — even AFTER a
      // revoke committed — answers the CACHED rotation response verbatim
      // (200, byte-identical token pair; the retained ancestor row's
      // replay evidence IS the retry-after-revoke contract), and the
      // cached response's ACCESS token still dies at the live /mcp grant
      // check (403). The barrier-origin reuse interval (60 s) makes the
      // window deterministic instead of a race against a 6 s window.
      const cached = await originC.token(refreshFormFor(originC.clientId, gen1.refreshToken));
      const cachedText = await cached.text();
      expect(cached.status, `cached retry body ${cachedText.slice(0, 300)}`).toBe(200);
      const cachedJson = JSON.parse(cachedText) as {
        access_token: string;
        refresh_token: string;
      };
      expect(
        sameTokenSet(cachedJson, {
          access_token: winner.accessToken,
          refresh_token: winner.refreshToken,
        }),
      ).toBe(true);
      expect((await originC.mcp(cachedJson.access_token, 2308)).status).toBe(403);

      // THEN the family-deleting rejection (this is the leg that must NOT
      // run first): presenting the winner's refresh token — revoked by the
      // REVOKE itself, never rotated, so it carries NO cached response —
      // is rejected AND terminally wipes the whole user+client refresh
      // family (the installed provider's terminal invalidation, the same
      // class row 15 pins on its rejected descendant). After it, zero
      // refresh rows remain: the strongest form of "nothing ever
      // refreshes again".
      const winnerRefresh = await originC.token(
        refreshFormFor(originC.clientId, winner.refreshToken),
      );
      expect([400, 401, 500]).toContain(winnerRefresh.status);
      expect(await db.oauthRefreshToken.count({ where: { clientId: originC.clientId } })).toBe(0);
    } finally {
      await originC.stop();
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // Gap row 14: same-session reauthorization routing + new browser session
  // → distinct active generation, old stays tombstoned.
  // -------------------------------------------------------------------------

  it("row 14 — tombstoned generation routes the SAME session to the login page; a NEW session mints a distinct active generation", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `reauth-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const email = `reauth-${suffix}@example.test`;
    const password = "reauth-password-123";
    const cookie1 = await signUpVerifiedUser(email, password);
    const gen1 = await mintTokensWithConsent(cookie1, clientId, "mcp:read offline_access");
    expect((await mcpToolCall(gen1.accessToken, "tools/list", {}, 2401)).status).toBe(200);

    const record = await db.oauthClient.findUniqueOrThrow({ where: { clientId } });
    await revokeConnection(email, record.id);
    expect((await mcpToolCall(gen1.accessToken, "tools/list", {}, 2402)).status).toBe(403);

    // SAME session (cookie still held): shouldRedirect sees the exact
    // tombstoned generation and routes authorize to the LOGIN page.
    const loginRedirect = await authorizeRequest(cookie1, {
      ...baseAuthorizeParams(clientId),
      scope: "mcp:read offline_access",
      resource: CANONICAL,
    });
    expect(loginRedirect.status).toBe(302);
    const loginPage = new URL(loginRedirect.headers.get("location")!, BASE);
    expect(loginPage.pathname).toContain("/mcp-login");

    // NEW browser session: sign in with the signed query (no old cookie).
    const res = await jsonPost("/api/auth/sign-in/email", {
      email,
      password,
      oauth_query: loginPage.search.slice(1),
    });
    const location = await expectContinuation(res);
    // The revoke deleted the remembered consent → the consent page shows.
    expect(location.pathname).toContain("/mcp-consent");
    const cookie2 = cookieOf(res);
    expect(cookie2).toContain("better-auth.session_token");
    expect(cookie2).not.toBe(cookie1);
    const callback = await consentAccept(cookie2, location);
    const gen2 = await parseTokenResponse(
      await exchangeCode({
        clientId,
        code: callback.searchParams.get("code")!,
        verifier: VERIFIER,
      }),
    );

    // Distinct ACTIVE generation; the old one stays tombstoned forever.
    expect(gen2.claims.mcp_grant_id).not.toBe(gen1.claims.mcp_grant_id);
    const oldGrant = await db.mcpGrant.findUniqueOrThrow({
      where: { id: gen1.claims.mcp_grant_id as string },
    });
    expect(oldGrant.revokedAt).not.toBeNull();
    const newGrant = await db.mcpGrant.findUniqueOrThrow({
      where: { id: gen2.claims.mcp_grant_id as string },
    });
    expect(newGrant.revokedAt).toBeNull();
    expect((await mcpToolCall(gen2.accessToken, "tools/list", {}, 2403)).status).toBe(200);
    expect((await mcpToolCall(gen1.accessToken, "tools/list", {}, 2404)).status).toBe(403);
    // Both sessions exist (two distinct browser sessions for the user).
    const sessions = await db.session.findMany({
      where: { userId: oldGrant.userId },
      select: { token: true },
    });
    expect(new Set(sessions.map((row) => row.token)).size).toBeGreaterThanOrEqual(2);
    // The settings-page listing shows the live connection again.
    const list = await (await humanGrantsClient(email)).mcpGrants.listMine();
    expect(list.map((c) => c.clientId)).toContain(clientId);

    // The OLD generation's REFRESH token, attempted AFTER the new sibling
    // generation exists (R117/R118 pass-1 gap — only its access token was
    // ever tried): rejected. No sibling-substitution revival through the
    // tombstoned chain. Deliberately LAST: depending on where the attempt
    // lands relative to the production 30 s reuse window, the installed
    // provider either answers the cached-rotation replay or wipes the
    // user+client token family — the asserted invariant is the rejection
    // itself, so neither installed behavior disturbs an earlier assertion.
    const oldRefresh = await refreshRequest({
      clientId,
      refreshToken: gen1.refreshToken,
    });
    expect([400, 401]).toContain(oldRefresh.status);
    expect(((await oldRefresh.json()) as { error: string }).error).toBe("invalid_grant");
  });

  // -------------------------------------------------------------------------
  // Gap row 15: late descendant artifact inertness (tokens minted before
  // revocation neither refresh nor pass /mcp; rows retained as evidence).
  // -------------------------------------------------------------------------

  it("row 15 — late descendant artifacts stay inert after revocation (retained-then-wiped by the rejected refresh); nothing ever refreshes or passes /mcp again", async () => {
    const suffix = crypto.randomUUID();
    const clientId = `descendant-${suffix}`;
    await seedPublicClient(clientId, { skipConsent: false });
    const email = `descendant-${suffix}@example.test`;
    const cookie = await signUpVerifiedUser(email, "descendant-password-123");
    const gen1 = await mintTokensWithConsent(cookie, clientId, "mcp:read offline_access");
    // Rotation creates the DESCENDANT artifacts (AT2/RT2) while the grant
    // is still active.
    const gen2 = await parseTokenResponse(
      await refreshRequest({ clientId, refreshToken: gen1.refreshToken }),
    );
    expect(gen2.claims.mcp_grant_id).toBe(gen1.claims.mcp_grant_id);
    expect((await mcpToolCall(gen2.accessToken, "tools/list", {}, 2501)).status).toBe(200);

    const refreshRowsBefore = await db.oauthRefreshToken.count({ where: { clientId } });
    expect(refreshRowsBefore).toBeGreaterThanOrEqual(2);
    const record = await db.oauthClient.findUniqueOrThrow({ where: { clientId } });
    await revokeConnection(email, record.id);

    // RETENTION at revoke time: the rows are flagged (replay evidence),
    // never deleted, exactly as the router's transaction writes them.
    const retainedAtRevoke = await db.oauthRefreshToken.findMany({ where: { clientId } });
    expect(retainedAtRevoke.length).toBe(refreshRowsBefore);
    for (const row of retainedAtRevoke) expect(row.revoked).not.toBeNull();

    // The LATE DESCENDANT is inert: its refresh is rejected and its access
    // token no longer passes /mcp (the live grant check kills it).
    const late = await refreshRequest({ clientId, refreshToken: gen2.refreshToken });
    expect([400, 401]).toContain(late.status);
    expect(((await late.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await mcpToolCall(gen2.accessToken, "tools/list", {}, 2502)).status).toBe(403);
    // The ancestor is equally dead.
    expect((await mcpToolCall(gen1.accessToken, "tools/list", {}, 2503)).status).toBe(403);

    // The installed provider TERMINALIZES the rejected refresh by wiping
    // the whole token family (probe-verified: 0 rows remain after the
    // failed attempt) — the strongest form of inertness: nothing exists
    // that could ever refresh again.
    expect(await db.oauthRefreshToken.count({ where: { clientId } })).toBe(0);

    // -------------------------------------------------------------------------
    // PART 2 — the LATE-MINT descendant (R117/R118 finding 1: part 1's
    // descendants were minted BEFORE the revoke; the required schedule is a
    // descendant whose issuance COMPLETES AFTER it). Two barrier probes on
    // dedicated origins (the grant check must PASS before each pause, so
    // each needs its own still-active generation):
    //   (i)   a ROTATION paused past the grant check mints NOTHING — the
    //         revoke revoked the ancestor row, so the installed rotation
    //         CAS (`WHERE revoked IS NULL`) rejects: no late descendant can
    //         be created through the refresh chain at all;
    //   (ii)  a CODE-EXCHANGE issuance paused past the grant check COMPLETES
    //         after the revoke (a fresh refresh row has no CAS) — the
    //         late-minted descendant postdates the revoke, is retained, and
    //         is INERT on both halves.
    // -------------------------------------------------------------------------
    const originForm = (clientId: string, grantType: string, extra: Record<string, string>) =>
      new URLSearchParams({ grant_type: grantType, client_id: clientId, ...extra });

    // (ii) FIRST (needs an ACTIVE generation; each probe consumes one).
    const lateOrigin = await launchShortOrigin({
      barrier: createClaimHookBarrier("after-grant-check"),
    });
    try {
      const lateCookie = await lateOrigin.signUp("origin2-password-123");
      const gen1Code = await lateOrigin.authorize(lateCookie, "mcp:read offline_access");
      const gen1 = await parseTokenResponse(
        await lateOrigin.token(
          originForm(lateOrigin.clientId, "authorization_code", {
            code: gen1Code,
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      expect((await lateOrigin.mcp(gen1.accessToken, 2504)).status).toBe(200); // warmup/control
      const lateRecord = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: lateOrigin.clientId },
      });

      const pausedCode = await lateOrigin.authorize(lateCookie, "mcp:read offline_access");
      lateOrigin.barrier!.activate(); // setup issuance already done
      const pausedExchange = lateOrigin.token(
        originForm(lateOrigin.clientId, "authorization_code", {
          code: pausedCode,
          code_verifier: VERIFIER,
          redirect_uri: CALLBACK,
        }),
      );
      await barrierDeadline(lateOrigin.barrier!.grantChecked(1), "row 15(ii) grantChecked(1)"); // past the grant check
      await revokeConnection(lateOrigin.email, lateRecord.id); // the revoke commits
      lateOrigin.barrier!.open(); // the issuance COMPLETES after it
      const descendant = await parseTokenResponse(await pausedExchange); // 200: minted
      // The descendant's refresh row POSTDATES the revoke: the revoke
      // flags EVERY user+client refresh row (its transaction contract,
      // proven by part 1 above), and this row is NOT flagged — so it did
      // not exist when the revoke ran. (The row's createdAt is the
      // REQUEST-start iat, captured before the pause, so it is NOT a valid
      // postdate witness; revoked-null + revoke completeness is.)
      const descendantRow = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(descendant.refreshToken) },
      });
      expect(descendantRow.revoked).toBeNull();
      const ancestorRow = await db.oauthRefreshToken.findUniqueOrThrow({
        where: { token: storedTokenHash(gen1.refreshToken) },
      });
      expect(ancestorRow.revoked).not.toBeNull(); // the SAME revoke flagged the ancestor
      // BOTH halves inert:
      expect((await lateOrigin.mcp(descendant.accessToken, 2505)).status).toBe(403);
      const descendantRefresh = await lateOrigin.token(
        originForm(lateOrigin.clientId, "refresh_token", {
          refresh_token: descendant.refreshToken,
        }),
      );
      expect([400, 401, 500]).toContain(descendantRefresh.status);
      // RETAINED, not wiped: the rejection came from the tombstone claims
      // hook (no reuse-window family wipe on this path) — replay evidence.
      expect(
        await db.oauthRefreshToken.findUnique({
          where: { token: storedTokenHash(descendant.refreshToken) },
        }),
      ).not.toBeNull();
      // The pre-revoke generation is equally dead.
      expect((await lateOrigin.mcp(gen1.accessToken, 2506)).status).toBe(403);
      const preRefresh = await lateOrigin.token(
        originForm(lateOrigin.clientId, "refresh_token", { refresh_token: gen1.refreshToken }),
      );
      expect([400, 401]).toContain(preRefresh.status);
    } finally {
      await lateOrigin.stop();
    }

    // (i) The ROTATION probe: no late descendant via the refresh chain.
    const casOrigin = await launchShortOrigin({
      barrier: createClaimHookBarrier("after-grant-check"),
    });
    try {
      const casCookie = await casOrigin.signUp("origin2-password-123");
      const casGen1 = await parseTokenResponse(
        await casOrigin.token(
          originForm(casOrigin.clientId, "authorization_code", {
            code: await casOrigin.authorize(casCookie, "mcp:read offline_access"),
            code_verifier: VERIFIER,
            redirect_uri: CALLBACK,
          }),
        ),
      );
      expect((await casOrigin.mcp(casGen1.accessToken, 2507)).status).toBe(200); // warmup/control
      const casRecord = await db.oauthClient.findUniqueOrThrow({
        where: { clientId: casOrigin.clientId },
      });
      const rowsBefore = await db.oauthRefreshToken.count({
        where: { clientId: casOrigin.clientId },
      });
      expect(rowsBefore).toBe(1);
      casOrigin.barrier!.activate(); // setup issuance already done
      const pausedRotation = casOrigin.token(
        originForm(casOrigin.clientId, "refresh_token", {
          refresh_token: casGen1.refreshToken,
        }),
      );
      await barrierDeadline(casOrigin.barrier!.grantChecked(1), "row 15(i) grantChecked(1)"); // grant check PASSED pre-revoke
      await revokeConnection(casOrigin.email, casRecord.id); // commits mid-issuance
      casOrigin.barrier!.open();
      const rotationRes = await pausedRotation;
      // The rotation CAS rejects: the revoke flagged the ancestor row, so
      // the conditional update matches nothing — the issuance FAILS and no
      // descendant row is created.
      expect([400, 401]).toContain(rotationRes.status);
      expect(((await rotationRes.json()) as { error: string }).error).toBe("invalid_grant");
      expect(await db.oauthRefreshToken.count({ where: { clientId: casOrigin.clientId } })).toBe(
        rowsBefore,
      );
    } finally {
      await casOrigin.stop();
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Gap row 16: duplicate account-key preflight spawn (exit 0 clean /
  // exit 1 seeded) against the disposable database.
  // -------------------------------------------------------------------------

  it("row 16 — duplicate account-key preflight: exit 0 clean, exit 1 seeded (spawned against the disposable DB)", async () => {
    const repoRoot = resolve(import.meta.dirname!, "../../..");
    // SCOPE NOTE (R117 finding 6): this test MUTATES the schema (drops the
    // account unique index) on whatever database the suite runs against.
    // The default `pnpm test:pg` path provisions a THROWAWAY container; the
    // supported SCHEMA_VALIDATION_DATABASE_URL opt-out runs against the
    // SUPPLIED database directly — disposable-only isolation is a caller
    // convention, not an enforced property, and this test assumes the URL
    // points at a disposable database.
    // R118 finding 4: the spawn is TIMEOUT-BOUNDED (the enclosing Vitest
    // timeout cannot interrupt a synchronously blocked child wait).
    const run = () =>
      spawnSync("pnpm", ["preflight:accounts"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl! },
        timeout: 60_000,
        killSignal: "SIGKILL",
      });

    // Clean database: exit 0 with the success line (and no timeout/kill).
    const clean = run();
    expect(clean.error, `${clean.stdout}${clean.stderr}`).toBeUndefined();
    expect(clean.status, `${clean.stdout}${clean.stderr}`).toBe(0);
    expect(clean.stdout).toContain("no duplicate");

    // Seed a duplicate (providerId, accountId) pair. The 1.7.3 schema
    // enforces uniqueness, so on this DISPOSABLE database the unique index
    // is dropped first and recreated in finally (the pre-deploy guard
    // exists exactly for databases that accumulated duplicates before it).
    // Prisma emits @@unique as a unique INDEX (not a table constraint), so
    // the name is read from pg_indexes.
    const indexRows = (await db.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'account' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%"providerId"%' AND indexdef LIKE '%"accountId"%'`,
    )) as { indexname: string }[];
    const indexName = indexRows[0]?.indexname;
    expect(indexName, "account (providerId, accountId) unique index found").toBeDefined();

    // R117 finding 6: the ENTIRE mutation interval — drop → seed → the
    // seeded preflight run — sits inside ONE try/finally, so a failure at
    // ANY point (including the seeded-user create that used to run BEFORE
    // the try) still reaches restoration. In the finally, the seeded data
    // is removed FIRST (a unique index cannot be recreated over
    // duplicates) but EACH step is individually guarded so a cleanup
    // failure can never skip the index-restoration attempt; the
    // restoration itself is idempotent (IF NOT EXISTS) and VERIFIED by an
    // explicit post-assertion after the finally.
    const suffix = crypto.randomUUID();
    const seededAccountId = `dup-${suffix}`;
    const seededEmail = `dup-${suffix}@example.test`;
    let seededUserId: string | undefined;
    try {
      await db.$executeRawUnsafe(`DROP INDEX "${indexName}"`);
      const seededUser = await db.user.create({
        data: { email: seededEmail, name: "Duplicate Seed", emailVerified: true },
      });
      seededUserId = seededUser.id;
      await db.account.createMany({
        data: [
          { accountId: seededAccountId, providerId: "credential", userId: seededUser.id },
          { accountId: seededAccountId, providerId: "credential", userId: seededUser.id },
        ],
      });
      const seeded = run();
      expect(seeded.status, `${seeded.stdout}${seeded.stderr}`).toBe(1);
      expect(`${seeded.stdout}${seeded.stderr}`).toContain("duplicate");
    } finally {
      // Data removal first (guarded — a failure here must not skip the
      // index restoration below).
      try {
        await db.account.deleteMany({ where: { accountId: seededAccountId } });
      } catch (error) {
        console.error(
          `[row 16] seeded account cleanup failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
        );
      }
      if (seededUserId !== undefined) {
        try {
          await db.user.delete({ where: { id: seededUserId } });
        } catch (error) {
          console.error(
            `[row 16] seeded user cleanup failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
          );
        }
      }
      // RESTORE the unique index — failure-safe and idempotent: IF NOT
      // EXISTS is a no-op when the drop never happened or the restore
      // already ran, and a genuine failure is caught and reported instead
      // of thrown, because the post-assertion below is the enforcement
      // (a silently-missing index FAILS the test loudly).
      try {
        await db.$executeRawUnsafe(
          `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "account"("providerId", "accountId")`,
        );
      } catch (error) {
        console.error(
          `[row 16] index restoration failed: ${error instanceof Error ? error.constructor.name : typeof error}`,
        );
      }
    }

    // POST-ASSERTION: the unique index EXISTS again (the finally's restore
    // is verified, not assumed) and the clean state exits 0 again.
    const restoredIndex = (await db.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'account' AND indexname = '${indexName}' AND indexdef LIKE 'CREATE UNIQUE INDEX%'`,
    )) as { indexname: string }[];
    expect(restoredIndex, "account unique index restored after the seeded run").toHaveLength(1);
    const restored = run();
    expect(restored.error, `${restored.stdout}${restored.stderr}`).toBeUndefined();
    expect(restored.status, `${restored.stdout}${restored.stderr}`).toBe(0);
  }, 120_000);
});
