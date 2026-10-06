import type { WebSocketLike } from "@hono/node-server";
import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    RATE_LIMIT_AUTH_POINTS: 100,
    RATE_LIMIT_AUTH_DURATION: 60,
    RATE_LIMIT_AUTH_BLOCK_DURATION: 60,
    RATE_LIMIT_SIGNUP_POINTS: 100,
    RATE_LIMIT_SIGNUP_DURATION: 60,
    RATE_LIMIT_SIGNUP_BLOCK_DURATION: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_DURATION: 60,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("../../rate-limit.js", () => ({
  realtimeUpgradeLimiter: {},
  createRateLimiterMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../client-ip.js", () => ({ resolveClientIp: () => "203.0.113.7" }));

const prisma = (await import("@ws-model-proxy/db")).default;
const { isForceTwoFactorRequired } = await import("@ws-model-proxy/auth/force-two-factor-policy");
const { WSContext } = await import("hono/ws");
const { SttRelayHub } = await import("../../relay/stt-relay.js");
const { RealtimeSessionCounters } = await import("./limits.js");
const { RealtimeSessionRegistry } = await import("./registry.js");
const { checkDashboardSession } = await import("./dashboard-session.js");
const { createDashboardRealtimeMiddleware, DASHBOARD_REALTIME_PATH } = await import(
  "./dashboard-websocket.js"
);
const { realtimeSocketEvents } = await import("./websocket.js");
const { dashboardRequester } = await import("./requester.js");

type Deps = Parameters<typeof realtimeSocketEvents>[1];
type RealtimeAuth = Parameters<typeof realtimeSocketEvents>[0];

const APP = "https://proxy.example.test";
const WEB = "https://web.example.test";

function session(userId = "user-1", sessionId = "sess-1"): Session {
  return { user: { id: userId }, session: { id: sessionId } } as Session;
}

function deps(overrides: Partial<Deps> = {}) {
  const hub = new SttRelayHub({ resolveLink: () => ({ ok: false, reason: "offline" }) });
  const counters = new RealtimeSessionCounters();
  const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
  const value: Deps = {
    relay: {
      createSttSession: (input) => hub.createSession(input),
      getOnlineNodeIds: () => [],
      isDraining: () => false,
    },
    counters,
    registry,
    authenticate: vi.fn(async () => null),
    router: () => ({
      candidates: async () => ({ ok: false, code: "no_live_member" }),
      memberOpenFailed: () => {},
    }),
    ...overrides,
  };
  return { deps: value, counters, registry };
}

function app(
  value: Deps,
  options: {
    current?: Session | null;
    verdict?: Awaited<ReturnType<typeof checkDashboardSession>> | Error;
  } = {},
) {
  const seen: RealtimeAuth[] = [];
  const checkSession = vi.fn(async () => {
    const verdict = options.verdict ?? "ok";
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const hono = new Hono<{ Variables: { realtimeAuth: RealtimeAuth } }>();
  hono.use(
    DASHBOARD_REALTIME_PATH,
    createDashboardRealtimeMiddleware(value, {
      allowedOrigins: [APP, WEB],
      readSession: async () => (options.current === undefined ? session() : options.current),
      checkSession,
    }),
  );
  hono.get(DASHBOARD_REALTIME_PATH, (c) => {
    seen.push(c.get("realtimeAuth"));
    return new Response("upgraded");
  });
  return { hono, seen, checkSession };
}

function upgrade(headers: Record<string, string> = { Origin: APP }) {
  return { method: "GET", headers: { Upgrade: "websocket", ...headers } };
}

const PATH = `${DASHBOARD_REALTIME_PATH}?intent=transcription&model=owner%2Fasr`;

describe("Chat Test realtime upgrade (dashboard login)", () => {
  it("admits a valid session as the HTTP Chat Test requester", async () => {
    const t = deps();
    const { hono, seen, checkSession } = app(t.deps);
    const response = await hono.request(PATH, upgrade());
    expect(await response.text()).toBe("upgraded");
    expect(checkSession).toHaveBeenCalledWith({ sessionId: "sess-1", userId: "user-1" });
    expect(seen[0]?.requester).toEqual({
      userId: "user-1",
      limitKey: "chat-test:user-1",
      credential: { kind: "dashboard", sessionId: "sess-1" },
    });
    expect(seen[0]?.model).toBe("owner/asr");
    // The split-origin web app is a dashboard origin too.
    expect((await hono.request(PATH, upgrade({ Origin: WEB }))).status).toBe(200);
    // A default port is the same origin.
    expect((await hono.request(PATH, upgrade({ Origin: `${APP}:443` }))).status).toBe(200);
    expect(t.counters.count({ tokenId: "chat-test:user-1" })).toBe(3);
    expect(t.counters.count({ userId: "user-1" })).toBe(3);
  });

  it.each([
    ["no Origin", {}],
    ["a foreign Origin", { Origin: "https://evil.example" }],
    ["a look-alike Origin", { Origin: "https://proxy.example.test.evil.example" }],
    ["a malformed Origin", { Origin: "null" }],
    ["the app host over another scheme", { Origin: "http://proxy.example.test" }],
    ["the app host on another port", { Origin: "https://proxy.example.test:8443" }],
    ["the web host on another port", { Origin: "https://web.example.test:3001" }],
  ])("refuses %s with 403 before reading the session", async (_label, headers) => {
    const t = deps();
    const { hono, checkSession } = app(t.deps);
    const response = await hono.request(PATH, upgrade(headers));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "origin_not_allowed" } });
    expect(checkSession).not.toHaveBeenCalled();
    expect(t.counters.count("server")).toBe(0);
  });

  it("refuses without a dashboard session (401)", async () => {
    const t = deps();
    const { hono, checkSession } = app(t.deps, { current: null });
    const response = await hono.request(PATH, upgrade());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "dashboard_session_required" },
    });
    expect(checkSession).not.toHaveBeenCalled();
  });

  it.each([
    ["ended", 401, "dashboard_session_ended"],
    ["blocked", 403, "access_denied"],
    ["two_factor_required", 403, "two_factor_required"],
  ] as const)("refuses a session that is %s (%d %s)", async (verdict, status, code) => {
    const t = deps();
    const { hono } = app(t.deps, { verdict });
    const response = await hono.request(PATH, upgrade());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(t.counters.count("server")).toBe(0);
  });

  it("refuses with 503 when the session row cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = deps();
    const { hono } = app(t.deps, { verdict: new Error("db down") });
    expect((await hono.request(PATH, upgrade())).status).toBe(503);
    expect(t.counters.count("server")).toBe(0);
    errors.mockRestore();
  });

  it("refuses a credential in the URL and requires an upgrade", async () => {
    const t = deps();
    const { hono } = app(t.deps);
    const credential = await hono.request(
      `${DASHBOARD_REALTIME_PATH}?intent=transcription&token=x`,
      upgrade(),
    );
    expect(credential.status).toBe(400);
    expect(await credential.json()).toMatchObject({ error: { code: "credential_in_url" } });
    expect((await hono.request(PATH, { method: "GET", headers: { Origin: APP } })).status).toBe(
      426,
    );
  });

  it("counts Chat Test as one credential of its own: 4 sessions", async () => {
    const t = deps();
    const { hono } = app(t.deps);
    for (let index = 0; index < 4; index += 1) {
      expect((await hono.request(PATH, upgrade())).status).toBe(200);
    }
    const refused = await hono.request(PATH, upgrade());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("Chat Test realtime sessions", () => {
  function fakeWs() {
    const closes: { code?: number; reason?: string }[] = [];
    const ws = new WSContext<WebSocketLike>({
      readyState: 1,
      send: () => {},
      close: (code, reason) => {
        closes.push({ code, reason });
      },
    });
    return { ws, closes };
  }

  function admitted(t: ReturnType<typeof deps>, model: string | null = null): RealtimeAuth {
    const requester = dashboardRequester("user-1", "sess-1");
    const result = t.counters.acquire({ tokenId: requester.limitKey, userId: requester.userId });
    if (!result.ok) throw new Error("cap");
    return { requester, admission: result.admission, model };
  }

  it("claims sends with no token and meters as TEST", async () => {
    const meter = { opened: vi.fn(), itemFinished: vi.fn(), ended: vi.fn() };
    const createMeter = vi.fn(() => meter);
    const authorizeOpen = vi.fn(() => async () => ({
      ok: false as const,
      denial: "requester" as const,
    }));
    const router = vi.fn(() => ({
      candidates: async () => ({
        ok: true as const,
        candidates: [
          {
            nodeId: "node",
            handle: "i-aaaaaaaaaaaa",
            upstreamModel: "m",
            capabilities: null,
            memberId: null,
          },
        ],
      }),
      memberOpenFailed: () => {},
    }));
    const t = deps({ createMeter, authorizeOpen, router });
    const events = realtimeSocketEvents(admitted(t, "owner/asr"), t.deps);
    const { ws, closes } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    // A refused requester ends the session with the dashboard's own error.
    await vi.waitFor(() =>
      expect(closes).toEqual([{ code: 1008, reason: "dashboard_session_ended" }]),
    );
    expect(authorizeOpen).toHaveBeenCalledWith({ tokenId: null, userId: "user-1" });
    expect(createMeter).toHaveBeenCalledWith({
      userId: "user-1",
      source: "TEST",
      tokenId: null,
      tokenLookupPrefix: null,
    });
    expect(router).toHaveBeenCalledWith(
      expect.objectContaining({ requester: expect.objectContaining({ userId: "user-1" }) }),
    );
    expect(t.counters.count("server")).toBe(0);
  });

  it("the 60 s recheck ends it once the dashboard session is revoked, and a token revoke never does", async () => {
    const t = deps();
    let valid = true;
    const registry = new RealtimeSessionRegistry(async ({ credential }) =>
      credential.kind === "dashboard" && !valid
        ? { ok: false, reason: "credential" }
        : { ok: true },
    );
    const events = realtimeSocketEvents(admitted(t), { ...t.deps, registry });
    const { ws, closes } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    registry.terminateForToken("chat-test:user-1");
    registry.terminateForToken("sess-1");
    await registry.recheckSessions();
    expect(closes).toEqual([]);
    valid = false;
    await registry.recheckSessions();
    expect(closes).toEqual([{ code: 1008, reason: "dashboard_session_ended" }]);
    expect(t.counters.count("server")).toBe(0);
  });

  it("a ban ends it at once", () => {
    const t = deps();
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws, closes } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    t.registry.terminateForUser("user-1");
    expect(closes).toEqual([{ code: 1008, reason: "dashboard_session_ended" }]);
  });
});

describe("checkDashboardSession", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const later = new Date("2026-10-06T12:00:00Z");
  const row = (overrides: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => ({
    userId: "user-1",
    expiresAt: later,
    user: {
      twoFactorEnabled: false,
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
      ...user,
    },
    ...overrides,
  });
  const findUnique = vi.mocked(prisma.session.findUnique);
  const check = () => checkDashboardSession({ sessionId: "sess-1", userId: "user-1", now });

  it("passes a live session of an unblocked user", async () => {
    findUnique.mockResolvedValueOnce(row() as never);
    expect(await check()).toBe("ok");
  });

  it("ends a revoked (deleted), expired or foreign session", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await check()).toBe("ended");
    findUnique.mockResolvedValueOnce(row({ expiresAt: now }) as never);
    expect(await check()).toBe("ended");
    findUnique.mockResolvedValueOnce(row({ userId: "someone" }) as never);
    expect(await check()).toBe("ended");
  });

  it("blocks a banned or deletion-pending user", async () => {
    findUnique.mockResolvedValueOnce(row({}, { banned: true }) as never);
    expect(await check()).toBe("blocked");
    findUnique.mockResolvedValueOnce(row({}, { deletionRequestedAt: now }) as never);
    expect(await check()).toBe("blocked");
  });

  it("requires 2FA enrollment only while the policy forces it", async () => {
    findUnique.mockResolvedValue(row() as never);
    vi.mocked(isForceTwoFactorRequired).mockResolvedValueOnce(true);
    expect(await check()).toBe("two_factor_required");
    findUnique.mockResolvedValue(row({}, { twoFactorEnabled: true }) as never);
    vi.mocked(isForceTwoFactorRequired).mockResolvedValueOnce(true);
    expect(await check()).toBe("ok");
  });
});
