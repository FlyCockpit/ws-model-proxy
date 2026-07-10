import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("@ws-model-proxy/auth", () => ({
  auth: {
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
};

describe("betterAuthAdminGate", () => {
  let app: Hono;
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    invalidateForceTwoFactorPolicyCache();
    db.appSetting.findUnique.mockResolvedValue(null);
    downstream.mockClear();
    app = new Hono();
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.all("/api/auth/admin/set-role", downstream);
    app.all("/api/auth/admin/impersonate-user", downstream);
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

  it("admits verified admins when force2fa is disabled", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const res = await app.request("/api/auth/admin/set-role", {
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
});
