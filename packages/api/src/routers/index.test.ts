import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — appConfig reads env.SMTP_HOST and SIGNUP_ENABLED at call
// time, so flipping values between tests exercises both branches.
const envMock = {
  SMTP_HOST: undefined as string | undefined,
  SIGNUP_ENABLED: true,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
  WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: undefined as string | undefined,
  WMP_MCP_ENABLED: true,
  WMP_MCP_PAT_ALLOW_NO_EXPIRY: true,
  WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  BETTER_AUTH_URL: "https://proxy.example.com",
};
vi.mock("@ws-model-proxy/env/server", () => ({
  env: envMock,
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
}));

// Mock @ws-model-proxy/db so importing the full appRouter graph never touches Postgres.
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// @ws-model-proxy/auth builds the Better-Auth instance (prismaAdapter, plugins) at
// import time — stub it so the graph loads without that machinery.
vi.mock("@ws-model-proxy/auth", () => ({
  auth: { api: {} },
}));

// @ws-model-proxy/mailer would open SMTP — stub the surface the import graph uses.
vi.mock("@ws-model-proxy/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { appRouter } = await import("./index");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as {
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  user: { count: ReturnType<typeof vi.fn> };
};

const publicContext: Context = { session: null };

function sessionContext(role: string): Context {
  return {
    session: {
      user: {
        id: "user",
        email: "user@example.com",
        name: "User",
        emailVerified: true,
        role,
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "session",
        userId: "user",
        token: "token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    },
  } as Context;
}

describe("appConfig", () => {
  beforeEach(() => {
    envMock.SMTP_HOST = undefined;
    envMock.SIGNUP_ENABLED = true;
    envMock.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    envMock.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = undefined;
    envMock.WMP_MCP_ENABLED = true;
    envMock.WMP_MCP_PAT_ALLOW_NO_EXPIRY = true;
    envMock.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = false;
    db.appSetting.findUnique.mockResolvedValue(null);
    db.user.count.mockResolvedValue(1);
  });

  it("reports emailEnabled=false when SMTP_HOST is unset", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(false);
  });

  it("reports emailEnabled=true when SMTP_HOST is configured", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(true);
  });

  it("surfaces signup flags alongside emailEnabled", async () => {
    envMock.SIGNUP_ENABLED = false;
    envMock.SMTP_HOST = "smtp.example.com";

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config).toEqual({
      ssoEnabled: false,
      forceSso: false,
      ssoProviderName: "SSO",
      signupEnabled: false,
      adminBootstrapSignupEnabled: false,
      emailEnabled: true,
    });
    expect(JSON.stringify(config)).not.toContain("keyring");
    expect(JSON.stringify(config)).not.toContain("deploymentFeatures");
  });

  it("keeps the feature inventory off the public payload", async () => {
    const sentinel = "zz-keyring-marker";
    envMock.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = sentinel;
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();
    expect(config).not.toHaveProperty("deploymentFeatures");
    expect(config).not.toHaveProperty("providerEgressEnabled");
    expect(JSON.stringify(config)).not.toContain(sentinel);
    await expect(client.deploymentFeatures()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.deploymentFlags()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("gives a signed-in user the product gates without the keyring status", async () => {
    envMock.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    envMock.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = true;
    const sentinel = "zz-keyring-marker";
    envMock.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = sentinel;
    const client = createRouterClient(appRouter, { context: sessionContext("user") });
    await expect(client.deploymentFlags()).resolves.toEqual({
      providerEgressEnabled: true,
      privateNetworksAllowed: true,
    });
    expect(JSON.stringify(await client.deploymentFlags())).not.toContain(sentinel);
    expect(JSON.stringify(await client.deploymentFlags())).not.toContain("keyring");
    await expect(client.deploymentFeatures()).rejects.toMatchObject({ code: "FORBIDDEN" });

    envMock.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = false;
    envMock.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = false;
    await expect(client.deploymentFlags()).resolves.toEqual({
      providerEgressEnabled: false,
      privateNetworksAllowed: false,
    });
  });

  it("reports the full deployment inventory to an admin", async () => {
    envMock.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
    envMock.WMP_MCP_ENABLED = true;
    envMock.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = true;
    const client = createRouterClient(appRouter, { context: sessionContext("admin") });

    const missingKeyring = await client.deploymentFeatures();
    expect(missingKeyring.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED).toEqual({
      enabled: true,
      keyringConfigured: false,
      ready: false,
    });
    expect(missingKeyring.WMP_MCP_ENABLED).toBe(true);
    expect(missingKeyring.WMP_MCP_PAT_ALLOW_NO_EXPIRY).toBe(true);
    expect(missingKeyring.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS).toBe(true);
    expect(JSON.stringify(missingKeyring)).not.toContain("WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS");

    const sentinel = "zz-keyring-marker";
    envMock.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = sentinel;
    const ready = await client.deploymentFeatures();
    expect(ready.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED).toEqual({
      enabled: true,
      keyringConfigured: true,
      ready: true,
    });
    expect(JSON.stringify(ready)).not.toContain(sentinel);
  });

  it("lets a runtime false setting override SIGNUP_ENABLED=true", async () => {
    envMock.SIGNUP_ENABLED = true;
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.signupEnabled).toBe(false);
    expect(config.adminBootstrapSignupEnabled).toBe(false);
  });

  it("lets a runtime true setting override SIGNUP_ENABLED=false", async () => {
    envMock.SIGNUP_ENABLED = false;
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.signupEnabled).toBe(true);
    expect(config.adminBootstrapSignupEnabled).toBe(false);
  });

  it("surfaces the first-user signup carve-out when signup is otherwise disabled", async () => {
    envMock.SIGNUP_ENABLED = true;
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });
    db.user.count.mockResolvedValue(0);

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.adminBootstrapSignupEnabled).toBe(true);
  });
});
