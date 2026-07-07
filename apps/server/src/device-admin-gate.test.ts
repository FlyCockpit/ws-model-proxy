import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @ws-model-proxy/auth at the module boundary so the gate reads session
// resolution from a stub instead of touching the real Better-Auth instance
// (which would otherwise try to connect to Postgres on import).
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

const { deviceAdminGate } = await import("./device-admin-gate");

describe("deviceAdminGate", () => {
  let app: Hono;
  // Sentinel — if the gate calls next() the downstream handler runs and we
  // return 200 with a payload the test can assert on. This stands in for the
  // real `auth.handler` mounted in apps/server/src/index.ts.
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    downstream.mockClear();
    app = new Hono();
    app.use("/api/auth/device/approve", deviceAdminGate);
    app.use("/api/auth/device/deny", deviceAdminGate);
    app.all("/api/auth/device/approve", downstream);
    app.all("/api/auth/device/deny", downstream);
  });

  it("rejects unauthenticated callers with 401", async () => {
    getSession.mockResolvedValue(null);
    const res = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABC123" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Authentication required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("admits signed-in regular users on /approve", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user" } });
    const res = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABC123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits signed-in unverified users", async () => {
    getSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", emailVerified: false } });
    const res = await app.request("/api/auth/device/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits signed-in regular users on /deny", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user" } });
    const res = await app.request("/api/auth/device/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABC123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits signed-in users with a missing role", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await app.request("/api/auth/device/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("treats a getSession failure as unauthenticated", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    const res = await app.request("/api/auth/device/approve", { method: "POST" });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("admits an admin caller and lets the downstream handler run on /approve", async () => {
    getSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", emailVerified: true } });
    const res = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABC123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits a verified caller whose role list contains admin", async () => {
    getSession.mockResolvedValue({
      user: { id: "admin-1", role: "editor, admin", emailVerified: true },
    });
    const res = await app.request("/api/auth/device/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits an admin caller on /deny", async () => {
    getSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", emailVerified: true } });
    const res = await app.request("/api/auth/device/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: "ABC123" }),
    });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});
