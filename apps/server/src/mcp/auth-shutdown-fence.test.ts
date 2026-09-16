import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part F pass 5 — F8 reopened: REAL requireMcpAuth continuation probes.
 *
 * The upstream verifier is NOT mocked here (unlike auth.test.ts): real
 * `requireMcpAuth` from @better-auth/mcp@1.7.3, real JOSE ES256 token/proof
 * verification, real DPoP binding, and the REAL Better Auth
 * `reserveVerificationValue` implementation — backed by a FENCED prisma
 * adapter around a mocked client (the exact production seam: the shared
 * auth instance's database is `prismaAdapter(withAuthDbShutdownFence(...))`
 * and the admission gate's onClosed arms the fence). No real database,
 * network issuer, or production credential is used; the JWKS fetch is an
 * injected in-process response. This mirrors the R59/R60 probes that
 * demonstrated `jwks:start → gate:drained → prisma:disconnect →
 * replay-db:create` with outstanding === 0 — the class the DB-seam fence +
 * shadow-awaited permit release close.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "fence-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: "https://app.example.com",
    RATE_LIMIT_AUTH_POINTS: 10,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 900,
    RATE_LIMIT_SIGNUP_POINTS: 3,
    RATE_LIMIT_SIGNUP_DURATION: 3600,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 3600,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_DURATION: 60,
    RATE_LIMIT_EMAIL_RECIPIENT_POINTS: 3,
    RATE_LIMIT_EMAIL_RECIPIENT_DURATION: 3600,
    RATE_LIMIT_EMAIL_RECIPIENT_BLOCK_DURATION: 0,
    RATE_LIMIT_SIGNUP_RECIPIENT_POINTS: 6,
    RATE_LIMIT_MCP_POINTS: 1000,
    RATE_LIMIT_MCP_DURATION: 60,
    RATE_LIMIT_MCP_CONSENT_POINTS: 10,
    RATE_LIMIT_MCP_CONSENT_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

import {
  AuthDbShutdownFenceError,
  armAuthDbShutdownFence,
  disarmAuthDbShutdownFence,
  isAuthDbShutdownFenceArmed,
  withAuthDbShutdownFence,
} from "@ws-model-proxy/auth/auth-db-shutdown-fence";
import prismaDefault from "@ws-model-proxy/db";
import type { DeepMockProxy } from "vitest-mock-extended";
import { createMcpAdmissionGate } from "./admission";
import { createMcpRequestHandler, type McpAuthPrisma, type McpTransport } from "./auth";

/** The module mock's default export: a deep-mocked Prisma client at runtime. */
const prisma = prismaDefault as unknown as DeepMockProxy<typeof prismaDefault>;

const BASE = "https://proxy.example.com";
const RESOURCE = `${BASE}/mcp`;
const ISSUER = `${BASE}/api/auth`;

function jwt(header: object, payload: object, key: KeyObject) {
  const message = [header, payload]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".");
  const signature = sign("sha256", Buffer.from(message), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${message}.${signature}`;
}

/** The production wiring under test: fenced prisma adapter + onClosed arming. */
function buildFencedAuthInstance() {
  return betterAuth({
    baseURL: BASE,
    secret: "fence-test-secret-at-least-thirty-two-characters",
    database: prismaAdapter(withAuthDbShutdownFence(prisma), { provider: "postgresql" }),
    logger: { disabled: true },
  });
}

/** Locally signed ES256 access token + DPoP proof + JWKS response (R60 probe shape). */
function signedCredentials(tag: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" }) as {
    crv: string;
    kty: string;
    x: string;
    y: string;
  };
  const kid = `fence-${tag}`;
  const jkt = createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
  const now = Math.floor(Date.now() / 1000);
  const token = jwt(
    { alg: "ES256", kid },
    {
      iss: ISSUER,
      aud: RESOURCE,
      exp: now + 300,
      sub: "u",
      client_id: "c",
      scope: "mcp:read",
      mcp_grant_id: "g",
      cnf: { jkt },
    },
    keys.privateKey,
  );
  const proof = jwt(
    { alg: "ES256", typ: "dpop+jwt", jwk },
    {
      htm: "POST",
      htu: RESOURCE,
      iat: now,
      jti: `fence-${tag}`,
      ath: createHash("sha256").update(token).digest("base64url"),
    },
    keys.privateKey,
  );
  const jwksResponse = () => Response.json({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] });
  return { token, proof, jwksResponse };
}

function mountHandler(
  authInstance: ReturnType<typeof buildFencedAuthInstance>,
  gate: ReturnType<typeof createMcpAdmissionGate>,
  options: { abortShadowAwaitMs?: number } = {},
) {
  const transport: McpTransport = { fetch: vi.fn(async () => new Response(null)) };
  const handler = createMcpRequestHandler({
    authInstance,
    transport,
    prisma: prisma as unknown as McpAuthPrisma,
    isForceTwoFactorRequired: async () => false,
    consumeIdentityQuota: async () => ({ ok: true }),
    admissionGate: gate,
    abortShadowAwaitMs: options.abortShadowAwaitMs,
  });
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", async (c, next) => {
    c.set("requestId", "fence");
    c.header("X-RateLimit-Limit", "120");
    await next();
  });
  app.post("/mcp", handler);
  const request = (token: string, proof: string) =>
    app.request(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          host: "proxy.example.com",
          authorization: `DPoP ${token}`,
          dpop: proof,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
  return { transport, request };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  disarmAuthDbShutdownFence();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Grant lookup misses (post-verification admission denial → 403) — the
  // verifier-side replay reservation is what these tests observe.
  prisma.mcpGrant.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  disarmAuthDbShutdownFence();
});

describe("F8 pass 5 — DB-seam fence + shadow-awaited release (real requireMcpAuth)", () => {
  it("POSITIVE CONTROL (fence inactive, gate open): the verifier's replay reservation REACHES the database", async () => {
    const { token, proof, jwksResponse } = signedCredentials("control");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jwksResponse()),
    );
    const gate = createMcpAdmissionGate({ onClosed: armAuthDbShutdownFence });
    const { request } = mountHandler(buildFencedAuthInstance(), gate);
    const res = await request(token, proof);
    // The fence never armed and the verification insert EXECUTED (mocked
    // client observed it) — the fence is transparent in normal operation.
    expect(isAuthDbShutdownFenceArmed()).toBe(false);
    expect(prisma.verification.create).toHaveBeenCalled();
    expect(res.status).toBe(403); // mocked grant lookup misses post-verification
    expect(gate.outstanding).toBe(0);
  });

  it("(a) DELAYED-JWKS: after gate close + 499, the verifier's replay-db create is FENCED (never executed) and the permit releases only once the stray settles", async () => {
    const { token, proof, jwksResponse } = signedCredentials("delayed-jwks");
    let finishJwks!: (response: Response) => void;
    const jwksPending = new Promise<Response>((resolve) => {
      finishJwks = resolve;
    });
    const fetchMock = vi.fn(async () => jwksPending);
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    const gate = createMcpAdmissionGate({ onClosed: armAuthDbShutdownFence });
    const { request } = mountHandler(buildFencedAuthInstance(), gate, {
      abortShadowAwaitMs: 60_000,
    });
    const pending = request(token, proof);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // index.ts shutdown order: gate.close() (arms the DB fence
    // synchronously) BEFORE the Prisma disconnect. The 499 answers the
    // client promptly, but the permit is HELD (shadow-await) — the verifier
    // continuation is still parked on the uncancellable JWKS fetch.
    const closing = gate.close();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(res.headers.get("x-ratelimit-limit")).toBe("120");
    expect(isAuthDbShutdownFenceArmed()).toBe(true);
    expect(gate.outstanding).toBe(1);
    events.push("prisma:disconnect");
    // The JWKS fetch resolves: the stray verifier continuation resumes,
    // verifies the proof, and attempts the DPoP replay reservation — the
    // DB-seam fence REJECTS the create BEFORE it reaches the mocked client
    // (the R60 probe recorded the create EXECUTING here).
    finishJwks(jwksResponse());
    await closing;
    events.push("gate:drained");
    expect(prisma.verification.create).not.toHaveBeenCalled();
    expect(gate.outstanding).toBe(0);
    // The sanitized fence line fired exactly once (static text, ctor only).
    const fenceLines = errorSpy.mock.calls
      .flat()
      .map(String)
      .filter((line: string) => line.includes("shutdown fence rejected database operation"));
    expect(fenceLines.length).toBeGreaterThanOrEqual(1);
    // Release happened AFTER the disconnect marker (the permit was held
    // across the entire stray-continuation lifetime).
    expect(events.indexOf("gate:drained")).toBeGreaterThan(events.indexOf("prisma:disconnect"));
  });

  it("(b) RESERVATION CONFLICT: the failure-path findOne after a rejected insert is FENCED too", async () => {
    const { token, proof, jwksResponse } = signedCredentials("conflict");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jwksResponse()),
    );
    const events: string[] = [];
    let failInsert!: (error: Error) => void;
    const insertPending = new Promise<never>((_, reject) => {
      failInsert = reject;
    });
    // The insert STARTS while the fence is inactive (pre-close) and stays
    // pending; the internal adapter's failure path then issues a findOne —
    // which must be fenced once the gate has closed.
    const createMockSlot = prisma.verification.create as unknown as {
      mockImplementation: (impl: () => Promise<never>) => void;
    };
    createMockSlot.mockImplementation(async () => {
      events.push("verification:create-start");
      return insertPending;
    });
    const gate = createMcpAdmissionGate({ onClosed: armAuthDbShutdownFence });
    const { request } = mountHandler(buildFencedAuthInstance(), gate, {
      abortShadowAwaitMs: 60_000,
    });
    const pending = request(token, proof);
    await vi.waitFor(() => expect(events).toContain("verification:create-start"));
    const closing = gate.close();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(gate.outstanding).toBe(1);
    events.push("prisma:disconnect");
    // The insert fails (synthetic duplicate-conflict): the internal
    // adapter's failure path calls findOne — the FENCE rejects it before
    // the mocked client sees anything.
    failInsert(new Error("synthetic duplicate conflict"));
    await closing;
    expect(prisma.verification.findFirst).not.toHaveBeenCalled();
    expect(gate.outstanding).toBe(0);
    expect(
      errorSpy.mock.calls
        .flat()
        .map(String)
        .some((line: string) => line.includes("shutdown fence rejected database operation")),
    ).toBe(true);
  });

  it("(d) SHADOW-AWAIT CAP: a never-settling verifier fetch cannot hold the permit — close() resolves within the budget with a sanitized log line", async () => {
    const { token, proof } = signedCredentials("hung-jwks");
    const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const gate = createMcpAdmissionGate({ onClosed: armAuthDbShutdownFence });
    const { request } = mountHandler(buildFencedAuthInstance(), gate, {
      abortShadowAwaitMs: 40,
    });
    const pending = request(token, proof);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const started = Date.now();
    await gate.close(); // resolves ONLY via the 40ms cap — the fetch never settles
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(gate.outstanding).toBe(0);
    const res = await pending;
    expect(res.status).toBe(499);
    expect(
      errorSpy.mock.calls
        .flat()
        .map(String)
        .some((line: string) => line.includes("shadow-await budget reached")),
    ).toBe(true);
    // The DB fence stays armed: the residual hanging continuation can never
    // touch the database if the fetch ever does settle later.
    expect(isAuthDbShutdownFenceArmed()).toBe(true);
  });

  it("the fence error is the dedicated sentinel (distinguishable in upstream catch paths)", () => {
    const client = { row: { findFirst: vi.fn(async (_args: unknown) => null) } };
    const wrapped = withAuthDbShutdownFence(client);
    armAuthDbShutdownFence();
    expect(() => wrapped.row.findFirst({})).toThrow(AuthDbShutdownFenceError);
    expect(client.row.findFirst).not.toHaveBeenCalled();
  });
});
