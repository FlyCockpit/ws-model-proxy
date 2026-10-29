import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    WMP_RATE_LIMIT_SCALE: 1,
    TRUST_PROXY_HOPS: 0,
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../client-ip.js", () => ({ resolveClientIp: () => "203.0.113.7" }));

const { RateLimiterMemory } = await import("rate-limiter-flexible");
const { NodeEventHub } = await import("./hub.js");
const { createNodeEventsHandler, NODE_EVENTS_PATH } = await import("./route.js");

type Verdict = "ok" | "ended" | "blocked" | "two_factor_required";

const APP = "https://proxy.example.test";

function session(userId = "user-1", sessionId = "sess-1"): Session {
  return { user: { id: userId }, session: { id: sessionId } } as Session;
}

function setup(
  options: {
    current?: Session | null;
    verdict?: Verdict | Error | (() => Promise<Verdict>);
    draining?: boolean;
    hub?: InstanceType<typeof NodeEventHub>;
    ipPoints?: number;
    userPoints?: number;
  } = {},
) {
  const hub = options.hub ?? new NodeEventHub();
  const app = new Hono();
  const verdict = options.verdict ?? "ok";
  const checkSession = vi.fn(async () => {
    if (verdict instanceof Error) throw verdict;
    if (typeof verdict === "function") return verdict();
    return verdict;
  });
  app.get(
    NODE_EVENTS_PATH,
    createNodeEventsHandler({
      allowedOrigins: [APP],
      isDraining: () => options.draining ?? false,
      hub,
      readSession: async () => (options.current === undefined ? session() : options.current),
      checkSession,
      ipLimiter: new RateLimiterMemory({ points: options.ipPoints ?? 100, duration: 60 }),
      userLimiter: new RateLimiterMemory({ points: options.userPoints ?? 100, duration: 60 }),
    }),
  );
  const request = (headers: Record<string, string> = {}) =>
    app.request(`${APP}${NODE_EVENTS_PATH}`, { headers });
  return { app, hub, request, checkSession };
}

async function firstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunk = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(chunk.value);
}

describe("GET /api/dashboard/events", () => {
  it("streams events for a signed-in same-origin request", async () => {
    const { request, hub } = setup();
    const response = await request({ "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(hub.size).toBe(1);
    expect(await firstChunk(response)).toBe("retry: 3000\n\n");
    expect(hub.size).toBe(0);
  });

  it("accepts the dashboard's own Origin", async () => {
    const { request } = setup();
    const response = await request({ origin: APP });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("refuses another site's Origin or a cross-site fetch", async () => {
    const { request, checkSession } = setup();
    const refused: Array<Record<string, string>> = [
      { origin: "https://evil.example.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of refused) {
      const response = await request(headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    }
    expect(checkSession).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    const { request } = setup({ current: null });
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_required" });
  });

  it("answers 401 for an ended session, 403 for a blocked user or missing 2FA", async () => {
    for (const [verdict, status, error] of [
      ["ended", 401, "session_ended"],
      ["blocked", 403, "access_blocked"],
      ["two_factor_required", 403, "two_factor_required"],
    ] as const) {
      const { request, hub } = setup({ verdict });
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(hub.size).toBe(0);
    }
  });

  it("answers 503 while draining or when the session cannot be read", async () => {
    const draining = await setup({ draining: true }).request();
    expect(draining.status).toBe(503);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = setup({ verdict: new Error("db down") });
    const response = await failed.request();
    expect(response.status).toBe(503);
    expect(failed.hub.size).toBe(0);
    error.mockRestore();
  });

  it("answers 429 over the stream cap or a limiter", async () => {
    const hub = new NodeEventHub({ perUser: 1, perServer: 10 });
    const { request } = setup({ hub });
    const first = await request();
    expect(first.status).toBe(200);
    const second = await request();
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "too_many_streams" });
    await first.body?.cancel();

    const limited = setup({ userPoints: 1 });
    (await limited.request()).body?.cancel();
    expect((await limited.request()).status).toBe(429);
    const ipLimited = setup({ ipPoints: 1 });
    (await ipLimited.request()).body?.cancel();
    expect((await ipLimited.request()).status).toBe(429);
  });

  it("answers 401 when the session ends while its row is read", async () => {
    const hub = new NodeEventHub();
    let release: (verdict: Verdict) => void = () => {};
    const { request } = setup({
      hub,
      verdict: () =>
        new Promise<Verdict>((resolve) => {
          release = resolve;
        }),
    });
    const pending = request();
    await vi.waitFor(() => expect(hub.size).toBe(1));
    hub.endSession("sess-1");
    release("ok");
    const response = await pending;
    expect(response.status).toBe(401);
    expect(hub.size).toBe(0);
  });
});
