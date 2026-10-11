import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSignupAccessState = vi.hoisted(() => vi.fn());
const isPendingShareInviteToken = vi.hoisted(() => vi.fn(async (_token: string) => false));

vi.mock("@ws-model-proxy/auth/signup-policy", () => ({
  getSignupAccessState,
  SIGNUP_DISABLED_MESSAGE: "Sign-up is currently disabled. Contact an admin if you need access.",
}));
vi.mock("@ws-model-proxy/auth/share-invite-acceptance", () => ({ isPendingShareInviteToken }));

const PENDING_TOKEN = "wsmp_inv_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const signupClosed = {
  signupEnabled: false,
  adminBootstrapSignupEnabled: false,
  userCount: 2,
};

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
    expect(isPendingShareInviteToken).not.toHaveBeenCalled();
  });

  describe("invite sign-up with open sign-up off", () => {
    const signUp = (headers: Record<string, string>) =>
      app.request("/api/auth/sign-up/email", { method: "POST", headers });

    it("lets a pending invite's token through", async () => {
      getSignupAccessState.mockResolvedValue(signupClosed);
      isPendingShareInviteToken.mockResolvedValueOnce(true);

      const res = await signUp({ "x-wsmp-invite": PENDING_TOKEN });

      expect(res.status).toBe(200);
      expect(downstream).toHaveBeenCalledTimes(1);
      expect(isPendingShareInviteToken).toHaveBeenCalledWith(PENDING_TOKEN);
    });

    it("refuses a used, revoked, expired or unknown token", async () => {
      getSignupAccessState.mockResolvedValue(signupClosed);
      isPendingShareInviteToken.mockResolvedValueOnce(false);

      const res = await signUp({ "x-wsmp-invite": PENDING_TOKEN });

      expect(res.status).toBe(403);
      expect(downstream).not.toHaveBeenCalled();
    });

    it("refuses a malformed token without a lookup", async () => {
      getSignupAccessState.mockResolvedValue(signupClosed);

      const res = await signUp({ "x-wsmp-invite": "wsmp_inv_not-a-token" });

      expect(res.status).toBe(403);
      expect(isPendingShareInviteToken).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
    });

    it("refuses without the header", async () => {
      getSignupAccessState.mockResolvedValue(signupClosed);

      const res = await signUp({});

      expect(res.status).toBe(403);
      expect(isPendingShareInviteToken).not.toHaveBeenCalled();
    });

    it("does not look the token up when open sign-up is on", async () => {
      getSignupAccessState.mockResolvedValue({ ...signupClosed, signupEnabled: true });

      const res = await signUp({ "x-wsmp-invite": "wsmp_inv_not-a-token" });

      expect(res.status).toBe(200);
      expect(isPendingShareInviteToken).not.toHaveBeenCalled();
    });

    it("never logs the token", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      getSignupAccessState.mockResolvedValue(signupClosed);

      await signUp({ "x-wsmp-invite": PENDING_TOKEN });

      const logged = JSON.stringify([log.mock.calls, error.mock.calls, warn.mock.calls]);
      expect(logged).not.toContain(PENDING_TOKEN);
      vi.restoreAllMocks();
    });
  });
});
