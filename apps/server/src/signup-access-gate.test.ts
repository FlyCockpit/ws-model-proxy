import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignupAccessState = vi.hoisted(() => vi.fn());

vi.mock("@ws-model-proxy/auth/signup-policy", () => ({
  getSignupAccessState,
  SIGNUP_DISABLED_MESSAGE: "Sign-up is currently disabled. Contact an admin if you need access.",
}));

const { signupAccessGate } = await import("./signup-access-gate");

describe("signupAccessGate", () => {
  let app: Hono;
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use("/api/auth/sign-up/*", signupAccessGate);
    app.post("/api/auth/sign-up/email", downstream);
  });

  it("allows signup when runtime signup is enabled", async () => {
    getSignupAccessState.mockResolvedValue({
      signupEnabled: true,
      adminBootstrapSignupEnabled: false,
      userCount: 12,
    });

    const res = await app.request("/api/auth/sign-up/email", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("allows first-user bootstrap when runtime signup is disabled", async () => {
    getSignupAccessState.mockResolvedValue({
      signupEnabled: false,
      adminBootstrapSignupEnabled: true,
      userCount: 0,
    });

    const res = await app.request("/api/auth/sign-up/email", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("rejects signup when runtime signup is disabled and users already exist", async () => {
    getSignupAccessState.mockResolvedValue({
      signupEnabled: false,
      adminBootstrapSignupEnabled: false,
      userCount: 2,
    });

    const res = await app.request("/api/auth/sign-up/email", { method: "POST" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Sign-up is currently disabled. Contact an admin if you need access.",
    });
    expect(downstream).not.toHaveBeenCalled();
  });
});
