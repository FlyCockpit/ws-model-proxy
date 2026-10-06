import type { Context as HonoContext } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: { getSession: vi.fn(async () => null) } } }));
vi.mock("@ws-model-proxy/auth/cookie-session", () => ({
  cookieSessionHeaders: (headers: Headers) => headers,
}));

import { createContext } from "./context";

function hono(session: unknown, headers: Record<string, string> = {}): HonoContext {
  return {
    get: (key: string) => (key === "session" ? session : undefined),
    req: { raw: new Request("https://proxy.example.com/rpc", { headers }) },
  } as unknown as HonoContext;
}

/**
 * `/rpc` never carries a token credential: agent tokens reach procedures only through MCP,
 * which counts `model_test` benches per token (models.test leaves them uncounted).
 */
describe("createContext", () => {
  it("answers a cookie session or anonymous, never a token, even with a bearer header", async () => {
    const bearer = { authorization: "Bearer wsmp_at_x" };
    const anonymous = await createContext({ context: hono(null, bearer) });
    expect(anonymous.auth).toEqual({ kind: "anonymous" });
    const signedIn = await createContext({
      context: hono({ user: { id: "me" }, session: { id: "sess" } }, bearer),
    });
    expect(signedIn.auth.kind).toBe("cookie_session");
  });
});
