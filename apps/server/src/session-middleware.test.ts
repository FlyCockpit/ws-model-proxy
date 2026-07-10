import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const { sessionMiddleware } = await import("./session-middleware");

describe("sessionMiddleware", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("resolves browser sessions without forwarding bearer authorization", async () => {
    getSession.mockResolvedValue(null);
    const app = new Hono();
    app.use("/*", sessionMiddleware);
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("/", {
      headers: {
        Authorization: "Bearer wsmp_model_secret",
        Cookie: "better-auth.session_token=signed-session",
      },
    });

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledOnce();
    const call = getSession.mock.calls[0]?.[0] as { headers: Headers };
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("cookie")).toBe("better-auth.session_token=signed-session");
  });
});
