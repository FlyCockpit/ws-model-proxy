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

const { resolveRouteSession, resolveRouteSessionFromAuth, toRouteSession } = await import(
  "./auth-session"
);

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

  it("turns lookup failures into thrown errors for the legacy helper", async () => {
    getSession.mockRejectedValue(new Error("database unavailable"));

    await expect(resolveRouteSession(headers())).rejects.toThrow("Route session unavailable");
  });
});

describe("resolveRouteSessionFromAuth", () => {
  it("returns an error resolution instead of throwing", async () => {
    const resolution = await resolveRouteSessionFromAuth(new Headers(), async () => {
      throw new Error("database unavailable");
    });
    expect(resolution).toEqual({ status: "error" });
  });

  it("projects a resolved session", async () => {
    const resolution = await resolveRouteSessionFromAuth(new Headers(), async () => ({
      user: {
        id: "u1",
        name: "User",
        email: "u@example.com",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
      },
    }));
    expect(resolution).toEqual({
      status: "resolved",
      session: {
        user: {
          id: "u1",
          name: "User",
          email: "u@example.com",
          emailVerified: true,
          role: "user",
          twoFactorEnabled: false,
        },
      },
    });
  });
});

describe("toRouteSession", () => {
  it("returns null for a missing session", () => {
    expect(toRouteSession(null)).toBeNull();
  });
});
