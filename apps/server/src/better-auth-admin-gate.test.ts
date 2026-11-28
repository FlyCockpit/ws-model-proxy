import { type Context, Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const cookieSecret = "disposable-impersonation-unit-secret";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
    $context: Promise.resolve({
      secret: "disposable-impersonation-unit-secret",
      createAuthCookie: () => ({ name: "better-auth.admin_session" }),
    }),
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const { default: prisma } = await import("@ws-model-proxy/db");
const { betterAuthAdminGate } = await import("./better-auth-admin-gate");
const { invalidateForceTwoFactorPolicyCache } = await import(
  "@ws-model-proxy/auth/force-two-factor-policy"
);

const db = prisma as unknown as {
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  session: { findFirst: ReturnType<typeof vi.fn> };
};

describe("betterAuthAdminGate", () => {
  let app: Hono;
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    db.session.findFirst.mockReset();
    invalidateForceTwoFactorPolicyCache();
    db.appSetting.findUnique.mockResolvedValue(null);
    downstream.mockClear();
    app = new Hono();
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.all("/api/auth/admin/set-role", downstream);
    app.all("/api/auth/admin/stop-impersonating", downstream);
    app.all("/api/auth/admin/impersonate-user", downstream);
    app.all("/api/auth/admin/*", downstream);
  });

  it("rejects unauthenticated callers with 401", async () => {
    getSession.mockResolvedValue(null);
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      error_description: "Authentication required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers before Better-Auth handles the route", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user", emailVerified: true } });
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Verified admin access required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects unverified admins", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: false, twoFactorEnabled: true },
    });
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects admins without 2FA when force2fa is enabled", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const res = await app.request("/api/auth/admin/set-user-password", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Two-factor authentication setup is required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("admits verified admins to supported operations when force2fa is disabled", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const res = await app.request("/api/auth/admin/impersonate-user", {
      method: "POST",
      headers: {
        Authorization: "Bearer wsmp_model_secret",
        Cookie: "better-auth.session_token=signed-session",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
    const call = getSession.mock.calls[0]?.[0] as { headers: Headers };
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("cookie")).toBe("better-auth.session_token=signed-session");
  });

  it("admits verified admins with 2FA when force2fa is enabled", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
  it("still rejects stop-impersonating for a normal non-admin session", async () => {
    getSession.mockResolvedValue({
      user: { id: "target", role: "user", emailVerified: true },
      session: { impersonatedBy: null },
    });
    const res = await app.request("/api/auth/admin/stop-impersonating", { method: "POST" });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/auth/admin/stop-impersonating"],
    ["POST", "/api/auth/admin/set-role"],
    ["POST", "/api/auth/admin/stop-impersonating/extra"],
  ])("keeps the impersonated role gate for %s %s", async (method, path) => {
    getSession.mockResolvedValue({
      user: { id: "target", role: "user", emailVerified: true },
      session: { impersonatedBy: "admin" },
    });
    const res = await app.request(path, { method });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });
  describe("return from impersonation", () => {
    const actor = () => ({
      user: { id: "admin", role: "admin", emailVerified: true, twoFactorEnabled: true },
      session: { id: "original", impersonatedBy: null },
    });
    const target = () => ({
      user: { id: "ordinary", role: "user", emailVerified: false },
      session: { id: "impersonation", impersonatedBy: "admin" },
    });
    const stop = async (path = "stop-impersonating", saved = "original-token:") =>
      app.request(`/api/auth/admin/${path}`, {
        method: "POST",
        headers: {
          cookie: await generateSignedCookie("better-auth.admin_session", saved, cookieSecret),
          authorization: "Bearer must-not-authorize",
        },
      });

    it("admits only the saved verified admin and strips bearer lookup credentials", async () => {
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce(actor());
      expect((await stop()).status).toBe(200);
      expect(downstream).toHaveBeenCalledTimes(1);
      for (const [options] of getSession.mock.calls) {
        expect(options.headers.has("authorization")).toBe(false);
      }
      expect(db.session.findFirst).toHaveBeenCalledWith({
        where: {
          token: "original-token",
          userId: "admin",
          impersonatedBy: null,
          expiresAt: { gt: expect.any(Date) },
        },
        select: { user: { select: expect.objectContaining({ deletionRequestedAt: true }) } },
      });
    });

    it.each([{ banned: true }, { deletionRequestedAt: new Date() }])(
      "a target's lifecycle cannot block returning: %j",
      async (lifecycle) => {
        const impersonated = target();
        getSession.mockResolvedValueOnce({
          ...impersonated,
          user: { ...impersonated.user, ...lifecycle },
        });
        db.session.findFirst.mockResolvedValueOnce(actor());
        expect((await stop()).status).toBe(200);
      },
    );

    it.each([
      { role: "user" },
      { emailVerified: false },
      { twoFactorEnabled: false },
      { banned: true },
      { deletionRequestedAt: new Date() },
    ])("checks the actor's current authority: %j", async (change) => {
      const admin = actor();
      db.appSetting.findUnique.mockResolvedValue({ value: "true" });
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce({ ...admin, user: { ...admin.user, ...change } });
      expect((await stop()).status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
    });

    it("refuses when no live saved browser session is bound to the actor", async () => {
      getSession.mockResolvedValueOnce(target());
      db.session.findFirst.mockResolvedValueOnce(null);
      expect((await stop()).status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each([
      ["POST", "stop-impersonating/"],
      ["GET", "stop-impersonating"],
      ["POST", "stop-impersonating-extra"],
    ])("keeps %s %s on the active-user gate", async (method, path) => {
      getSession.mockResolvedValueOnce(target());
      const response = await app.request(`/api/auth/admin/${path}`, { method });
      expect(response.status).toBe(403);
      expect(db.session.findFirst).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each([null, { user: { id: "admin" }, session: { impersonatedBy: null } }])(
      "requires a live impersonated session: %j",
      async (impersonated) => {
        getSession.mockResolvedValueOnce(impersonated);
        expect((await stop()).status).toBe(401);
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it.each(["", "better-auth.admin_session=unsigned", "better-auth.admin_session=bad.signature"])(
      "refuses a missing or invalid signed restoration cookie",
      async (cookie) => {
        getSession.mockResolvedValueOnce(target());
        const response = await app.request("/api/auth/admin/stop-impersonating", {
          method: "POST",
          headers: { cookie },
        });
        expect(response.status).toBe(401);
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it("does not confer actor authority on another management endpoint", async () => {
      getSession.mockResolvedValue(target());
      expect((await stop("list-users")).status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
    });

    it.each(["duplicate", "malformed-quoted-duplicate", "quoted"])(
      "rejects ambiguous saved cookie inputs: %s",
      async (kind) => {
        const signed = await generateSignedCookie(
          "better-auth.admin_session",
          "original-token:",
          cookieSecret,
        );
        const cookie =
          kind === "duplicate"
            ? `${signed}; ${signed}`
            : kind === "malformed-quoted-duplicate"
              ? signed.replace("=", '="') + `X; ${signed}`
              : signed.replace("=", '="') + '"';
        getSession.mockResolvedValueOnce(target());
        const response = await app.request("/api/auth/admin/stop-impersonating", {
          method: "POST",
          headers: { cookie },
        });
        expect(response.status).toBe(401);
        expect(db.session.findFirst).not.toHaveBeenCalled();
        expect(downstream).not.toHaveBeenCalled();
      },
    );

    it("fails closed when the session lookup fails", async () => {
      getSession.mockRejectedValue(new Error("database unavailable"));
      expect((await stop()).status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    });
  });
});

describe("Better Auth parallel access writes", () => {
  it.each([
    ["set-role", {}],
    ["ban-user", {}],
    ["unban-user", {}],
    ["remove-user", {}],
    ["update-user", { data: { role: "admin" } }],
    ["update-user", { data: { banned: false } }],
    ["update-user", { data: { banExpires: null } }],
    ["update-user", { data: { emailVerified: true } }],
  ])("blocks %s before the endpoint writes", async (path, body) => {
    getSession.mockResolvedValue({ user: { id: "a", role: "admin", emailVerified: true } });
    invalidateForceTwoFactorPolicyCache();
    db.appSetting.findUnique.mockResolvedValue(null);
    const endpoint = vi.fn((c: Context) => c.json({ wrote: true }));
    const server = new Hono();
    server.use("*", betterAuthAdminGate);
    server.all("*", endpoint);
    const response = await server.request(`/api/auth/admin/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "USE_ORPC_USER_MANAGEMENT" });
    expect(endpoint).not.toHaveBeenCalled();
  });
});
