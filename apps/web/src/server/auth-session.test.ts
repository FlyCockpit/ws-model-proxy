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

const { resolveRouteSession } = await import("./auth-session");

describe("resolveRouteSession", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  const headers = () =>
    new Headers({
      authorization: "Bearer model-token",
      cookie: "better-auth.session_token=session-token",
    });

  it("returns a token-free session projection", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "u1",
        name: "User One",
        email: "u1@example.com",
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: true,
        locale: "en-US",
      },
      session: {
        token: "secret-session-token",
      },
    });

    await expect(resolveRouteSession(headers())).resolves.toEqual({
      user: {
        id: "u1",
        name: "User One",
        email: "u1@example.com",
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: true,
      },
    });
    const call = getSession.mock.calls[0]?.[0] as { headers: Headers };
    expect(call.headers.get("authorization")).toBeNull();
  });

  it("returns null when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(resolveRouteSession(headers())).resolves.toBeNull();
  });

  it("lets lookup failures bubble as route errors", async () => {
    const error = new Error("database unavailable");
    getSession.mockRejectedValue(error);

    await expect(resolveRouteSession(headers())).rejects.toBe(error);
  });
});
