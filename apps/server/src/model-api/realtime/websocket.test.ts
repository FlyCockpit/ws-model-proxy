import type { WebSocketLike } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ApiKeyIdentity } from "../resolve.js";
import { dashboardRequester, tokenRequester } from "./requester.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const limiterState = vi.hoisted(() => ({
  hits: 0,
  limit: Number.POSITIVE_INFINITY,
  keys: [] as string[],
}));
vi.mock("../../rate-limit.js", () => ({
  realtimeUpgradeLimiter: {},
  createRateLimiterMiddleware:
    (_limiter: unknown, options: { resolveKey: (c: unknown) => string }) =>
    async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => {
      limiterState.keys.push(options.resolveKey(c));
      limiterState.hits += 1;
      if (limiterState.hits > limiterState.limit) {
        return c.json({ error: "Too many attempts." }, 429);
      }
      await next();
    },
}));
vi.mock("../../client-ip.js", () => ({ resolveClientIp: () => "203.0.113.7" }));

const { WSContext } = await import("hono/ws");
const { SttRelayHub } = await import("../../relay/stt-relay.js");
const { RealtimeSessionCounters } = await import("./limits.js");
const { RealtimeSessionRegistry } = await import("./registry.js");
const {
  createRealtimeWebsocketMiddleware,
  REALTIME_OPEN_GUARD_MS,
  REALTIME_PONG_TIMEOUT_MS,
  REALTIME_PING_INTERVAL_MS,
  readRealtimeQuery,
  realtimeSocketEvents,
  subprotocolSecret,
} = await import("./websocket.js");

type Deps = Parameters<typeof realtimeSocketEvents>[1];

const TOKEN: ApiKeyIdentity = {
  id: "token-1",
  userId: "user-1",
  scope: "ALL_POOLS",
  lookupPrefix: "wsmp_key_abc",
  expiresAt: null,
  lastUsedAt: null,
};
const SECRET = "wsmp_key_secret";

function deps(overrides: Partial<Deps> = {}) {
  const hub = new SttRelayHub({ resolveLink: () => ({ ok: false, reason: "offline" }) });
  const counters = new RealtimeSessionCounters();
  const recheck = vi.fn(async () => ({ ok: true as const }));
  const registry = new RealtimeSessionRegistry(recheck);
  const draining = { value: false };
  const authenticate = vi.fn(async (secret: string) => (secret === SECRET ? TOKEN : null));
  const value: Deps = {
    relay: {
      createSttSession: (input) => hub.createSession(input),
      getOnlineNodeIds: () => [],
      isDraining: () => draining.value,
    },
    counters,
    registry,
    authenticate,
    router: () => ({
      candidates: async () => ({ ok: false, code: "no_live_member" }),
      memberOpenFailed: () => {},
    }),
    ...overrides,
  };
  return { deps: value, counters, registry, recheck, draining, authenticate };
}

function app(value: Deps) {
  const hono = new Hono();
  hono.use("/v1/realtime", createRealtimeWebsocketMiddleware(value));
  hono.get("/v1/realtime", () => new Response("upgraded"));
  return hono;
}

function upgrade(headers: Record<string, string> = {}) {
  return { method: "GET", headers: { Upgrade: "websocket", ...headers } };
}

beforeEach(() => {
  limiterState.hits = 0;
  limiterState.limit = Number.POSITIVE_INFINITY;
  limiterState.keys = [];
});

describe("realtime upgrade middleware", () => {
  it("requires an upgrade and refuses while draining", async () => {
    const t = deps();
    expect((await app(t.deps).request("/v1/realtime?intent=transcription")).status).toBe(426);
    t.draining.value = true;
    expect((await app(t.deps).request("/v1/realtime?intent=transcription", upgrade())).status).toBe(
      503,
    );
  });

  it.each([
    ["/v1/realtime", "unsupported_intent"],
    ["/v1/realtime?intent=conversation", "unsupported_intent"],
    ["/v1/realtime?intent=transcription&intent=transcription", "unsupported_intent"],
    [`/v1/realtime?intent=transcription&api_key=${SECRET}`, "credential_in_url"],
    ["/v1/realtime?intent=transcription&voice=x", "unknown_parameter"],
    [`/v1/realtime?intent=transcription&model=${"m".repeat(257)}`, "invalid_value"],
    ["/v1/realtime?intent=transcription&model=a&model=b", "invalid_value"],
  ])("refuses %s with 400 %s, before reading any credential", async (path, code) => {
    const t = deps();
    const response = await app(t.deps).request(
      path,
      upgrade({ Authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(t.authenticate).not.toHaveBeenCalled();
  });

  it("refuses a missing or invalid credential with 401", async () => {
    const t = deps();
    const path = "/v1/realtime?intent=transcription";
    expect((await app(t.deps).request(path, upgrade())).status).toBe(401);
    expect(
      (await app(t.deps).request(path, upgrade({ Authorization: "Bearer wsmp_key_wrong" }))).status,
    ).toBe(401);
    expect(t.counters.count("server")).toBe(0);
  });

  it("accepts the bearer header or the browser subprotocol key, and holds an admission", async () => {
    const t = deps();
    const path = "/v1/realtime?intent=transcription&model=owner%2Fasr";
    const bearer = await app(t.deps).request(path, upgrade({ Authorization: `Bearer ${SECRET}` }));
    expect(await bearer.text()).toBe("upgraded");
    const browser = await app(t.deps).request(
      path,
      upgrade({ "Sec-WebSocket-Protocol": `realtime, openai-insecure-api-key.${SECRET}` }),
    );
    expect(await browser.text()).toBe("upgraded");
    expect(t.authenticate).toHaveBeenCalledWith(SECRET);
    expect(t.counters.count({ tokenId: TOKEN.id })).toBe(2);
    // The pre-auth limiter never keys on credential bytes.
    expect(limiterState.keys.every((key) => key === "ip:203.0.113.7")).toBe(true);
  });

  it("refuses with 429 past the per-token cap, before the upgrade", async () => {
    const t = deps();
    const path = "/v1/realtime?intent=transcription";
    for (let index = 0; index < 4; index += 1) {
      expect(
        (await app(t.deps).request(path, upgrade({ Authorization: `Bearer ${SECRET}` }))).status,
      ).toBe(200);
    }
    const refused = await app(t.deps).request(path, upgrade({ Authorization: `Bearer ${SECRET}` }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("applies the pre-auth IP limiter", async () => {
    const t = deps();
    limiterState.limit = 0;
    expect((await app(t.deps).request("/v1/realtime?intent=transcription", upgrade())).status).toBe(
      429,
    );
    expect(t.authenticate).not.toHaveBeenCalled();
  });

  it("releases the admission when the upgrade handler throws", async () => {
    const t = deps();
    const hono = new Hono();
    hono.use("/v1/realtime", createRealtimeWebsocketMiddleware(t.deps));
    hono.get("/v1/realtime", () => {
      throw new Error("upgrade failed");
    });
    const response = await hono.request(
      "/v1/realtime?intent=transcription",
      upgrade({ Authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(500);
    expect(t.counters.count("server")).toBe(0);
  });

  it("reads the subprotocol key and the query strictly", () => {
    expect(subprotocolSecret("realtime, openai-insecure-api-key.abc")).toBe("abc");
    expect(subprotocolSecret("realtime, openai-insecure-api-key.")).toBeNull();
    expect(subprotocolSecret(undefined)).toBeNull();
    expect(readRealtimeQuery("http://x/v1/realtime?intent=transcription&model=a")).toEqual({
      ok: true,
      model: "a",
    });
    expect(readRealtimeQuery("http://x/v1/realtime?intent=transcription&token=x")).toMatchObject({
      ok: false,
      code: "credential_in_url",
    });
  });
});

describe("realtime socket events", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeWs(raw?: unknown) {
    const sends: Record<string, unknown>[] = [];
    const closes: { code?: number; reason?: string }[] = [];
    const ws = new WSContext<WebSocketLike>({
      readyState: 1,
      send: (data) => {
        sends.push(JSON.parse(String(data)) as Record<string, unknown>);
      },
      close: (code, reason) => {
        closes.push({ code, reason });
      },
      ...(raw ? { raw: raw as WebSocketLike } : {}),
    });
    return { ws, sends, closes };
  }

  function admitted(t: ReturnType<typeof deps>) {
    const result = t.counters.acquire({ tokenId: TOKEN.id, userId: TOKEN.userId });
    if (!result.ok) throw new Error("cap");
    return { requester: tokenRequester(TOKEN), admission: result.admission, model: null };
  }

  it("opens a session, answers events, and releases everything on close", () => {
    const t = deps();
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws, sends } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    expect(sends[0]?.type).toBe("session.created");
    expect(t.registry.size).toBe(1);
    events.onMessage?.(new MessageEvent("message", { data: "{" }), ws);
    expect(sends.at(-1)).toMatchObject({ type: "error", error: { code: "invalid_json" } });
    events.onMessage?.(new MessageEvent("message", { data: new ArrayBuffer(2) }), ws);
    expect(sends.at(-1)).toMatchObject({ type: "error", error: { code: "invalid_event" } });
    events.onClose?.(new CloseEvent("close"), ws);
    expect(t.registry.size).toBe(0);
    expect(t.counters.count("server")).toBe(0);
  });

  it("L1: a failure while setting the session up releases the admission and closes 1011", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = deps({
      router: () => {
        throw new Error("setup bug");
      },
    });
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws, closes } = fakeWs();
    expect(() => events.onOpen?.(new Event("open"), ws)).not.toThrow();
    expect(t.counters.count("server")).toBe(0);
    expect(closes).toEqual([{ code: 1011, reason: "server_error" }]);
    expect(t.registry.size).toBe(0);
    errors.mockRestore();
  });

  it("uses the injected send claim for opens", async () => {
    const authorizeOpen = vi.fn(() => async () => ({
      ok: false as const,
      denial: "access" as const,
    }));
    const t = deps({
      authorizeOpen,
      router: () => ({
        candidates: async () => ({
          ok: true,
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
      }),
    });
    const events = realtimeSocketEvents({ ...admitted(t), model: "owner/asr" }, t.deps);
    const { ws, closes } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    await vi.waitFor(() => expect(closes).toEqual([{ code: 1008, reason: "model_not_found" }]));
    expect(authorizeOpen).toHaveBeenCalledWith({ tokenId: TOKEN.id, userId: TOKEN.userId });
  });

  it("feeds the usage meter from the session hooks", () => {
    const meter = { opened: vi.fn(), itemFinished: vi.fn(), ended: vi.fn() };
    const createMeter = vi.fn(() => meter);
    const t = deps({ createMeter });
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    events.onClose?.(new CloseEvent("close"), ws);
    expect(createMeter).toHaveBeenCalledWith({
      source: "API_KEY",
      tokenId: TOKEN.id,
      userId: TOKEN.userId,
      tokenLookupPrefix: TOKEN.lookupPrefix,
    });
    expect(meter.ended).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: null, closeCode: null, sentAudioBytes: 0 }),
    );
    expect(meter.opened).not.toHaveBeenCalled();
  });

  it("attributes a /v1/realtime session to its token and a Chat Test session to no token", () => {
    const meter = { opened: vi.fn(), itemFinished: vi.fn(), ended: vi.fn() };
    const createMeter = vi.fn(() => meter);
    const authorizeOpen = vi.fn(() => async () => ({ ok: true as const }));
    const t = deps({ createMeter, authorizeOpen });
    const dashboard = dashboardRequester("user-1", "sess-1");
    const chatTestAdmission = t.counters.acquire({
      tokenId: dashboard.limitKey,
      userId: dashboard.userId,
    });
    if (!chatTestAdmission.ok) throw new Error("cap");
    for (const auth of [
      admitted(t),
      { requester: dashboard, admission: chatTestAdmission.admission, model: null },
    ]) {
      const events = realtimeSocketEvents(auth, t.deps);
      const { ws } = fakeWs();
      events.onOpen?.(new Event("open"), ws);
      events.onClose?.(new CloseEvent("close"), ws);
    }
    expect(createMeter.mock.calls).toEqual([
      [
        {
          userId: TOKEN.userId,
          source: "API_KEY",
          tokenId: TOKEN.id,
          tokenLookupPrefix: TOKEN.lookupPrefix,
        },
      ],
      [{ userId: "user-1", source: "TEST", tokenId: null, tokenLookupPrefix: null }],
    ]);
    expect(authorizeOpen.mock.calls).toEqual([
      [{ tokenId: TOKEN.id, userId: TOKEN.userId }],
      [{ tokenId: null, userId: "user-1" }],
    ]);
    expect(t.counters.count("server")).toBe(0);
  });

  it("gives the admission back when the handshake never opens", () => {
    vi.useFakeTimers();
    const t = deps();
    realtimeSocketEvents(admitted(t), t.deps);
    expect(t.counters.count("server")).toBe(1);
    vi.advanceTimersByTime(REALTIME_OPEN_GUARD_MS);
    expect(t.counters.count("server")).toBe(0);
  });

  it("refuses a socket that opens after shutdown began (1001), releasing its admission", () => {
    const t = deps();
    t.registry.closeAll();
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws, closes, sends } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    expect(closes).toEqual([{ code: 1001, reason: "server_shutting_down" }]);
    expect(sends.map((event) => event.type)).toEqual(["error"]);
    expect(t.counters.count("server")).toBe(0);
  });

  it("shutdown and access rechecks reach a session still waiting for a model", async () => {
    const t = deps();
    t.recheck.mockResolvedValueOnce({ ok: false, reason: "credential" } as never);
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { ws, closes } = fakeWs();
    events.onOpen?.(new Event("open"), ws);
    await t.registry.recheckSessions();
    expect(closes).toEqual([{ code: 1008, reason: "invalid_api_key" }]);
    expect(t.counters.count("server")).toBe(0);

    const other = realtimeSocketEvents(admitted(t), t.deps);
    const second = fakeWs();
    other.onOpen?.(new Event("open"), second.ws);
    t.registry.closeAll();
    expect(second.closes).toEqual([{ code: 1001, reason: "server_shutting_down" }]);
  });

  function fakeRawSocket() {
    const raw = Object.create(WebSocket.prototype) as WebSocket;
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    Object.defineProperties(raw, {
      bufferedAmount: { value: 0 },
      pause: { value: () => calls.push("pause") },
      resume: { value: () => calls.push("resume") },
      ping: { value: () => calls.push("ping") },
      terminate: { value: () => calls.push("terminate") },
      on: {
        value: (event: string, listener: () => void) => {
          listeners.set(event, listener);
          return raw;
        },
      },
    });
    return { raw, calls, pong: () => listeners.get("pong")?.() };
  }

  it("pings, keeps a socket that answers, and terminates one silent for 60 s", () => {
    vi.useFakeTimers();
    const t = deps();
    const events = realtimeSocketEvents(admitted(t), t.deps);
    const { raw, calls, pong } = fakeRawSocket();
    const { ws } = fakeWs(raw);
    events.onOpen?.(new Event("open"), ws);
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS);
    expect(calls).toEqual(["ping"]);
    pong();
    vi.advanceTimersByTime(REALTIME_PING_INTERVAL_MS * 2);
    expect(calls).not.toContain("terminate");
    vi.advanceTimersByTime(REALTIME_PONG_TIMEOUT_MS);
    expect(calls).toContain("terminate");
    events.onClose?.(new CloseEvent("close"), ws);
  });
});
