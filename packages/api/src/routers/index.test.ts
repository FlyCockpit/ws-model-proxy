import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — appConfig reads env.SMTP_HOST and SIGNUP_ENABLED at call
// time, so flipping values between tests exercises both branches.
const envMock = {
  SMTP_HOST: undefined as string | undefined,
  SIGNUP_ENABLED: true,
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

describe("appConfig", () => {
  beforeEach(() => {
    envMock.SMTP_HOST = undefined;
    envMock.SIGNUP_ENABLED = true;
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
