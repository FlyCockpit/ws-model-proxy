import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forceTwoFactorPolicy = vi.hoisted(() => ({
  invalidateForceTwoFactorPolicyCache: vi.fn(),
  isForceTwoFactorRequired: vi.fn(),
}));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => forceTwoFactorPolicy);
const signupPolicy = vi.hoisted(() => ({
  SIGNUP_ENABLED_SETTING_KEY: "signupEnabled",
  getRuntimeSignupEnabled: vi.fn(async () => true),
}));
vi.mock("@ws-model-proxy/auth/signup-policy", () => signupPolicy);
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));

import type { Context } from "../context";
import { adminSettingsRouter } from "./admin-settings";
import { settingsRouter } from "./settings";

const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  appSetting: { findMany: MockInstance; upsert: MockInstance };
  user: { findUnique: MockInstance; update: MockInstance; updateMany: MockInstance };
};

function context(user: Partial<Session["user"]> = {}, csrfVerified = true): Context {
  const id = user.id ?? "user-1";
  return {
    auth: { kind: "cookie_session", userId: id, sessionId: "s", csrfVerified },
    session: {
      user: {
        id,
        email: "u@example.test",
        name: "U",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        ...user,
      },
      session: { id: "s", userId: id, expiresAt: new Date(Date.now() + 60_000) },
    } as Session,
  };
}

const row = {
  name: "U",
  email: "u@example.test",
  slug: "u",
  locale: "en-US",
  operationalAlerts: true,
  twoFactorEnabled: null,
  onboardingDoneAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  forceTwoFactorPolicy.isForceTwoFactorRequired.mockResolvedValue(false);
});

describe("settings (per person)", () => {
  it("reads the signed-in person's settings", async () => {
    db.user.findUnique.mockResolvedValue(row);
    const client = createRouterClient(settingsRouter, { context: context() });
    await expect(client.get()).resolves.toEqual({
      ...row,
      twoFactorEnabled: false,
      onboardingDoneAt: null,
    });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
  });

  it("updates only the fields given, for the caller only", async () => {
    db.user.update.mockResolvedValue({ ...row, operationalAlerts: false });
    const client = createRouterClient(settingsRouter, { context: context() });
    await client.update({ operationalAlerts: false });
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" }, data: { operationalAlerts: false } }),
    );
  });

  it("refuses an update without the CSRF header (not a person)", async () => {
    const client = createRouterClient(settingsRouter, { context: context({}, false) });
    await expect(client.update({ operationalAlerts: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("completes onboarding once (the first time is kept)", async () => {
    db.user.findUnique.mockResolvedValue({ ...row, onboardingDoneAt: new Date("2026-10-01") });
    const client = createRouterClient(settingsRouter, { context: context() });
    const result = await client.onboarding.complete();
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1", onboardingDoneAt: null } }),
    );
    expect(result.onboardingDoneAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("adminSettings", () => {
  const admin = { id: "admin-1", role: "admin", twoFactorEnabled: true };

  it("hides itself from people who are not admins", async () => {
    const client = createRouterClient(adminSettingsRouter, { context: context() });
    await expect(client.get()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads the server settings with clamped media values", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "mediaAssetTtlHours", value: "999" }]);
    const client = createRouterClient(adminSettingsRouter, { context: context(admin) });
    const settings = await client.get();
    expect(settings.mediaAssetTtlHours).toBe(168);
    expect(settings.signupEnabled).toBe(true);
  });

  it("refuses forced 2FA while the admin has no second factor", async () => {
    const client = createRouterClient(adminSettingsRouter, {
      context: context({ ...admin, twoFactorEnabled: false }),
    });
    await expect(client.update({ forceTwoFactor: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("stores forced 2FA and drops the policy cache", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const client = createRouterClient(adminSettingsRouter, { context: context(admin) });
    await client.update({ forceTwoFactor: true });
    expect(db.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "force2fa" },
        create: { key: "force2fa", value: "true" },
      }),
    );
    expect(forceTwoFactorPolicy.invalidateForceTwoFactorPolicyCache).toHaveBeenCalled();
  });

  it("clamps the attachment limit before storing it", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    const client = createRouterClient(adminSettingsRouter, { context: context(admin) });
    await client.update({ mediaAttachmentMaxBytes: 1 });
    expect(db.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { key: "mediaAttachmentMaxBytes", value: String(256 * 1024) },
      }),
    );
  });
});
