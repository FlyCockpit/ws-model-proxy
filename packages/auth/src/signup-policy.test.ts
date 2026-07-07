import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = {
  SIGNUP_ENABLED: true,
};

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn() },
  user: { count: vi.fn() },
}));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: envMock,
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: db,
}));

const { getRuntimeSignupEnabled, getSignupAccessState } = await import("./signup-policy");

describe("signup policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.SIGNUP_ENABLED = true;
    db.appSetting.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(1);
  });

  it("falls back to SIGNUP_ENABLED when no runtime setting exists", async () => {
    envMock.SIGNUP_ENABLED = false;

    await expect(getRuntimeSignupEnabled()).resolves.toBe(false);
    expect(db.appSetting.findUnique).toHaveBeenCalledWith({
      where: { key: "signupEnabled" },
      select: { value: true },
    });
  });

  it("lets runtime true override SIGNUP_ENABLED=false", async () => {
    envMock.SIGNUP_ENABLED = false;
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });

    await expect(getRuntimeSignupEnabled()).resolves.toBe(true);
  });

  it("lets runtime false override SIGNUP_ENABLED=true", async () => {
    envMock.SIGNUP_ENABLED = true;
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });

    await expect(getRuntimeSignupEnabled()).resolves.toBe(false);
  });

  it("allows first-user bootstrap when runtime signup is disabled", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });
    db.user.count.mockResolvedValue(0);

    await expect(getSignupAccessState()).resolves.toEqual({
      signupEnabled: false,
      adminBootstrapSignupEnabled: true,
      userCount: 0,
    });
  });
});
