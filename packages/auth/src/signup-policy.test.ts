import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = {
  SIGNUP_ENABLED: true,
  NODE_ENV: "development",
  ADMIN_EMAIL: undefined as string | undefined,
};

const db = vi.hoisted(() => ({
  appSetting: { findUnique: vi.fn() },
  user: { count: vi.fn() },
}));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: envMock,
  get ADMIN_EMAIL() {
    return envMock.ADMIN_EMAIL;
  },
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: db,
}));

const { getRuntimeSignupEnabled, getSignupAccessState, resolveBootstrapAdminIdentity } =
  await import("./signup-policy");

describe("signup policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.SIGNUP_ENABLED = true;
    envMock.NODE_ENV = "development";
    envMock.ADMIN_EMAIL = undefined;
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

  it("requires one configured owner before production exposes bootstrap signup", async () => {
    envMock.NODE_ENV = "production";
    envMock.SIGNUP_ENABLED = false;
    db.user.count.mockResolvedValue(0);

    await expect(getSignupAccessState()).resolves.toEqual({
      signupEnabled: false,
      adminBootstrapSignupEnabled: false,
      userCount: 0,
    });

    envMock.ADMIN_EMAIL = "operator@example.com";
    await expect(getSignupAccessState()).resolves.toEqual({
      signupEnabled: false,
      adminBootstrapSignupEnabled: true,
      userCount: 0,
    });
  });

  it("admits only the configured production owner and canonicalizes variants before the unique email boundary", () => {
    envMock.NODE_ENV = "production";
    envMock.ADMIN_EMAIL = "operator@example.com";

    const identities = [" Operator@Example.com ", "OPERATOR@example.com"].map(
      resolveBootstrapAdminIdentity,
    );
    expect(identities).toEqual([
      { allowed: true, canonicalEmail: "operator@example.com" },
      { allowed: true, canonicalEmail: "operator@example.com" },
    ]);
    // The auth before-hook writes canonicalEmail as `data.email`; therefore
    // concurrent variants reach Prisma's @@unique([email]) as one identity.
    expect(new Set(identities.map((identity) => identity.canonicalEmail))).toEqual(
      new Set(["operator@example.com"]),
    );
    expect(resolveBootstrapAdminIdentity("attacker@example.com")).toEqual({ allowed: false });
    expect(resolveBootstrapAdminIdentity(undefined)).toEqual({ allowed: false });
  });
});
